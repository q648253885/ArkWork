/**
 * v0.27.0 R2/F7：终止控制动作收尾（由 loop.ts 纯移动，行为不变）。
 * - finishViaTaskComplete：task_complete 分支（配对 observation + 完成态 + 里程碑 + 记忆钩子）
 * - pauseViaAskUser：ask_user 分支（参数兜底校验 + 配对 observation + continuation 注入判定）
 */

import type { Task } from '@shared/types/task'
import type { ReActAction } from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import type { LlmCompleteResponse } from '../../llm/adapter.js'
import { logger } from '../../system/logger.js'
import { updateTask, getTask } from '../../store/tasks.js'
import { broadcastTaskStatus } from '../events.js'
import { emitEvent, emitProgress, safeSlice } from './broadcast.js'
import { appendPairedControlObservations } from './act.js'
import { runDoneMemoryHooks } from './memory-hooks.js'
import { buildFallbackAskUserQuestion, sealGraphForTaskOutcome, discardIncompletePlanItems } from './gates.js'
import { unfinishedTaskNodes } from '../graph/migrate.js'
import { continueTurnIfInjected } from './abort.js'
// v0.30.0：完成语义（Sync · S3 Write + S4 Gate）—— 用"验收通过"替代"模型宣称"
import { syncModelClaim } from '../graph/sync.js'
import { appendL1 } from '../../memory/l1-working.js'
import { getUiLocale, tFor } from '../../i18n/messages.js'

export interface TurnEndCtx {
  task: Task
  agent: Agent
  modelId: string
}

/**
 * v0.32.1（缺陷 D39）：`task_complete` 前的**未完成项守卫**每轮 run 允许的拒绝次数。
 *
 * 为什么需要拒绝而不是直接接受：任务要标 `done`、清单里却留着 4 条 `ready`
 * （从未执行）—— 用户在任务面板看到的是「已完成的任务 + 4 条待执行」，与 D36 同源的
 * 另一种「任务态 ↔ 清单态不一致」。这与 v0.28.1 在「无工具调用」分支的既有裁决同向
 * （清单有未完成项时**不静默收尾**，先让模型自处）。
 *
 * 为什么必须**有上限**：模型可能反复坚持「已完成」。超过上限后接受完成，
 * 但要求清单与终态自洽 —— 剩余项收成 `cancelled`（附原因），而不是把矛盾留在界面上。
 */
export const MAX_COMPLETE_REFUSALS = 2

/**
 * v0.32.1（缺陷 D39）：拒绝一次 `task_complete` —— 补配对 observation + 一条指令性
 * user message，告诉模型「清单还有哪些项没终态」以及它的两个选择。
 *
 * 与 `verifyTrigger` 的处理方式完全同构（同样要补配对 observation，否则 assistant 的
 * tool_calls 悬空，下次 assembleMessages 重建消息时服务端会 400）。
 */
async function refuseCompletionForLeftovers(args: {
  taskId: string
  iteration: number
  pendingActions: ReActAction[]
  pendingActionIds: string[]
  leftovers: ReadonlyArray<{ key?: string; id: string; status: string; title?: string }>
  priorRefusals: number
}): Promise<void> {
  const { taskId, iteration, pendingActions, pendingActionIds, leftovers, priorRefusals } = args
  const list = leftovers
    .map((n) => `  · ${n.key ?? n.id}（${n.status}）${(n.title ?? '').slice(0, 40)}`)
    .join('\n')
  await appendPairedControlObservations({
    taskId,
    iteration,
    actions: pendingActions,
    actionIds: pendingActionIds,
    controlTool: 'task_complete',
    controlContent: `[task_complete] 已受理，但任务清单仍有 ${leftovers.length} 项未收口`,
    skipPrefix: '[skipped] 等待清单收口，跳过：',
  })
  await appendL1({
    taskId,
    role: 'user',
    kind: 'user_message',
    iteration,
    content:
      `[unfinished-plan] 任务清单仍有 ${leftovers.length} 项没有终态，因此**不能**判定完成：\n` +
      `${list}\n` +
      `请二选一（不要重复调用 task_complete，它不会让未执行的项变成完成）：\n` +
      `  ① 继续调用工具把这些项做完；或\n` +
      `  ② 若确认它们已无需执行，用 todo-update 把它们显式标记为 cancelled（或 skipped），` +
      `说明理由，然后再调用 task_complete。`,
  })
  logger.info(
    'Agent',
    `task_complete 被拦截：清单仍有 ${leftovers.length} 项未收口（第 ${priorRefusals + 1}/${MAX_COMPLETE_REFUSALS} 次）`,
    taskId,
  )
}

export async function finishViaTaskComplete(
  ctx: TurnEndCtx,
  action: ReActAction,
  response: LlmCompleteResponse,
  pendingActions: ReActAction[],
  pendingActionIds: string[],
  iteration: number,
  /** 本轮 run 内已被拒绝的次数（由 loop.ts 维护；缺省 0 —— 单次调用语义不变） */
  priorRefusals = 0,
): Promise<boolean> {
  const { task, agent, modelId } = ctx

  // ============================================================
  // v0.30.0：完成语义变更 —— "完成"由验证结果判定，不再由模型宣称判定
  //
  // v0.29 的行为：模型调 task_complete → 直接 `updateTask(status:'done')`（F3 自评失明）。
  // v0.30.0：先走 syncModelClaim，由 harness 决定采纳方式：
  //   · 节点 verification.required=true 且缺充分证据 → **不结束任务**，把节点置为
  //     verifying 并返回一条指令性 observation 要求模型执行验证命令；
  //     下一轮 shell 跑出符合期望的退出码后，节点才会转 completed。
  //   · 否则 → 补一条证据后置 completed，继续走既有收尾流程。
  //
  // 返回 `true` 表示"本回合不结束、继续循环"（与 pauseViaAskUser 的约定一致）。
  // ============================================================
  if (task.graphId) {
    const claim = await syncModelClaim(
      { taskId: task.id, graphId: task.graphId, iteration },
      {
        nodeId: typeof action.args.node_id === 'string' ? (action.args.node_id as string) : undefined,
        summary: (action.args.summary as string) ?? safeSlice(response.thought, 500),
      },
    )
    if (claim.verifyTrigger) {
      // 配对 observation（防悬空 tool_calls 导致服务端 400 —— 与既有修复同理）
      await appendPairedControlObservations({
        taskId: task.id,
        iteration,
        actions: pendingActions,
        actionIds: pendingActionIds,
        controlTool: 'task_complete',
        controlContent: '[task_complete] 已受理，但完成需验证通过',
        skipPrefix: '[skipped] 等待验证，跳过：',
      })
      // 指令性 user message：让模型在下一轮执行验证命令
      const node = claim.graph?.nodes[claim.verifyTrigger.nodeId]
      await appendL1({
        taskId: task.id,
        role: 'user',
        kind: 'user_message',
        iteration,
        content:
          `[verification-required] 节点 ${node?.key ?? claim.verifyTrigger.nodeId} 已进入 verifying。\n` +
          `任务的"完成"由验证结果判定，不是由宣称判定。请立即用 shell 执行验证命令：\n` +
          `  ${claim.verifyTrigger.command}\n` +
          `退出码符合期望后该节点会自动转为 completed；失败会按 maxAttempts 重试，超次触发重规划。\n` +
          `不要重复调用 task_complete —— 它不会让未验证的节点变成完成。`,
      })
      logger.info(
        'Agent',
        `task_complete 被拦截：${claim.verifyTrigger.nodeId} 需先跑验证命令 \`${claim.verifyTrigger.command}\``,
        task.id,
      )
      return true // 不结束任务，回到循环顶部
    }
    if (claim.gateError) {
      logger.info('Agent', `task_complete 被门禁拒绝：${claim.gateError.message}`, task.id)
    }

    // ============================================================
    // v0.32.1（缺陷 D39）：**完成前守卫** —— 清单还有未收口项时不静默收尾。
    //
    // 真实环境实测形态（模型自建 10 项计划 → 执行 3 项 → 取消 3 项 → 直接 task_complete）：
    //   任务 `done` ✅ ｜ 图 `completed` ✅ ｜ **清单里 4 项仍是 `ready`（从未执行）** ❌
    // 用户在任务面板看到「已完成的任务 + 4 条待执行」，无从判断这些项到底做没做。
    //
    // 策略（与 v0.28.1 在「无工具调用」分支的既有裁决同向）：
    //   ① 前 MAX_COMPLETE_REFUSALS 次 → **拒绝收尾**，把未完成项列给模型，要求其二选一：
    //      继续执行，或显式用 `todo-update` 标记取消/跳过（留下「这是模型主动不做」的痕迹）；
    //   ② 超过上限仍坚持 → 接受完成，但**必须让清单与终态自洽**：剩余项收成 `cancelled`
    //      （附原因 + 告警日志），而不是把矛盾留在界面上。
    // ============================================================
    const leftovers = claim.graph ? unfinishedTaskNodes(claim.graph) : []
    if (leftovers.length > 0) {
      if (priorRefusals < MAX_COMPLETE_REFUSALS) {
        await refuseCompletionForLeftovers({
          taskId: task.id,
          iteration,
          pendingActions,
          pendingActionIds,
          leftovers,
          priorRefusals,
        })
        return true // 不结束任务，回到循环顶部让模型自处
      }
      logger.warn(
        'Agent',
        `task_complete 连续 ${priorRefusals} 次被拒后仍坚持完成：把剩余 ${leftovers.length} 项收为 cancelled` +
          `（${leftovers.map((n) => n.key ?? n.id).join(', ')}）`,
        task.id,
      )
      await discardIncompletePlanItems(task, '任务完成：模型坚持收尾，剩余未执行项收为 cancelled')
    }
  } else {
    // 无图任务（tier 0/1）：同一守卫，判据换成扁平清单 —— 必须**读一次最新的**
    // planItems（内存里的 task 对象可能在若干轮 todo-update 之后已过期）。
    const fresh = await getTask(task.id)
    const pending = (fresh?.planItems ?? []).filter((p) => p.status === 'running' || p.status === 'pending')
    if (pending.length > 0) {
      if (priorRefusals < MAX_COMPLETE_REFUSALS) {
        await refuseCompletionForLeftovers({
          taskId: task.id,
          iteration,
          pendingActions,
          pendingActionIds,
          leftovers: pending.map((p) => ({ id: p.id, status: p.status, title: p.text })),
          priorRefusals,
        })
        return true
      }
      logger.warn(
        'Agent',
        `task_complete 连续 ${priorRefusals} 次被拒后仍坚持完成：把剩余 ${pending.length} 项收为 cancelled`,
        task.id,
      )
      await discardIncompletePlanItems(task, '任务完成：模型坚持收尾，剩余未执行项收为 cancelled')
    }
  }

  // v0.14.0 修复：task_complete 由模型以 tool_calls 形式触发，但本分支直接完成
  // 不执行工具。若不补写配对的 tool observation，assistant 的 tool_calls 将悬空，
  // 下次 assembleMessages 重建消息时服务端会 400
  // "tool messages responding to each tool_call_id"。
  // v0.19.x：多 action 时（如 [task_complete, file-writer]）为每个 action 补写配对
  // observation，非控制动作写"跳过"，避免 reconcileToolCalls 剥离悬空 tool_calls。
  await appendPairedControlObservations({
    taskId: task.id,
    iteration,
    actions: pendingActions,
    actionIds: pendingActionIds,
    controlTool: 'task_complete',
    controlContent: '[task_complete] 任务已完成',
    skipPrefix: '[skipped] 任务已完成，跳过：',
  })
  await emitEvent(task.id, {
    type: 'task_complete',
    iteration,
    summary: (action.args.summary as string) ?? safeSlice(response.thought, 500),
    // v0.15.0 Task 7：透传 Agent 附带的建议（由 LLM 真实生成，不再前端硬编码映射）
    suggestions: Array.isArray(action.args.suggestions)
      ? (action.args.suggestions as Array<{ label: string; description?: string; recommended?: boolean }>)
          .filter((s) => s && typeof s.label === 'string')
          .slice(0, 4)
      : undefined,
  })
  // v0.32.1（缺陷 D36 成功路径补齐）：**task_complete 工具分支同样必须封图级 status**。
  //
  // 为什么这条一度漏掉：D36 的收口只在 loop.ts 的「无工具调用且清单已清空」成功分支挂了点
  // （见 loop.ts 的 `sealGraphForTaskOutcome(task, 'completed')`），而**更常见的成功路径**
  // 恰恰是模型显式调用 `task_complete` 工具 —— 它走的是本函数，于是：
  //
  //   任务 `done` ✅ ｜ 节点全终态 ✅ ｜ 图 `status` **仍是 `in_progress`** ❌
  //
  // 真实环境实测即此形状（task=done、7/10 done + 3 cancelled、graph.status=in_progress），
  // 任务面板会一直显示「进行中」。
  //
  // 顺序：**先封图、再写任务终态** —— 这样 UI 收到 `task:status=done` 的那一刻，
  // 图侧已经是自洽的终态，不会出现「任务已完成、清单还在跑」的一帧。
  // 收口本身失败不抛（只告警），因此不会连带阻塞任务完成。
  await sealGraphForTaskOutcome(task, 'completed', '任务完成（task_complete）')
  await updateTask(task.id, { status: 'done', completedAt: Date.now() })
  broadcastTaskStatus({ ...task, status: 'done', completedAt: Date.now() })
  // Task 9：task_complete 工具分支同样推进到完成态
  await emitProgress({
    type: 'task_progress',
    taskId: task.id,
    currentStage: 'ops',
    stageIndex: 8,
    overallPercentage: 100,
    nextStepLabel: undefined,
  })
  await emitProgress({
    type: 'task_milestone',
    taskId: task.id,
    milestoneId: 'code-done',
    label: tFor(getUiLocale(), 'milestone.codeDone'),
    reachedAt: Date.now(),
  })
  // v0.8.0 F803/F804/F805：run done 归档 + 画像合成 + 蒸馏评估
  await runDoneMemoryHooks(task, agent, modelId, response.thought)
  return false
}

export async function pauseViaAskUser(
  ctx: TurnEndCtx,
  action: ReActAction,
  pendingActions: ReActAction[],
  pendingActionIds: string[],
  iteration: number,
): Promise<boolean> {
  const { task } = ctx
  // v0.18.x fix：放宽校验 — 只强制 question 有效，suggestions 不再硬性要求 2~4 个。
  // 此前「suggestions < 2 即拒绝重试」会让 LLM 在「参数解析持续失败」里空转，
  // 进而跳过门禁、继续编码，甚至因后续参数截断导致整个任务中断。
  // 现在：suggestions 不足时注入兜底选项，仍保留「门禁 + 选择」体验，但不再触发重试循环。
  const rawQuestion = action.args.question
  const rawSuggestions = action.args.suggestions
  const validatedSuggestions = Array.isArray(rawSuggestions)
    ? (rawSuggestions as Array<{ label?: unknown; description?: unknown; recommended?: unknown }>)
        .filter((s) => s && typeof s.label === 'string' && (s.label as string).trim().length > 0)
        .slice(0, 4)
        .map((s) => ({
          label: String(s.label),
          description: typeof s.description === 'string' ? s.description : undefined,
          recommended: s.recommended === true,
        }))
    : []
  // v0.25.2 fix：question 缺失或为空 → 不再拒绝重试。此前走「拒绝 + continue」
  // 会让 LLM 在参数解析持续失败里空转，门禁跳过、只会报错从不提问；
  // 现在与 suggestions 兜底（v0.18.x / v0.25.0 context-aware）同策略——
  // 注入上下文兜底问题后正常暂停，保证 ask_user 门禁始终可用。
  const hasQuestion = typeof rawQuestion === 'string' && rawQuestion.trim().length > 0
  const lowerQ = String(rawQuestion ?? '').toLowerCase()
  const question: string = hasQuestion
    ? (rawQuestion as string)
    : buildFallbackAskUserQuestion()
  if (!hasQuestion) {
    logger.warn('Agent', `ask_user.question 缺失或为空，注入兜底问题：${question}`, task.id)
  }
  // v0.18.x：suggestions 不足 2 个时注入兜底选项，避免前端拿不到建议卡
  // v0.25.0 F2 P1：兜底改为 context-aware —— 根据 question 关键字生成更合理的选项。
  // 同时始终保留「继续」+「暂停补充信息」两项兜底（与 v0.18.x 契约一致；测试断言依赖）。
  const isFailureQ = /(失败|fail|错误|err|异常|exception|超时)/.test(lowerQ)
  const isContinueQ = /(继续|下一步|继续运行|下一步要做什么|怎么继续|该做什么|选择下一步|怎么办)/.test(lowerQ)
  // v0.29.0 F6：兜底建议选项随 UI 语言切换（label/description 均为用户可见文案）
  const locale = getUiLocale()
  const contextualSuggestions = isFailureQ
    ? [
        { label: tFor(locale, 'suggest.retryStep.label'), description: tFor(locale, 'suggest.retryStep.desc') },
        { label: tFor(locale, 'suggest.skipStep.label'), description: tFor(locale, 'suggest.skipStep.desc') },
        { label: tFor(locale, 'suggest.retryOtherWay.label'), description: tFor(locale, 'suggest.retryOtherWay.desc') },
      ]
    : isContinueQ
      ? [
          { label: tFor(locale, 'suggest.resumeRun.label'), description: tFor(locale, 'suggest.resumeRun.desc') },
          { label: tFor(locale, 'suggest.finishHere.label'), description: tFor(locale, 'suggest.finishHere.desc') },
          { label: tFor(locale, 'suggest.changeDirection.label'), description: tFor(locale, 'suggest.changeDirection.desc') },
        ]
      : []
  // 保底兜底：始终含「继续」+「暂停」两项（v0.18.x 契约；description 描述补充）。
  const fallbackSuggestions = [
    { label: tFor(locale, 'suggest.continue.label'), description: tFor(locale, 'suggest.continue.desc') },
    { label: tFor(locale, 'suggest.pause.label'), description: tFor(locale, 'suggest.pause.desc') },
  ]
  const finalSuggestions =
    validatedSuggestions.length >= 2
      ? validatedSuggestions
      : [
          ...validatedSuggestions,
          ...contextualSuggestions,
          ...fallbackSuggestions,
        ].slice(0, 4)
  // v0.14.0 修复：与 task_complete 同理，补写配对 tool observation，
  // 避免 assistant tool_calls 悬空导致后续交互 400。
  // v0.19.x：多 action 时为每个 action 补写配对 observation。
  await appendPairedControlObservations({
    taskId: task.id,
    iteration,
    actions: pendingActions,
    actionIds: pendingActionIds,
    controlTool: 'ask_user',
    controlContent: '[ask_user] 已向用户提问，等待用户回复',
    skipPrefix: '[skipped] 已暂停等待用户，跳过：',
  })
  await emitEvent(task.id, {
    type: 'ask_user',
    iteration,
    question,
    // 透传 Agent 附带的建议选项（不足时已兜底为 2 项）
    suggestions: finalSuggestions,
  })
  // v0.19.0 M3：停止候选——先给监听器注入 continuation 的机会，注入则同轮继续
  if (await continueTurnIfInjected(task, iteration)) return true
  // v0.30.2 D12：打 ask_user 暂停标记 —— 用户答复后下一轮 run 据此识别为
  // 「答复型续聊」（清单保持不变，不触发重评/重建）；此处仅在确认暂停时写。
  await updateTask(task.id, {
    status: 'paused',
    pendingAskUser: { question, askedAt: Date.now() },
  })
  broadcastTaskStatus({ ...task, status: 'paused' })
  return false
}
