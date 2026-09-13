/**
 * ArkWork — Replan（结构化补丁事务）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.4
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §4.3 / §4.4
 *
 * **本模块替代 v0.29 的"让模型再想一遍"式重规划**。差异：
 *
 * | | v0.29 | v0.30.0 |
 * |---|---|---|
 * | 形态 | `replanHint` 文本（让模型自己评估）或 `plan-regen` 全量重生成 | 对图应用一组**带影响分析的可审计原子补丁** |
 * | 触发 | 用户续聊 / plan 生成失败降级 | E1–E9 事件驱动 |
 * | 约束 | 无 | `reason` 必填；必须做 impact 分析；不得改已 approved 的 AC；ops 是原子事务 |
 * | 批准 | 无分级 | 4 级（追加自动 / invalidate 需批准 / 改 scope 需批准 / 改 AC 禁止） |
 * | 审计 | 无 | Revision 留痕，可 diff |
 *
 * 四条硬约束（设计稿 §4.3）：
 *  1. **Replan 必须写 `reason`** —— 不可解释的重规划会破坏用户对系统的信任
 *  2. **Replan 必须做影响分析** —— 明确告知"这个改动会让 T-05 白做"
 *  3. **不得修改已 `approved` 的 acceptance** —— 要改必须走 Spec 修订流程（I3）
 *  4. **ops 是一个原子事务** —— 要么全应用，要么全回滚
 */
import {
  generateNodeId,
  generatePatchId,
  type AcceptanceCriterion,
  type GraphWriteError,
  type NodeChange,
  type NodeStatus,
  type ReplanApprovalLevel,
  type ReplanEventType,
  type ReplanImpact,
  type ReplanOp,
  type ReplanPatch,
  type Revision,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import { validateWrite } from './invariants.js'
import { runGate } from './gate.js'
import { validateGraphShape } from './store.js'
import { logger } from '../../system/logger.js'

/** 新增节点的默认 token 估算（impact.estimatedExtraTokens 用） */
const DEFAULT_NODE_EST_TOKENS = 1500

/* ============================================================
 * 一、构造补丁（含影响分析与批准级别）
 * ============================================================ */

export interface BuildPatchInput {
  triggerEvent: ReplanEventType
  reason: string
  ops: ReplanOp[]
  /** 追溯：谁提出的（模型 / 系统 / 用户） */
  by?: Revision['by']
}

/**
 * 构造 ReplanPatch。**纯函数**：只读图，不修改它。
 *
 * @returns `error` 非空表示补丁本身不合法（如 reason 为空、op 引用了不存在的节点）
 */
export function buildPatch(
  graph: TaskGraph,
  input: BuildPatchInput,
): { patch?: ReplanPatch; error?: GraphWriteError } {
  // 约束 1：reason 必填
  if (!input.reason?.trim()) {
    return {
      error: {
        code: 'FORBIDDEN',
        message: 'Replan 缺少 reason',
        hint: '重规划必须说明"为什么要改"—— 请填写 reason（一句话，说明触发这次变更的具体观察）。不可解释的重规划会破坏用户对系统的信任。',
      },
    }
  }
  if (input.ops.length === 0) {
    return {
      error: {
        code: 'SCHEMA_INVALID',
        message: 'Replan 的 ops 为空',
        hint: '补丁至少包含一个操作（add / remove / update / reorder / relink）。若你认为不需要改动，请不要调用 replan。',
      },
    }
  }

  // op 引用的节点必须存在（remove/update/reorder/relink）
  for (const op of input.ops) {
    if (op.op === 'add') continue
    if (op.op === 'update' || op.op === 'remove' || op.op === 'relink') {
      if (!graph.nodes[op.id]) {
        return {
          error: {
            code: 'NOT_FOUND',
            message: `Replan op 引用了不存在的节点：${op.id}`,
            hint: '请先调用 task_list 读取当前任务图，确认节点 id 后再提交补丁。',
            violatedBy: { nodeId: op.id },
          },
        }
      }
    }
    if (op.op === 'reorder') {
      const missing = op.ids.filter((id) => !graph.nodes[id])
      if (missing.length > 0) {
        return {
          error: {
            code: 'NOT_FOUND',
            message: `Replan reorder 引用了不存在的节点：${missing.join(', ')}`,
            hint: '请先调用 task_list 读取当前节点列表。',
          },
        }
      }
    }
  }

  // 约束 3：不得修改已 approved 的 acceptance
  if (isAcEdit(graph, input.ops)) {
    return {
      error: {
        code: 'FORBIDDEN',
        message: 'Replan 试图修改已批准的验收条件',
        hint: '已批准（spec.state=approved）的 acceptance.statement / verify 不可改写（不变量 I3）—— 否则等于让 agent 弱化自己的成功标准。正确做法：新增一条 AC 承载新的验证方式，或把原 AC 标为 waived，或发起 Spec 修订流程。',
      },
    }
  }

  const impact = computeImpact(graph, input.ops)
  const approvalLevel = decideApprovalLevel(graph, input.ops, impact)

  return {
    patch: {
      id: generatePatchId(),
      reason: input.reason.trim(),
      triggerEvent: input.triggerEvent,
      ops: input.ops,
      impact,
      approvalLevel,
      state: approvalLevel >= 2 ? 'pending' : 'applied',
      createdAt: Date.now(),
    },
  }
}

/**
 * 计算影响分析。
 *
 * `invalidatedTasks` 的判定（比设计稿更保守，避免"虚报代价"）：
 *  - `remove` 掉的节点里，状态为 completed 的
 *  - `update` 把已 completed 节点的 dependsOn / acceptance / layer 改动的
 *  - 被 remove 节点的**已完成后代**
 * 仅仅是改标题、改优先级**不算** invalidate（用户不会因此白做）。
 */
export function computeImpact(graph: TaskGraph, ops: ReplanOp[]): ReplanImpact {
  const invalidated = new Set<string>()
  const affected = new Set<string>()

  const markSubtreeCompleted = (rootId: string): void => {
    const visit = (id: string): void => {
      const node = graph.nodes[id]
      if (!node) return
      if (node.status === 'completed') invalidated.add(id)
      impactedAcsOf(node, affected)
      for (const c of node.children) visit(c)
    }
    visit(rootId)
  }

  let extraTokens = 0
  for (const op of ops) {
    switch (op.op) {
      case 'add':
        extraTokens += op.node.tokenBudget ?? DEFAULT_NODE_EST_TOKENS
        break
      case 'remove':
        markSubtreeCompleted(op.id)
        break
      case 'update': {
        const before = graph.nodes[op.id]
        if (before?.status === 'completed') {
          const touched = Object.keys(op.patch).filter((k) =>
            ['dependsOn', 'acceptance', 'layer', 'parentId', 'children', 'verification'].includes(k),
          )
          if (touched.length > 0) {
            invalidated.add(op.id)
            impactedAcsOf(before, affected)
          }
        }
        // 改验收条件 → 影响对应 AC
        if (op.patch.acceptance) {
          for (const ac of before?.acceptance ?? []) affected.add(ac.id)
        }
        extraTokens += DEFAULT_NODE_EST_TOKENS / 2
        break
      }
      case 'relink': {
        const node = graph.nodes[op.id]
        if (node?.status === 'completed' && hasChanged(op.dependsOn, node.dependsOn)) {
          invalidated.add(op.id)
          impactedAcsOf(node, affected)
        }
        break
      }
      case 'reorder':
        // 纯顺序调整不影响状态
        break
    }
  }

  // 受影响的 AC：所有 coveredBy 命中 invalidated 节点的 AC
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (!invalidated.has(nodeId)) continue
    impactedAcsOf(node, affected)
  }
  for (const ac of graph.spec.acceptance) {
    if (ac.coveredBy.some((id) => invalidated.has(id))) affected.add(ac.id)
  }

  return {
    invalidatedTasks: [...invalidated],
    affectedACs: [...affected],
    estimatedExtraTokens: Math.round(extraTokens),
  }
}

/**
 * 批准级别（设计稿 §4.4）。
 *
 * 注意第 4 级在 `buildPatch` 里已经被拒（约束 3），此处保留返回 4 的能力
 * 是为了让 UI 能明确展示"为什么不可改"（F18 的补充态）。
 */
export function decideApprovalLevel(
  graph: TaskGraph,
  ops: ReplanOp[],
  impact: ReplanImpact,
): ReplanApprovalLevel {
  if (isAcEdit(graph, ops)) return 4
  if (ops.some((op) => op.op === 'update' && touchesScope(op.patch))) return 3
  if (impact.invalidatedTasks.length > 0 || impact.affectedACs.length > 0) return 2
  return 1
}

/* ============================================================
 * 二、应用补丁（原子事务）
 * ============================================================ */

export interface ApplyResult {
  graph: TaskGraph
  changes: NodeChange[]
  error?: GraphWriteError
  /** 影响的 AC（供 UI 展示与埋点） */
  affectedACs: string[]
}

/**
 * 原子应用补丁。
 *
 * 实现（系统设计 §6.4）：
 *  1. 校验 `reason` 与批准级别（level ≥2 且 `approved=false` → 拒绝，返回 pending）
 *  2. `structuredClone` 快照
 *  3. 逐 op 应用到草稿（任一抛错 → 丢弃草稿，返回原图）
 *  4. 形状校验 + 不变量校验（失败 → 丢弃草稿，返回原图）
 *  5. 通过后才由调用方落盘（本函数不读盘不写盘）
 *
 * **回滚保证**：返回的 `graph` 在失败时与入参**逐字段一致**（同一引用，未做过任何修改）。
 *
 * @param approved 用户是否已批准（level ≥ 2 必须显式传 true）
 */
export function applyPatch(
  graph: TaskGraph,
  patch: ReplanPatch,
  approved = false,
): ApplyResult {
  // 约束 3 的二次防线（即使 patch 是外部构造的，也不允许落地）
  if (patch.approvalLevel === 4 || isAcEdit(graph, patch.ops)) {
    return {
      graph,
      changes: [],
      affectedACs: [],
      error: {
        code: 'FORBIDDEN',
        message: '补丁试图修改已批准的验收条件（第 4 级：禁止）',
        hint: '请走 Spec 修订流程：新增一条 AC 或把原 AC 标为 waived，而不是改写它。',
      },
    }
  }
  if (patch.approvalLevel >= 2 && !approved) {
    return {
      graph,
      changes: [],
      affectedACs: patch.impact.affectedACs,
      error: {
        code: 'FORBIDDEN',
        message: `该补丁为第 ${patch.approvalLevel} 级，需要用户批准`,
        hint: '补丁已生成并等待用户确认（UI 会展示"为什么 / 改了什么 / 代价是什么"）。请勿重复提交，等用户决定。',
      },
    }
  }

  // 2) 快照（浅层 clone 足够：下面所有 op 都走不可变替换）
  const base = graph
  let draft: TaskGraph = { ...graph, nodes: { ...graph.nodes } }
  const changes: NodeChange[] = []

  try {
    for (const op of patch.ops) {
      applyOp(draft, op, changes)
    }
  } catch (err) {
    logger.warn('Agent', `replan: op 应用失败，已回滚（${(err as Error).message}）`)
    return {
      graph: base,
      changes: [],
      affectedACs: patch.impact.affectedACs,
      error: {
        code: 'INVARIANT_VIOLATION',
        message: `补丁应用失败：${(err as Error).message}`,
        hint: '补丁已全量回滚，图状态与执行前一致。请检查 ops 是否引用了已删除的节点，或依赖关系是否自相矛盾。',
      },
    }
  }

  // 4) 形状 + 不变量校验
  const shapeErrors = validateGraphShape(draft)
  if (shapeErrors.length > 0) {
    logger.warn('Agent', `replan: 形状校验失败，已回滚（${shapeErrors[0].message}）`)
    return {
      graph: base,
      changes: [],
      affectedACs: patch.impact.affectedACs,
      error: {
        code: 'SCHEMA_INVALID',
        message: `补丁应用后图形状非法：${shapeErrors[0].message}`,
        hint: '补丁已全量回滚。请检查新增节点的必填字段（title / layer / status / verification / assignee）。',
      },
    }
  }
  const invErr = validateWrite(draft, { kind: 'replan', nodeIds: patch.ops.flatMap(opIds) }, base)
  // I7 只警告不阻断（与 gate.ts 的口径一致）
  if (invErr && invErr.invariant !== 'I7') {
    logger.warn('Agent', `replan: 不变量校验失败，已回滚（${invErr.message}）`)
    return {
      graph: base,
      changes: [],
      affectedACs: patch.impact.affectedACs,
      error: {
        code: invErr.code,
        invariant: invErr.invariant,
        message: `补丁应用后被不变量拒绝：${invErr.message}`,
        hint: `${invErr.hint}（补丁已全量回滚，图状态与执行前一致）`,
        violatedBy: invErr.violatedBy,
      },
    }
  }
  const gate = runGate(draft, { kind: 'replan', nodeIds: patch.ops.flatMap(opIds) }, base)
  if (gate.downgrade) {
    draft = {
      ...draft,
      nodes: {
        ...draft.nodes,
        [gate.downgrade.nodeId]: { ...draft.nodes[gate.downgrade.nodeId], status: 'verifying' },
      },
    }
  } else if (!gate.ok) {
    return {
      graph: base,
      changes: [],
      affectedACs: patch.impact.affectedACs,
      error: gate.error,
    }
  }

  // 记录一条 replan 审计（Revision 由 store.saveGraph 追加，这里只更新图内状态）
  draft = {
    ...draft,
    updatedAt: Date.now(),
    revisions: [
      ...draft.revisions,
      {
        seq: (draft.revisions.at(-1)?.seq ?? 0) + 1,
        at: Date.now(),
        by: { kind: 'agent', id: 'agent' },
        op: 'replan',
        targetId: patch.id,
        after: { ops: patch.ops.map((o) => o.op), invalidated: patch.impact.invalidatedTasks },
        reason: patch.reason,
      },
    ],
  }
  return { graph: draft, changes, affectedACs: patch.impact.affectedACs }
}

/** 单个 op 的应用（就地修改 draft 的 nodes 表） */
function applyOp(draft: TaskGraph, op: ReplanOp, changes: NodeChange[]): void {
  switch (op.op) {
    case 'add': {
      const node: TaskNode = {
        ...op.node,
        id: op.node.id || generateNodeId(),
        createdAt: op.node.createdAt || Date.now(),
        updatedAt: Date.now(),
        revision: 1,
      }
      if (draft.nodes[node.id]) throw new Error(`节点 id 冲突：${node.id}`)
      draft.nodes[node.id] = node

      if (node.parentId) {
        const parent = draft.nodes[node.parentId]
        if (!parent) throw new Error(`新增节点的 parentId 不存在：${node.parentId}`)
        const idx = op.after ? parent.children.indexOf(op.after) + 1 : parent.children.length
        const children = [...parent.children]
        children.splice(idx <= 0 ? children.length : idx, 0, node.id)
        draft.nodes[node.parentId] = { ...parent, children, updatedAt: Date.now() }
      } else {
        const idx = op.after ? draft.rootIds.indexOf(op.after) + 1 : draft.rootIds.length
        const roots = [...draft.rootIds]
        roots.splice(idx <= 0 ? roots.length : idx, 0, node.id)
        draft.rootIds = roots
      }
      changes.push({ nodeId: node.id, source: 'replan', reason: `新增 ${node.key ?? ''} ${node.title}` })
      break
    }
    case 'remove': {
      const node = draft.nodes[op.id]
      if (!node) throw new Error(`remove 目标不存在：${op.id}`)
      // 连带删除整个子树（避免孤儿节点）
      const doomed = subtreeIds(draft, op.id)
      for (const id of doomed) delete draft.nodes[id]
      if (node.parentId && draft.nodes[node.parentId]) {
        const parent = draft.nodes[node.parentId]
        draft.nodes[node.parentId] = {
          ...parent,
          children: parent.children.filter((c) => c !== op.id),
          updatedAt: Date.now(),
        }
      }
      draft.rootIds = draft.rootIds.filter((r) => r !== op.id)
      // 清理其他节点对已删节点的依赖
      for (const [id, n] of Object.entries(draft.nodes)) {
        if (n.dependsOn.some((d) => doomed.includes(d))) {
          draft.nodes[id] = { ...n, dependsOn: n.dependsOn.filter((d) => !doomed.includes(d)) }
        }
      }
      changes.push({ nodeId: op.id, source: 'replan', reason: `删除：${op.reason}` })
      break
    }
    case 'update': {
      const node = draft.nodes[op.id]
      if (!node) throw new Error(`update 目标不存在：${op.id}`)
      const next: TaskNode = { ...node, ...op.patch, updatedAt: Date.now(), revision: node.revision + 1 }
      next.id = node.id // 防御：不允许改 id
      draft.nodes[op.id] = next
      if (op.patch.status && op.patch.status !== node.status) {
        changes.push({
          nodeId: op.id,
          from: node.status,
          to: op.patch.status,
          source: 'replan',
          reason: '重规划调整状态',
        })
      }
      break
    }
    case 'reorder': {
      // 支持**同一父节点下**的重排（跨父重排会破坏树结构，不做）
      const parentId = draft.nodes[op.ids[0]]?.parentId ?? null
      const sameParent = op.ids.every((id) => (draft.nodes[id]?.parentId ?? null) === parentId)
      if (!sameParent) {
        throw new Error('reorder 只支持同一父节点下的重排（跨父重排请用 relink）')
      }
      if (parentId) {
        const parent = draft.nodes[parentId]
        const rest = parent.children.filter((c) => !op.ids.includes(c))
        draft.nodes[parentId] = { ...parent, children: [...rest, ...op.ids], updatedAt: Date.now() }
      } else {
        const rest = draft.rootIds.filter((c) => !op.ids.includes(c))
        draft.rootIds = [...rest, ...op.ids]
      }
      break
    }
    case 'relink': {
      const node = draft.nodes[op.id]
      if (!node) throw new Error(`relink 目标不存在：${op.id}`)
      for (const dep of op.dependsOn) {
        if (!draft.nodes[dep]) throw new Error(`relink 指向不存在的节点：${dep}`)
        if (dep === op.id) throw new Error(`relink 不能依赖自己：${op.id}`)
      }
      draft.nodes[op.id] = { ...node, dependsOn: [...op.dependsOn], updatedAt: Date.now() }
      break
    }
  }
}

/* ============================================================
 * 三、内部工具
 * ============================================================ */

/** op 涉及的节点 id（用于门禁的定向检查） */
function opIds(op: ReplanOp): string[] {
  switch (op.op) {
    case 'add':
      return [op.node.id]
    case 'remove':
    case 'update':
    case 'relink':
      return [op.id]
    case 'reorder':
      return op.ids
  }
}

/** 是否试图修改已 approved 的 AC（约束 3 / I3） */
function isAcEdit(graph: TaskGraph, ops: ReplanOp[]): boolean {
  const specFrozen = graph.spec.state === 'approved' || graph.spec.state === 'amended'
  for (const op of ops) {
    if (op.op === 'update' && op.patch.acceptance) {
      const before = graph.nodes[op.id]?.acceptance ?? []
      const after = op.patch.acceptance as AcceptanceCriterion[]
      const afterMap = new Map(after.map((a) => [a.id, a]))
      for (const b of before) {
        const a = afterMap.get(b.id)
        if (!a) continue
        if (a.statement !== b.statement) return true
        if (JSON.stringify(a.verify ?? null) !== JSON.stringify(b.verify ?? null)) return true
      }
    }
    // remove 一个节点会顺带删掉它的 AC → 同样视为"改验收"，但在 approved 前允许
    if (op.op === 'remove' && specFrozen) {
      const node = graph.nodes[op.id]
      if (node?.acceptance.length) return true
    }
  }
  return false
}

/** update 是否触碰 scope（→ 第 3 级） */
function touchesScope(patch: Partial<TaskNode>): boolean {
  // scopeIn/scopeOut 在 spec 上，不在 node 上。
  // 但存在一种常见场景：模型通过 update 节点把标题改成与 scope 冲突的内容，
  // 这不算"改 scope"。因此这里对 node patch 恒为 false，
  // 真正的 scope 变更走独立入口（spec-update 流程）。
  void patch
  return false
}

/** 为某个节点涉及的 AC 打标 */
function impactedAcsOf(node: TaskNode, out: Set<string>): void {
  for (const ac of node.acceptance) out.add(ac.id)
}

function hasChanged(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.some((x, i) => x !== sb[i])
}

/** 子树 id（含自身） */
function subtreeIds(graph: TaskGraph, rootId: string): string[] {
  const out: string[] = []
  const visit = (id: string): void => {
    out.push(id)
    for (const c of graph.nodes[id]?.children ?? []) visit(c)
  }
  visit(rootId)
  return out
}

/* ============================================================
 * 四、给 UI / 模型看的文案
 * ============================================================ */

/** 批准级别的说明（Replan 卡片的标题与出口按钮用） */
export const APPROVAL_LEVEL_LABEL: Record<ReplanApprovalLevel, string> = {
  1: '自动应用（仅追加 / 加边）',
  2: '需要你的批准（会影响已完成的工作）',
  3: '需要你的批准（改动范围，视为 Spec 修订）',
  4: '禁止（不能修改已批准的验收条件）',
}

/**
 * 渲染 Replan 通知卡的"三件事"。
 *
 * 设计稿 §4.3 硬要求：**必须展示 为什么 / 改了什么 / 代价是什么，缺一个用户就不敢点"接受"**。
 * 本函数同时服务于 UI 与日志，保证两者口径一致。
 */
export function renderPatchSummary(graph: TaskGraph, patch: ReplanPatch): {
  reason: string
  changes: { op: ReplanOp['op']; text: string }[]
  cost: { invalidated: string[]; affectedACs: string[]; extraTokens: number }
  approvalLabel: string
} {
  const changes = patch.ops.map((op) => {
    switch (op.op) {
      case 'add':
        return {
          op: op.op,
          text: `${op.node.key ? `${op.node.key} ` : ''}${op.node.title}`,
        }
      case 'remove':
        return { op: op.op, text: `${labelOf(graph, op.id)}（${op.reason}）` }
      case 'update':
        return {
          op: op.op,
          text: `${labelOf(graph, op.id)} → ${Object.keys(op.patch).join(' / ')}`,
        }
      case 'reorder':
        return { op: op.op, text: `顺序调整：${op.ids.map((id) => labelOf(graph, id)).join(' → ')}` }
      case 'relink':
        return {
          op: op.op,
          text: `${labelOf(graph, op.id)} 依赖改为 ${op.dependsOn.map((d) => labelOf(graph, d)).join(', ') || '（无）'}`,
        }
    }
  })
  return {
    reason: patch.reason,
    changes,
    cost: {
      invalidated: patch.impact.invalidatedTasks.map((id) => labelOf(graph, id)),
      affectedACs: patch.impact.affectedACs,
      extraTokens: patch.impact.estimatedExtraTokens,
    },
    approvalLabel: APPROVAL_LEVEL_LABEL[patch.approvalLevel],
  }
}

function labelOf(graph: TaskGraph, id: string): string {
  const n = graph.nodes[id]
  return n ? `${n.key ? `${n.key} ` : ''}${n.title}` : id
}

/** 供 UI 使用的状态标签映射（Replan 后树增量动画用） */
export function statusLabel(status: NodeStatus): string {
  return status
}
