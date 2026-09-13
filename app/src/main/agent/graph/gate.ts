/**
 * ArkWork — Sync · S4 Gate（门控 + hook 执行点）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.1
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §2.2-S4
 *
 * 这是把**"提示词纪律"升级为"运行时契约"**的核心机制：状态写入之前先跑
 * 不变量校验，违反则拒绝写入并返回结构化错误。
 *
 * 三类处置（与 invariants.ts 的 DOWNGRADE/WARN_ONLY 常量对应）：
 *  | 情形 | 处置 | 理由 |
 *  |---|---|---|
 *  | I2 违反（缺证据就标 completed） | **降级为 verifying**，不拒绝 | 设计稿 §4.4 的"违反后果"列明确要求降级；拒绝会让模型卡死在"我不能完成" |
 *  | I7 违反（节点没有 intent/derivedFrom） | **警告 + 继续写入** | 设计稿标注为"警告 + 记录"；这是信息缺失，不是错误 |
 *  | 其余违反 | **拒绝写入 + 回滚** | 结构性错误（成环/多 in_progress/改已批准 AC）必须拦住 |
 *
 * Hook 机制（借鉴 Claude Code 的 TaskCreated / TaskCompleted hook）：
 *  - `onTaskCreate`  可拒绝（如"描述不足 20 字"）
 *  - `onTaskComplete` 可拒绝（如"测试未跑"、"需人工 review"）
 *  - `onStatusChange` 只观察（用于 UI 通知、外部同步）
 *
 * **本版与既有阶段产物门禁的关系**：两条校验链**并行**，都过才允许写。
 * `react-core-skills/stage-gates.ts`（文档驱动开发 10 阶段）与
 * `prompt/gates.ts`（契约门禁状态机）**行为完全不变**。
 */
import {
  DOWNGRADE_INVARIANTS,
  WARN_ONLY_INVARIANTS,
  renderGraphErrorForModel,
  transitionDenied,
  validateWrite,
  type WriteChange,
} from './invariants.js'
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  type GraphWriteError,
  type NodeStatus,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import { logger } from '../../system/logger.js'

/* ============================================================
 * 一、Hook 注册表
 * ============================================================ */

export type GateHookName = 'onTaskCreate' | 'onTaskComplete' | 'onStatusChange'

/** 创建/完成 hook：返回错误即拒绝 */
export type GateRejectHook = (
  node: TaskNode,
  graph: TaskGraph,
) => GraphWriteError | null | undefined

/** 状态变更 hook：只观察，返回值被忽略 */
export type GateObserveHook = (
  from: NodeStatus,
  to: NodeStatus,
  node: TaskNode,
  graph: TaskGraph,
) => void

const rejectHooks: Record<'onTaskCreate' | 'onTaskComplete', Set<GateRejectHook>> = {
  onTaskCreate: new Set(),
  onTaskComplete: new Set(),
}
const observeHooks = new Set<GateObserveHook>()

/**
 * 注册门禁 hook。
 *
 * @returns 反注册函数（调用方在 dispose 时调用，防止长生命周期进程里 hook 泄漏）
 */
export function registerGateHook(
  name: 'onTaskCreate' | 'onTaskComplete',
  fn: GateRejectHook,
): () => void
export function registerGateHook(name: 'onStatusChange', fn: GateObserveHook): () => void
export function registerGateHook(name: GateHookName, fn: GateRejectHook | GateObserveHook): () => void {
  if (name === 'onStatusChange') {
    const h = fn as GateObserveHook
    observeHooks.add(h)
    return () => observeHooks.delete(h)
  }
  const h = fn as GateRejectHook
  rejectHooks[name].add(h)
  return () => rejectHooks[name].delete(h)
}

/** 清空全部 hook（测试用；生产路径不应调用） */
export function clearGateHooks(): void {
  rejectHooks.onTaskCreate.clear()
  rejectHooks.onTaskComplete.clear()
  observeHooks.clear()
}

/* ============================================================
 * 二、门禁执行
 * ============================================================ */

export interface GateOutcome {
  /** 是否允许写入 */
  ok: boolean
  /** 拒绝原因（ok=false 时必有） */
  error?: GraphWriteError
  /**
   * I2 触发的降级动作。调用方（write.ts）必须执行它：
   * 把 `nodeId` 的状态从 completed 改成 verifying，然后重新跑门禁。
   */
  downgrade?: { nodeId: string; to: 'verifying'; reason: string }
  /** 只警告不阻断的问题（I7） */
  warnings: GraphWriteError[]
}

/**
 * 写入前门禁。
 *
 * @param next   变更后的图（调用方已应用变更）
 * @param change 变更描述
 * @param prev   变更前的图（I3 需要）
 */
export function runGate(next: TaskGraph, change: WriteChange, prev?: TaskGraph): GateOutcome {
  const warnings: GraphWriteError[] = []

  // 1) 状态转换合法性（比不变量更早拦：非法转换的错误信息更具体）
  if (change.kind === 'node-status' && change.nodeId && change.from && change.to) {
    if (!canTransition(change.from, change.to)) {
      return {
        ok: false,
        error: transitionDenied(change.nodeId, change.from, change.to, ALLOWED_TRANSITIONS[change.from]),
        warnings,
      }
    }
  }

  // 2) 图不变量
  const err = validateWrite(next, change, prev)
  if (err) {
    if (err.invariant && DOWNGRADE_INVARIANTS.has(err.invariant)) {
      // I2：降级而非拒绝
      const nodeId = err.violatedBy?.nodeId ?? change.nodeId
      if (nodeId) {
        logger.info(
          'Agent',
          `sync: gate 触发 I2 降级 → ${nodeId} completed 改为 verifying（缺充分证据或验收未全通过）`,
        )
        return {
          ok: true,
          downgrade: { nodeId, to: 'verifying', reason: err.message },
          warnings,
        }
      }
    }
    if (err.invariant && WARN_ONLY_INVARIANTS.has(err.invariant)) {
      warnings.push(err)
      logger.warn('Agent', `sync: gate 警告（不阻断）${renderGraphErrorForModel(err).replace(/\n/g, ' ')}`)
    } else {
      return { ok: false, error: err, warnings }
    }
  }

  // 3) 用户注册的 hook（创建 / 完成）
  if (change.kind === 'node-create' && change.nodeId) {
    const node = next.nodes[change.nodeId]
    if (node) {
      for (const hook of rejectHooks.onTaskCreate) {
        const hErr = hook(node, next)
        if (hErr) return { ok: false, error: hErr, warnings }
      }
    }
  }
  if (
    change.kind === 'node-status' &&
    change.to === 'completed' &&
    change.nodeId
  ) {
    const node = next.nodes[change.nodeId]
    if (node) {
      for (const hook of rejectHooks.onTaskComplete) {
        const hErr = hook(node, next)
        if (hErr) return { ok: false, error: hErr, warnings }
      }
    }
  }

  return { ok: true, warnings }
}

/** 通知观察型 hook（状态真正提交之后调用） */
export function notifyStatusChange(
  from: NodeStatus,
  to: NodeStatus,
  node: TaskNode,
  graph: TaskGraph,
): void {
  for (const hook of observeHooks) {
    try {
      hook(from, to, node, graph)
    } catch (err) {
      // 观察型 hook 抛错不得影响主流程
      logger.warn('Agent', `gate: onStatusChange hook 抛错（已忽略）：${(err as Error).message}`)
    }
  }
}

/* ============================================================
 * 三、便利封装：直接做一次"带门禁的状态变更"
 * ============================================================ */

/**
 * 应用一次带门禁的状态变更（含 I2 降级重试）。
 *
 * 这是 write.ts / replan.ts / IPC 层共用的唯一状态写入原语 —— 所有状态变更
 * 都必须经过它，否则就绕过了不变量校验。
 *
 * @returns `graph` 为写入后的图；`error` 非空时 `graph` 是**变更前的原图**（即已回滚）
 */
export function applyStatusChange(
  graph: TaskGraph,
  nodeId: string,
  to: NodeStatus,
  source: string,
  prev?: TaskGraph,
): {
  graph: TaskGraph
  error?: GraphWriteError
  warnings: GraphWriteError[]
  /** 是否发生了 I2 降级（目标从 completed 被降为 verifying） */
  downgraded?: boolean
} {
  const node = graph.nodes[nodeId]
  if (!node) {
    return {
      graph,
      error: {
        code: 'NOT_FOUND',
        message: `节点不存在：${nodeId}`,
        hint: '图可能已被其他操作修改。请调用 task_list 重新读取当前任务图。',
      },
      warnings: [],
    }
  }
  const from = node.status
  if (from === to) return { graph, warnings: [] }

  const stamp = Date.now()
  /** 造一个"把 nodeId 置为 status"的候选图（不改入参） */
  const withNode = (status: NodeStatus, base: TaskGraph): TaskGraph => ({
    ...base,
    nodes: {
      ...base.nodes,
      [nodeId]: { ...(base.nodes[nodeId] ?? node), status, updatedAt: stamp, revision: node.revision + 1 },
    },
    updatedAt: stamp,
  })

  const change: WriteChange = { kind: 'node-status', nodeId, from, to, source }
  const candidate = withNode(to, graph)
  const outcome = runGate(candidate, change, prev ?? graph)

  // I2 降级：把目标状态改成 verifying（不拒绝写入）
  if (outcome.downgrade) {
    const downgradedGraph = withNode('verifying', graph)
    const recheck = runGate(
      downgradedGraph,
      { kind: 'node-status', nodeId, from, to: 'verifying', source },
      prev ?? graph,
    )
    if (!recheck.ok) return { graph, error: recheck.error, warnings: recheck.warnings }
    notifyStatusChange(from, 'verifying', downgradedGraph.nodes[nodeId], downgradedGraph)
    logger.info('Agent', `sync: ${node.key ?? nodeId} 完成被降级为 verifying（${outcome.downgrade.reason}）`)
    return { graph: downgradedGraph, warnings: recheck.warnings, downgraded: true }
  }

  if (!outcome.ok) return { graph, error: outcome.error, warnings: outcome.warnings }

  notifyStatusChange(from, to, candidate.nodes[nodeId], candidate)
  return { graph: candidate, warnings: outcome.warnings }
}
