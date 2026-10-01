/**
 * v0.27.0 R2/F7：终止控制动作收尾（由 loop.ts 纯移动，行为不变）。
 * - finishViaTaskComplete：task_complete 分支（配对 observation + 完成态 + 里程碑 + 记忆钩子）
 * - pauseViaAskUser：ask_user 分支（参数兜底校验 + 配对 observation + continuation 注入判定）
 */

import {
  type Task,
  type ReActAction,
  type Agent,
  type LlmCompleteResponse,
  logger,
  updateTask,
  broadcastTaskStatus,
  broadcastTaskStatusStored,
  appendL1,
} from './engine-context.js'
import { emitEvent, emitProgress, safeSlice } from './broadcast.js'
import { appendPairedControlObservations } from './act.js'
import { runDoneMemoryHooks } from './memory-hooks.js'
import { buildFallbackAskUserQuestion, sealGraphForTaskOutcome } from './gates.js'
import { continueTurnIfInjected } from './abort.js'
// v0.37.0：统一完成门禁（账本版）+ 账本收口
// v0.38.0（D150/D151/D152/D153）：判定（ledger-guard）与投递（gate-channel）分离；
//   判据改为客观事实（workClass + touchedTree），拒绝计数唯一落点是账本。
// v0.39.0（D178/D183）：门禁放行后的在途项收口走 `forceCloseOpenItems`。
import { guardFinish, recordRefusal, forceCloseOpenItems } from './ledger-guard.js'
import { refuseViaGate, emitTurnNote } from './gate-channel.js'
import type { WorkClass } from './work-class.js'
import { sealLedger } from '../ledger/engine.js'
// v0.30.0：完成语义（Sync · S3 Write + S4 Gate）—— 用"验收通过"替代"模型宣称"
import { syncModelClaim } from '../graph/sync.js'
import { getUiLocale, tFor } from '../../i18n/messages.js'

export interface TurnEndCtx {
  task: Task
  agent: Agent
  modelId: string
  /**
   * v0.38.0（D150）：本 run 的工作性质（`classifyRunWork(toolsThisRun)` 的结果）。
   * 缺省 `'mutating'` —— 旧调用方（含测试）不传时按保守侧处理，只跳过「零写树」判定，
   * 不跳过 UNFINISHED。
   */
  workClass?: WorkClass
  /**
   * v0.38.0（D150）：本 run 是否触碰过任务清单（`touchesPlanTree` 累计）。
   * 缺省 `true` —— 与 v0.37.0 的 UNFINISHED 语义对齐（只判「清单是否有在途项」）。
   */
  touchedTree?: boolean
}

/* ────────────────────────────────────────────────────────────────
 * v0.39.0（D183）：**已删除** v0.32.1 的 D39「第二套完成守卫」
 *
 *   `MAX_COMPLETE_REFUSALS` + `refuseCompletionForLeftovers`
 *   + 「图侧 unfinishedTaskNodes」/「扁平 planItems」两套 leftover 判据
 *
 * 删除理由（与 D151 同型，缺一都不足以解释现场）：
 *   ① 它与 v0.38.0 的统一账本门禁 `guardFinish` **串联**：门禁先按
 *      `workClass + touchedTree` 拒一轮（账本 `resume.refusals` 上限 2），
 *      放行后再由 D39 用 run 局部 `completeRefusals` 又拒一轮（上限 2）
 *      → 单 run 最多 2 + 3 次拒绝，且第二套**不写账本**，现场无人能解释；
 *   ② 判据不同源：门禁读账本在途项，D39 读图节点/内存 planItems（v0.36.4 的
 *      「双通道对账」就是在给这个不同源打补丁，补丁本身又引入新的静默放行）；
 *   ③ 兜底自相矛盾：超限后 `discardIncompletePlanItems` 把未执行项收成
 *      `cancelled`（作废），而账本门禁超限后是「放行 + 收口」——两条路径对
 *      同一形态给出相反结论。
 *
 * 替代实现：门禁放行后统一由 `forceCloseOpenItems` 一次性收口在途项
 * （与 loop.ts 最终答复分支同口径，D178）；拒绝计数只有账本 `resume.refusals`
 * 一处，判据只有 `guardFinish` 一条。
 * ──────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────
 * v0.38.0（D150/D151/D152/D153）：**已删除** v0.36.6 的 D128 专用通道
 *
 *   `refuseCompletionForTreeSync` + `emitTreeSyncRefusal`
 *
 * 删除理由（三条，缺一都不足以解释现场）：
 *   ① 判据是代理变量：`treeSyncDebt = pendingTreeSync && !treeTouchedThisRun`，
 *      而 `pendingTreeSync` 由 `startIter > 0 && !isReplyContinuation && graphId`
 *      推出 —— 三个条件都不读用户输入内容，纯只读提问被判"新指令型续聊"（D150）；
 *   ② 计数与账本叠加：本通道用 run 局部 `completeRefusals === 0`、账本门禁用
 *      `resume.refusals`（上限 2），且本通道**不调** `recordRefusal`（账本留不下痕迹）
 *      → 单 run 稳定 `1 + 2 = 3` 次拒绝，与现场"连续三轮"精确吻合（D151）；
 *   ③ 投递即吞答复：拒绝时 `return true` 早退、不投 `task_complete` 事件，
 *      而 UI 的答复正文正是靠它投递 → 用户看不到任何答复（D152）。
 *
 * 替代实现：统一走 `gate-channel.ts` 的 `refuseViaGate`（system 指令 + 用户通告）
 * 与 `emitTurnNote`（被拒轮已生成的正文保底投递），判据由 `guardFinish`
 * 按 `workClass` + `touchedTree` 客观裁决。
 * ──────────────────────────────────────────────────────────────── */

/**
 * v0.39.0（D197）：`task_complete` 的 summary 兜底 —— **永不输出空串**。
 *
 * 此前两处收尾都是 `(action.args.summary as string) ?? safeSlice(response.thought, 500)`：
 * 模型既没给 summary、`thought` 又是空串时（全空回合的特征），兜底链**两级全空**，
 * 于是 `event.summary === ''` 一路传到渲染层，用户看到一条**空白的「答复」**而任务
 * 已被标完成（实机证据见 `reason-phase.ts` 的 D197 注释）。
 *
 * 兜底顺序（单一事实源，loop 与 turn-end 共用）：
 *   ① 模型显式 summary（trim 后非空）
 *   ② 本轮正文 thought（截 500 字）
 *   ③ 常量占位 —— 保证「完成」这件事在 UI 上永远有一句话可读
 */
/* @@ARKWORK-PURE:START@@ */
export function resolveCompleteSummary(
  args: Record<string, unknown> | undefined,
  thought: string | undefined,
): string {
  const explicit = typeof args?.summary === 'string' ? args.summary.trim() : ''
  if (explicit) return explicit
  const fromThought = safeSlice(thought ?? '', 500).trim()
  if (fromThought) return fromThought
  return '任务已完成（模型未附文字总结）'
}
/* @@ARKWORK-PURE:END@@ */

export async function finishViaTaskComplete(
  ctx: TurnEndCtx,
  action: ReActAction,
  response: LlmCompleteResponse,
  pendingActions: ReActAction[],
  pendingActionIds: string[],
  iteration: number,
): Promise<boolean> {
  const { task, agent, modelId } = ctx

  // ============================================================
  // v0.38.0（D150/D151/D152/D153）：**统一账本完成门禁**。
  //
  // 此前这里是两个并列守卫（D128 续聊零写树 + D134 清单未收口），判据全是代理变量、
  // 计数源有两套，叠加出"连续三轮被拦且不服告"的现场。现在只剩一条：
  //   · 判据客观 —— `workClass`（本 run 实际调过哪些工具）+ `touchedTree`（是否写过清单）；
  //   · 计数单一 —— 账本 `resume.refusals`，上限 `MAX_LEDGER_REFUSALS`；
  //   · 投递分离 —— 拒绝理由经 `refuseViaGate` 走 system 指令 + 用户通告两条通道，
  //     被拒轮模型**已经写好的正文**经 `emitTurnNote` 保底投给用户（治 D152）。
  // ============================================================
  const verdict = await guardFinish({
    taskId: task.id,
    iteration,
    workClass: ctx.workClass ?? 'mutating',
    touchedTree: ctx.touchedTree ?? true,
  })
  if (!verdict.allow) {
    await appendPairedControlObservations({
      taskId: task.id,
      iteration,
      actions: pendingActions,
      actionIds: pendingActionIds,
      controlTool: 'task_complete',
      controlContent: `[task_complete] 已受理，但任务清单未收口（${verdict.code}）`,
      skipPrefix: '[skipped] 等待清单收口，跳过：',
    })
    await recordRefusal(task.id)
    await refuseViaGate({
      taskId: task.id,
      iteration,
      code: verdict.code,
      message: verdict.message,
      refusals: verdict.refusals,
    })
    // D152 保底：被拒不等于"用户不该看到答案" —— 把模型本轮已生成的正文投出去。
    await emitTurnNote({
      taskId: task.id,
      iteration,
      text: (action.args.summary as string) ?? safeSlice(response.thought, 500),
      via: 'gate-refusal',
    })
    return true
  }

  // ============================================================
  // v0.39.0（D183）：**删除第二套完成守卫**。
  //
  // 这里原本在 `guardFinish` 之后又用 `MAX_COMPLETE_REFUSALS=2` + run 局部
  // `completeRefusals` 再拦一轮，且不走账本计数 —— 与门禁串联后单 run 最多
  // 产出 2 + 3 次拒绝，重演 D151「两套计数叠加、无人能解释」的教训。
  // 现在只有**一条**判据（guardFinish）与**一个**计数（账本 `resume.refusals`）。
  // 在途项的处理统一为：放行后一次性收口（与 loop 最终答复分支同口径，D178）。
  // ============================================================
  if (verdict.leftovers.length > 0) {
    await forceCloseOpenItems(
      task.id,
      `完成门禁放行（${verdict.reason}）：收口 ${verdict.leftovers.length} 项在途任务`,
    )
  }

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
    // v0.39.0（D197）：summary 兜底链的第三级（常量占位）见 resolveCompleteSummary
    summary: resolveCompleteSummary(action.args, response.thought),
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
  await sealLedger(task.id, 'completed', '任务完成（task_complete）')
  const updatedTask = await updateTask(task.id, { status: 'done', completedAt: Date.now() })
  broadcastTaskStatusStored(updatedTask, { ...task, status: 'done', completedAt: Date.now() })
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
  const updatedTask = await updateTask(task.id, {
    status: 'paused',
    pendingAskUser: { question, askedAt: Date.now() },
  })
  broadcastTaskStatusStored(updatedTask, { ...task, status: 'paused' })
  return false
}
