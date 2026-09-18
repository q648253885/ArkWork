/**
 * ArkWork — planItem ↔ graph 唯一桥（v0.30.0 · 缺陷 D9）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §4.7 / §4.8 / §10.6
 *
 * 背景：v0.29 遗留了 8 类直接写 `Task.planItems` 的路径，绕过了 `graph.json`（唯一真相）。
 * 本模块把它们统一收敛为「**写图 → 由图重算镜像**」：
 *
 *   planItemId ──(隐式不变量 `planItemId === nodeId`，§4.7)──▶ nodeId
 *     → `applyStatusChange()`（唯一状态写入原语，含 I1–I7 门禁 / I2 降级）
 *     → `persist()`（唯一副作用出口：落盘 + `graph_patch`/`graph_status` 广播 + 重算镜像）
 *     → `saveGraph` 内 `mirrorWrittenHook` 显式补发 `task:plan-list-snapshot`（通道 A ←→ B 同帧一致）
 *
 * 三条铁律：
 *  1. **无图任务（`!task.graphId`，tier 0/1）不进入本模块** —— 调用方保持 v0.29 直写行为不变；
 *  2. 图写失败（不变量拒绝 / 节点不存在）**不抛错**，返回 `{ ok: false, error }` 让调用方决定降级；
 *  3. 镜像广播走 `store.ts` 的 `registerMirrorWrittenHook` **注册回调**注入（依赖倒置 §10.1），
 *     本模块不新增 ESM 求值期边（`agent/events.ts` 不 import `graph/store.js`）。
 */
import type { GraphWriteError, NodeChange, NodeStatus } from '@shared/types/graph'
import type { PlanItemSource, PlanItemStatus } from '@shared/types/task'
import { applyStatusChange } from './gate.js'
import { patchNode } from './write.js'
import { getGraphById, persist, type SyncCtx } from './sync.js'
import { sealGraphAtTurnEnd } from './migrate.js'
import { registerMirrorWrittenHook } from './store.js'
import { broadcastPlanListSnapshot, broadcastGraphStatusChanged } from '../events.js'
import { logger } from '../../system/logger.js'

/** 桥的上下文：必须有图（无图任务调用方自行回落 v0.29 直写） */
export interface PlanSyncCtx {
  taskId: string
  graphId: string
  iteration?: number
}

export interface PlanSyncResult {
  ok: boolean
  /** 图写被拒时的错误（调用方据此决定是否回滚 optimistic UI / 提示用户） */
  error?: GraphWriteError
}

/**
 * 一次性写入多项状态变更。
 *
 * 两条写入路径（与 IPC `graph:set-status` 的常规 / `force` 双分支同构）：
 *  - 默认（`force === false`）：走 `applyStatusChange()`（唯一状态写入原语），受 `ALLOWED_TRANSITIONS`
 *    与不变量门禁约束（I2 证据不足会**降级为 `verifying`**）；被拒 → `{ ok: false, error }`。
 *  - `force === true`：等价于 `graph:set-status` 的强制分支 —— 直接改写节点 status + `revision + 1`，
 *    绕过状态机 / 不变量。用于**行政性写入**（引擎记账 / 用户显式指令），以保持 v0.29 的既有语义
 *    （如"用户点完成 = done"、"stage-gate 命中 = done"）；Agent 模型声明的验收路径仍走
 *    `write.ts:applyModelClaim`，门禁在那里继续生效。
 *
 * @returns 全部成功 → `{ ok: true }`；任一项被门禁拒绝 → `{ ok: false, error }`（**已写入的前项不回滚**，
 *          与 IPC `graph:set-status` 的单步语义一致：拒绝即停在上一合法图）。
 */
async function commitStatuses(
  ctx: PlanSyncCtx,
  updates: ReadonlyArray<{ nodeId: string; to: NodeStatus; source: string; reason?: string }>,
  reason?: string,
  force = false,
): Promise<PlanSyncResult> {
  const syncCtx: SyncCtx = {
    taskId: ctx.taskId,
    graphId: ctx.graphId,
    iteration: ctx.iteration ?? 0,
  }
  const base = await getGraphById(ctx.graphId)
  if (!base) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `图不存在：${ctx.graphId}`,
        hint: '任务图可能已被删除。请刷新任务列表后重试。',
      },
    }
  }

  let current = base
  const changes: NodeChange[] = []
  for (const u of updates) {
    const node = current.nodes[u.nodeId]
    if (!node) {
      return {
        ok: false,
        error: {
          code: 'NOT_FOUND',
          message: `节点不存在：${u.nodeId}`,
          hint: 'planItem 与图节点应一一对应（§4.7）。图可能已被其他操作修改，请刷新后重试。',
        },
      }
    }
    const from = node.status
    if (force) {
      if (from === u.to) continue
      current = patchNode(current, u.nodeId, (n) => ({ ...n, status: u.to, revision: n.revision + 1 }))
      changes.push({ nodeId: u.nodeId, from, to: u.to, source: u.source, reason: u.reason ?? reason })
      continue
    }
    const res = applyStatusChange(current, u.nodeId, u.to, u.source, base)
    if (res.error) return { ok: false, error: res.error }
    current = res.graph
    const to = current.nodes[u.nodeId]?.status
    if (from !== to) {
      changes.push({ nodeId: u.nodeId, from, to, source: u.source, reason: u.reason ?? reason })
    }
  }

  // 幂等：无实际变更时不落盘、不广播（避免污染 revision / 产生空 diff）
  if (changes.length === 0) return { ok: true }

  await persist(syncCtx, current, { changes, reason, source: 'plan-sync' })
  return { ok: true }
}

/**
 * 把 planItem 的目标态解析为图节点目标态。
 *
 * 语义差别的取舍（planItem 6 态 vs graph 11 态）：
 *  - `cancelled` / `skipped` → `cancelled`
 *  - `done` → `completed`（受 I2 约束：无充分证据会被降级为 `verifying`）
 *  - `failed` → `failed`
 *  - `running`（重试）→ **`ready`**：重试的语义是「让它可再次运行」，而不是「立刻 in_progress」；
 *    图模型里 `in_progress` 表示引擎正在执行，人工点击不应伪造该状态。
 */
function resolveTargetNodeStatus(target: PlanItemStatus): NodeStatus {
  switch (target) {
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
    case 'skipped':
      return 'cancelled'
    case 'running':
      return 'ready'
    case 'pending':
    default:
      return 'ready'
  }
}

/**
 * IPC 用户手动切状态（`task:plan-item-cancel` / `-retry` / `-mark-done`）的图侧原语。
 *
 * 默认 `force = true`：用户显式指令优先（与 `graph:set-status` 的强制分支同语义），
 * 例如"把一项尚未开始的待办直接记为完成"在状态机下是非法转换，但这是用户的明确意图。
 *
 * @returns `{ ok, effectiveStatus?, error? }` —— `effectiveStatus` 由图重算（供 Renderer reconcile）
 */
export async function applyPlanItemStatus(
  ctx: PlanSyncCtx,
  planItemId: string,
  target: PlanItemStatus,
  source: PlanItemSource,
  reason?: string,
  force = true,
): Promise<PlanSyncResult & { effectiveStatus?: PlanItemStatus }> {
  const base = await getGraphById(ctx.graphId)
  if (!base) {
    return {
      ok: false,
      error: { code: 'NOT_FOUND', message: `图不存在：${ctx.graphId}`, hint: '请刷新任务列表后重试。' },
    }
  }
  if (!base.nodes[planItemId]) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `节点不存在：${planItemId}`,
        hint: 'planItem 与图节点应一一对应（§4.7）。图可能已被其他操作修改，请刷新后重试。',
      },
    }
  }
  const to = resolveTargetNodeStatus(target)
  const res = await commitStatuses(ctx, [{ nodeId: planItemId, to, source, reason }], reason, force)
  if (!res.ok) return res
  const saved = await getGraphById(ctx.graphId)
  return { ok: true, effectiveStatus: planItemStatusOf(saved?.nodes[planItemId]?.status) }
}

/** 图状态 → planItem 状态（与 `store.ts` 的 `mapNodeStatusToPlanItemStatus` 同口径） */
function planItemStatusOf(status: NodeStatus | undefined): PlanItemStatus | undefined {
  switch (status) {
    case undefined:
      return undefined
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'in_progress':
    case 'verifying':
    case 'needs_human':
      return 'running'
    default:
      return 'pending'
  }
}

/**
 * stage-gate 命中后推进：当前项 → `completed`，下一项 → `in_progress`（对应 `engine/loop.ts` 分支）。
 *
 * `force = true`：阶段门禁是引擎的记账动作（产物已落地），需与 v0.17.5「清单↔阶段产物对齐」语义一致，
 * 不能被 I2「证据不足先降级 verifying」拦下。
 */
export async function applyStageGateAdvance(
  ctx: PlanSyncCtx,
  donePlanItemId: string,
  nextPlanItemId?: string,
  source: PlanItemSource = 'engine-decide',
): Promise<PlanSyncResult> {
  const updates: { nodeId: string; to: NodeStatus; source: string; reason?: string }[] = [
    { nodeId: donePlanItemId, to: 'completed', source },
  ]
  if (nextPlanItemId) {
    updates.push({ nodeId: nextPlanItemId, to: 'in_progress', source })
  }
  return commitStatuses(ctx, updates, 'stage-gate 命中推进', true)
}

/**
 * 批量把 planItem 状态写回图（`todo_update` / 推理阶段回写 共用）。
 *
 * @param updates 每个元素给出 planItemId 与目标 planItem 状态
 * @param force   默认 `true`：本方法服务于引擎 / LLM 的显式清单指令，保持 v0.29 语义
 */
export async function applyPlanItemStatuses(
  ctx: PlanSyncCtx,
  updates: ReadonlyArray<{ planItemId: string; to: PlanItemStatus }>,
  source: PlanItemSource,
  reason?: string,
  force = true,
): Promise<PlanSyncResult> {
  return commitStatuses(
    ctx,
    updates.map((u) => ({ nodeId: u.planItemId, to: resolveTargetNodeStatus(u.to), source })),
    reason,
    force,
  )
}

/**
 * 把某一 planItem 标记为「正在执行」（图节点 → `in_progress`）。
 *
 * 与 `applyPlanItemStatuses(ctx, [{ to: 'running' }])` 的区别：后者把 `running` 解析为 `ready`
 * （「重试 = 让它可再次运行」语义，见 `resolveTargetNodeStatus`），而本方法服务于引擎
 * 「首轮开始执行第一项」的推进语义，必须真正进入 `in_progress` —— 否则镜像回落为 `pending`，
 * 交互区与侧边栏会再次分叉（即缺陷 D9）。对应 `engine/reason-phase.ts` 的推理阶段回写。
 *
 * `force = true`：保持 v0.29「不管起点状态，一律置 running」的既有语义，不受状态机 / I1 拦截。
 */
export async function markPlanItemInProgress(
  ctx: PlanSyncCtx,
  planItemId: string,
  source: PlanItemSource = 'engine-decide',
  reason = '迭代开始，推进首项',
): Promise<PlanSyncResult> {
  return commitStatuses(ctx, [{ nodeId: planItemId, to: 'in_progress', source, reason }], reason, true)
}

/**
 * 任务失败收口：把在途节点标记为 `failed` **并封图级 status**（对应
 * `engine/gates.ts` 的 `markRunningPlanItemFailed`）。
 *
 * v0.32.1（缺陷 D35/D36）—— 本函数此前有两个洞，都是「失败后任务清单纹丝不动」
 * 的成因：
 *
 *  - **D36 无兜底**：只看 `in_progress`。而最常见的失败场景（计划生成失败 → 兜底
 *    单步清单 `pending` → 迁移成 `ready` → ReAct 立刻失败）里**根本没有 in_progress**
 *    → 直接 `{ ok: true }` 静默返回。现由 `sealGraphAtTurnEnd` 的兜底覆盖
 *    （在途为空时收第一个排队项）。
 *  - **D35 不封口**：只改节点、不改 `graph.status`，于是「节点 failed / 任务 failed /
 *    图仍 in_progress」三者自相矛盾。现由 `sealGraphAtTurnEnd` 一并封口。
 *
 * 两者合并为**一次落盘**（`sealAndPersist`），不再分两步写。
 */
export async function markRunningFailed(
  ctx: PlanSyncCtx,
  reason: string,
): Promise<PlanSyncResult> {
  return sealAndPersist(ctx, 'failed', reason)
}

/** 非终态集合（排除 goal 层节点） */
const NON_TERMINAL: ReadonlySet<NodeStatus> = new Set([
  'draft',
  'proposed',
  'approved',
  'ready',
  'in_progress',
  'verifying',
  'blocked',
  'needs_human',
])

/**
 * 丢弃未完成项：所有非终态、非 goal 节点 → `cancelled`
 * （对应 `engine/gates.ts` 的 `discardIncompletePlanItems`）。
 */
export async function cancelIncomplete(
  ctx: PlanSyncCtx,
  reason: string,
): Promise<PlanSyncResult> {
  const graph = await getGraphById(ctx.graphId)
  if (!graph) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `图不存在：${ctx.graphId}`, hint: '请刷新后重试。' } }
  }
  const victims = Object.values(graph.nodes).filter(
    (n) => n.layer !== 'goal' && NON_TERMINAL.has(n.status),
  )
  if (victims.length === 0) return { ok: true }
  return commitStatuses(
    ctx,
    victims.map((n) => ({ nodeId: n.id, to: 'cancelled' as NodeStatus, source: 'engine-fail', reason })),
    reason,
    true,
  )
}

/**
 * v0.32.1（缺陷 D35）：**回合收口** —— 任务以一个终态结束时，把「节点 + 图级 status」
 * 一并收干净，**一次落盘**。
 *
 * 为什么需要它： `sealGraphAtTurnEnd` 此前是**死代码**（只有测试调用它），生产代码
 * 里没有任何一处改 `graph.status`。于是任务终态时出现「节点 failed / 任务 failed /
 * 图仍 in_progress」这组自相矛盾的状态 —— 任务清单看起来还在进行中。
 *
 * 收口范围由 `sealGraphAtTurnEnd` 决定（`failed` / `cancelled` / `completed` 三者
 * 语义不同，见该函数文档）。本函数只负责：读图 → 收口 → 落盘 → 广播。
 *
 * 幂等：既无节点变更、图级状态也已一致时不落盘（不污染 `graphRevision`）。
 * 失败不抛：图读写失败返回 `{ ok: false, error }`；`persist` 内部的落盘失败只告警
 * （沿用既有纪律 —— 落盘失败不牵连任务收尾）。
 */
async function sealAndPersist(
  ctx: PlanSyncCtx,
  outcome: 'failed' | 'cancelled' | 'completed',
  reason: string,
): Promise<PlanSyncResult> {
  const base = await getGraphById(ctx.graphId)
  if (!base) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `图不存在：${ctx.graphId}`,
        hint: '任务图可能已被删除。请刷新任务列表后重试。',
      },
    }
  }
  const sealed = sealGraphAtTurnEnd(base, outcome, reason)
  const statusChanged = sealed.graph.status !== base.status
  if (sealed.changedIds.length === 0 && !statusChanged) return { ok: true }

  const changes: NodeChange[] = sealed.changedIds.map((id) => ({
    nodeId: id,
    from: base.nodes[id]?.status,
    to: sealed.graph.nodes[id]?.status,
    source: outcome === 'failed' ? 'engine-fail' : outcome === 'cancelled' ? 'user-cancel' : 'engine-decide',
    reason,
  }))

  await persist(
    { taskId: ctx.taskId, graphId: ctx.graphId, iteration: ctx.iteration ?? 0 },
    sealed.graph,
    { changes, reason, source: 'plan-sync' },
  )

  // v0.32.1（缺陷 D36 可见性）：图级 status 变更必须**单独广播**。
  //
  // `persist()` 的 `graph:update` 扇出以「有节点变更」为前提；而成功收口
  // （`completed` 不动节点、`failed` 的在途已先被标 failed）常常是**零节点变更、
  // 纯图级封口**。少了这条广播，面板的快照就永远停在封口前那一帧 ——
  // 任务已经 `done`，任务面板却仍显示「进行中」。
  if (statusChanged && changes.length === 0) {
    broadcastGraphStatusChanged(ctx.taskId, ctx.graphId, sealed.graph.status, reason)
  }
  return { ok: true }
}

/**
 * 任务**取消/中断**时的收口入口（由 `engine/abort.ts` 的 cancelled 分支调用）。
 *
 * 为什么不复用 `cancelIncomplete`：那个函数由「取消」与「暂停」两条分支共用，
 * 而**暂停是可恢复的**（用户点「继续」会接着跑），把 `graph.status` 封成 `cancelled`
 * 会让恢复后的图状态与执行事实不符。所以只在本函数的调用点（已确认是不可恢复的
 * 取消）才封口。
 */
export async function sealGraphForOutcome(
  ctx: PlanSyncCtx,
  outcome: 'failed' | 'cancelled',
  reason: string,
): Promise<PlanSyncResult> {
  return sealAndPersist(ctx, outcome, reason)
}

/**
 * 任务**成功完成**时的收口入口（由 `engine/loop.ts` 的「无工具调用且清单已清空」
 * 成功分支调用）。清单各项在过程中已由 `decidePlanAdvance` / stage-gate 逐项推进到
 * `completed`，这里只需把**图级 status** 封成 `completed` —— 否则任务标 `done`
 * 而图仍是 `in_progress`，任务面板会一直显示「进行中」。
 */
export async function sealGraphOnSuccess(ctx: PlanSyncCtx, reason: string): Promise<PlanSyncResult> {
  return sealAndPersist(ctx, 'completed', reason)
}

/**
 * v0.32.1（缺陷 D36 配套）：**新一轮执行开始时把图重开**（终态 → `in_progress`）。
 *
 * 为什么必须有它 —— 封口是单向的，而任务是可以被继续的：
 *   · 任务 `done` 后用户继续对话（`appendUserMessage` → 任务回 `pending` → 新 run），
 *   · `failed` / `cancelled` 后用户点重试或续聊。
 *
 * 收口把 `graph.status` 封成终态之后，**没有任何生产代码会把它改回 `in_progress`**
 * （全仓 `graph.status` 的赋值只有建图时的 `migrateToGraph`）。于是续聊的后果是
 * 「任务在跑、图显示已完成/已取消」—— 与 D36 同源的另一种自相矛盾，只是方向相反。
 *
 * 因此：新 run 起步（`loop.ts` 在把任务标 `running` 之后）调用本函数重开图。
 * **只动图级 status，不动任何节点**（节点状态是执行事实，重开不改变它们）。
 * 幂等：已是 `in_progress` 时直接返回，不落盘、不广播。
 *
 * 失败不抛：图不存在 → `{ ok: false, error }`；落盘失败由 `persist` 内部告警兜住。
 */
export async function reopenGraphForRun(ctx: PlanSyncCtx, reason: string): Promise<PlanSyncResult> {
  const base = await getGraphById(ctx.graphId)
  if (!base) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `图不存在：${ctx.graphId}`,
        hint: '任务图可能已被删除。请刷新任务列表后重试。',
      },
    }
  }
  if (base.status === 'in_progress') return { ok: true }

  await persist(
    { taskId: ctx.taskId, graphId: ctx.graphId, iteration: ctx.iteration ?? 0 },
    { ...base, status: 'in_progress', updatedAt: Date.now() },
    { changes: [], reason, source: 'plan-sync' },
  )
  broadcastGraphStatusChanged(ctx.taskId, ctx.graphId, 'in_progress', reason)
  return { ok: true }
}

let installed = false

/**
 * 启动时安装一次：把 `saveGraph` 的「镜像已写」通知接到 `task:plan-list-snapshot` 广播上。
 *
 * 依赖倒置（§10.1）：`graph/store.ts` 不静态 import `agent/events.js`，只暴露注册口；
 * 由本模块（上层编排）注入具体实现。幂等，重复调用安全。
 */
export function installPlanSync(): void {
  if (installed) return
  installed = true
  registerMirrorWrittenHook((taskId, planItems) => {
    broadcastPlanListSnapshot(taskId, planItems, 'engine-decide')
  })
  logger.info('Agent', 'plan-sync: 镜像写入广播 hook 已安装')
}
