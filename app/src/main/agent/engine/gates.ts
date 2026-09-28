/**
 * v0.27.0 R2（§3.1 引擎拆分）：门禁与计划推进判定：ask_user 兜底、阶段门禁、计划项失败/丢弃处理
 * 由 engine.ts 纯移动而来（行区间 171-175 / 1558-1624 / 2170-2332）。
 */

import {
  type Task,
  type PlanItem,
  type ReActEvent,
  type ReActAction,
  type ReActStep,
  type PlanContent,
  type Agent,
  getAdapter,
  getModel,
  type LlmMessage,
  type LlmTool,
  type LlmCompleteResponse,
  callLlmWithRetry,
  withLlmTimeout,
  isContextOverflowError,
  invokeSkill,
  skillToLlmTool,
  skillToolName,
  listSkills,
  getSkill,
  type SkillContext,
  buildSystemSections,
  renderSystemPrompt,
  buildPersonalitySegment,
  collectAlwaysOnSections,
  assembleSystemPrompt,
  collectGateSpecs,
  initGateStates,
  checkGateBeforeAdvance,
  confirmGate,
  findGateForStageDoc,
  isDocDrivenAgent,
  type GateSpec,
  appendSessionEvent,
  drainContinuations,
  emitTurnStopping,
  matchStageGate,
  isCoreSkillsEnabled,
  buildGateBlockObservation,
  describeGateForLog,
  computeAllowedStage,
  matchForbiddenWritePath,
  matchForbiddenShellCommand,
  type StageGate,
  appendL1,
  listEnabledL1,
  listL1,
  totalTokens,
  persistRawL2,
  logger,
  genId,
  isNoisePlanItem,
  describeAction,
  createHash,
  updateTask,
  getTask,
  getAgent,
  broadcastStep,
  broadcastTaskStatus,
  broadcastToolProgress,
  clearToolProgress,
  broadcastPlanItemStatus,
  broadcastPlanListSnapshot,
  broadcastTextDelta,
  type ToolProgress,
  completeWithStream,
  createTextDeltaPump,
  type TextDeltaPump,
  getWorkspaceDir,
  saveCheckpoint,
  checkpointId,
  applyPending,
  getCuratedSnapshot,
  archiveTaskL1,
  initArchiveIndex,
  getProfile,
  synthesizeFromTaskL1,
  evaluateDistillTrigger,
  autoPromoteDistill,
  getDistillMetrics,
  runForSkillForge,
  compressMemory,
  compactTask,
  createMemoryPhase0,
  type CompressPolicy,
  estimatePayloadTokens,
  estimatePayloadTokensDetailed,
  estimateTextTokens,
  contextBudget,
  shouldCompact,
  truncateLongContent,
  MAX_REASONING_CONTENT,
  MAX_OBSERVATION_CONTENT,
  MICRO_COMPACT_PLACEHOLDER,
  OBSERVATION_TRUNCATED_MARK,
  getMemoryConfig,
  getSettings,
  listKb,
  listEnabledKb,
  searchKb,
  initKbIndex,
  readFile,
  computeContextBreakdown,
  type ContextBreakdownInput,
  type ContextBreakdownResult,
  type ContextToolEntry,
  type ContextSkillInstruction,
} from './engine-context.js'
// v0.30.0 D9：planItem ↔ graph 唯一桥（有图任务写图，无图任务保持 v0.29 直写）
import { markRunningFailed, cancelIncomplete, sealGraphForOutcome, sealGraphOnSuccess, reopenGraphForRun } from '../graph/plan-sync.js'
import { findPlanItemForStage } from './plan-parser.js'
// v0.37.0：清单真相源（TaskLedger）—— 写路径唯一入口
import { parkLedger, discardLedger, ensureLedger } from '../ledger/engine.js'
import { getUiLocale, tFor } from '../../i18n/messages.js'

// v0.25.2：ask_user 的 question 缺失/为空时注入的兜底问题。
// 与 suggestions 兜底同策略，保证门禁交互始终可用，避免「拒绝重试 → 空转报错」。
export function buildFallbackAskUserQuestion(): string {
  return tFor(getUiLocale(), 'askUser.fallbackQuestion')
}

/**
 * v0.18.x fix：任务级失败时，把当前 running（无则首个 pending）的清单项标 failed，
 * 让清单与真实执行进度一致 —— 此前任务失败（超迭代 / ReAct 崩溃）时清单纹丝不动，
 * 用户看不到任何失败反馈。
 */
export async function markRunningPlanItemFailed(task: Task): Promise<void> {
  // v0.30.0 D9：有图任务写图（唯一真相），镜像与广播由 graph/store.saveGraph 统一补发。
  if (task.graphId) {
    await markRunningFailed({ taskId: task.id, graphId: task.graphId }, '任务失败，引擎标记当前项 failed')
    return
  }
  const planItems = task.planItems ?? []
  if (planItems.length === 0) return
  const runningIdx = planItems.findIndex((p) => p.status === 'running')
  const targetIdx = runningIdx >= 0 ? runningIdx : planItems.findIndex((p) => p.status === 'pending')
  if (targetIdx < 0) return
  const target = planItems[targetIdx]!
  const fromStatus = target.status
  // v0.37.0（D132）：无图任务的「失败标记」也走账本 —— 此前直写 planItems，
  // 与 todo_update（账本）双通道并存，同轮内互相覆盖（诊断 §2 L3）。
  try {
    const ledF = await import('../ledger/engine.js')
    let res = await ledF.mutate(
      task.id,
      {
        kind: 'set-status',
        itemId: target.id,
        to: 'failed',
        source: 'engine-fail',
        note: '任务失败，引擎标记当前项 failed',
        force: true,
      },
      { actor: 'engine-fail' },
    )
    if (!res.ok && res.error?.code === 'NOT_FOUND') {
      await ledF.ensureLedger(task, { seedFromPlanItems: true })
      res = await ledF.mutate(
        task.id,
        {
          kind: 'set-status',
          itemId: target.id,
          to: 'failed',
          source: 'engine-fail',
          note: '任务失败，引擎标记当前项 failed',
          force: true,
        },
        { actor: 'engine-fail' },
      )
    }
    const fresh = await ledF.loadLedger(task.id)
    if (fresh) task.planItems = (await import('../ledger/project.js')).toPlanItems(fresh)
    if (!res.ok) {
      logger.warn('Agent', `markRunningPlanItemFailed 落账失败：${res.error?.message ?? '未知'}`, task.id)
    }
  } catch (err) {
    logger.warn('Agent', `markRunningPlanItemFailed 账本异常：${(err as Error).message}`, task.id)
  }
  broadcastPlanItemStatus(task.id, [
    {
      planItemId: target.id,
      index: targetIdx,
      fromStatus,
      status: 'failed',
      source: 'engine-fail',
      reason: '任务失败，引擎标记当前项 failed',
    },
  ])
}

/**
 * v0.19.1：任务**明确取消**时，把清单里未完成（running / pending）的项标记为 cancelled（丢弃）。
 * 用户 v0.19.0 反馈：中断或换路线时，原有清单未执行完的项应变为丢弃，而不是纹丝不动。
 *
 * v0.37.0（D131）：本函数**只**用于不可恢复的取消（`task.status === 'cancelled'`）。
 * 可恢复的暂停走 {@link parkIncompletePlanItems} —— 两者此前共用这一个函数，
 * 是"续聊重复执行第一个任务"的直接根因。
 */
export async function discardIncompletePlanItems(task: Task, reason: string): Promise<void> {
  // v0.37.0：清单真相源已收敛到 TaskLedger —— 所有写路径统一经 ledger.mutate。
  // 无账本时**先建账再写**，而不是回退成直写 planItems（那会重新制造第二个写入者）。
  let res = await discardLedger(task.id, reason)
  if (!res.ok && res.error?.code === 'NOT_FOUND') {
    try {
      await ensureLedger(task, { seedFromPlanItems: true })
    } catch (err) {
      logger.warn('Agent', `discard 建账失败：${(err as Error).message}`, task.id)
    }
    res = await discardLedger(task.id, reason)
  }
  if (res.ok) return
  logger.warn('Agent', `discardIncompletePlanItems 落账失败：${res.error?.message ?? '未知'}`, task.id)
  // 图是派生层，仍按既有纪律收口（失败只告警，不牵连任务终态）
  if (task.graphId) {
    try {
      await cancelIncomplete({ taskId: task.id, graphId: task.graphId }, reason)
    } catch (err) {
      logger.warn('Agent', `图侧 discard 失败：${(err as Error).message}`, task.id)
    }
  }
}

/**
 * v0.37.0（缺陷 D131）：**中断保留（park）** —— 与 `discard` 严格分离。
 *
 * 语义：用户按停止 / Esc / 任务暂停时，工作**没有作废**，只是暂时停下：
 *   · running → `paused`（可恢复）
 *   · pending → 原样保留（此前被误标 cancelled，导致续聊"无事可做"）
 *   · 写入人话恢复点 `resume.hint`：上次做到哪、还剩几项
 *
 * 这是"续聊不重复执行第一个任务"的第一道修复（诊断 §5.2 方案 A + 恢复点）。
 */
export async function parkIncompletePlanItems(task: Task, reason: string): Promise<void> {
  let res = await parkLedger(task.id, reason)
  if (!res.ok && res.error?.code === 'NOT_FOUND') {
    try {
      await ensureLedger(task, { seedFromPlanItems: true })
    } catch (err) {
      logger.warn('Agent', `park 建账失败：${(err as Error).message}`, task.id)
    }
    res = await parkLedger(task.id, reason)
  }
  if (res.ok) return
  // 建账后仍失败：只告警，不回退直写 —— 直写会制造第二个真相源，
  // 而"中断后清单被误 cancelled"的代价远大于"这一次没记下恢复点"。
  logger.warn('Agent', `parkIncompletePlanItems 落账失败：${res.error?.message ?? '未知'}`, task.id)
}

/**
 * v0.32.1（缺陷 D35）：**回合收口** —— 任务以一个终态结束时，把图级 `status` 封到该终态。
 *
 * 为什么必须单独有这一步：节点收口（`markRunningPlanItemFailed` /
 * `discardIncompletePlanItems`）只管**节点**，而 `graph.status` 是**另一份数据**，
 * 在 v0.32.1 之前**没有任何生产代码写过它**（`sealGraphAtTurnEnd` 是死代码）。
 * 于是任务终态时会出现这组自相矛盾的状态：
 *
 *   任务 `failed`  ✅ ｜ 节点 `failed`  ✅ ｜ 图 `status` **仍是 `in_progress`** ❌
 *
 * 用户看到的就是「刚开始执行就直接失败了，任务清单却纹丝不动、还显示在进行中」。
 *
 * 三种 outcome 的收口范围见 `sealGraphAtTurnEnd`：
 *  - `'failed'`    → 在途节点（+ 在途为空时的兜底排队项）→ failed；
 *  - `'cancelled'` → 所有非终态非 goal 节点 → cancelled；
 *  - `'completed'` → 不动节点，只封图级 status → completed。
 *
 * **失败不抛**：收口失败只告警，绝不牵连任务本身的终态写入（沿用 `persist` 的既有
 * 纪律 —— 落盘失败不该让用户的任务状态卡住）。
 *
 * **无图任务（`!task.graphId`）直接返回** —— tier 0/1 没有图级 status 这一层概念。
 */
export async function sealGraphForTaskOutcome(
  task: Task,
  outcome: 'failed' | 'cancelled' | 'completed',
  reason: string,
): Promise<void> {
  if (!task.graphId) return
  const ctx = { taskId: task.id, graphId: task.graphId }
  const res =
    outcome === 'completed' ? await sealGraphOnSuccess(ctx, reason) : await sealGraphForOutcome(ctx, outcome, reason)
  if (!res.ok) {
    logger.warn(
      'Agent',
      `[plan-sync] 回合收口 ${outcome} 未完成（不改任务终态）：${res.error?.message ?? '未知原因'}`,
      task.id,
    )
  }
}

/**
 * v0.32.1（缺陷 D36 配套）：**新一轮执行开始时的图重开** —— 与
 * `sealGraphForTaskOutcome` 互为逆操作，由 `engine/loop.ts` 在把任务标为
 * `running` 之后调用。
 *
 * 为什么需要它：收口是单向的，而任务可以被继续（`done` 后继续对话、`failed` /
 * `cancelled` 后重试）。若重开缺位，续聊会出现「任务在跑、图显示已完成」的
 * 反向自相矛盾 —— 与 D36 同源。**只改图级 status，不动节点**；
 * 幂等（已是 `in_progress` 时不落盘不广播）；**失败不抛**（只告警，绝不牵连任务启动）。
 *
 * 无图任务（tier 0/1）直接返回。
 */
export async function reopenGraphForTaskRun(task: Task, reason: string): Promise<void> {
  if (!task.graphId) return
  const res = await reopenGraphForRun({ taskId: task.id, graphId: task.graphId }, reason)
  if (!res.ok) {
    logger.warn(
      'Agent',
      `[plan-sync] 新一轮图重开未完成（不影响执行）：${res.error?.message ?? '未知原因'}`,
      task.id,
    )
  }
}

/**
 * v0.17.6：判断一个工具名是否属于"产成性"工具——成功调用通常意味着清单项可标 done。
 * 非产成性工具（只读探索 / 信息检索 / 阶段内中间写入）成功后由 LLM 自行决定是否推进清单。
 *
 * v0.18.x fix：file-writer / file-editor / shell 三项**不再**自动推进清单。
 * 原因：一个清单项往往需要多次写入 / 多次命令（尤其 frontend-design 等插件会连续写多个文件），
 * 若每次成功都自动把当前项标 done 并推进下一项，清单会"抢跑"，与真实执行进度错位。
 * 这些阶段内工具成功后保持 running，由 LLM 通过 todo_update 在真正完成一个子任务时显式推进。
 *
 * 产成性（可自动标 done）：task_complete / ask_user / spec / plan / bugfix / react-core-skills 等
 * 只读性：file-reader / glob-search / grep-search / web-search / fetch-url / kb-search / session-search 等
 */
export function isProductiveTool(tool: string): boolean {
  // v0.39.0（W15）：删除 'todo-update' / 'todo_update' —— 工具已下架（D154），
  //   且 act.ts 在调用本函数前已用 `!isPlanTool()` 排除清单族，这两项**永不命中**；
  //   留着只会让"谁在写清单"重新变得含糊（清单的唯一写入口是 task_plan → 账本）。
  const PRODUCTIVE = new Set([
    'task_complete', 'ask_user', 'spec', 'plan', 'bugfix', 'react-core-skills',
  ])
  return PRODUCTIVE.has(tool)
}

/**
 * v0.17.6：基于 act 结果独立推进清单状态，**不依赖 LLM 自调 todo_update**。
 *
 * 决策规则（优先级从高到低）：
 *  1. act 失败 → 保持 running（v0.19.x fix：单次工具失败多为可重试的瞬时错误，
 *     如路径写错/网络抖动，模型读到失败 observation 后会自纠重试；此前直接永久标
 *     failed，导致清单卡死无法恢复，后续项在任务结束时被批量标 cancelled）
 *  2. act 成功 + 产成性工具 → running 项自动 done + 自动推进下一项为 running
 *  3. act 成功 + 只读工具 → 保持 running，让 LLM 在下一轮决定
 *  4. 当前无 running 项 → 若还有 pending 项则自动恢复推进首个 pending（v0.19.x fix）
 *
 * 同时把判断结果与原 planItems 差异记入 "engineDecision" 字段，让 LLM 看到机器视角的判断。
 */
export function decidePlanAdvance(
  planItems: PlanItem[],
  toolName: string,
  ok: boolean,
  errorMessage?: string,
): {
  planItems: PlanItem[]
  decisions: Array<{ index: number; before: PlanItem['status']; after: PlanItem['status']; reason: string }>
} {
  const next = planItems.map((p) => ({ ...p }))
  const decisions: Array<{ index: number; before: PlanItem['status']; after: PlanItem['status']; reason: string }> = []
  const runningIdx = next.findIndex((p) => p.status === 'running')
  if (runningIdx < 0) {
    // v0.19.x fix：无 running 项时自动恢复——把首个 pending 提升为 running。
    // 修复"清单卡死"：此前 running 项被标 failed 后 decidePlanAdvance 永远空转，
    // 后续 pending 项只能等任务结束时被批量标 cancelled。
    const pendingIdx = next.findIndex((p) => p.status === 'pending')
    if (pendingIdx >= 0) {
      next[pendingIdx].status = 'running'
      next[pendingIdx].updatedAt = Date.now()
      decisions.push({
        index: pendingIdx,
        before: 'pending',
        after: 'running',
        reason: '清单无 running 项，引擎自动恢复推进下一项',
      })
    }
    return { planItems: next, decisions }
  }

  const before = next[runningIdx].status
  if (!ok) {
    // v0.19.x fix：瞬时失败保持 running，等模型读到失败 observation 后自纠重试。
    // 真正的失败仍由任务级 markRunningPlanItemFailed（超迭代/引擎崩溃）标记。
    decisions.push({
      index: runningIdx,
      before,
      after: 'running',
      reason: `${toolName} 调用失败（瞬时，保持 running 待重试）：${(errorMessage ?? '').slice(0, 100)}`,
    })
  } else if (isProductiveTool(toolName)) {
    next[runningIdx].status = 'done'
    next[runningIdx].updatedAt = Date.now()
    next[runningIdx].completedAt = Date.now()
    decisions.push({
      index: runningIdx,
      before,
      after: 'done',
      reason: `${toolName} 调用成功，引擎判定该项已完成`,
    })
    // 自动推进下一项
    if (runningIdx + 1 < next.length && next[runningIdx + 1].status === 'pending') {
      next[runningIdx + 1].status = 'running'
      next[runningIdx + 1].updatedAt = Date.now()
      decisions.push({
        index: runningIdx + 1,
        before: 'pending',
        after: 'running',
        reason: `引擎自动推进（上一项已完成）`,
      })
    }
  } else {
    // 只读工具成功：保持 running，让 LLM 决定
    decisions.push({
      index: runningIdx,
      before,
      after: 'running',
      reason: `${toolName} 为只读探索，引擎不自动推进；等待 LLM 在下一轮确认进度`,
    })
  }
  return { planItems: next, decisions }
}

/**
 * v0.17.6：把引擎独立判断后的 planItems 状态写入 L1 + 持久化 planItems。
 * 写入的 kind='plan_status' 在 assembleMessages 时被注入为独立 user 消息，LLM 必须以它为准。
 */
export async function emitPlanStatus(
  task: Task,
  iteration: number,
  trigger: string,
): Promise<void> {
  if (!task.planItems || task.planItems.length === 0) return
  const items = task.planItems.map((p, i) => {
    const mark =
      p.status === 'done'
        ? '[x]'
        : p.status === 'running'
          ? '[~]'
          : p.status === 'failed'
            ? '[!]'
            : p.status === 'skipped'
              ? '[-]'
              : p.status === 'cancelled'
                ? '[·]'
                : '[ ]'
    return `${i + 1}. ${mark} ${p.text}`
  })
  const counts = task.planItems.reduce(
    (acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
  const runningIdx = task.planItems.findIndex((p) => p.status === 'running')
  const content =
    `（触发点：${trigger}）\n` +
    `总项数=${task.planItems.length}  done=${counts.done ?? 0}  ` +
    `running=${counts.running ?? 0}  pending=${counts.pending ?? 0}  ` +
    `failed=${counts.failed ?? 0}  skipped=${counts.skipped ?? 0}  ` +
    `cancelled=${counts.cancelled ?? 0}\n` +
    `当前运行：${runningIdx >= 0 ? `第 ${runningIdx + 1} 项` : '无'}\n\n` +
    items.join('\n') +
    // v0.38.1（D166）：todo_update 已下架（v0.38.0 D154），模型可见注入改指 task_plan。
    `\n\n[同步义务] 若当前 running 项已实际完成，本轮必须通过 task_plan 提交完整最新清单把它标 done 并说明下一步；` +
    `若某项不再需要，标 skipped 或 cancelled。禁止累积多步后一次性批量修正——清单必须与实际执行实时一致。`
  await appendL1({
    taskId: task.id,
    role: 'assistant',
    kind: 'plan_status',
    iteration,
    content,
    meta: JSON.stringify({
      trigger,
      runningIndex: runningIdx,
      counts,
      total: task.planItems.length,
    }),
  })
}
