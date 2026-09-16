/**
 * ArkWork — Sync 五子阶段编排（TAR Loop 的第四阶段）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.1 / §6.2
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §二（TAR Loop）
 *
 * 这是 v0.30.0 的**核心接线文件** —— engine 只调用它，不直接调用五个子阶段。
 *
 * Sync 的五个子阶段（由 Harness 驱动，非模型自觉）：
 *  S1 Project 投影   → 把任务活跃窗口注入下一轮上下文（project.ts）
 *  S2 Drift   漂移   → 比对 Action 与任务意图（drift.ts）
 *  S3 Write   写回   → 更新 TaskGraph，**判定依据是验收通过而非工具成功**（write.ts）
 *  S4 Gate    门控   → 写前跑 I1–I7 + hook（gate.ts）
 *  S5 Event   事件   → 是否触发 Replan / 干预 / 收敛（events.ts）
 *
 * **为什么 Sync 必须由 Harness 驱动**（Manus 的教训）：早期 todo.md 范式
 * 约 1/3 的动作花在更新待办上。所以清单维护必须：低频（语义边界而非每步）、
 * 自动（能推断的就不要让模型调工具）、混合（模型显式 + harness 隐式，取并集）。
 *
 * 三个必须遵守的工程约束：
 *  1. **一个 graph 在一个进程内只有一个内存实例**（`graphCache`）。所有变更走
 *     不可变替换 + `persist()` 落盘，避免"内存里三份不同的图"。
 *  2. **每个副作用（落盘 / 广播 / 写审计）都只在 `persist()` 里发生一次**，
 *     子阶段本身保持纯粹（便于在 Replan 事务里做"预演"）。
 *  3. **降级不阻断**：任何 Sync 内部的异常都不允许让任务失败 —— 记录日志、
 *     返回上一次有效的图，让主循环继续（Sync 是增强，不是关键路径）。
 */
import type {
  EventDecision,
  GraphNotice,
  GraphWriteError,
  NodeChange,
  NodeStatus,
  ReplanPatch,
  TaskGraph,
} from '@shared/types/graph'
import type { ActSyncInput } from './write.js'
import { applyModelClaim, syncAfterAct } from './write.js'
import { buildThreeSegInjection, formatWaiting, type ThreeSegInjection } from './project.js'
import { computeDrift, renderDriftHardBlock, renderDriftHint, type DriftInput, type DriftResult } from './drift.js'
import { evaluateEvents, getLastConvergeCompleted, markConverged, type EventInput } from './events.js'
import { hasConvergeFindings, renderConvergeNoticeText, runConverge, type ConvergeInput } from './converge.js'
import { loadGraph, saveGraph } from './store.js'
import { broadcastReActEvent } from '../events.js'
import { appendL1 } from '../../memory/l1-working.js'
import { logger } from '../../system/logger.js'
import { recordMetric } from './metrics.js'

/* ============================================================
 * 一、上下文与内存缓存
 * ============================================================ */

export interface SyncCtx {
  taskId: string
  /** 无 graphId 表示该任务走轻量模式（tier 0/1），Sync 直接短路 */
  graphId?: string
  iteration: number
  /** 会话 id（写进 node.sessionIds） */
  sessionId?: string
}

/** 进程内图缓存：一个 graphId 一份实例 */
const graphCache = new Map<string, TaskGraph>()

/** 漂移连续低分计数：key = `${graphId}:${nodeId ?? '*'} ` */
const driftStreaks = new Map<string, number>()
// v0.30.2 D13：hard 只提请一次 —— 同 focus 的 hard 已注入过 observation 后，
// 后续轮次 streak 继续累计但不再重复注入 driftHardText / 广播 graph_drift
// （防"连续 16 轮刷屏"，用户实测 D13）；streak 归零（score 回升 ≥0.4）时清除，
// focus 切换天然因 key 变化而重置。
const hardAlerted = new Set<string>()

/** 取图（命中缓存优先）。加载失败返回 null（调用方短路，不阻断任务） */
export async function getGraph(ctx: SyncCtx): Promise<TaskGraph | null> {
  if (!ctx.graphId) return null
  const cached = graphCache.get(ctx.graphId)
  if (cached) return cached
  const graph = await loadGraph(ctx.graphId)
  if (graph) graphCache.set(ctx.graphId, graph)
  return graph
}

/** 直接读取（供 IPC 层使用，允许指定 graphId） */
export async function getGraphById(graphId: string): Promise<TaskGraph | null> {
  const cached = graphCache.get(graphId)
  if (cached) return cached
  const graph = await loadGraph(graphId)
  if (graph) graphCache.set(graphId, graph)
  return graph
}

/** 把图写回缓存（外部修改后同步） */
export function putGraphCache(graph: TaskGraph): void {
  graphCache.set(graph.id, graph)
}

/** 清理某个图的内存状态（任务结束/删除时调用，防泄漏） */
export function dropGraphCache(graphId: string): void {
  graphCache.delete(graphId)
  for (const key of [...driftStreaks.keys()]) {
    if (key.startsWith(`${graphId}:`)) driftStreaks.delete(key)
  }
  for (const key of [...hardAlerted]) {
    if (key.startsWith(`${graphId}:`)) hardAlerted.delete(key)
  }
}

/* ============================================================
 * 二、持久化 + 广播（唯一的副作用出口）
 * ============================================================ */

export interface PersistOptions {
  changes?: NodeChange[]
  reason?: string
  source?: string
  /** 是否广播增量（批量初始化时可关掉） */
  broadcast?: boolean
  /** 图内已含 Revision 时不再追加（replan 自己写了） */
  skipRevision?: boolean
}

/**
 * 落盘 + 广播。**所有子阶段之后统一调用一次**。
 *
 * 副作用（严格按序）：
 *  1. `saveGraph`：快照 → 形状校验 → 原子写 → 追加 Revision → 重算 graph.md → 重算 planItems 镜像 → 索引
 *  2. 更新内存缓存
 *  3. 广播 `graph_patch`（增量）+ 每个状态变更的 `graph_status`
 */
export async function persist(
  ctx: SyncCtx,
  graph: TaskGraph,
  opts: PersistOptions = {},
): Promise<TaskGraph> {
  const revision = opts.skipRevision
    ? undefined
    : {
        by: { kind: 'system' as const },
        op: (opts.source === 'replan' ? 'replan' : 'status') as 'replan' | 'status',
        targetId: opts.changes?.[0]?.nodeId ?? graph.id,
        after: opts.changes?.length ? { count: opts.changes.length } : undefined,
        reason: opts.reason,
      }
  let saved: TaskGraph
  try {
    saved = await saveGraph(graph, { revision, taskId: ctx.taskId })
  } catch (err) {
    // ★ 落盘失败不允许让任务失败：内存里保持新状态，日志告警
    logger.warn('Agent', `sync: 图落盘失败（内存状态保留）${(err as Error).message}`, ctx.taskId)
    saved = graph
  }
  graphCache.set(saved.id, saved)

  if (opts.broadcast !== false && opts.changes?.length) {
    broadcastReActEvent({
      type: 'graph_patch',
      taskId: ctx.taskId,
      graphId: saved.id,
      changes: opts.changes,
      graphRevision: saved.graphRevision,
    })
    for (const ch of opts.changes) {
      if (ch.from && ch.to) {
        broadcastReActEvent({
          type: 'graph_status',
          taskId: ctx.taskId,
          graphId: saved.id,
          nodeId: ch.nodeId,
          from: ch.from,
          to: ch.to,
          source: ch.source,
          reason: ch.reason,
        })
      }
    }
  }
  return saved
}

/* ============================================================
 * 三、S1 Project（投影）
 * ============================================================ */

export interface ProjectOutcome {
  injection?: ThreeSegInjection
  /** 需要放进 system 段的锚点文本（GOAL + SCOPE-OUT） */
  anchorText?: string
  /** 需要附在 observation 尾部的一行刷新 */
  afterToolText?: string
  /** E6：本次投影是否因上下文压缩而强制刷新 */
  forced?: boolean
}

/**
 * 执行 S1 投影。
 *
 * 副作用：把活跃窗口写进 L1（`kind='plan_status'`）。
 *
 * **为什么沿用 `kind='plan_status'`**：`engine/messages.ts:204` 已有把该 kind
 * 渲染为独立 user 消息的成熟管道（含归档/压缩策略）。复用它可以做到
 * "新投影 + 零改动既有消费方"，是侵入面最小的接法。
 */
export async function syncProject(
  ctx: SyncCtx,
  opts?: { afterCompaction?: boolean },
): Promise<ProjectOutcome> {
  const graph = await getGraph(ctx)
  if (!graph) return {}

  try {
    const injection = buildThreeSegInjection(graph)
    // 写 L1：每轮投影都是"最新状态"，历史投影会在压缩时被归档（既有机制）
    await appendL1({
      taskId: ctx.taskId,
      role: 'user',
      kind: 'plan_status',
      iteration: ctx.iteration,
      content: injection.windowText,
      meta: JSON.stringify({
        trigger: opts?.afterCompaction ? '压缩后强制重投影' : '迭代开始',
        graphId: graph.id,
        graphRevision: graph.graphRevision,
        tokens: injection.totalTokens,
        trimmed: injection.trimmed,
        forced: !!opts?.afterCompaction,
      }),
    })
    recordMetric('sync_projection', {
      graphId: graph.id,
      tokens: injection.totalTokens,
      trimmed: injection.trimmed.length,
      overBudget: injection.overBudget,
    })
    logger.info(
      'Agent',
      `sync: S1 projected ${injection.totalTokens} tok（trimmed: ${injection.trimmed.join(',') || '无'}）`,
      ctx.taskId,
    )
    return {
      injection,
      anchorText: injection.anchorText,
      afterToolText: injection.afterToolText,
      forced: !!opts?.afterCompaction,
    }
  } catch (err) {
    logger.warn('Agent', `sync: S1 投影失败（跳过本轮投影）${(err as Error).message}`, ctx.taskId)
    return {}
  }
}

/* ============================================================
 * 四、act 后：S2 → S3 → S4 → S5
 * ============================================================ */

export interface SyncOutcome {
  graph: TaskGraph | null
  changes: NodeChange[]
  notices: GraphNotice[]
  gateError?: GraphWriteError
  /** 引擎需要执行的验证命令 */
  verifyTrigger?: { nodeId: string; command: string }
  events: EventDecision[]
  primaryEvent?: EventDecision
  /** 是否发生 I2 降级（→ 幻影完成率埋点） */
  downgraded?: boolean
  drift?: DriftResult
  /** 漂移软提示（注入下一轮上下文） */
  driftHint?: string
  /** 漂移硬干预文本（应弹 ask_user / 触发 E2） */
  driftHardText?: string
  /** 需要引擎持久化以供 UI 展示的 Replan 补丁（level ≥2 时等用户批准） */
  pendingPatch?: ReplanPatch
}

export interface PostActInput extends ActSyncInput {
  /** 动作的自然语言描述（漂移第三信号用） */
  descriptions?: string[]
  /** 是否刚发生过上下文压缩（E6） */
  afterCompaction?: boolean
  /** 用户是否插入了新需求（E5） */
  userInserted?: boolean
  /** v0.30.2 D13-E：技能加载等准备动作（工具名 = skillToolName 动态名）—— 不参与漂移判定 */
  metaTool?: boolean
}

/**
 * act 收尾时的完整 Sync（S2 → S3 → S4 → S5）。
 *
 * 顺序不可调换：
 *  - S2 必须在 S3 之前（漂移要在状态被改写前比对"本轮动作 vs 原意图"）
 *  - S4 由 S3 内部逐次调用（每次状态写入都过门禁）
 *  - S5 在最后（它要读"写回之后"的图来判断完成率/预算压力）
 */
export async function syncPostAct(ctx: SyncCtx, input: PostActInput): Promise<SyncOutcome> {
  const base = await getGraph(ctx)
  if (!base) {
    return { graph: null, changes: [], notices: [], events: [] }
  }

  let graph = base
  const notices: GraphNotice[] = []
  let gateError: GraphWriteError | undefined
  let verifyTrigger: { nodeId: string; command: string } | undefined
  let downgraded = false

  // ---- S2 Drift ----
  let drift: DriftResult | undefined
  let driftHint: string | undefined
  let driftHardText: string | undefined
  try {
    const driftInput: DriftInput = {
      toolNames: [input.toolName],
      files: input.files ?? [],
      symbols: [],
      descriptions: input.descriptions ?? [input.command ?? input.toolName],
    }
    const focusId = pickFocusId(graph)
    const key = `${graph.id}:${focusId ?? '*'}`
    const prev = driftStreaks.get(key) ?? 0
    if (input.metaTool === true) {
      // v0.30.2 D13-E：技能加载是准备动作，与节点意图零词法关联是预期行为，
      // 不构成漂移证据 —— 跳过 S2 判定，streak 保持不洗白，不产 hint/alert。
      driftStreaks.set(key, prev)
    } else {
      drift = computeDrift(graph, driftInput, prev, focusId)
      driftStreaks.set(key, drift.streak)
      // v0.30.2 D13：score 回升（streak 归零）→ 解除 hard 已提请状态，允许下次再报
      if (drift.streak === 0) hardAlerted.delete(key)
      if (drift.action === 'soft') {
        driftHint = renderDriftHint(graph.nodes[focusId ?? ''], drift)
      } else if (drift.action === 'hard' && !hardAlerted.has(key)) {
        hardAlerted.add(key)
        driftHardText = renderDriftHardBlock(graph.nodes[focusId ?? ''], drift)
        broadcastReActEvent({
          type: 'graph_drift',
          taskId: ctx.taskId,
          graphId: graph.id,
          nodeId: focusId,
          score: drift.score,
          streak: drift.streak,
          action: 'hard',
          detail: drift.detail,
        })
      }
      if (drift.action !== 'none') {
        logger.info('Agent', `sync: drift ${drift.action}（${drift.score.toFixed(2)}）streak=${drift.streak}——${drift.detail}`, ctx.taskId)
      }
    }
  } catch (err) {
    logger.warn('Agent', `sync: S2 漂移检测失败（跳过）${(err as Error).message}`, ctx.taskId)
  }

  // ---- S3 Write（内含 S4 Gate） ----
  try {
    const res = syncAfterAct(graph, input)
    graph = res.graph
    gateError = res.gateError
    verifyTrigger = res.verifyTrigger
    downgraded = !!res.downgraded
    if (res.changes.length > 0) {
      graph = await persist(ctx, graph, {
        changes: res.changes,
        reason: res.changes[0]?.reason,
        source: 'sync-write',
      })
    }
    if (gateError) {
      logger.info('Agent', `sync: gate 拒绝 ${gateError.code}（${gateError.invariant ?? '-'}）${gateError.message}`, ctx.taskId)
    }
  } catch (err) {
    logger.warn('Agent', `sync: S3 写回失败（保持原状）${(err as Error).message}`, ctx.taskId)
    graph = base
  }

  // ---- S5 Event ----
  let events: EventDecision[] = []
  let primaryEvent: EventDecision | undefined
  try {
    const eventInput: EventInput = {
      drift,
      afterCompaction: input.afterCompaction,
      userInserted: input.userInserted,
      files: input.files,
      lastConvergeCompleted: getLastConvergeCompleted(graph.id),
    }
    events = evaluateEvents(graph, eventInput)
    const priority: EventDecision['action'][] = ['replan', 'ask', 'converge']
    for (const a of priority) {
      const hit = events.find((d) => d.action === a)
      if (hit) {
        primaryEvent = hit
        break
      }
    }
    for (const ev of events) {
      logger.info('Agent', `event: ${ev.event}（${ev.action}）${ev.reason}`, ctx.taskId)
      recordMetric('event', { graphId: graph.id, event: ev.event, action: ev.action })
    }
  } catch (err) {
    logger.warn('Agent', `sync: S5 事件判定失败（跳过）${(err as Error).message}`, ctx.taskId)
  }

  if (downgraded) {
    recordMetric('phantom_completion', { graphId: graph.id, nodeId: input.toolName })
    notices.push({
      kind: 'replan',
      severity: 'warn',
      text: '完成宣称被降级为"验证中"：缺少充分证据',
      dismissible: true,
    })
  }

  return {
    graph,
    changes: [],
    notices,
    gateError,
    verifyTrigger,
    events,
    primaryEvent,
    downgraded,
    drift,
    driftHint,
    driftHardText,
  }
}

/* ============================================================
 * 五、模型宣称完成
 * ============================================================ */

export async function syncModelClaim(
  ctx: SyncCtx,
  claim: { nodeId?: string; summary: string; tokens?: number },
): Promise<SyncOutcome> {
  const base = await getGraph(ctx)
  if (!base) return { graph: null, changes: [], notices: [], events: [] }

  try {
    const res = applyModelClaim(base, claim)
    let graph = res.graph
    if (res.changes.length > 0) {
      graph = await persist(ctx, graph, {
        changes: res.changes,
        reason: '模型宣称完成',
        source: 'model-claim',
      })
    }
    if (res.downgraded) {
      recordMetric('phantom_completion', { graphId: graph.id })
    }
    return {
      graph,
      changes: res.changes,
      notices: [],
      gateError: res.gateError,
      verifyTrigger: res.verifyTrigger,
      events: [],
      downgraded: res.downgraded,
    }
  } catch (err) {
    logger.warn('Agent', `sync: 完成宣称处理失败（回退为不完成）${(err as Error).message}`, ctx.taskId)
    return { graph: base, changes: [], notices: [], events: [] }
  }
}

/* ============================================================
 * 六、收敛
 * ============================================================ */

export interface ConvergeOutcome {
  graph: TaskGraph | null
  /** 需要弹给用户的报告（无发现时为 undefined —— 静默） */
  report?: import('@shared/types/graph').DriftReport
  notice?: GraphNotice
}

/**
 * 执行收敛并落盘报告。
 *
 * **无发现时静默**（不弹卡、不通知）—— 只在 revisions 留一条 `op:'converge'` 记录。
 * 理由：converge 每 5 个节点触发一次，如果每次都弹"一切正常"，
 * 它会迅速变成被无视的噪音（和 Windows UAC 弹窗一样的下场）。
 */
export async function syncConverge(ctx: SyncCtx, input: ConvergeInput = {}): Promise<ConvergeOutcome> {
  const graph = await getGraph(ctx)
  if (!graph) return { graph: null }

  try {
    const report = await runConverge(graph, input)
    // 写报告进图（供面板读取），并记 convergence 时间
    const next: TaskGraph = {
      ...graph,
      spec: { ...graph.spec, lastConvergeAt: report.at, driftReport: report },
      updatedAt: Date.now(),
      revisions: [
        ...graph.revisions,
        {
          seq: (graph.revisions.at(-1)?.seq ?? 0) + 1,
          at: report.at,
          by: { kind: 'system' },
          op: 'converge',
          targetId: graph.id,
          after: {
            acCoverage: report.acCoverage.length,
            unmodeled: report.unmodeledWork.length,
            zombies: report.zombieTasks.length,
            invalidAssumptions: report.invalidAssumptions.length,
            degraded: report.degraded ?? [],
          },
          reason: hasConvergeFindings(report) ? renderConvergeNoticeText(report) : '定时兜底检查，无发现',
        },
      ],
    }
    const saved = await persist(ctx, next, { skipRevision: true, broadcast: false })
    markConverged(saved.id, Object.values(saved.nodes).filter((n) => n.status === 'completed').length)
    recordMetric('converge', {
      graphId: saved.id,
      unmodeled: report.unmodeledWork.length,
      zombies: report.zombieTasks.length,
      degraded: report.degraded ?? [],
    })

    if (!hasConvergeFindings(report)) {
      return { graph: saved }
    }
    const notice: GraphNotice = {
      kind: 'converge',
      severity: report.invalidAssumptions.length > 0 ? 'warn' : 'info',
      text: renderConvergeNoticeText(report),
      refId: saved.id,
      dismissible: true,
    }
    broadcastReActEvent({
      type: 'graph_converge_report',
      taskId: ctx.taskId,
      graphId: saved.id,
      report,
    })
    broadcastReActEvent({ type: 'graph_notice', taskId: ctx.taskId, graphId: saved.id, notice })
    return { graph: saved, report, notice }
  } catch (err) {
    logger.warn('Agent', `sync: converge 失败（跳过）${(err as Error).message}`, ctx.taskId)
    return { graph }
  }
}

/* ============================================================
 * 七、小工具
 * ============================================================ */

function pickFocusId(graph: TaskGraph): string | undefined {
  const nodes = Object.values(graph.nodes)
  return (
    nodes.find((n) => n.status === 'needs_human') ??
    nodes.find((n) => n.status === 'verifying') ??
    nodes.find((n) => n.status === 'in_progress')
  )?.id
}

/** 把等待时长渲染给 UI（needs_human 卡片） */
export function waitingLabel(since: number | undefined): string {
  if (!since) return ''
  return `等待 ${formatWaiting(Date.now() - since)}`
}

/** 状态是否在途（engine 用它判断"任务能不能结束"） */
export function hasInFlight(graph: TaskGraph): boolean {
  return Object.values(graph.nodes).some(
    (n) => n.status === 'in_progress' || n.status === 'verifying' || n.status === 'needs_human',
  )
}

/** 统计信息（日志/埋点用） */
export function summarizeGraph(graph: TaskGraph): {
  total: number
  counts: Partial<Record<NodeStatus, number>>
  tokensUsed: number
} {
  const counts: Partial<Record<NodeStatus, number>> = {}
  let tokensUsed = 0
  let total = 0
  for (const n of Object.values(graph.nodes)) {
    counts[n.status] = (counts[n.status] ?? 0) + 1
    tokensUsed += n.tokensUsed || 0
    total += 1
  }
  return { total, counts, tokensUsed }
}
