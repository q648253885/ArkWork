/**
 * ArkWork — Sync · S3 Write（状态写回）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.1 / §6.2
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §2.2-S3
 *
 * **本文件是 v0.30.0 与 v0.29 语义差异最大的地方。** 请先读这段。
 *
 * v0.29 的写回（`engine/gates.ts` 的 `decidePlanAdvance`）：
 *   `isProductiveTool(tool)` 且调用成功 → 当前项标 done 并推进下一项。
 *   判定依据是**"工具调用成功"**。
 *
 * v0.30.0 的写回（本文件）：
 *   判定依据是**"验收通过"**。具体：
 *   - 普通工具成功 → **不推进**（只更新 tokensUsed / 解除 blocked / 补齐 in_progress）
 *   - 验证命令成功（匹配 `verification.command` 或 `acceptance[].verify.command`，
 *     且退出码符合 `expectExitCode`）→ 更新对应 AC 为 passing、追加证据，
 *     然后才允许进入 completed（若 required 则先进 verifying）
 *   - 模型显式 `task_update` → 走同一套门禁
 *   - 模型宣称完成（`task_complete`）→ 走 `applyModelClaim`，同样先过验收
 *
 * 为什么这么改：v0.29 的判定让"改了文件"就等于"做完了"（F3 自评失明的变体）。
 * 设计稿 §02 的核心判词是 —— **"完成"必须由验证结果判定，不是模型说了算**。
 *
 * 混合写回策略（设计稿 §2.2-S3）：模型可以"提议"状态变更，harness 决定是否采纳。
 */
import {
  EVIDENCE_TRUST,
  SUFFICIENT_EVIDENCE_TRUST,
  type AcceptanceCriterion,
  type AcceptanceStatus,
  type Evidence,
  type EvidenceKind,
  type GraphWriteError,
  type NodeChange,
  type NodeStatus,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import { applyStatusChange } from './gate.js'
import { logger } from '../../system/logger.js'

/* ============================================================
 * 一、输入
 * ============================================================ */

/** 一次 Act 的观察结果（由 engine/act.ts 在 act 收尾时组装） */
export interface ActSyncInput {
  toolName: string
  ok: boolean
  args: Record<string, unknown>
  errorMessage?: string
  /** 本次 act 产出的文件路径（file-writer / file-editor） */
  files?: string[]
  /** 命令退出码（shell） */
  exitCode?: number
  /** 命令原文（shell） */
  command?: string
  /** 本次 act 的 token 近似消耗 */
  tokens?: number
}

/** 模型宣称完成 */
export interface ModelClaimInput {
  /** 模型显式指定的节点（缺省：当前 in_progress） */
  nodeId?: string
  /** task_complete 的 summary（作为低可信度的补充证据说明） */
  summary: string
  tokens?: number
}

/** 写回结果 */
export interface WriteOutcome {
  graph: TaskGraph
  changes: NodeChange[]
  /** 门禁拒绝（调用方应把结构化错误交给模型） */
  gateError?: GraphWriteError
  /** 只警告不阻断的问题（I7） */
  warnings: GraphWriteError[]
  /**
   * 需要引擎执行的验证命令（verification.required 且刚进入 verifying）。
   * 调用方（act.ts / turn-end.ts）负责真正执行它 —— 本模块不碰 shell。
   */
  verifyTrigger?: { nodeId: string; command: string }
  /** 是否发生了 I2 降级（用于"幻影完成率"埋点） */
  downgraded?: boolean
}

/* ============================================================
 * 二、Act 后的 harness 写回
 * ============================================================ */

/**
 * Act 收尾时的 harness 写回。
 *
 * 决策顺序（从高到低）：
 *  1. **验证命令命中** → 更新 AC + 证据，按结果推进状态（唯一的"自动完成"路径）
 *  2. 解除 blocked（依赖已完成的节点回 ready）
 *  3. 无 in_progress 且有 ready → 自动提升（等价 v0.19 的"清单卡死"修复）
 *  4. 更新 tokensUsed
 *
 * **明确不做**：不因为"文件被改了"就把节点标 completed（这是 v0.29 的行为，本版刻意去掉）。
 */
export function syncAfterAct(graph: TaskGraph, input: ActSyncInput): WriteOutcome {
  let work = graph
  const changes: NodeChange[] = []
  let warnings: GraphWriteError[] = []
  let downgraded = false

  // ---- 4. tokens 累计（先做：不影响状态机） ----
  if (input.tokens && input.tokens > 0) {
    const focus = pickFocus(work)
    if (focus) {
      work = patchNode(work, focus.id, (n) => ({ ...n, tokensUsed: (n.tokensUsed || 0) + input.tokens! }))
    }
  }

  // ---- 1. 验证命令命中 ----
  const verifyHit = matchVerification(work, input)
  if (verifyHit) {
    const { nodeId, acceptanceIds } = verifyHit
    const node = work.nodes[nodeId]
    const expect =
      node.verification.command === normalize(input.command ?? '')
        ? undefined
        : node.acceptance.find((a) => normalize(a.verify?.command ?? '') === normalize(input.command ?? ''))
            ?.verify?.expectExitCode
    const expectCode = expect ?? 0
    const passed = input.ok && (input.exitCode ?? 0) === expectCode

    // 写 acceptance 状态
    work = patchNode(work, nodeId, (n) => ({
      ...n,
      acceptance: n.acceptance.map((a) =>
        acceptanceIds.includes(a.id)
          ? {
              ...a,
              status: (passed ? 'passing' : 'failing') as AcceptanceStatus,
              lastResult: {
                at: Date.now(),
                exitCode: input.exitCode ?? -1,
                excerpt: (input.errorMessage ?? input.command ?? '').slice(0, 2000),
              },
              coveredBy: a.coveredBy.includes(nodeId) ? a.coveredBy : [...a.coveredBy, nodeId],
            }
          : a,
      ),
      evidence: [
        ...n.evidence,
        {
          kind: (passed ? 'test' : 'command') as EvidenceKind,
          summary: `${input.command ?? input.toolName} → ${passed ? '通过' : `失败（exit ${input.exitCode ?? '?'}）`}`,
          exitCode: input.exitCode,
          at: Date.now(),
          by: { kind: 'system' },
        },
      ],
      attempts: passed ? n.attempts : n.attempts + 1,
      lastError: passed ? undefined : (input.errorMessage ?? `退出码 ${input.exitCode}`),
    }))
    changes.push({
      nodeId,
      source: 'verify',
      reason: passed ? `验证通过：${input.command}` : `验证失败：${input.command}`,
    })

    const updated = work.nodes[nodeId]
    if (passed) {
      // 验收是否全过 → 决定能否 completed
      const unfinished = updated.acceptance.filter(
        (a) => a.status !== 'passing' && a.status !== 'waived',
      )
      if (unfinished.length === 0) {
        const needsVerifying = updated.verification.required && !updated.verification.allowSelfAttest
        const target: NodeStatus = needsVerifying ? 'completed' : 'completed'
        const res = applyStatusChange(work, nodeId, target, 'sync-write', work)
        if (res.error) {
          // 不把错误抛给模型（这是引擎内部推进），只记日志并保持现状
          logger.warn('Agent', `sync: 验证通过后推进 ${nodeId} 失败：${res.error.message}`)
        } else {
          work = res.graph
          downgraded = !!res.downgraded
          changes.push({ nodeId, from: updated.status, to: work.nodes[nodeId].status, source: 'sync-write', reason: '验收全部通过' })
        }
      }
    } else if (updated.attempts >= updated.verification.maxAttempts) {
      const res = applyStatusChange(work, nodeId, 'failed', 'sync-write', work)
      if (!res.error) {
        work = res.graph
        changes.push({
          nodeId,
          from: updated.status,
          to: 'failed',
          source: 'sync-write',
          reason: `验证连续失败 ${updated.attempts}/${updated.verification.maxAttempts} 次`,
        })
      }
    } else {
      // 未超上限 → 回 in_progress 自动重试
      const res = applyStatusChange(work, nodeId, 'in_progress', 'sync-write', work)
      if (!res.error) {
        work = res.graph
        changes.push({ nodeId, from: 'verifying', to: 'in_progress', source: 'sync-write', reason: '验证失败，自动重试' })
      }
    }
  }

  // ---- 2. 解除 blocked ----
  for (const node of Object.values(work.nodes)) {
    if (node.status !== 'blocked') continue
    const unmet = node.dependsOn.filter((d) => {
      const dep = work.nodes[d]
      return dep && dep.status !== 'completed' && dep.status !== 'cancelled'
    })
    if (unmet.length === 0) {
      const res = applyStatusChange(work, node.id, 'ready', 'sync-write', work)
      if (!res.error) {
        work = res.graph
        changes.push({ nodeId: node.id, from: 'blocked', to: 'ready', source: 'sync-write', reason: '依赖已全部完成' })
      }
    }
  }

  // ---- 3. 无 in_progress → 提升首个 ready ----
  const hasRunning = Object.values(work.nodes).some((n) => n.status === 'in_progress')
  if (!hasRunning && (work.policy.maxParallel ?? 1) >= 1) {
    const next = orderByTree(work).find(
      (n) =>
        n.status === 'ready' &&
        n.layer !== 'goal' &&
        n.dependsOn.every((d) => {
          const dep = work.nodes[d]
          return !dep || dep.status === 'completed' || dep.status === 'cancelled'
        }),
    )
    if (next) {
      const res = applyStatusChange(work, next.id, 'in_progress', 'sync-write', work)
      if (!res.error) {
        work = res.graph
        changes.push({
          nodeId: next.id,
          from: 'ready',
          to: 'in_progress',
          source: 'sync-write',
          reason: '无进行中节点，引擎自动推进首个就绪项',
        })
      }
    }
  }

  return { graph: work, changes, warnings, downgraded }
}

/* ============================================================
 * 三、模型宣称完成
 * ============================================================ */

/**
 * 处理模型的完成宣称（`task_complete`）。
 *
 * **明确不再直接置 completed**（这是本版对既有可见行为的一处变更，须在交付说明明示）：
 *  - `verification.required === true` → **先置 verifying**，返回 `verifyTrigger`
 *    让引擎去跑验证命令；只有验证通过才 completed
 *  - `verification.required === false` → 直通 completed，但**必须补一条证据**
 *    （I2 不允许零证据完成，即使是"人工确认"也要留痕）
 *  - `allowSelfAttest === true`（仅用户显式开启）→ 允许直接 completed，
 *    证据标记为 agent 自证，UI 上会显示"自证"徽标
 *
 * @returns `verifyTrigger` 非空表示"需要引擎去执行验证命令，别急着结束任务"
 */
export function applyModelClaim(graph: TaskGraph, input: ModelClaimInput): WriteOutcome {
  let work = graph
  const changes: NodeChange[] = []
  const warnings: GraphWriteError[] = []

  const node = input.nodeId ? work.nodes[input.nodeId] : pickFocus(work)
  if (!node) {
    return { graph, changes: [], warnings }
  }

  if (input.tokens && input.tokens > 0) {
    work = patchNode(work, node.id, (n) => ({ ...n, tokensUsed: (n.tokensUsed || 0) + input.tokens! }))
  }

  const needVerify =
    node.verification.required &&
    !node.verification.allowSelfAttest &&
    !hasSufficientEvidence(node)

  if (needVerify) {
    // 先进 verifying，由引擎执行验证命令
    const command =
      node.verification.command ?? node.acceptance.find((a) => a.verify?.command)?.verify?.command
    const res = applyStatusChange(work, node.id, 'verifying', 'model-claim', work)
    if (res.error) return { graph, changes, warnings, gateError: res.error }
    work = res.graph
    changes.push({
      nodeId: node.id,
      from: node.status,
      to: 'verifying',
      source: 'model-claim',
      reason: '模型宣称完成 → 进入验证（不接受自证）',
    })
    logger.info(
      'Agent',
      `sync: ${node.key ?? node.id} 模型宣称完成 → verifying（等待验证命令${command ? `：${command}` : '（未声明命令，需人工确认）'}）`,
    )
    return { graph: work, changes, warnings, verifyTrigger: command ? { nodeId: node.id, command } : undefined }
  }

  // 不需要外部验证：补一条证据后置 completed
  const evidence: Evidence = {
    kind: node.verification.allowSelfAttest ? 'diff' : 'human',
    summary: input.summary.slice(0, 200) || '模型宣称完成（无外部验证要求）',
    at: Date.now(),
    by: { kind: 'agent', id: 'agent' },
  }
  work = patchNode(work, node.id, (n) => ({ ...n, evidence: [...n.evidence, evidence] }))

  const res = applyStatusChange(work, node.id, 'completed', 'model-claim', work)
  if (res.error) return { graph, changes, warnings, gateError: res.error }
  work = res.graph
  changes.push({
    nodeId: node.id,
    from: node.status,
    to: work.nodes[node.id].status,
    source: 'model-claim',
    reason: res.downgraded ? '模型宣称完成 → 证据不足，降级为 verifying' : '模型宣称完成（无外部验证要求）',
  })
  return { graph: work, changes, warnings, downgraded: res.downgraded }
}

/* ============================================================
 * 四、基础写入原语（tools.ts / IPC / replan 共用）
 * ============================================================ */

/** 已有充分证据（trust ≥ 门槛） */
export function hasSufficientEvidence(node: TaskNode): boolean {
  return node.evidence.some((e) => EVIDENCE_TRUST[e.kind] >= SUFFICIENT_EVIDENCE_TRUST)
}

/** 追加证据（不跑状态机 —— 状态由调用方决定） */
export function addEvidence(graph: TaskGraph, nodeId: string, evidence: Evidence): TaskGraph {
  return patchNode(graph, nodeId, (n) => ({ ...n, evidence: [...n.evidence, evidence] }))
}

/** 只读地取节点 */
export function getNode(graph: TaskGraph, nodeId: string): TaskNode | undefined {
  return graph.nodes[nodeId]
}

/** 更新节点的非状态字段（白名单由调用方保证） */
export function updateNodeFields(
  graph: TaskGraph,
  nodeId: string,
  patch: Partial<TaskNode>,
): TaskGraph {
  return patchNode(graph, nodeId, (n) => {
    const next: TaskNode = { ...n, ...patch, updatedAt: Date.now(), revision: n.revision + 1 }
    // 防御：不允许通过这个原语改 id / children / revision 语义字段
    next.id = n.id
    next.children = patch.children ?? n.children
    return next
  })
}

/** 内部：不可变地替换一个节点 */
export function patchNode(
  graph: TaskGraph,
  nodeId: string,
  fn: (node: TaskNode) => TaskNode,
): TaskGraph {
  const node = graph.nodes[nodeId]
  if (!node) return graph
  return {
    ...graph,
    nodes: { ...graph.nodes, [nodeId]: { ...fn(node), updatedAt: Date.now() } },
    updatedAt: Date.now(),
  }
}

/* ============================================================
 * 五、内部工具
 * ============================================================ */

/** 命令归一化（比对时忽略空白差异） */
function normalize(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ')
}

/**
 * 匹配"本轮命令是否是某个节点的验证命令"。
 *
 * 匹配范围：`verification.command` 或任一 `acceptance[].verify.command`。
 * 只在 `in_progress` / `verifying` 节点上匹配（已完成的节点不需要再验）。
 *
 * ★ **必须同时识别"验证失败"**（该缺陷由 TC-SYNC-015 捕获）：
 *   只看成功路径会让 `attempts` 永远不增长 → `maxAttempts` 形同虚设 →
 *   失败重试与 E1 事件都不会触发，节点会永久停在 verifying。
 *
 * ★ 区分两种情况（避免把瞬时执行错误也算作一次验证失败）：
 *   · `exitCode` 有值 → 命令**确实跑起来了**并返回非零 → 计一次验证失败
 *   · `exitCode` 缺失（工具层 ok=false）→ 命令**没能执行**（如路径错、权限被拒）
 *     → 不计入 attempts（与 v0.19.x 的"瞬时失败保持 running 待重试"同一取向）
 */
function matchVerification(
  graph: TaskGraph,
  input: ActSyncInput,
): { nodeId: string; acceptanceIds: string[] } | null {
  if (!input.command) return null
  // 瞬时执行错误（没能跑起来）不算验证失败
  if (!input.ok && input.exitCode === undefined) return null
  const cmd = normalize(input.command)
  for (const node of Object.values(graph.nodes)) {
    if (node.status !== 'in_progress' && node.status !== 'verifying') continue
    const hits: string[] = []
    if (node.verification.command && normalize(node.verification.command) === cmd) {
      hits.push(...node.acceptance.map((a) => a.id))
    }
    for (const ac of node.acceptance) {
      if (ac.verify?.command && normalize(ac.verify.command) === cmd && !hits.includes(ac.id)) {
        hits.push(ac.id)
      }
    }
    if (hits.length > 0) return { nodeId: node.id, acceptanceIds: hits }
  }
  return null
}

/** 找出"当前任务"：needs_human → verifying → in_progress */
function pickFocus(graph: TaskGraph): TaskNode | undefined {
  const nodes = Object.values(graph.nodes)
  return (
    nodes.find((n) => n.status === 'needs_human') ??
    nodes.find((n) => n.status === 'verifying') ??
    nodes.find((n) => n.status === 'in_progress')
  )
}

/** 按图的自然顺序返回节点 */
function orderByTree(graph: TaskGraph): TaskNode[] {
  const out: TaskNode[] = []
  const visit = (id: string): void => {
    const n = graph.nodes[id]
    if (!n) return
    out.push(n)
    for (const c of n.children) visit(c)
  }
  for (const id of graph.rootIds) visit(id)
  return out
}

/** 供 tools.ts 复用：把 AC 列表渲染成给模型看的文本 */
export function renderAcceptance(acceptance: AcceptanceCriterion[]): string {
  if (acceptance.length === 0) return '（无验收条件）'
  return acceptance
    .map(
      (a) =>
        `- ${a.id} [${a.status}] ${a.statement}` +
        (a.verify?.command ? `\n    验证：\`${a.verify.command}\`` : '') +
        (a.verify?.expectExitCode !== undefined ? `（期望退出码 ${a.verify.expectExitCode}）` : ''),
    )
    .join('\n')
}
