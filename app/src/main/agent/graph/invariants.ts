/**
 * ArkWork — TaskGraph 不变量校验（I1–I7）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §4.4 / §5.2
 *       agent-design-v1.0/03-统一任务模型TaskGraph.md §4.4
 *
 * 设计原则（三条，改动本文件前先读）：
 *  1. **纯函数**。不读盘、不广播、不改入参 —— 便于单测与在 Replan 事务里做"预演"。
 *  2. **返回结构化错误，不 throw**。设计稿 §S4 要求返回"说明违反了哪条、为什么、怎么修"
 *     的结构化错误给模型；裸异常会被上层吞成"操作失败"，模型无从自纠。
 *  3. **顺序确定**。按 I1→I7 顺序检查并返回**第一个**违规，避免"修好 A 才发现 B"
 *     的来回拉锯（模型每次只需要处理一个明确的问题）。
 *
 * 每条不变量对冲的失败模式（设计稿 §02）：
 *  I1 对冲 F2 上下文焦虑（"同时做很多事"导致每件都做不完）
 *  I2 对冲 F3 自评失明（模型自称完成）与 F6 过早完成
 *  I3 对冲 F6 过早完成（模型弱化自己的成功标准来"通过"）
 *  I4/I5 对冲 F5 计划衰变（依赖图自相矛盾）
 *  I6 对冲 F4 目标漂移（卡住时沉默地跑偏，而不是明确求助）
 *  I7 对冲 F4/F5（图里长出"来路不明的任务"）
 */
import {
  EVIDENCE_TRUST,
  INVARIANT_LABEL,
  SUFFICIENT_EVIDENCE_TRUST,
  type AcceptanceCriterion,
  type GraphWriteError,
  type InvariantId,
  type NodeStatus,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'

/* ============================================================
 * 变更描述（写入方声明"我改了什么"，供 I1–I7 判定）
 * ============================================================ */

/** 一次写入涉及的动作类型 */
export type WriteKind =
  | 'node-create'
  | 'node-update'
  | 'node-status'
  | 'node-delete'
  | 'spec-update'
  | 'replan'
  | 'converge'
  | 'migrate'

export interface WriteChange {
  kind: WriteKind
  /** 主要目标节点（node-* 类动作必填） */
  nodeId?: string
  /** 状态变更的起止（node-status 必填，用于转换合法性判定） */
  from?: NodeStatus
  to?: NodeStatus
  /** 变更后的节点快照（node-update / node-status 建议提供，用于 I2/I6/I7 快检） */
  patch?: Partial<TaskNode>
  /** batch 类动作（replan / converge / migrate）受影响的节点 id 列表 */
  nodeIds?: string[]
  /** 来源标记（写入 Revision 与 UI 徽标） */
  source?: string
}

/* ============================================================
 * 错误构造
 * ============================================================ */

/**
 * 构造一个不变量违规错误。
 *
 * `hint` 是**写给模型看的修复指引** —— 必须包含"怎么改"的具体动作，
 * 而不是"请修正后重试"这类空话（空话会让模型原地打转）。
 */
function violation(
  invariant: InvariantId,
  message: string,
  hint: string,
  violatedBy?: GraphWriteError['violatedBy'],
): GraphWriteError {
  return {
    code: 'INVARIANT_VIOLATION',
    invariant,
    message: `${invariant} 违反：${message}`,
    hint,
    violatedBy,
  }
}

/** 构造一个状态转换被拒错误 */
export function transitionDenied(
  nodeId: string,
  from: NodeStatus,
  to: NodeStatus,
  allowed: readonly NodeStatus[],
): GraphWriteError {
  return {
    code: 'TRANSITION_DENIED',
    message: `不允许的状态转换：${from} → ${to}`,
    hint: `${from} 只能转换到 [${allowed.join(', ')}]。若确实需要跳过中间态，请先用 task_update 把状态推进到合法前驱，或走 task_block 说明为何需要人工介入。`,
    violatedBy: { nodeId, field: 'status', value: to },
  }
}

/* ============================================================
 * 单条不变量（逐条导出，便于单测与复用）
 * ============================================================ */

/**
 * I1 · 最多一个 in_progress。
 *
 * 为什么是硬不变量而不是提示词纪律：设计稿准则 B1 —— 把"一次只做一件事"
 * 写进协议而非提示词。v0.29 已有等价实现约定（decidePlanAdvance 只维护一个
 * running 项），本版把它从"实现约定"升级为"写入前校验"。
 */
export function checkI1(graph: TaskGraph): GraphWriteError | null {
  const maxParallel = graph.policy.maxParallel ?? 1
  const running = Object.values(graph.nodes).filter((n) => n.status === 'in_progress')
  if (running.length <= maxParallel) return null
  const extra = running.slice(maxParallel).map((n) => n.key ?? n.id)
  return violation(
    'I1',
    `同时有 ${running.length} 个 in_progress 节点，超过并行度 ${maxParallel}`,
    `把多余的 in_progress 节点改回 ready（或 blocked / needs_human），一次只保留 ${maxParallel} 个进行中：${extra.join(', ')}。`,
    { field: 'status', value: running.map((n) => n.id) },
  )
}

/**
 * I2 · completed 的合法性。
 *
 * 三个条件同时满足才允许 completed：
 *  a) `verification.required === true` 时，必须**经过 verifying**（由调用方通过 change.from 传入；
 *     纯图级校验无法回溯历史，故此项在 change 存在时判定）
 *  b) 至少一条**充分证据**（trust >= SUFFICIENT_EVIDENCE_TRUST 且非 diff）
 *  c) 节点自身 acceptance 的 status 全部 ∈ {passing, waived}
 *
 * 注意：本函数只负责"报告违规"。**违规的处置是降级为 verifying 而不是拒绝写入**
 * （设计稿 §4.4 的"违反后果"列）。该降级动作在 graph/write.ts 里实现。
 */
export function checkI2(graph: TaskGraph, change?: WriteChange): GraphWriteError | null {
  const targets = pickTargets(graph, change).filter((n) => n.status === 'completed')
  for (const node of targets) {
    // a) 是否跳过了 verifying
    if (
      node.verification.required &&
      !node.verification.allowSelfAttest &&
      change?.kind === 'node-status' &&
      change.nodeId === node.id &&
      change.from === 'in_progress' &&
      change.to === 'completed'
    ) {
      return violation(
        'I2',
        `节点 ${node.key ?? node.id} 从 in_progress 直接跳到 completed，跳过了 verifying`,
        `先把状态改为 verifying 并执行验证命令（${node.verification.command ?? '见 acceptance[].verify.command'}），由验证结果决定 completed 或 failed。`,
        { nodeId: node.id, field: 'status', value: 'completed' },
      )
    }
    // b) 是否有充分证据
    const hasSufficient = node.evidence.some(
      (e) => EVIDENCE_TRUST[e.kind] >= SUFFICIENT_EVIDENCE_TRUST,
    )
    if (!hasSufficient) {
      const kinds = node.evidence.map((e) => e.kind).join(', ') || '（无证据）'
      return violation(
        'I2',
        `节点 ${node.key ?? node.id} 标记 completed，但没有充分证据（现有证据类型：${kinds}）`,
        `调用 task_evidence 追加至少一条可信证据：跑一次测试（kind="test"）或命令（kind="command"）并带上 exitCode。注意 diff 只能证明"改了"，不能证明"对了"，不能单独作为完成证据。`,
        { nodeId: node.id, field: 'evidence' },
      )
    }
    // c) 自身验收是否全过
    const unfinished = node.acceptance.filter(
      (a) => a.status !== 'passing' && a.status !== 'waived',
    )
    if (unfinished.length > 0) {
      return violation(
        'I2',
        `节点 ${node.key ?? node.id} 的验收条件未全部通过：${unfinished
          .map((a) => `${a.id}(${a.status})`)
          .join(', ')}`,
        `逐条跑通验收：${unfinished
          .map((a) => `${a.id} → ${a.verify?.command ?? '（无命令，需人工确认）'}`)
          .join('；')}。若某条验收确实不再适用，请把它标为 waived 并说明理由，而不是直接标 completed。`,
        { nodeId: node.id, field: 'acceptance' },
      )
    }
  }
  return null
}

/**
 * I3 · approved 后的 acceptance 不可变。
 *
 * 需要 `prev` 才能做 diff。规则（设计稿 §5.4）：**不能让 agent 修改自己的成功标准**，
 * 否则它会通过弱化标准来"通过"测试。
 *
 * 允许的变更：**新增** AC、把 status 改为 waived。
 * 禁止的变更：修改已存在 AC 的 statement 或 verify 字段。
 */
export function checkI3(prev: TaskGraph | undefined, next: TaskGraph, change?: WriteChange): GraphWriteError | null {
  // 只有 approved（或已修订）之后的图才冻结验收条件
  const frozenAt = prev?.spec.state
  if (!prev || (frozenAt !== 'approved' && frozenAt !== 'amended')) return null

  const diffAc = (
    before: AcceptanceCriterion[],
    after: AcceptanceCriterion[],
    scope: string,
    nodeId?: string,
  ): GraphWriteError | null => {
    const afterMap = new Map(after.map((a) => [a.id, a]))
    for (const b of before) {
      const a = afterMap.get(b.id)
      if (!a) continue // 删除也不允许，但更容易发生的违规是改写；删除走 remove 流程
      if (a.statement !== b.statement) {
        return violation(
          'I3',
          `${scope} 的 ${b.id} 陈述被修改（Spec 已 approved）`,
          `已批准的验收条件不可改写，否则等于让 agent 弱化自己的成功标准。正确做法：保留 ${b.id} 原文，新增一条替代 AC（如 ${b.id}-rev2）并说明理由，或把 ${b.id} 标为 waived。`,
          { nodeId, field: `acceptance.${b.id}.statement`, value: a.statement },
        )
      }
      const bVerify = JSON.stringify(b.verify ?? null)
      const aVerify = JSON.stringify(a.verify ?? null)
      if (bVerify !== aVerify) {
        return violation(
          'I3',
          `${scope} 的 ${b.id} 验证方式被修改（Spec 已 approved）`,
          `已批准的 verify 不可改写（例如把 npm test -- auth:strict 改成 npm test -- auth 属于弱化标准）。请新增一条 AC 承载新的验证方式，或发起 Spec 修订流程（write reason + 人工批准）。`,
          { nodeId, field: `acceptance.${b.id}.verify`, value: a.verify },
        )
      }
    }
    return null
  }

  const specErr = diffAc(prev.spec.acceptance, next.spec.acceptance, 'spec')
  if (specErr) return specErr

  for (const [id, prevNode] of Object.entries(prev.nodes)) {
    const nextNode = next.nodes[id]
    if (!nextNode) continue
    const err = diffAc(prevNode.acceptance, nextNode.acceptance, `节点 ${prevNode.key ?? id}`, id)
    if (err) return err
  }
  return null
}

/**
 * I4 · 依赖图中无环。
 *
 * 实现：对 dependsOn 边做拓扑排序（Kahn）。顺带校验依赖目标存在
 * ——"指向不存在的节点"会让 UI 渲染出悬空边，同样是图损坏。
 */
export function checkI4(graph: TaskGraph): GraphWriteError | null {
  const ids = Object.keys(graph.nodes)
  // 1) 悬空依赖
  for (const id of ids) {
    for (const dep of graph.nodes[id].dependsOn) {
      if (!graph.nodes[dep]) {
        return violation(
          'I4',
          `节点 ${graph.nodes[id].key ?? id} 依赖了不存在的节点 ${dep}`,
          `请把该依赖改为一个真实存在的节点 id，或调用 task_update 删除这条无效依赖。`,
          { nodeId: id, field: 'dependsOn', value: dep },
        )
      }
    }
  }
  // 2) 成环检测（Kahn 剥离入度为 0 的点）
  const indeg = new Map<string, number>()
  for (const id of ids) indeg.set(id, 0)
  for (const id of ids) {
    for (const dep of graph.nodes[id].dependsOn) {
      if (dep !== id) indeg.set(id, (indeg.get(id) ?? 0) + 1)
    }
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  let visited = 0
  while (queue.length > 0) {
    const cur = queue.shift() as string
    visited += 1
    // 找出所有依赖 cur 的节点
    for (const id of ids) {
      if (graph.nodes[id].dependsOn.includes(cur)) {
        const d = (indeg.get(id) ?? 0) - 1
        indeg.set(id, d)
        if (d === 0) queue.push(id)
      }
    }
  }
  if (visited < ids.length) {
    const inCycle = ids.filter((id) => (indeg.get(id) ?? 0) > 0)
    return violation(
      'I4',
      `依赖图存在环，涉及节点：${inCycle.map((id) => graph.nodes[id].key ?? id).join(' → ')}`,
      `移除成环的那条边（用 replan 的 relink 操作重设 dependsOn），环上的节点无法被调度。`,
      { field: 'dependsOn', value: inCycle },
    )
  }
  return null
}

/**
 * I5 · 父节点 completed 要求所有非 cancelled 子节点 completed。
 *
 * 为什么：父节点代表"可独立交付/验收的阶段"。子任务没做完就交付父阶段，
 * 会让"验收集合"失真（父节点的 acceptance 通常覆盖子节点成果的集成）。
 */
export function checkI5(graph: TaskGraph): GraphWriteError | null {
  for (const node of Object.values(graph.nodes)) {
    if (node.status !== 'completed') continue
    const incomplete = node.children
      .map((c) => graph.nodes[c])
      .filter((c): c is TaskNode => !!c && c.status !== 'cancelled' && c.status !== 'completed')
    if (incomplete.length > 0) {
      return violation(
        'I5',
        `节点 ${node.key ?? node.id} 已 completed，但仍有 ${incomplete.length} 个子节点未完成：${incomplete
          .map((c) => `${c.key ?? c.id}(${c.status})`)
          .join(', ')}`,
        `先把子节点做到 completed，或把不再需要的子节点标为 cancelled（并写清理由），父节点才能完成。`,
        { nodeId: node.id, field: 'children', value: incomplete.map((c) => c.id) },
      )
    }
  }
  return null
}

/**
 * I6 · needs_human 必须携带 blockingQuestion。
 *
 * 理由（设计稿 §4.2）：needs_human 的价值全在于"人一眼知道要回答什么"。
 * 没有问题的 needs_human 在 UI 上就是一个红点，人不知道该做什么 —— 比 in_progress 更糟。
 */
export function checkI6(graph: TaskGraph): GraphWriteError | null {
  for (const node of Object.values(graph.nodes)) {
    if (node.status !== 'needs_human') continue
    const q = node.blockingQuestion?.trim()
    if (!q) {
      return violation(
        'I6',
        `节点 ${node.key ?? node.id} 为 needs_human，但没有 blockingQuestion`,
        `调用 task_block 时必须给出具体问题（blockingQuestion）。若你其实不需要人介入，请改回 ready 继续执行；若需要人在几个方案间选择，请同时给出 blockingOptions（每个选项附代价说明）。`,
        { nodeId: node.id, field: 'blockingQuestion' },
      )
    }
    if (!node.blockingSince) {
      return violation(
        'I6',
        `节点 ${node.key ?? node.id} 为 needs_human，但没有 blockingSince`,
        `blockingSince 用于让用户看到"这个东西等了我多久"。请由引擎写入阻塞开始时间戳（不需要模型提供）。`,
        { nodeId: node.id, field: 'blockingSince' },
      )
    }
  }
  return null
}

/**
 * I7 · 每个节点必须有 derivedFrom 或 intent（不允许"来路不明的任务"）。
 *
 * 严重程度：设计稿标注为"警告 + 记录"而非拒绝写入。故本函数**返回错误但由调用方
 * 决定是否降级为警告**（gate.ts 里对 I7 走 warn 分支）。
 */
export function checkI7(graph: TaskGraph): GraphWriteError | null {
  for (const node of Object.values(graph.nodes)) {
    const hasDerived = (node.derivedFrom?.length ?? 0) > 0
    const hasIntent = !!node.intent?.trim()
    if (!hasDerived && !hasIntent) {
      return violation(
        'I7',
        `节点 ${node.key ?? node.id}（${node.title}）既没有 derivedFrom 也没有 intent`,
        `补一个 intent（一句话说明"为什么要做这个"）或 derivedFrom（指回它服务的 AC id / 父节点）。没有来路的任务在后续收敛检查里会被当成僵尸任务。`,
        { nodeId: node.id, field: 'intent' },
      )
    }
  }
  return null
}

/* ============================================================
 * 组合校验入口
 * ============================================================ */

/** 需要"降级而非拒绝"的不变量（设计稿 §4.4 的违反后果列） */
export const DOWNGRADE_INVARIANTS: ReadonlySet<InvariantId> = new Set<InvariantId>(['I2'])
/** 只警告不阻断的不变量 */
export const WARN_ONLY_INVARIANTS: ReadonlySet<InvariantId> = new Set<InvariantId>(['I7'])

/**
 * 写入前校验：按 I1→I7 顺序跑，返回**第一个**违规；全部通过返回 null。
 *
 * @param next    变更后的图（调用方已应用变更，本函数不修改它）
 * @param change  变更描述（用于 I2 的"是否跳过 verifying"判定）
 * @param prev    变更前的图（仅 I3 需要；不传则跳过 I3）
 *
 * 调用方处置约定（见 graph/gate.ts）：
 *  - 返回 `I2` 且 change 是"→ completed" → **降级为 verifying**（不拒绝）
 *  - 返回 `I7` → 记为警告，继续写入
 *  - 其余 → 拒绝写入并回滚，把结构化错误交给模型
 */
export function validateWrite(
  next: TaskGraph,
  change?: WriteChange,
  prev?: TaskGraph,
): GraphWriteError | null {
  return (
    checkI1(next) ??
    checkI2(next, change) ??
    checkI3(prev, next, change) ??
    checkI4(next) ??
    checkI5(next) ??
    checkI6(next) ??
    checkI7(next)
  )
}

/**
 * 图级自检（不针对某次变更）—— 用于**加载时**校验已有 graph.json。
 *
 * 与 validateWrite 的区别：不做 I3（无 prev 可比）、不做"是否跳过 verifying"判定。
 * 返回全部违规（加载时要一次性把问题都告诉用户，而不是修一个报一个）。
 */
export function validateGraph(graph: TaskGraph): GraphWriteError[] {
  const errs: GraphWriteError[] = []
  for (const check of [checkI1, checkI2, checkI4, checkI5, checkI6, checkI7]) {
    const err = check(graph)
    if (err) errs.push(err)
  }
  return errs
}

/** 取"本次变更涉及的节点"（用于 I2 的定向检查，避免全图扫描） */
function pickTargets(graph: TaskGraph, change?: WriteChange): TaskNode[] {
  if (change?.nodeId) {
    const node = graph.nodes[change.nodeId]
    return node ? [node] : []
  }
  if (change?.nodeIds?.length) {
    return change.nodeIds.map((id) => graph.nodes[id]).filter((n): n is TaskNode => !!n)
  }
  // 无变更描述（如加载时自检）：全图
  return Object.values(graph.nodes)
}

/** 供日志与 UI 展示：把错误压成一行 */
export function formatGraphError(err: GraphWriteError): string {
  const inv = err.invariant ? `[${err.invariant}] ` : ''
  const where = err.violatedBy?.nodeId ? ` @${err.violatedBy.nodeId}` : ''
  return `${inv}${err.message}${where}`
}

/** 供 tool 返回值使用：把错误转成给模型看的文本（含 hint） */
export function renderGraphErrorForModel(err: GraphWriteError): string {
  const inv = err.invariant ? `${err.invariant}（${INVARIANT_LABEL[err.invariant]}）` : err.code
  return [
    `❌ 写入被拒绝 · ${inv}`,
    `原因：${err.message}`,
    `怎么修：${err.hint}`,
  ].join('\n')
}
