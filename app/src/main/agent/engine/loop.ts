/**
 * v0.27.0 R2（§3.1 引擎拆分）：ReAct 主循环：预算控制、Reason/Act 编排、迭代推进、终止分支
 * 由 engine.ts 纯移动而来；v0.27.0 F7 接缝抽取：前置准备→run-setup.ts、
 * Reason→reason-phase.ts、终止收尾→turn-end.ts、中断→abort.ts（均纯移动）。
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
  describeActionKey,
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
// v0.36.0 F1.5：问候循环守卫 + endpoint unhealthy 计数（协议层泛化，设计 §3.3）
import { createGreetingLoopGuard, markEndpointUnhealthy } from '../../llm/normalize.js'
// v0.31.0 D22：瞬时提示通道标签（技能体 vs 引擎提示，两类不得共用标签）
import { labelEngineHint, labelSkillHint } from './hints.js'
// v0.38.1（D177）：无工具答复的正则清单提取回退（与 task_plan 共用落库管线）
// v0.39.0：正文解析统一走规划通道的解析器（纪律⑧：一份语义，不许两份实现）
import { parsePlannerOutput } from '../planning/parse.js'
import { shouldCommitRegexDraft, initPlannerState, shouldRunPlanner, notePlannerRun, draftFingerprint } from '../planning/policy.js'
// v0.40.0（O1–O7）：清单操作通道 —— 清单的推进不再只依赖模型发起 `task_plan` tool_call
import { initPlanOpsState } from '../planning/ops/policy.js'
import { planOpsTick } from './plan-ops-tick.js'
// v0.39.0（W2 · F7）：失败摘要采集 + 阈值重排
import { pushFailureDigest } from '../planning/digest.js'
import { runPlannerPass, getPlannerModelId } from '../planning/runner.js'
import { PLANNER_FAILURE_THRESHOLD } from '../planning/types.js'
import type { PlannerFailureDigest, PlannerRequestItem } from '../planning/types.js'
import { loadLedger } from '../ledger/engine.js'
import { forceCloseOpenItems } from './ledger-guard.js'
// v0.42.1（D212）：终局指引唯一文案源（清单族被拦时回执/system hint 复用）
import { PLAN_TOOL_HINT } from '../ledger/hint.js'
import { commitPlanDraft } from './plan-commit-pipeline.js'
import { getUiLocale, tFor } from '../../i18n/messages.js'
import { safeSlice, emitEvent, emitProgress } from './broadcast.js'
import { emitContextSizeReport } from './context.js'
import { buildFallbackAskUserQuestion, markRunningPlanItemFailed, discardIncompletePlanItems, isProductiveTool, decidePlanAdvance, emitPlanStatus, sealGraphForTaskOutcome, reopenGraphForTaskRun } from './gates.js'
// v0.37.0：统一完成门禁（覆盖最终答复路径）+ 账本收口
// v0.38.0（D150/D151/D152/D153）：判定（ledger-guard）与投递（gate-channel）分离；
//   拒绝计数唯一落点是账本 `resume.refusals`；被拒轮已生成的正文经 gate-channel 保底投递。
import { guardFinish, recordRefusal } from './ledger-guard.js'
import { refuseViaGate, emitTurnNote } from './gate-channel.js'
// v0.41.0（D208）：Ollama qwen3.5 正文工具降级通道（提取器 / 谓词 / 契约提示）
import { extractProseToolCalls, isProseToolFallbackModel, proseToolContractHint } from './prose-tool-call.js'
// v0.38.0（D150）：本 run 工作性质分类 —— 只读白名单唯一事实源（纪律⑧）
import { classifyRunWork, isReadonlyTool, isPlanWriteTool, normalizeResponseToolNames } from './work-class.js'
// v0.38.0（D156）：阶段结论兜底投递策略（连续多轮无输出 → 请求进展）
import { createNotePolicyState, advanceNotePolicy, MAX_ROUNDS_WITHOUT_NOTE } from './turn-note-policy.js'
import { sealLedger } from '../ledger/engine.js'
// v0.34.0（D52）：零产出轮终局守卫（小模型空转 ≤6 轮即优雅暂停）
import { isStalledRound, planSignature, advanceStallCounter, isStallTerminal, MAX_STALLED_ROUNDS } from './stall.js'
// v0.38.0（D160）：伪工具调用检测 —— 模型把调用"演"成正文而非原生 tool_calls。
import { detectPseudoToolCallInTurn, PSEUDO_CALL_STOP_ROUNDS } from './pseudo-call.js'
import { tryGeneratePlan, generatePlan } from './plan.js'
import { findPlanItemForStage, renderPlanTreeSnapshot } from './plan-parser.js'
// v0.36.5（D126）：段末任务树陈旧提醒（对齐 ZCode todo_reminder）
import { shouldRemindTreeSync, touchesPlanTree, TREE_SYNC_REMIND_INTERVAL } from './plan-tree-sync.js'
import { applyStageGateAdvance } from '../graph/plan-sync.js'
import { injectSkillInstruction, broadcastSkillAutoLoaded } from './skills.js'
import { buildObservationSummary, collectActionsForIteration, appendPairedControlObservations, executeAct, toFinishedProgress } from './act.js'
import { maybePrecallCompact, assembleMessages, assembleTools } from './messages.js'
import { buildMemoryInjection, buildKbStatusLine, autoRecallKb, maybeAutoCompress, runDoneMemoryHooks, buildDistillContext } from './memory-hooks.js'
import type { ActContext, ActExecutionResult } from './act.js'
import { isPhaseHeader } from './plan-parser.js'
import { prepareRun } from './run-setup.js'
import { runReasonPhase, EMPTY_RESPONSE_ATTEMPTS } from './reason-phase.js'
import { finishViaTaskComplete, pauseViaAskUser, resolveCompleteSummary } from './turn-end.js'
import { handleAbort, continueTurnIfInjected } from './abort.js'

/* ============================================================
 * ArkWork — ReAct Engine
 * 设计文档 §9.1 — AsyncGenerator 推送事件流，可中断
 * ============================================================ */

export interface RunOptions {
  task: Task
  agent: Agent
  modelId: string
  signal: AbortSignal
  /** 最大迭代数（缺省 200；取值链见循环内 budget 解析） */
  maxIterations?: number
  /** 本运行是否已被新一次运行接管——被接管后退出时不再写入任务状态（v0.8.1） */
  stale?: () => boolean
  /**
   * v0.15.x Task 1+2：本运行的 generation（runner 在每次 runTask 时自增）。
   * 仅当 opts.stale 未传时使用此字段构造兜底 stale 闭包，避免重复维护 generation。
   * runner 通常直接传 stale()；独立调用方（如 task 直接走 engine）可仅传 startGeneration。
   */
  startGeneration?: number
}

// v0.28.0（F9）：参考 Claude Code / mini-harness / OpenCode 的宽松尺度全面放宽预算，
// 并支持项目级覆盖（task.config.budget.*，见 shared/types/task.ts TaskConfig）。
// 取值链统一为：opts.x ?? task.config.budget?.x ?? task.config.maxIterations(仅迭代数) ?? 常量。
const MAX_ITERATIONS = 200
// polish4 §D1.2：单 tool 调用次数上限（防 infinite loop / agent 反复调同 tool）
// v0.16.3：预算拆为两层：
// 1. 调用签名层（MD5(toolName + args)）：防止同参数反复执行
// 2. 工具类别层：防止整体工具过度使用；达限中断并 ask_user 询问是否继续
// v0.16.6：上调写入类预算（file-writer/file-editor/shell），签名层已能防"同参数反复执行"。
// v0.19.x：类别上限统一提高到 200；达限视为"任务执行时间过长"信号而非直接跳过。
// v0.28.0：签名层 3→5（分页读/多轮 grep 场景合法重复增多）；默认类 200→400、只读类 200→600
// （大型项目多文件探索与长 ReAct 链路需要更大余量）。
const MAX_PER_SIGNATURE = 5
const MAX_PER_TOOL_DEFAULT = 400
const MAX_PER_TOOL_READONLY = 600
/**
 * v0.34.4（D65）：**连续**「本轮所有请求的工具都被预算拦截」的轮数上限。
 *
 * 达到即优雅暂停（paused + ask_user），**不再 task_failed**。
 * 取 3 而非 D52 的 6：这一路是"引擎侧已无工具可用"的硬事实，
 * 不像零产出轮那样需要留观察窗口给模型自己找回节奏。
 *
 * 与 D52 的零产出守卫（`MAX_STALLED_ROUNDS=6`）关系：两条**独立**路径，
 * 谁先到谁结束；本路径更严（要求"本轮**每一个**工具都被拦"），
 * 零产出守卫更宽（含"只读空转但没被拦"）。
 */
const MAX_ALL_EXHAUSTED_ROUNDS = 3
// v0.28.1 fix：无工具调用回合的提示加强阈值。LLM 只回文字不调工具时，注入
// 提示让模型自愈；连续达到该阈值后提示升级为强指令（继续调工具 / task_complete
// 二选一）。不打扰用户——用户无从判断引擎内部状态；失控由 maxIterations 兜底。
const MAX_CONSECUTIVE_NO_TOOL = 2
// v0.38.1（D168）②：无工具「纯答复」轮的优雅暂停阈值 —— 在强提示
// （MAX_CONSECUTIVE_NO_TOOL）之后仍给 2 轮自纠机会，连满即转人工。
// 实测 0.8b 级模型对提示自愈无响应（say 非空 → stall 计数每轮归零、
// D160 伪调用守卫也不触发），原设计只能烧到 maxIterations（60 轮 ≈ 10 分钟假执行）。
const NO_TOOL_STOP_ROUNDS = 4
// v0.38.0（纪律⑧）：本地 `READONLY_TOOLS` 已删除 —— 只读白名单唯一事实源在
// `work-class.ts`，全仓只许调 `isReadonlyTool()` / `classifyRunWork()`。
// （此前 loop / registry / plan-tree-sync 各有一份，三份语义漂移是 D150 的温床。）

function getToolCategoryLimit(tool: string, readonlyLimit: number, defaultLimit: number): number {
  return isReadonlyTool(tool) ? readonlyLimit : defaultLimit
}

// v0.16.3：调用签名 key = MD5(toolName + args)
function getToolCallKey(tool: string, args: unknown): string {
  const payload = JSON.stringify({ tool, args })
  return createHash('md5').update(payload).digest('hex')
}

// v0.9.x：shell 写入命令特征（命中即视为产出性操作，清零只读停滞计数）
const WRITE_COMMAND_RE = /mkdir|tee|\bcp\b|\bmv\b|\becho\b|cat\s*>|>|\$\s*\(/i

/**
 * v0.34.x（D52）：零产出终局的优雅暂停（Act 路径与无工具分支共用）。
 * 与 maxIter 超限同一形态：paused + ask_user，把「模型能力不足」交给用户决策；
 * 刻意**不封图**、不标清单失败（暂停可恢复，见 D36）。
 */
async function pauseForStalledRounds(task: Task, iteration: number, rounds: number): Promise<void> {
  const question = tFor(getUiLocale(), 'askUser.stalledQuestion', { count: rounds })
  logger.warn('Agent', `${rounds} consecutive stalled rounds — paused for user decision`, task.id)
  await emitEvent(task.id, { type: 'max_iterations_reached', iteration })
  await emitEvent(task.id, {
    type: 'ask_user',
    iteration,
    question,
    suggestions: [
      { label: tFor(getUiLocale(), 'suggest.resumeRun.label'), description: tFor(getUiLocale(), 'suggest.resumeRun.desc') },
      { label: tFor(getUiLocale(), 'suggest.finishHere.label'), description: tFor(getUiLocale(), 'suggest.finishHere.desc'), action: 'finish' },
    ],
  })
  await updateTask(task.id, {
    status: 'paused',
    pendingAskUser: { question, askedAt: Date.now() },
  })
  broadcastTaskStatus({ ...task, status: 'paused' })
}

/**
 * v0.38.0（D160）：**「模型没在用工具调用」的优雅暂停 + 人话说明**。
 *
 * 与 `pauseForStalledRounds` 同形态（paused + ask_user，进度保留、可继续），
 * 但**原因必须讲清楚**：不是"没产出"，而是"模型把工具调用写成了正文"。
 * 用户据此能做出正确决策（换支持 function calling 的模型 / 关闭思考模式 /
 * 就此结束），而不是对着一堆"正在执行…"的假动作干等。
 *
 * 纪律⑨：静默退化是复合缺陷的粘合剂 —— 这条路径必须在诊断通道留人话。
 */
async function pauseForPseudoToolCalls(task: Task, iteration: number, tool: string): Promise<void> {
  // 纯文本（不含 Markdown / 反引号）：交互区原样渲染，带标记会显示成 `**` 噪音。
  const question =
    `已停止：模型连续 ${PSEUDO_CALL_STOP_ROUNDS} 轮没有发起真实工具调用，` +
    `而是把调用写成了正文（例如 ${tool}(…)）—— 这类文字引擎无法执行。\n` +
    `这通常表示当前模型 / 端点未启用工具调用（function calling）能力。` +
    `可尝试：换用支持工具调用的模型，或在 Ollama 侧关闭「思考 / 推理」模式后重试。`
  logger.warn(
    'Agent',
    `model emits pseudo tool calls instead of native tool_calls (${tool}) for ${PSEUDO_CALL_STOP_ROUNDS} rounds — paused`,
    task.id,
  )
  await emitEvent(task.id, { type: 'max_iterations_reached', iteration })
  // 人话正文**额外**走 turn_note（NoteBlock）：实测 ask_user 卡片只渲染建议按钮，
  // 正文不显示 —— 只靠它等于仍然静默（纪律⑨）。NoteBlock 是已验证可见的通道。
  await emitTurnNote({ taskId: task.id, iteration, text: question, via: 'engine-stop' })
  await emitEvent(task.id, {
    type: 'ask_user',
    iteration,
    question,
    suggestions: [
      { label: '换个模型重试', description: '改用支持工具调用（function calling）的模型后重新运行本任务' },
      { label: '就此结束', description: '保留当前进度，不再自动执行', action: 'finish' },
    ],
  })
  await updateTask(task.id, {
    status: 'paused',
    pendingAskUser: { question, askedAt: Date.now() },
  })
  broadcastTaskStatus({ ...task, status: 'paused' })
}

/**
 * v0.39.0（D197）：**「端点连续空响应」的优雅暂停 + 人话说明**。
 *
 * 与 `pauseForStalledRounds` / `pauseForPseudoToolCalls` 同形态
 * （paused + ask_user，进度保留、可继续），但**这不是「模型没产出」，而是
 * 「端点一个字符都没给」**：reason 阶段首轮 + 补试共 `EMPTY_RESPONSE_ATTEMPTS`
 * 次调用全部返回「content / thought / actions 全空」。
 *
 * 为什么必须停：空回合既没有正文可交付、也没有动作可执行。此前补试用尽后
 * 没有第三级处置，空响应顺着「未调工具 + 清单无未完成项 + 未截断」三条判定
 * 一路走到成功分支，用**空 summary**把任务封成 completed —— 用户看到一条
 * 空白的「答复」，却没有任何可继续的入口（实机证据见 reason-phase.ts D197）。
 *
 * 纪律⑨：静默退化是复合缺陷的粘合剂 —— 这条路径必须在诊断通道留人话。
 */
async function pauseForEmptyResponses(task: Task, iteration: number, attempts: number): Promise<void> {
  // 纯文本（不含 Markdown / 反引号）：交互区原样渲染，带标记会显示成 `**` 噪音。
  const question =
    `已停止：模型连续 ${attempts} 次返回空响应（既无正文、也无工具调用），本轮没有任何内容可交付。\n` +
    `这通常是推理端点侧的问题（模型服务重启 / 上下文超限 / 思考模式空转），不是任务本身出错 —— 任务不会被标记完成。\n` +
    `可尝试：确认模型服务正常后点「继续」重试；或就此结束，保留已有进度。`
  logger.warn(
    'Agent',
    `empty response for ${attempts} consecutive attempts — paused (no content / no tool call)`,
    task.id,
  )
  await emitEvent(task.id, { type: 'max_iterations_reached', iteration })
  // 人话正文额外走 turn_note（NoteBlock）：ask_user 卡片只渲染建议按钮（同 D160）。
  await emitTurnNote({ taskId: task.id, iteration, text: question, via: 'engine-stop' })
  await emitEvent(task.id, {
    type: 'ask_user',
    iteration,
    question,
    suggestions: [
      { label: tFor(getUiLocale(), 'suggest.resumeRun.label'), description: tFor(getUiLocale(), 'suggest.resumeRun.desc') },
      { label: tFor(getUiLocale(), 'suggest.finishHere.label'), description: tFor(getUiLocale(), 'suggest.finishHere.desc'), action: 'finish' },
    ],
  })
  await updateTask(task.id, {
    status: 'paused',
    pendingAskUser: { question, askedAt: Date.now() },
  })
  broadcastTaskStatus({ ...task, status: 'paused' })
}

/**
 * v0.38.1（D168）②：**「模型只用文字答复、不按清单收尾」的优雅暂停 + 人话说明**。
 *
 * 与 `pauseForPseudoToolCalls` 同形态（paused + ask_user，进度保留、可继续）。
 * 差异：伪调用守卫管「把调用写成正文」；本守卫管「连调用都不写、纯聊天」——
 * 引擎的提示自愈对能力不足的模型无效，烧到 maxIterations 只会让用户对着
 * 「正在执行…」干等十分钟。转人工并讲清原因（纪律⑨）。
 */
async function pauseForNoToolAnswerStall(
  task: Task,
  iteration: number,
  openCount: number,
  rounds: number,
): Promise<void> {
  // 纯文本（不含 Markdown / 反引号）：交互区原样渲染，带标记会显示成 `**` 噪音。
  const question =
    `已停止：模型连续 ${rounds} 轮只输出文字答复，未调用任何工具，清单仍有 ${openCount} 项未完成。\n` +
    `这通常表示当前模型较弱，无法按提示完成清单收尾（task_plan / task_complete）。\n` +
    `可尝试：换用更强的模型后重试；或就此结束 —— 模型的答复已保留在对话中。`
  logger.warn(
    'Agent',
    `model keeps answering in prose without tool calls for ${rounds} rounds (${openCount} open items) — paused`,
    task.id,
  )
  await emitEvent(task.id, { type: 'max_iterations_reached', iteration })
  // 人话正文额外走 turn_note（NoteBlock）：ask_user 卡片只渲染建议按钮（同 D160）。
  await emitTurnNote({ taskId: task.id, iteration, text: question, via: 'engine-stop' })
  await emitEvent(task.id, {
    type: 'ask_user',
    iteration,
    question,
    suggestions: [
      { label: '换个模型重试', description: '改用更强的模型后重新运行本任务' },
      { label: '就此结束', description: '保留当前进度与答复，不再自动执行', action: 'finish' },
    ],
  })
  await updateTask(task.id, {
    status: 'paused',
    pendingAskUser: { question, askedAt: Date.now() },
  })
  broadcastTaskStatus({ ...task, status: 'paused' })
}

/**
 * v0.34.4（D65）：**预算耗尽终局的优雅暂停**。
 *
 * 此前这里是 `task_failed`（硬失败）。用户实测看到的是：
 *   「运行出错：请查看上方错误信息」+ 重试 / 停止
 * —— 一个**没有任何可选动作的死胡同**，与 D52 写在 `stall.ts` 的意图
 * （「把『模型能力不足』这类事实如实交给用户判断」）自相矛盾。
 *
 * 两者的语义本该相同：都是「引擎侧资源耗尽，不是任务本身的错」。
 * 因此统一走 paused + ask_user：进度保留、可不封图、可继续运行（模型会换工具）、
 * 可调整描述后重试、也可就此结束。
 */
async function pauseForBudgetExhausted(task: Task, iteration: number, rounds: number): Promise<void> {
  const question = tFor(getUiLocale(), 'askUser.budgetExhaustedQuestion', { count: rounds })
  logger.warn(
    'Agent',
    `all tools exhausted for ${rounds} consecutive iterations — paused for user decision`,
    task.id,
  )
  await emitEvent(task.id, { type: 'max_iterations_reached', iteration })
  await emitEvent(task.id, {
    type: 'ask_user',
    iteration,
    question,
    suggestions: [
      { label: tFor(getUiLocale(), 'suggest.resumeRun.label'), description: tFor(getUiLocale(), 'suggest.resumeRun.desc') },
      { label: tFor(getUiLocale(), 'suggest.finishHere.label'), description: tFor(getUiLocale(), 'suggest.finishHere.desc'), action: 'finish' },
    ],
  })
  await updateTask(task.id, {
    status: 'paused',
    pendingAskUser: { question, askedAt: Date.now() },
  })
  broadcastTaskStatus({ ...task, status: 'paused' })
}

export async function runReActLoop(
  opts: RunOptions,
): Promise<void> {
  const { task, agent, signal } = opts
  // v0.28.0（F9）：预算取值链 —— 显式 opts > 项目 agent.budget 配置 > 旧版扁平 maxIterations（仅迭代数）> 内置常量
  const budgetCfg = task.config.budget
  const maxIter =
    opts.maxIterations ?? budgetCfg?.maxIterations ?? task.config.maxIterations ?? MAX_ITERATIONS
  const maxPerSignature = budgetCfg?.maxPerSignature ?? MAX_PER_SIGNATURE
  const catReadonlyLimit = budgetCfg?.maxPerToolReadonly ?? MAX_PER_TOOL_READONLY
  const catDefaultLimit = budgetCfg?.maxPerToolDefault ?? MAX_PER_TOOL_DEFAULT
  // v0.15.x Task 1+2：stale 兜底 — runner 通常会传 opts.stale（基于其内部
  // generations Map）。若调用方只传 startGeneration（绕过 runner 跑 engine 的
  // 场景），engine 没有外部 generation 查询源，无法做真实 stale 检查 —— 此时
  // 返回一个始终为 false 的兜底闭包，避免误判接管导致静默退出。
  // 正常路径下优先使用 opts.stale。
  const startGenerationStored = opts.startGeneration
  const stale: ((() => boolean) | undefined) =
    opts.stale
    ?? (startGenerationStored !== undefined
      ? () => false  // 退化路径：engine 不知 generation 变化，永远不视为 stale
      : undefined)

  // polish4 §D1.2：单 tool 调用次数上限（防 infinite loop）
  // v0.16.3：拆为两层预算：调用签名（MD5(tool+args)）+ 工具类别
  const toolSignatureBudget = new Map<string, number>()
  const toolCategoryBudget = new Map<string, number>()
  // Phase A Task 1：同任务内同一调用签名已达预算上限仅记录一次 L2/L3 日志，避免 UI 日志噪音
  const budgetWarnedKeys = new Set<string>()
  // v0.19.x：达限中断状态 —— 类别预算触顶时只 ask_user 一次（本次 run 内），
  // 用户回复"继续"后新 run 会重置预算计数；同参数重复调用被拦截次数（重点关注信号）
  let budgetInterrupted = false
  let signatureBlockedTotal = 0
  // 连续多轮所有 action 均被跳过计数（避免模型反复尝试已耗尽签名导致空转）
  let consecutiveSkippedIterations = 0
  // v0.28.1 fix：连续「无工具调用但清单未完成/输出被截断」计数。用于把注入的
  // 自愈提示从温和版升级为强指令版；有工具调用时归零。
  let consecutiveNoToolFinal = 0
  // v0.39.0（D183）：**已删除** `completeRefusals` —— 它就是 D151 现场「1+2=3 三次
  // 拒绝」的那一半。拒绝计数的唯一落点是账本 `resume.refusals`（`guardFinish` 读写），
  // run 局部计数此后**不得**再出现在任何完成判定里。
  // v0.38.0（D150）：本 run 实际调用过的全部工具名（客观事实来源）。
  // 完成门禁据此判 `workClass`，取代此前的三个代理变量（startIter / isReplyContinuation / graphId）。
  const toolsThisRun: string[] = []
  // v0.38.0（D156）：阶段结论兜底节流状态（连续 N 轮无输出 → 请求进展）。
  let notePolicy = createNotePolicyState()
  // v0.34.0（D52）：连续「零产出轮」计数 —— 判定见 stall.ts。
  // 用户实测：小模型每轮都成功调只读工具、内容全空，既有保护（无工具调用 /
  // 同签名 / 只读提示）一个都不触发，直到 maxIterations=200（≈100 分钟）。
  let consecutiveStalledRounds = 0
  // v0.34.x：上一轮叙述签名（freshNarrative 的重复检测基准）
  let prevNarrativeSig = ''
  // v0.38.0（D160）：连续「无工具调用 + 正文出现伪调用」计数。
  // 判据**独立于** `consecutiveStalledRounds` —— 后者把"一直在说话"算作有产出
  // （hasSayOutput → 计数归零），而伪调用正是"一直在说话但没真动作"，
  // 因此必须单独计：实机 qwen3.5:9b 空转 21 轮，stall 守卫一次都没触发。
  let consecutivePseudoNoTool = 0
  /** v0.39.0（D182）：本 run 已由「文本解析回退」代为落库的次数（上限 MAX_REGEX_COMMITS_PER_RUN） */
  let regexCommits = 0
  /**
   * v0.39.0（F1）：本 run 的规划通道预算与冷却状态（纯数据结构，policy.ts 管判定）。
   * 每 run 归零 —— 预算是「这一次 run 最多烧几次额外调用」，不是跨 run 配额。
   */
  let plannerState = initPlannerState()
  /**
   * v0.39.0（W2 · F7）：本 run 的失败摘要环形缓冲。
   * 同一 itemId + tool 的重复失败会累加 `attempts`，连满 PLANNER_FAILURE_THRESHOLD
   * 次即触发一次「换回合重排」—— 触发后清空，把机会留给**新的**连续失败。
   */
  let failureDigest: PlannerFailureDigest[] = []
  /** v0.39.0（D180）：完成门禁拒绝计数**写入失败**的连续次数（有界放行兜底用） */
  let refusalWriteFailures = 0
  /** 连续写失败达此次数即认为门禁计数已失能 → 有界放行（D180） */
  const MAX_REFUSAL_WRITE_FAILURES = 2

  // 标记任务为 running
  await updateTask(task.id, { status: 'running', startedAt: Date.now() })
  broadcastTaskStatus({ ...task, status: 'running' })

  // v0.32.1（缺陷 D36 配套）：**新一轮执行开始时重开图**。
  // 收口（sealGraphForTaskOutcome）是单向的，而任务是可继续的：`done` 后续聊、
  // `failed` / `cancelled` 后重试都会再跑一轮。若不重开，续聊时会看到
  // 「任务在跑、图显示已完成/已取消」的反向矛盾（与 D36 同源）。
  // 幂等：图已是 in_progress 时不落盘、不广播；无图任务（tier 0/1）直接返回。
  await reopenGraphForTaskRun(task, '新一轮执行开始')

  // Task 9：任务启动 → 初始化进度摘要（默认进入第一阶段「开源调研」，
  // 整体 5%；由 Renderer 收到 task_progress 事件后落地 taskProgress）
  await emitProgress({
    type: 'task_progress',
    taskId: task.id,
    currentStage: 'research',
    stageIndex: 0,
    overallPercentage: 5,
    nextStepLabel: '启动规划',
  })

  logger.info('Agent', `ReAct loop started for ${task.id} (@${agent.id})`, task.id)

  // polish4 §D1.1：循环顶部 stale guard（已在 handleAbort 里，但仍需顶部守门）
  if (stale?.()) {
    logger.warn('Agent', 'reconcile stale run at start', task.id)
    return
  }

  try {
    // v0.27.0 R2/F7：运行前置准备（system_prompt 注入 / 记忆·门禁·技能初始化 /
    // 首轮 Plan 生成与续聊 plan-regen）抽至 run-setup.ts（纯移动，行为不变）。
    const prepared = await prepareRun({ task, agent, modelId: opts.modelId, signal })
    const { startIter, memoryInjection, alwaysOnContracts, docDriven, coreSkillsEnabled, allowedStage } = prepared
    // v0.38.1（D170）：对话级任务 —— 首轮 plan 时模型显式回 `[]`（Tier 0），
    // 模型的正文答复即为最终答复（答复即终局），不把兜底占位项当「未完成工作」。
    const chatMode = prepared.chatMode
    let pendingSystemHint = prepared.pendingSystemHint
    let iteration = startIter
    // v0.9.x：连续"只读探索"轮数（>=3 时注入产出提示，防空工作区无限探索）
    let consecutiveReadOnly = 0
    // v0.36.5（D126）：距上次写树动作（v0.38.0 起 = task_plan）的轮数。
    // 达阈值 → 段末注入陈旧提醒 + 树快照（ZCode todo_reminder 对应物），
    // 触发后归零防刷屏。跨 run 不持久 —— 中断/续聊场景由 run-setup 续聊 hint（D125）负责重评。
    //
    // v0.38.0（D150/D151）：**删除** v0.36.6 的「新指令型续聊 → 欠账满额启动」——
    // `pendingTreeSync` 由 `startIter > 0 && !isReplyContinuation && graphId` 三个代理变量
    // 推出，把纯只读提问误判为"新指令型续聊"（现场连续三轮被拦的根因）。
    // 现在统一从 0 起算，续聊与首轮同待遇；是否"零写树"由 `treeTouchedThisRun` 客观记录。
    let itersSinceTreeTouch = 0
    let treeTouchedThisRun = false
    // v0.40.0（O2）：清单操作通道的 run 级预算与「上一轮事实」信号。
    // 状态放在循环外：预算必须跟「一次 run」绑定，而轮内的 `continue` 有十几处，
    // 任何一处跳过都会让预算/冷却失真（D179 同族病根：判定块被埋在分支里）。
    let planOpsState = initPlanOpsState()
    let planOpsJustSucceeded = false
    // v0.40.0（真机修正）：弱模型「只用正文干活」也必须算进展信号。
    // 实测（`T-20260928-4t5z6k` + 本地 0.8b）：只看 `planOpsJustSucceeded` 时，
    // `plan-ops` 日志**零命中** —— 模型从不调工具 → 恒 false；也不是空回合 →
    // 一路烧到 D168 的 6 轮暂停，清单停在初始 4 项。
    let planOpsHadProse = false
    let planOpsLastEvent = ''
    // v0.36.0 F1.5：问候循环守卫 —— 基准 = 用户原始输入（task.input.text），
    // 连续 3 轮响应与基准同前缀 → 注入纠正指令 + endpoint unhealthy 计数（§3.3 泛化）
    const greetingGuard = createGreetingLoopGuard({ reference: task.input?.text ?? '' })
    const greetingEndpoint = (await getModel(opts.modelId))?.baseURL
    // v0.41.0（D208）：Ollama qwen3.5 正文工具降级通道 —— **run 级一次判定**。
    // 谓词默认关闭：非 ollama 形态 / 非 qwen3.5 模型，后续所有分支零变化
    //（纪律㊵：安全默认与放行开关分离；影响面见 04-system-design §2.3）。
    const proseToolFallback = isProseToolFallbackModel(await getModel(opts.modelId))
    if (proseToolFallback) {
      logger.info('Agent', 'prose tool fallback armed (ollama qwen3.5) — 正文工具降级通道已激活', task.id)
    }
    while (iteration < startIter + maxIter) {
      iteration += 1
      if (signal.aborted) {
        await handleAbort(task, iteration, stale)
        return
      }

      // v0.28.1 fix B：每轮迭代开始前从 store 同步最新清单到本地引用。
      // planItems 存在循环外写入方 —— 用户在 UI 中途编辑（ipc/plan-items）、
      // 暂停恢复 restorePlanItems（pause/manager）等均为整组数组替换，不经本地引用；
      // 若不同步，「无工具调用守卫」会基于过期清单计算未完成数：漏判 → 提前 done，
      // 多判 → 无意义提示空转。同步点同时让阶段门禁推进 / 清单状态注入读到实时数据。
      try {
        const freshTask = await getTask(task.id)
        if (freshTask?.planItems) task.planItems = freshTask.planItems
      } catch (syncErr) {
        logger.warn('Agent', `planItems sync skipped: ${(syncErr as Error).message}`, task.id)
      }

      // ============================================================
      // v0.40.0（O2 · 缺陷 D200）：轮首「清单推进」tick。
      //
      // 补的是 v0.39.0 留下的**夹缝**：规划通道只管「生成」，而正文解析回退
      // （下方 `!action && pendingActions.length === 0` 分支）的前提是「本轮
      // **零**工具调用」。于是最高频的真实情形 —— 模型调了 `file-reader`
      // 却没调 `task_plan` —— 两条路都不覆盖，清单纹丝不动。
      //
      // 放在**轮首**而不是轮末：轮内有十几处 `continue`（伪调用 / 停滞 /
      // 文本解析各自早退），放在轮末会被它们整片跳过；轮首只依赖「上一轮的
      // 客观事实」，不受本轮怎么结束影响。
      //
      // 三条自限（缺一即变成"又多烧一次 token"）：
      //   ① 受每 run 预算（MAX_PLAN_OPS_PER_RUN）硬约束，且预算判定优先于一切豁免；
      //   ② 失败静默回落 —— 主循环**照常**往下走，清单维护是增强不是前置条件；
      //   ③ 用户中止（AbortError）原样上抛 —— 吞掉它会让「停止」按钮失灵。
      // ============================================================
      try {
        const tick = await planOpsTick({
          task,
          round: iteration,
          modelId: opts.modelId,
          signal,
          state: planOpsState,
          signals: {
            failedCount: failureDigest.reduce((m, f) => Math.max(m, f.attempts ?? 0), 0),
            staleRounds: itersSinceTreeTouch,
            justSucceeded: planOpsJustSucceeded,
            hadProse: planOpsHadProse,
            cancelRequested: false,
            emptyRound: false,
          },
          event: planOpsLastEvent || '（本轮之前尚无进展记录）',
        })
        planOpsState = tick.state
        if (tick.changed) {
          // tick 真的写了账本 → 视同「本 run 触碰过清单」（与 D126 同口径，
          // 避免陈旧提醒刚被 tick 解决完又立刻触发一遍）
          itersSinceTreeTouch = 0
          treeTouchedThisRun = true
        }
      } catch (tickErr) {
        if (signal.aborted) {
          await handleAbort(task, iteration, stale)
          return
        }
        logger.warn('Agent', `plan-ops tick skipped: ${(tickErr as Error).message}`, task.id)
      }

      // -------- Reason --------
      // Reason 主体（消息组装 / system 契约装配 / 流式 LLM 调用 / 重试与
      // Reactive Fallback 压缩 / reasoning 落盘广播）→ reason-phase.ts（F7 纯移动）
      const { response, emptyExhausted } = await runReasonPhase({
        task,
        agent,
        modelId: opts.modelId,
        signal,
        iteration,
        pendingSystemHint,
        memoryInjection,
        alwaysOnContracts,
        // v0.41.0（D208）：降级通道激活 → 请求级 think:true（TC-PTL-005）
        proseToolFallback,
      })
      pendingSystemHint = undefined  // reason 内已消费（原 L695 语义），防陈旧 hint 重复注入
      // ============================================================
      // v0.39.0（D197）：补试用尽仍是「全空回合」→ **就地终止本 run**。
      //
      // 这里是唯一的拦截点，位置刻意放在**完成门禁之前**：再往下走，
      // 空响应会满足「未调工具 ✓ + 清单无未完成项 ✓ + 未截断 ✓」三条判定，
      // `guardFinish` 对它天然放行，于是被当成「最终答复」收尾 ——
      // `summary` 取 `response.thought`（空）→ 用户看到一条空白的「答复」
      // 而任务已被标 completed（实机证据见 reason-phase.ts 的 D197 注释）。
      //
      // 语义依据：`llm-call.ts` 给 `isIncompleteLlmResponse` 的定义就是
      // 「必须重试或失败，**不能算完成**」—— 空回合无正文可交付、无动作可执行。
      // ============================================================
      if (emptyExhausted) {
        // ============================================================
        // v0.40.0（O7 · 缺陷 D201）：空回合**先给清单一次推进机会**，再决定暂停。
        //
        // 此前空响应等价于「清单永久停摆」—— 这是「任务在跑但清单不动」的
        // 最坏形态。现在先用上一轮的既有事实例行维护一次清单：
        //   · 清单动了 → 说明任务仍有可推进的东西，**继续跑**；
        //   · 清单没动 → 走既有 `pauseForEmptyResponses` 优雅暂停（**不旁路** D197）。
        //
        // 为什么不会变成无限循环：`force` 只豁免「轮间隔」，**不豁免预算**
        // （`shouldRunPlanOps` 里预算判定排在豁免之前）。预算用尽后 tick 恒
        // `changed=false`，控制流自然落到下面的暂停。
        // ============================================================
        let advancedByOps = false
        try {
          const tick = await planOpsTick({
            task,
            round: iteration,
            modelId: opts.modelId,
            signal,
            state: planOpsState,
            signals: {
              failedCount: failureDigest.reduce((m, f) => Math.max(m, f.attempts ?? 0), 0),
              staleRounds: itersSinceTreeTouch,
              justSucceeded: planOpsJustSucceeded,
              hadProse: planOpsHadProse,
              cancelRequested: false,
              emptyRound: true,
            },
            event: planOpsLastEvent || '模型本轮返回了空响应（既无正文、也无工具调用）',
          })
          planOpsState = tick.state
          advancedByOps = tick.changed
          if (tick.changed) {
            itersSinceTreeTouch = 0
            treeTouchedThisRun = true
            logger.warn(
              'Agent',
              `empty response but plan advanced via plan-ops (${tick.kind}) — 继续下一轮（不暂停）`,
              task.id,
            )
          }
        } catch (opsErr) {
          if (signal.aborted) {
            await handleAbort(task, iteration, stale)
            return
          }
          logger.warn('Agent', `plan-ops empty-round advance skipped: ${(opsErr as Error).message}`, task.id)
        }
        if (advancedByOps) continue
        await pauseForEmptyResponses(task, iteration, EMPTY_RESPONSE_ATTEMPTS)
        return
      }
      // v0.38.0（D159）：工具名归一化 —— **唯一摄取点**（任何分支 / 统计之前）。
      // 实机证据（2026-09-25 22:33 现场）：模型偶发把引擎自有下划线名写成连字符
      // （`task-plan`），未归一时 act 拦截分支不认 → 掉进 registry 报错 →
      // classifyRunWork 误判 mutating → 完成门禁误拦（连续三轮被拒）。
      // v0.40.0（真机修正 · 信号采集点 A）：本轮「有没有正文」必须在这里记，
      // 不能挪到 Act 之后 —— 无工具分支（下方 `!action && pendingActions.length === 0`）
      // 有十几处 `continue`，一旦跳过 Act 之后的采集点，弱模型的每一轮都采不到信号，
      // 清单维护通道就永远不会被触发（真机实测的原始病态）。
      // 同时把 `planOpsJustSucceeded` 复位：本轮的成败由下方 Act 分支重新置位。
      planOpsHadProse = Boolean((response.content ?? '').trim() || (response.thought ?? '').trim())
      planOpsJustSucceeded = false
      normalizeResponseToolNames(response)
      // ============================================================
      // v0.41.0（D208）：正文工具降级通道 —— 合成动作**回灌点**。
      //
      // 位置即防线（TC-PTL-001）：必须在 `normalizeResponseToolNames` 之后
      // （名字已归一），且在 `const action = response.action` **之前** ——
      // 合成动作写回 response 后，与原生 tool_calls 走**同一条** Act / 预算 /
      // observation 配对 / 门禁链路，零旁路（不进无工具分支、不碰 D179 固定序）。
      //
      // 触发条件三要素（TC-PTL-002）：谓词命中 + 无原生 action + 无 pendingActions
      // —— 原生 tool_calls 永远优先，降级只兜「模型不会 function calling」的场。
      // ============================================================
      if (proseToolFallback && !response.action && (response.actions?.length ?? 0) === 0) {
        const extracted = extractProseToolCalls(response.content)
        if (extracted.calls.length > 0) {
          const synthesized: ReActAction[] = extracted.calls.map((c) => ({ tool: c.tool, args: c.args }))
          response.actions = synthesized
          response.action = synthesized[0] ?? null
          // `prose_` 前缀：observation 配对可归因（区分原生 tool_call id，TC-PTL-003）
          response.toolCallIds = synthesized.map((_, i) => `prose_${iteration}_${i}`)
          logger.warn(
            'Agent',
            `prose tool fallback: ${synthesized.map((a) => a.tool).join(', ')}` +
              (extracted.invalid > 0 ? `（另有 ${extracted.invalid} 个无效调用已跳过）` : '') +
              ' — 正文工具降级通道代为执行',
            task.id,
          )
        } else if (extracted.invalid > 0) {
          logger.warn(
            'Agent',
            `prose tool fallback: ${extracted.invalid} 个疑似工具调用因白名单/参数不合法被拒（宁缺毋滥）`,
            task.id,
          )
        }
      }
      // -------- 检查终止 --------
      // v0.14.x Task 1：以"是否确有工具调用"为准（collectActionsForIteration 会同时读
      // response.actions 与 response.action），防止适配器只回传 actions（未填 action 单
      // 字段）时把"还要继续跑"误判为最终答复 → 任务被提前置 done / 清单被提前勾完。
      const action = response.action
      const pendingActions = collectActionsForIteration(response)
      // v0.34.x：本轮叙述是否「翻新」（非空且与上一轮不同）—— 探索类任务的
      // 只读探索每轮有新发现，不能算零产出（D52 误杀修正，见 stall.ts）。
      // 叙述签名优先级：thought（content 正文）> reasoning（原生思考）——
      // 真机 qwen3.5:9b 实测：探索阶段叙述**全走 reasoning 通道**、content 恒空
      // （每轮 100 tokens 思考 + 读新文件），只看 thought 会再次误杀；
      // 而 0.8b 空转案例的 reasoning 每轮雷同（≤19 tokens 复读）或全空，仍拦得住。
      // 只在签名非空时更新基准：空轮不清基准，重复检测始终对上一条真叙述进行。
      const thoughtTrim = (response.thought ?? '').trim()
      const reasoningTrim = (response.reasoningContent ?? '').trim()
      const narrativeSig = thoughtTrim || reasoningTrim
      const freshNarrative = !!(narrativeSig && narrativeSig !== prevNarrativeSig)
      if (narrativeSig) prevNarrativeSig = narrativeSig

      // v0.19.x：提前计算每个 action 对应的 toolCallId（与 Act 阶段口径一致），
      // 供 task_complete / ask_user 分支补写"跳过"observation。否则多 action 时
      // 只写控制动作的 observation，其余 assistant tool_calls 悬空，每轮触发
      // reconcileToolCalls "stripped dangling tool_calls"（并有 OpenAI 兼容端点 400 风险）。
      const pendingActionIds: string[] =
        response.toolCallIds && response.toolCallIds.length === pendingActions.length
          ? response.toolCallIds
          : pendingActions.map((_, i) => `call_${iteration}_${i}`)

      // v0.36.0 F1.5：问候循环守卫观测（在无工具/有工具两分支之前）。
      // 触发 → 注入纠正指令（下一轮 Reason 生效）+ endpoint unhealthy 计数；
      // 无工具时由下方 no-tool 分支接管（greetingLoopTriggered 进入提示路径，
      // 不再误判为「最终答复」→ 防 greeting 被当成 task done 的收尾）。
      let greetingLoopTriggered = false
      if (greetingGuard) {
        const verdict = greetingGuard.observe(response.content ?? '')
        if (verdict.repeated) {
          greetingLoopTriggered = true
          const unhealthy = markEndpointUnhealthy(greetingEndpoint, opts.modelId)
          logger.warn(
            'Agent',
            `greeting-loop guard: response repeats first user message (endpoint unhealthy count: ${unhealthy})`,
            task.id,
          )
        }
      }
      if (greetingLoopTriggered) {
        const greetingUnfinished = (task.planItems ?? []).some(
          (p) => p.status === 'running' || p.status === 'pending' || p.status === 'paused',
        )
        pendingSystemHint = labelEngineHint(
          '你已连续多轮回复与用户第一条消息重复的内容（疑似问候循环）。请停止复述问候语，' +
            '阅读系统提示与任务清单，直接推进当前任务：调用工具执行未完成项，或给出针对任务的实质回复。' +
            (greetingUnfinished ? '' : '若任务确已完成，调用 task_complete 并在 summary 中说明。'),
        )
      }
      if (!action && pendingActions.length === 0) {
        // v0.38.1（D177）：正则清单提取回退 —— 用户裁决「要有策略让小模型也能完成任务
        // 生成 / 替换」。实机 qwen3.5:9b（S2 ⚠️）在重上下文下不发起原生 tool_calls，
        // 而把任务清单直接写成正文（fenced JSON / 编号列表）→ 引擎解析出 0 个动作 →
        // 清单永远建立不起来。此处用纯函数提取器扫描无工具答复：能提取出清单草案就
        // 走与 task_plan **同一条**落库管线（plan-regex 管线，纪律⑧）代为登记，然后
        // 注入提示让模型继续执行。changed=0（重复提交同一清单）不 continue —— 落回
        // 既有守卫链，防止「提交 → 再解析 → 再提交」的无限循环。
        // v0.28.1 fix：无工具调用的回合并不总是「最终答复」。
        // 1) finish=length 且无 action → 工具调用大概率被输出长度截断，注入提示让模型自愈
        // 2) 任务清单仍有未完成项（running/pending）→ LLM 提前收尾：注入提示引导其继续
        // 处理策略：不打扰用户（用户无从判断引擎内部状态），全部交给模型自纠——
        // 首次温和提示，连续多次无工具调用则提示加强（明确二选一：继续调工具 / task_complete）。
        // 失控风险由 maxIterations 迭代上限兜底（超限走既有 paused + ask_user 路径）。
        const outputTruncated = response.finishReason === 'length'
        // v0.37.0：paused 也计入未完成 —— 中断保留态不是"已处理完"，
        // 把它漏掉会让「暂停 → 续聊 → 直接收尾」这条路径静默丢工作。
        // v0.38.1（D170）：对话级任务不把兜底占位项当「未完成工作」——
        // 纯对话输入（你好/问好/闲聊）被 plan 兜底成单项清单后，模型每轮的正文答复
        // 本身就是正确产出；此前它被守卫视为「unfinished work」→ 4 轮有界暂停 →
        // ask_user「模型较弱」，实测 qwen3.5:9b 对「你好」也被迫走完全套守卫链。
        // chatMode 时 unfinishedCount 恒为 0 → 自然落到下方「最终答复收尾」路径。
        const unfinishedCount = chatMode
          ? 0
          : (task.planItems ?? []).filter(
              (p) => p.status === 'running' || p.status === 'pending' || p.status === 'paused',
            ).length
        // v0.36.0 F1.5：greetingLoopTriggered 时绝不走「最终答复」收尾（问候语
        // 被当成 task done 是问候循环最恶劣的出口），一律进提示自愈路径。
        if (outputTruncated || unfinishedCount > 0 || greetingLoopTriggered) {
          consecutiveNoToolFinal += 1
          const truncatedHint =
            '你上一轮回复被输出长度截断（finish=length），工具调用可能被截掉。' +
            '请直接继续：重新发起被截断的工具调用，不要复述已完成的步骤。'
          const unfinishedHint =
            consecutiveNoToolFinal >= MAX_CONSECUTIVE_NO_TOOL
              ? `【重要】任务清单仍有 ${unfinishedCount} 项未完成（running/pending），但你已连续 ${consecutiveNoToolFinal} 轮未调用任何工具。` +
                `请立即做出选择：若剩余项确已无需执行，调用 task_complete 明确收尾并在 summary 中说明原因；` +
                `否则从第一个未完成项开始继续调用工具执行。禁止只输出文字说明。`
              : `任务清单仍有 ${unfinishedCount} 项未完成（running/pending），而上一轮回复未调用任何工具。` +
                `若这些项确已无需执行，请调用 task_complete 明确收尾；否则请继续调用工具完成剩余项，不要只输出文字。`
          // v0.36.0 F1.5：问候循环专属提示（优先于截断/未完成通用提示，已含【引擎提示】标签）
          // v0.41.0（D208）：降级通道激活且非问候循环 → 提示替换为正文协议契约
          //（TC-PTL-004：命中分支不得再出现"请发起真实工具调用"这类无效措辞）
          const hint = greetingLoopTriggered && !outputTruncated
            ? (pendingSystemHint ?? unfinishedHint)
            : proseToolFallback
              ? proseToolContractHint()
              : outputTruncated
                ? truncatedHint + (unfinishedCount > 0 ? `\n${unfinishedHint}` : '')
                : unfinishedHint
          logger.warn(
            'Agent',
            `no-tool turn with unfinished work (round ${consecutiveNoToolFinal}) — injected self-heal hint`,
            task.id,
          )
          // v0.38.0（D160）：伪调用定向处置 —— 判据独立于「模型有没有说话」。
          // 实机 qwen3.5:9b 把 `file-reader(path=".")` / `task_plan(items=[…])`
          // 写成正文，引擎解析出 0 个动作；而 stall.ts 的零产出守卫因
          // hasSayOutput=true（一直在说话）每轮把计数清零 → 空转 21 轮无人管。
          // 处置两段式：① 首轮给定向提示（要求发起真实调用）；② 连满
          // PSEUDO_CALL_STOP_ROUNDS 轮 → 转人工并讲清原因（纪律⑨）。
          const pseudoTool = detectPseudoToolCallInTurn({
            content: response.content ?? undefined,
            thought: response.thought ?? undefined,
            reasoningContent: response.reasoningContent ?? undefined,
          })
          if (pseudoTool) {
            consecutivePseudoNoTool += 1
            logger.warn(
              'Agent',
              `pseudo tool call in prose: ${pseudoTool}(…) (round ${consecutivePseudoNoTool}/${PSEUDO_CALL_STOP_ROUNDS}) — model is not emitting native tool_calls`,
              task.id,
            )
            if (consecutivePseudoNoTool >= PSEUDO_CALL_STOP_ROUNDS) {
              await pauseForPseudoToolCalls(task, iteration, pseudoTool)
              return
            }
            pendingSystemHint = labelEngineHint(
              // v0.41.0（D208）：降级通道激活 → 不再要求"发起真实工具调用"
              //（对不会 function calling 的模型是无效指令），改给正文协议契约
              proseToolFallback
                ? proseToolContractHint()
                : `【重要】你上一轮把工具调用写成了正文文字（例如 \`${pseudoTool}(…)\`），` +
                  `这类文字引擎**无法执行**。请改为发起真实工具调用（用系统提供的工具 / 函数），` +
                  `不要用代码块演示调用，也不要复述你"将要"做什么。`,
            )
            continue
          }
          consecutivePseudoNoTool = 0
          // v0.38.1（D168）②：无工具「纯答复」停滞守卫（对齐 D160 伪调用两段处置）。
          // 实机 qwen3.5:0.8b：强提示对能力不足的模型无效 —— 连续多轮只输出正文
          // 答复、从不调 task_plan / task_complete，而 say 非空使 stall 计数每轮
          // 归零、伪调用守卫也不触发 → 原设计烧到 maxIterations（10 分钟假执行）。
          // 连满 NO_TOOL_STOP_ROUNDS 轮 → 转人工并讲清原因（纪律⑨）。
          if (consecutiveNoToolFinal >= NO_TOOL_STOP_ROUNDS) {
            await pauseForNoToolAnswerStall(task, iteration, unfinishedCount, consecutiveNoToolFinal)
            return
          }
          // ============================================================
          // v0.39.0（D179 / D182）：文本解析回退**必须排在最后**。
          //
          // v0.38.1（D177）把它放在无工具分支的最前面，后果有两条：
          //   ① 伪调用守卫被架空 —— 模型把 `task_plan(items=[…])` 写成 fenced JSON
          //      时，这里先把它当"合法清单"登记并 `continue`，`consecutivePseudoNoTool`
          //      永远不递增，D160 的第二段（连满 3 轮转人工）永远走不到；
          //   ② D168 与 stall 计数被 `continue` 旁路 —— 措辞每次微变就能让
          //      `changed > 0` 持续成立，一路烧到 maxIterations。
          // 现在顺序固定为：伪调用 → 纯答复停滞 →（本处）文本解析。
          //
          // 另外两条硬条件（D182）：
          //   · 对话级任务（chatMode）不解析 —— 模型解释性答复里的「1… 2…」不是清单；
          //   · 每 run 最多代为落库 3 次 —— 防止「提交 → 再解析 → 再提交」的空转。
          // ============================================================
          if (shouldCommitRegexDraft({
            chatMode,
            // v0.39.0（D188）：此处**必须传真实推导值**，不能写字面量 `false`。
            // 上面两条早退（伪调用 → continue/return；纯答复停滞 → return）只是**顺序**
            // 上保证了这两个守卫此刻为假；把 `false` 写死，等于把「顺序」这个唯一防线
            // 悄悄降级成「没人会动这段代码」的假设 —— 日后有人把本块挪到伪调用判定
            // 之前，守卫不会自己失效，而是安安静静继续放行（D179 的原始病态）。
            // 传推导值后，重排顺序会让这两个条件**自己**成立 → 解析回退自动关门。
            pseudoHit: pseudoTool !== null,
            noToolStallHit: consecutiveNoToolFinal >= NO_TOOL_STOP_ROUNDS,
            regexCommits,
          })) {
            const parsedPlan = parsePlannerOutput(
              [response.content, response.reasoningContent, response.thought].filter(Boolean).join('\n'),
            )
            if (parsedPlan) {
              const committed = await commitPlanDraft({
                task,
                iteration,
                draft: parsedPlan.draft,
                reason: '模型未发起原生工具调用，引擎从答复正文解析出清单并代为登记（D177 正则回退）',
                source: 'plan-regex',
              })
              if (committed.ok && committed.changed > 0) {
                regexCommits += 1
                logger.info(
                  'Agent',
                  `plan-regex: extracted ${parsedPlan.draft.length} item(s) via ${parsedPlan.via}, committed changed=${committed.changed}（本 run 第 ${regexCommits} 次）`,
                  task.id,
                )
                pendingSystemHint = labelEngineHint(
                  `已从你上一轮的答复正文里解析出任务清单（${parsedPlan.draft.length} 项，${committed.summary || '已登记'}）并登记生效，` +
                    `后续清单更新请直接调用 task_plan 工具。现在请从第一个未完成项开始，调用工具实际执行（file-writer / shell 等）。`,
                )
                // D179：代为落库后**仍然**计入「无工具轮次」。此前 continue 跳过了
                // consecutiveNoToolFinal 的递增，等于给这条路径开了无限通行证。
                consecutiveNoToolFinal += 1
                continue
              }
            }
          }
          // v0.31.0 D22（用户实测缺陷）：此处原为 appendL1 + role=user +
          // kind=user_message（详见 l1-repair.ts 头注释）。该类别是**渲染层
          // 判定「这是用户说的话」的唯一依据**（derive-conversation.ts 把所有
          // 该类条目映射成对话框气泡），于是引擎自救提示被当成用户输入：
          //   ① 用户重开任务后看到一句自己从没打过的话（本缺陷的报障现象）；
          //   ② 该提示永久留在 L1，续聊时作为「用户的话」反复进入模型上下文。
          // 自救提示的语义是「针对上一轮无工具调用」的一次性修正，只在下一轮有效，
          // 因此改走 pendingSystemHint 瞬时通道（与工具达限 / 空转提示同一管道）：
          // 只进下一轮 Reason 的尾部消息，不落 L1、不进对话、不污染上下文。
          // 标签用 `[引擎提示]`（技能来源见下方 labelSkillHint）：本提示是引擎对
          // 自身检测结果（清单有未完成项 / 上轮无工具调用）的说明，不是技能契约。
          pendingSystemHint = labelEngineHint(hint)
          // v0.34.x（D52 补口）：无工具分支此前不推进零产出计数 —— 空响应/纯文字
          // 回合会在这里无限循环（提示注入 → 继续空转 → 再提示），qwen3.5:9b
          // @ Ollama 实测连烧 100+ 轮直到 maxIterations。此处与 Act 路径同口径：
          // 有 say 叙述视为有产出（归零），否则计一次零产出，达阈值走优雅暂停。
          const stalledNoTool = isStalledRound({
            hasToolCall: false,
            allReadonly: true,
            hasSayOutput: !!(response.say && response.say.trim()),
            hasNewThought: freshNarrative,
            planProgressed: false,
          })
          consecutiveStalledRounds = advanceStallCounter(consecutiveStalledRounds, stalledNoTool)
          if (isStallTerminal(consecutiveStalledRounds)) {
            await pauseForStalledRounds(task, iteration, MAX_STALLED_ROUNDS)
            return
          }
          continue
        }
        // 模型未调用工具，且清单无未完成项、输出未被截断 → 认为是最终回复
        // ============================================================
        // v0.38.0（D150/D151/D152/D153）：**答复型收尾过统一完成门禁**。
        //
        // 这里此前是两条独立分支（D128 的「续聊零写树」+ D134 的「清单未收口」），
        // 两者计数源不同（run 局部 `completeRefusals` vs 账本 `resume.refusals`），
        // 叠加后单 run 稳定产出 3 次拒绝且无人能解释（现场「连续三轮」即此）。
        // 现在只剩**一条**判定：判据客观（本 run 实际工具调用），计数单一（账本）。
        //
        // 被拒时：recordRefusal（账本唯一计数）→ refuseViaGate（system 指令 + 用户通告
        // 两条独立通道）→ emitTurnNote（把模型本轮**已经写好的正文**保底投给用户，
        // 治 D152「拒绝即吞答复」）。
        // ============================================================
        const verdict = await guardFinish({
          taskId: task.id,
          iteration,
          workClass: classifyRunWork(toolsThisRun),
          touchedTree: treeTouchedThisRun,
        })
        if (!verdict.allow) {
          // v0.39.0（D180）：`recordRefusal` 现在返回是否写成功。写失败时账本计数
          // 不会增长 → `overLimit` 永不成立 → 任务在「拒绝 → continue」里烧到迭代
          // 上限（fail-closed）。这里用「连续写失败」做有界放行兜底：不是绕过门禁，
          // 而是在门禁自己失能时给一条出口，并且明确告警。
          const wrote = await recordRefusal(task.id)
          if (wrote) {
            refusalWriteFailures = 0
          } else {
            refusalWriteFailures += 1
            if (refusalWriteFailures >= MAX_REFUSAL_WRITE_FAILURES) {
              logger.warn(
                'Agent',
                `完成门禁拒绝计数连续 ${refusalWriteFailures} 次写入失败 —— 门禁计数已不可信，按超限放行（清单不改写）`,
                task.id,
              )
              await emitTurnNote({
                taskId: task.id,
                iteration,
                text: '清单写入异常，引擎已按最小干预原则放行收尾（清单状态保持原样）。',
                via: 'gate-refusal',
              })
              await sealLedger(task.id, 'completed', '任务完成（门禁计数异常，有界放行）')
              await sealGraphForTaskOutcome(task, 'completed', '任务完成')
              await updateTask(task.id, { status: 'done', completedAt: Date.now() })
              broadcastTaskStatus({ ...task, status: 'done', completedAt: Date.now() })
              return
            }
          }
          await refuseViaGate({
            taskId: task.id,
            iteration,
            code: verdict.code,
            message: verdict.message,
            refusals: verdict.refusals,
          })
          await emitTurnNote({
            taskId: task.id,
            iteration,
            text: safeSlice(response.thought, 500),
            via: 'gate-refusal',
          })
          continue
        }
        await emitEvent(task.id, {
          type: 'task_complete',
          iteration,
          // v0.39.0（D197）：此处是「未调工具且清单已收口」的答复型收尾，
          // 没有 action.args.summary 可读，第一级必然落到 thought；
          // 由 resolveCompleteSummary 保证第三级占位兜底（永不输出空串 ——
          // 空串会在渲染层直出一条空白「答复」，即 D197 的用户可见形态）。
          summary: resolveCompleteSummary(undefined, response.thought),
        })
        // ============================================================
        // v0.39.0（D178）：超限放行后的在途项收口。
        //
        // `guardFinish` 以 `over-limit` 放行时，账本里可能仍有在途项（模型坚持
        // 清单无需变化）。而 `seal` 算子对 `completed` **显式跳过所有项**，于是
        // 任务 done、清单仍 running —— 界面上是一眼可见的矛盾态，而
        // `ledger-guard.ts` 的注释当时还承诺「在途项将在收尾时收口」。
        //
        // 只对 **UNFINISHED 型**超限收口（有实质动作、清单确实没收干净）；
        // TREE_SYNC 型超限保持既有用户裁决「不逼模型做假动作、不改写清单」。
        // ============================================================
        if (verdict.reason === 'over-limit' && verdict.leftovers.length > 0 && treeTouchedThisRun) {
          try {
            await forceCloseOpenItems(task.id, `完成门禁已达拒绝上限，收尾时收口 ${verdict.leftovers.length} 项在途任务`)
            logger.warn(
              'Agent',
              `over-limit 放行：已收口 ${verdict.leftovers.length} 项在途任务（避免「任务 done 清单仍在途」）`,
              task.id,
            )
          } catch (err) {
            logger.warn('Agent', `over-limit 在途项收口失败（不影响任务终局）：${(err as Error).message}`, task.id)
          }
        }
        // v0.38.1（D170 + TC-WIRE-008 修正）：对话级任务的兜底占位项随任务完成收口。
        // 正常任务到达此处时清单已全部终态（guardFinish 已拦在途项），等价无操作；
        // 仅 chatMode 的引擎兜底单项（如「你好」）会在此被真实收口，避免任务 done
        // 而清单仍挂 running。**必须走账本 mutate**（唯一写入口纪律 / D132 /
        // TC-WIRE-008）—— 此前直写 task.planItems 是第二个写入者。
        if (chatMode) {
          try {
            const led = await import('../ledger/engine.js')
            const ledSnap = await led.loadLedger(task.id)
            const openItems = (ledSnap?.items ?? []).filter(
              (it) => it.status === 'pending' || it.status === 'running' || it.status === 'paused',
            )
            for (const it of openItems) {
              await led.mutate(
                task.id,
                {
                  kind: 'set-status',
                  itemId: it.id,
                  to: 'done',
                  source: 'engine-decide',
                  note: '对话级交互：模型已直接答复',
                  force: true,
                },
                { actor: 'engine:chat-final' },
              )
            }
          } catch (err) {
            logger.warn('Agent', `chatMode 清单收口失败（不影响任务终局）：${(err as Error).message}`, task.id)
          }
        }
        // v0.37.0：清单账本同步收口（graph 收口在下一行，两者是不同层）
        await sealLedger(task.id, 'completed', '任务完成（最终答复）')
        // v0.32.1（缺陷 D35）：把**图级 status** 封成 completed。
        // 清单各节点在过程中已由 decidePlanAdvance / stage-gate 逐项推进到 completed，
        // 但 graph.status 在此之前从没有任何生产代码写过 —— 不封口就会出现
        // 「任务 done 而图仍 in_progress」，任务面板一直显示「进行中」。
        await sealGraphForTaskOutcome(task, 'completed', '任务完成')
        await updateTask(task.id, { status: 'done', completedAt: Date.now() })
        broadcastTaskStatus({ ...task, status: 'done', completedAt: Date.now() })
        // Task 9：任务完成 → 推进进度到 100% + 标记「编码完成」里程碑
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
        await runDoneMemoryHooks(task, agent, opts.modelId, response.thought)
        return
      }

      // v0.28.1 fix：到达此处说明本轮确有工具调用，重置「无工具调用」连续计数
      consecutiveNoToolFinal = 0

      // v0.14.0 Task 4：action 可能为 null（模型返回多个 pendingActions 时走下方并行 Act），
      // 单工具分支用可选链兜底，避免 null 穿透
      if (action?.tool === 'task_complete') {
        // v0.27.0 R2/F7：完成收尾（配对 observation / 完成态 / 里程碑 / 记忆钩子）→ turn-end.ts
        // v0.30.0：返回 true 表示"完成被验证门禁拦截，本回合不结束"（需先跑验证命令）
        // v0.38.0（D150/D151）：判据改为**客观事实** —— workClass（本 run 实际工具调用）
        // + touchedTree（本 run 是否写过清单）。
        //
        // v0.39.0（D183）：**计数唯一** —— 此前本循环另维护 `completeRefusals`
        // （run 局部、上限 2）驱动 turn-end 里的 D39 第二套守卫，与账本
        // `resume.refusals`（上限 2）串联出「单 run 最多 3 次拒绝且无人能解释」
        // 的现场。第二套守卫已删除，本计数随之删除：拒绝只有账本一处落点。
        if (
          await finishViaTaskComplete(
            {
              task,
              agent,
              modelId: opts.modelId,
              workClass: classifyRunWork(toolsThisRun),
              touchedTree: treeTouchedThisRun,
            },
            action,
            response,
            pendingActions,
            pendingActionIds,
            iteration,
          )
        ) {
          continue
        }
        return
      }

      if (action?.tool === 'ask_user') {
        // v0.27.0 R2/F7：暂停收尾（兜底问题 / 兜底选项 / continuation 注入判定）→ turn-end.ts
        if (await pauseViaAskUser({ task, agent, modelId: opts.modelId }, action, pendingActions, pendingActionIds, iteration)) continue
        return
      }

      // -------- Act --------
      // v0.14.0 Task 4：同一轮 Reason 可能返回多个无依赖工具调用；
      // 我们按"工具维度"并行执行，但每条 act 仍写入独立 ReActStep 并
      // 通过单一 `task:progress` 通道聚合回流，保证 UI 不漂移。
      const actStartedAt = Date.now()
      // v0.34.0（D52）：Act 前的清单签名 —— 用于判定「本轮是否产生实质进展」
      const planSigBefore = planSignature(task.planItems)
      const actions = collectActionsForIteration(response)
      // v0.38.0（D160）：本轮确有真实工具调用 → 伪调用连续计数归零
      // （只统计**连续**无工具轮，中间成功调过工具就重新计）。
      if (actions.length > 0) consecutivePseudoNoTool = 0
      // v0.38.0（D150）：记录本 run 实际请求过的工具 —— 完成门禁的唯一客观事实来源。
      // 在此处（Act 之前）收集：即使个别 action 随后被预算/阶段守卫拦下，它仍属于
      // 「模型尝试做过实质工作」，按事实计入（宁可保守拦截，不可静默放行）。
      for (const a of actions) toolsThisRun.push(a.tool)
      const groupId = genId('group')
      // polish4 §A2 + §D1.1 + §D1.2：每个 action 独立 id，并入 toolCallBudget
      // actionIds 优先采用 response.toolCallIds（adapter 已收集的真实 id），
      // 退化用 `call_${iteration}_${i}`。
      const actionIds: string[] = (response.toolCallIds && response.toolCallIds.length === actions.length)
        ? response.toolCallIds
        : actions.map((_, i) => `call_${iteration}_${i}`)
      // 工具预算检查：达上限不硬中断，改为软警告 + 跳过执行
      // Phase A Task 1：UI 层静默化 —— 不再弹 toast，仅写 L2/L3 日志；同调用签名仅首次记录
      const exhaustedIndices = new Set<number>()
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const signatureKey = getToolCallKey(a.tool, a.args)
        const categoryLimit = getToolCategoryLimit(a.tool, catReadonlyLimit, catDefaultLimit)
        const signaturePrev = toolSignatureBudget.get(signatureKey) ?? 0
        const categoryPrev = toolCategoryBudget.get(a.tool) ?? 0

        // 两层预算：调用签名（防同参数反复执行）+ 工具类别（防整体过度使用）
        const signatureExhausted = signaturePrev >= maxPerSignature
        const categoryExhausted = categoryPrev >= categoryLimit
        // v0.19.x：同参数重复调用被拦截 → 计入重点关注统计（供达限询问时向用户披露）
        if (signatureExhausted) signatureBlockedTotal += 1
        // v0.19.x：类别预算触顶（200）→ 任务可能执行过长/已卡住，中断询问用户是否继续。
        // 复用 ask_user 交互：暂停任务并弹出问题卡，用户回复后作为新 run 继续。
        if (categoryExhausted && !budgetInterrupted) {
          budgetInterrupted = true
          // v0.29.0 F6：询问文案随 UI 语言切换（ask_user 问题卡展示给用户）
          const locale = getUiLocale()
          const repeatHint = signatureBlockedTotal > 0
            ? tFor(locale, 'askUser.budgetRepeatHint', { count: signatureBlockedTotal })
            : ''
          const question = tFor(locale, 'askUser.budgetQuestion', { tool: a.tool, limit: categoryLimit, hint: repeatHint })
          logger.warn('Agent', `tool budget interrupt: ${a.tool} (${categoryPrev}/${categoryLimit}) — ask user`, task.id)
          await emitEvent(task.id, {
            type: 'ask_user',
            iteration,
            question,
            suggestions: [
              { label: tFor(locale, 'askUser.budgetContinue.label'), description: tFor(locale, 'askUser.budgetContinue.desc'), recommended: true },
              { label: tFor(locale, 'askUser.budgetStop.label'), description: tFor(locale, 'askUser.budgetStop.desc') },
            ],
          })
          // v0.30.2 D12：预算中断也属 ask_user 暂停 → 打答复型续聊标记（同 turn-end）
          await updateTask(task.id, {
            status: 'paused',
            pendingAskUser: { question, askedAt: Date.now() },
          })
          broadcastTaskStatus({ ...task, status: 'paused' })
          return
        }
        if (signatureExhausted || categoryExhausted) {
          exhaustedIndices.add(i)
          if (!budgetWarnedKeys.has(signatureKey)) {
            budgetWarnedKeys.add(signatureKey)
            const reason = signatureExhausted
              ? `same signature (${signaturePrev}/${maxPerSignature})`
              : `tool category (${categoryPrev}/${categoryLimit})`
            logger.warn(
              'Agent',
              `tool budget exceeded: ${a.tool} (${reason}) — soft warn, skip execution`,
              task.id,
            )
          }
        } else {
          if (categoryPrev >= categoryLimit - 2) {
            pendingSystemHint = `${a.tool} 已调用 ${categoryPrev + 1}/${categoryLimit} 次，即将达限。请考虑切换替代方法或收敛任务。`
            logger.info('Agent', `tool budget warning: ${a.tool} (${categoryPrev}/${categoryLimit})`, task.id)
          }
          // v0.19.1 fix：仅在「实际执行」时递增预算计数，达限即停；
          // 此前对已耗尽工具仍无条件递增，导致计数越过上限一路涨到 33/32、36/32。
          toolSignatureBudget.set(signatureKey, signaturePrev + 1)
          toolCategoryBudget.set(a.tool, categoryPrev + 1)
        }
      }

      // 本轮所有 action 均被跳过
      if (exhaustedIndices.size === actions.length && actions.length > 0) {
        consecutiveSkippedIterations += 1
        // 连续 MAX_ALL_EXHAUSTED_ROUNDS 轮所有请求都被跳过 → 引擎侧已无可用工具，
        // 避免模型反复尝试已耗尽签名空转。
        if (consecutiveSkippedIterations >= MAX_ALL_EXHAUSTED_ROUNDS) {
          // v0.34.4（D65）：**曾经这里是 task_failed 硬失败** —— 用户只拿到
          // 「运行出错」+ 重试/停止，一个没有可选动作的死胡同。改为与 D52 同源的
          // 优雅暂停（paused + ask_user）：这本来就是"引擎侧资源耗尽"而非任务本身
          // 的错，应当把判断权交回用户。刻意不调 markRunningPlanItemFailed
          // —— 暂停可恢复，清单不该被标失败（同 D36）。
          await pauseForBudgetExhausted(task, iteration, consecutiveSkippedIterations)
          return
        }
        // 全部达上限 → 注入强提示（换**类别**，而不是原样重试）。
        // v0.42.1（D212）：被拦集合含清单族时追加终局指引 —— 真机（qwen3.8 27b）
        // 「无法结束任务」的死循环入口：模型反复 task_plan 撞上限后没有任何出路。
        // 指引指向 task_complete / 最终答复（换层次），符合纪律⑩。
        pendingSystemHint = `本次请求的工具（${actions.map((a) => a.tool).join(', ')}）均已达到调用上限。请改用**其他类别**的可用工具，或基于已有信息推理完成任务。${
          actions.some((a) => isPlanWriteTool(a.tool)) ? PLAN_TOOL_HINT.endgame : ''
        }`
      } else {
        consecutiveSkippedIterations = 0
        // v0.34.4（D65）：修正**注释与分支相反**的历史错位。
        // 原代码把"部分达上限"的提示写在"全部达上限"分支里，于是这段提示
        // 在它真正该出现的场景（部分耗尽、还有别的工具可用）**永远不会触发**。
        if (exhaustedIndices.size > 0) {
          const blocked = actions.filter((_, i) => exhaustedIndices.has(i)).map((a) => a.tool)
          pendingSystemHint = `工具（${blocked.join(', ')}）已达调用上限，本轮未执行。请换用其它工具或**其它参数**继续，不要原样重试。${
            blocked.some((t) => isPlanWriteTool(t)) ? PLAN_TOOL_HINT.endgame : ''
          }`
        }
      }
      const actSteps: ReActStep[] = actions.map((a) => {
        // v0.29.0 F5：动作意图 key 化（intentKey/intentParams 供渲染层展示层翻译）
        const desc = describeActionKey(a.tool, a.args)
        return {
          id: genId('step'),
          taskId: task.id,
          iteration,
          type: 'act',
          toolName: a.tool,
          toolArgs: JSON.stringify(a.args, null, 2),
          // v0.21.0：人类可读动作意图（如「执行命令：npm test」），交互区每个操作展示简介；保留 zh 原文向后兼容历史记录
          intent: describeAction(a.tool, a.args),
          intentKey: desc.key,
          intentParams: desc.params,
          startedAt: actStartedAt,
          durationMs: 0,
          status: 'running',
        }
      })

      // 先广播 act_start + 进度 running（让 UI 立即看到该轮的全部并行工具）
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const step = actSteps[i]
        await emitEvent(task.id, { type: 'act_start', iteration, tool: a.tool, args: a.args })
        broadcastToolProgress({
          taskId: task.id,
          groupId,
          requestId: step.id,
          tool: a.tool,
          status: 'running',
          startedAt: actStartedAt,
        })
      }

      // 并行执行所有 act 调用；已耗尽预算的工具跳过执行，返回合成结果
      const actCtx: ActContext = { task, agent, signal, coreSkillsEnabled, allowedStage, iteration }
      const actResults = await Promise.all(
        actions.map((a, i) => {
          if (exhaustedIndices.has(i)) {
            const toolName = a.tool
            const signatureKey = getToolCallKey(toolName, a.args)
            const signaturePrev = toolSignatureBudget.get(signatureKey) ?? 0
            const categoryPrev = toolCategoryBudget.get(toolName) ?? 0
            const categoryLimit = getToolCategoryLimit(toolName, catReadonlyLimit, catDefaultLimit)
            const reason = signaturePrev >= maxPerSignature
              ? `同参数调用已达上限（${signaturePrev}/${maxPerSignature}）`
              : `工具类别调用已达上限（${categoryPrev}/${categoryLimit}）`
            // v0.42.1（D212）：清单族被拦 → 回执必须带终局指引（真机死循环根治）。
            // 指向 task_complete / 最终答复 = 换层次动作，不是被拦的那条调用（纪律⑩）。
            const planEndgame = isPlanWriteTool(toolName) ? `。${PLAN_TOOL_HINT.endgame}` : ''
            const msg = `${toolName} ${reason}，请改用替代方法${planEndgame}`
            return Promise.resolve<ActExecutionResult>({
              completedStep: {
                ...actSteps[i],
                status: 'failed',
                result: { error: msg },
                resultSummary: msg,
                durationMs: 0,
                errorMessage: msg,
                // v0.19.x：预算拦截是引擎主动行为而非工具报错，标 softFail（前端橙色警告态）
                softFail: true,
              },
              result: { error: msg },
              resultSummary: msg,
              durationMs: 0,
              ok: false,
              errorMessage: msg,
            })
          }
          return executeAct(a, actSteps[i], actCtx)
        }),
      )

      // v0.6.0：捕获任意一个 act 注入的渐进式披露 hint，下一轮 Reason 合并到 system prompt
      // v0.31.0 D22：本行是通道里**唯一的技能来源**，显式打 `[Skill 指令]` 标签；
      // 其余（工具达限 / 只读空转 / 清单未完成自愈 / 图锚点）由 reason-phase 兜底为
      // `[引擎提示]`，两类提示不再共用一个标签。
      for (const r of actResults) {
        if (r.additionalSystemHint) pendingSystemHint = labelSkillHint(r.additionalSystemHint)
      }

      let lastObservationSummary = ''
      // v0.16.x：阶段门禁信号 — 本轮迭代触发了文档驱动开发门禁（写完 PRD / 交互 / 原型 /
      // 系统设计等）。引擎强制暂停任务并自动 ask_user，避免 LLM 写完不询问直接跳下一阶段。
      let stageGateHit: import('../../skills/builtin/react-core-skills/stage-gates.js').StageGate | null = null
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const step = actSteps[i]
        const r = actResults[i]
        broadcastStep(r.completedStep)
        broadcastToolProgress(toFinishedProgress(r.completedStep, groupId))
        await emitEvent(task.id, {
          type: 'act_end',
          iteration,
          result: r.result,
          resultSummary: r.resultSummary,
          durationMs: r.durationMs,
          ok: r.ok,
          errorMessage: r.errorMessage,
          // v0.19.x：透传软失败标记（门禁/预算拦截），前端日志按 WARN（橙）而非 ERROR（红）
          softFail: (r.completedStep as ReActStep).softFail === true,
        })
        // Task 9：每个 act 完成 → 同步回流到进度摘要（按工具名推断阶段）
        // 编码类工具：shell / file-reader / delegate-agent → 'code'
        // 调研类工具：web-search / fetch-url → 'research'
        // 其余通用 → 'code'（保守归类）
        const stage = ((): 'research' | 'code' | 'test' => {
          const t = a.tool
          if (t === 'web-search' || t === 'fetch-url' || t === 'session-search') return 'research'
          if (t === 'shell' || t === 'file-reader' || t === 'delegate-agent') return 'code'
          return 'code'
        })()
        await emitProgress({
          type: 'task_step_complete',
          taskId: task.id,
          stepId: step.id,
          label: `${a.tool}: ${safeSlice(r.resultSummary, 60) || a.tool}`,
          stage,
          ok: r.ok,
          durationMs: r.durationMs,
        })
        // 每个 act 写一条 observation
        // ============================================================
        // v0.39.0（W2 · F7）：**失败摘要采集**。
        //
        // 不是把堆栈贴给模型，而是三件事都说清：哪一步（tool）、失败多少次
        // （attempts，让模型知道"重试过了，别再来"）、下一步建议（digest.suggest）。
        // 工具**成功**即清掉同 tool 的记录 —— 只有"连续失败"才值得换回合重想。
        // ============================================================
        if (!r.ok) {
          failureDigest = pushFailureDigest(failureDigest, {
            tool: String(a.tool ?? 'unknown'),
            code: r.failureCode,
            message: safeSlice(String(r.errorMessage ?? '工具执行失败'), 160),
            // 首次记 1；同一 tool 再次失败由 pushFailureDigest 累加
            attempts: 1,
          })
        } else {
          failureDigest = failureDigest.filter((f) => f.tool !== a.tool)
        }
        const observationSummary = buildObservationSummary(a.tool, r.result, r.resultSummary, r.ok)
        await appendL1({
          taskId: task.id,
          role: 'tool',
          kind: 'observation',
          content: observationSummary,
          iteration,
          // polish4 §A2.2：meta 含 toolCallId（=actionId），用于 assembleMessages 精确配对
          meta: JSON.stringify({
            tool: a.tool,
            toolCallId: actionIds[i],
            actionId: actionIds[i],
          }),
        })
        lastObservationSummary = observationSummary

        // v0.16.x：react-core-skills 阶段门禁识别 —
        // file-writer 写出阶段产物文档（00-opensource-research.md / 01-prd.md /
        // 02-interaction.md / prototype/*.html / 03-system-design.md）后，
        // 推 task_progress 推进 ProgressPanel 阶段 + 推 task_milestone +
        // 标记本轮必须 ask_user 暂停（取最高阶段，避免一次写多文件匹配到低阶段）
        if (r.ok && a.tool === 'file-writer') {
          const filePath = (r.result as { path?: string } | undefined)?.path
          if (filePath) {
            const gate = matchStageGate(filePath)
            if (gate) {
              const { isCoreSkillsEnabled } = await import(
                '../../skills/builtin/react-core-skills/stage-gates.js'
              )
              if (isCoreSkillsEnabled(task, agent)) {
                if (!stageGateHit || gate.stageIndex > stageGateHit.stageIndex) {
                  stageGateHit = gate
                }
              }
            }
          }
        }
      }
      // ============================================================
      // v0.39.0（W2 · F7）：**失败达阈值 → 规划通道重排**。
      //
      // 业界共识：失败后最忌「原样重试」。此前引擎把失败原样贴回 observation，
      // 模型看到的是一串红字，最省力的回应就是再调一次同一个工具 —— 实测一路
      // 烧到工具预算上限。现在连满 PLANNER_FAILURE_THRESHOLD 次就**换一个回合想**：
      // 一次不带工具的独立调用，输入是「失败摘要 + 当前清单」，硬性要求
      // 「不得原样重试同一失败动作，必须换路径或拆小」（prompt.failure）。
      //
      // 三条自限（缺一即变成"又多烧一次 token"）：
      //   ① 触发后**清空** failureDigest —— 下一次机会留给新的连续失败；
      //   ② 受每 run 预算（MAX_PLANNER_PASSES_PER_RUN=5）约束，failure 豁免冷却；
      //   ③ planner 不可用 / 解析不出清单 / 落库失败 → 什么都不做，既有
      //      observation 通道照常把失败交给模型（**不影响正常 LLM**）。
      // ============================================================
      if (failureDigest.some((f) => f.attempts >= PLANNER_FAILURE_THRESHOLD)) {
        const digest = failureDigest
        failureDigest = []
        try {
          const ledgerNow = await loadLedger(task.id)
          const items: PlannerRequestItem[] = (ledgerNow?.items ?? []).map((it) => ({
            id: it.id,
            text: it.text,
            status: String(it.status),
            parentId: it.parentId ?? null,
          }))
          const gate = shouldRunPlanner({
            state: plannerState,
            trigger: 'failure',
            now: Date.now(),
            fingerprint: draftFingerprint(
              items.map((i) => ({ text: i.text, status: i.status as 'todo' })),
            ),
          })
          if (!gate.run) {
            logger.info('Agent', `失败重排被策略跳过（${gate.reason}）—— 既有失败提示照常`, task.id)
          } else {
            plannerState = notePlannerRun(plannerState, 'failure', Date.now(), draftFingerprint(
              items.map((i) => ({ text: i.text, status: i.status as 'todo' })),
            ))
            const res = await runPlannerPass({
              req: {
                taskId: task.id,
                trigger: 'failure',
                goal: safeSlice(task.input.text || '任务计划', 120),
                items,
                failures: digest,
              },
              modelId: await getPlannerModelId(opts.modelId),
              signal,
            })
            if (res.ok && res.draft.length > 0) {
              const committed = await commitPlanDraft({
                task,
                iteration,
                draft: res.draft,
                reason: `连续失败 ${digest.length} 项后由规划通道重排（via=${res.via}）`,
                source: 'planner',
              })
              if (committed.ok && committed.changed > 0) {
                logger.warn(
                  'Agent',
                  `失败重排生效：${res.summary} → changed=${committed.changed}`,
                  task.id,
                )
                // 告知用户「换了个打法」—— 否则界面上清单突然变了没人知道为什么
                await emitTurnNote({
                  taskId: task.id,
                  iteration,
                  text:
                    `连续失败后重新规划：${res.summary}。` +
                    `已按新清单继续（原来的做法不再重试）。`,
                  via: 'plan-revision',
                })
              }
            } else {
              logger.info('Agent', `失败重排未产出清单（${res.summary}）—— 既有失败提示照常`, task.id)
            }
          }
        } catch (err) {
          if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err
          logger.warn('Agent', `失败重排异常（忽略，回落既有提示）：${(err as Error).message}`, task.id)
        }
      }

      // 兼容原单 act 事件：最后一组（无并行/单 act 时）通过 observation 事件告知
      await emitEvent(task.id, {
        type: 'observation',
        iteration,
        summary: lastObservationSummary,
      })
      // 该 group 全部完成 → 清理进度聚合（避免 UI 上遗留 running）
      clearToolProgress(task.id, groupId)

      // v0.17.5：计划项完成检测改为「阶段门禁驱动」。
      // 此前 v0.17.3 的激进方案是「本轮 act 全部成功 → running 项标 done」，
      // 导致 file-reader 列个目录、shell ls 都被当作完成一步，清单与实际进度
      // 严重脱节（调研阶段就跳到"设计关卡布局"）。
      // 现在改为：只有阶段门禁（产物文档真正写完）触发时才标 done，
      // 对齐 TraeWork「tasks.md 状态随产物落地自动更新」的做法。

      // v0.39.0（D188）：**已删除 P8 计划闸门暂停块**。
      // 该块由 v0.30.0 `planGateHit`（`a.tool === 'submit_plan' && r.ok`）驱动，而
      // `submit_plan` / `request_plan` 已随 v0.38.0（D154）下架 —— 模型根本拿不到这两个
      // 工具名，即便硬编也先被 `act.ts` 的退役兜底拦掉（`r.ok === false`）
      // ⇒ 判定恒为假，暂停**从未执行**，日志里却写着"闸门触发"。这是最坏的一类残留：
      // 代码自称实现了「不批准不执行」，实际什么都没做，读代码的人被它骗过。
      // 今天闸门仍会被登记（`run-setup.ts:370` 的计划三级降级全败 → 错误态卡片），
      // 但**是否要让任务在此阻塞**是未决的产品语义（降级单步计划本身是可执行的兜底），
      // 故本版只移除死代码、不擅自恢复暂停；缺口登记见 04-system-design §7 D188 与 §9 遗留。
      // 恢复暂停的正确接法：读**活**的闸门状态 `getPlanApproval(task.id)?.state === 'pending'`，
      // 而不是任何工具名 —— 工具名会被下架，闸门状态不会。

      // v0.16.x：阶段门禁 — 写完产物后立即推 task_progress + milestone，并
      // 自动 ask_user + 暂停任务（强制门禁）。修复「写完文档没询问直接开始」。
      if (stageGateHit) {
        const gate = stageGateHit
        logger.info(
          'Agent',
          `react-core-skills 阶段门禁触发：${describeGateForLog(gate)}`,
          task.id,
        )
        // v0.17.5：把对应阶段的 planItem 标 done，下一个标 running（清单↔阶段产物对齐）
        // v0.30.0 D9：有图任务写图（唯一真相），镜像与广播由 graph/store.saveGraph 统一补发；
        //            无图任务（tier 0/1）保持 v0.29 直写。
        if (task.planItems && task.planItems.length > 0) {
          const doneIdx = findPlanItemForStage(task.planItems, gate.stage)
          if (doneIdx >= 0) {
            const doneId = task.planItems[doneIdx].id
            const nextId =
              doneIdx + 1 < task.planItems.length && task.planItems[doneIdx + 1].status === 'pending'
                ? task.planItems[doneIdx + 1].id
                : undefined
            if (task.graphId) {
              await applyStageGateAdvance(
                { taskId: task.id, graphId: task.graphId },
                doneId,
                nextId,
              )
            } else {
              // v0.37.0（D132）：无图任务的阶段门禁推进也走账本 ——
              // 此前直写 `updateTask({ planItems })`，与 todo_update 双通道并存。
              try {
                const ledS = await import('../ledger/engine.js')
                const res = await ledS.mutate(
                  task.id,
                  { kind: 'advance', fromItemId: doneId, source: 'stage-gate', note: `阶段门禁：${gate.label}` },
                  { actor: 'stage-gate' },
                )
                if (!res.ok && res.error?.code === 'NOT_FOUND') {
                  await ledS.ensureLedger(task, { seedFromPlanItems: true })
                  await ledS.mutate(
                    task.id,
                    { kind: 'advance', fromItemId: doneId, source: 'stage-gate', note: `阶段门禁：${gate.label}` },
                    { actor: 'stage-gate' },
                  )
                }
                const fresh = await ledS.loadLedger(task.id)
                if (fresh) task.planItems = (await import('../ledger/project.js')).toPlanItems(fresh)
              } catch (err) {
                logger.warn('Agent', `阶段门禁清单推进失败（账本）：${(err as Error).message}`, task.id)
              }
            }
          }
        }
        // 1) 推进 ProgressPanel 阶段显示
        await emitProgress({
          type: 'task_progress',
          taskId: task.id,
          currentStage: gate.stage,
          stageIndex: gate.stageIndex,
          overallPercentage: Math.round(((gate.stageIndex + 1) / 9) * 100),
          nextStepLabel: '等待用户确认门禁',
        })
        // 2) 标记里程碑到达（带产物路径）
        await emitProgress({
          type: 'task_milestone',
          taskId: task.id,
          milestoneId: gate.milestoneId,
          label: gate.label,
          reachedAt: Date.now(),
        })
        // 3) 写 L1 user 消息让 LLM 在下一轮 Reason 知道必须通过门禁。
        //    注意：不能写成 role:'tool' 的 observation —— 引擎自动 ask_user
        //    并非 LLM 发起的 tool_call，写成 tool observation 会变成无配对
        //    toolCallId 的孤立 tool 消息，导致 OpenAI 兼容端点 400 (2013)
        //    "tool result's tool id not found"。
        await appendL1({
          taskId: task.id,
          role: 'user',
          kind: 'user_message',
          content: buildGateBlockObservation(gate),
          iteration,
        })
        // 4) 同步广播 ask_user 事件并暂停任务（无需等 LLM 主动 ask_user，
        //    引擎直接推送 + 暂停）。LLM 下一轮 Reason 看到 user 消息会继续执行。
        await emitEvent(task.id, {
          type: 'ask_user',
          iteration,
          question: gate.question,
          suggestions: gate.suggestions,
        })
        // v0.19.0 M3：停止候选——先给监听器注入 continuation 的机会，注入则同轮继续
        if (await continueTurnIfInjected(task, iteration)) continue
        // v0.30.2 D12：阶段门禁直推 ask_user → 打答复型续聊标记（同 turn-end）
        await updateTask(task.id, {
          status: 'paused',
          pendingAskUser: { question: gate.question, askedAt: Date.now() },
        })
        broadcastTaskStatus({ ...task, status: 'paused' })
        return
      }

      // v0.9.x：只读停滞检测 — 连续 N 轮仅做只读探索（未开始产出）→ 注入产出提示。
      // 设置于本迭代 Act 之后：pendingSystemHint 会在下一迭代 Reason 构建
      // systemPrompt（parts.push）时注入并在随后清零，符合"上一迭代设置 → 下一迭代注入"。
      // 无工具调用（最终回复）已在终止检查处 return，不会进入此处，计数保持不变。
      const anyWrite = actions.some((a) =>
        a.tool === 'shell'
          ? WRITE_COMMAND_RE.test(String((a.args as Record<string, unknown>)?.command ?? ''))
          : a.tool === 'task_complete' || a.tool === 'ask_user' || a.tool === 'delegate-agent',
      )
      if (anyWrite) {
        consecutiveReadOnly = 0
      } else if (actions.length > 0 && actions.every((a) => isReadonlyTool(a.tool))) {
        consecutiveReadOnly += 1
        if (consecutiveReadOnly >= 3) {
          logger.debug(
            'Agent',
            `stalled: ${consecutiveReadOnly} consecutive read-only rounds — injecting produce hint`,
            task.id,
          )
          pendingSystemHint = `你已经连续探索 ${consecutiveReadOnly} 轮仍未开始产出。若工作区为空或与任务无关，请立即用 shell mkdir 创建项目目录并开始实现；若已有足够信息，直接开始执行。`
          consecutiveReadOnly = 0  // 避免下一轮重复注入
        }
      }

      /* ---------- v0.36.5（D126）：段末任务树完成检查（ZCode todo_reminder 对应物） ----------
       * 用户实测（java-coder agent 导出会话）：LLM 执行完一段任务后既不更新清单标记、
       * 也不检查清单是否与现实脱节 —— 树与进度脱节只能靠中断/续聊暴露。
       * 每轮 Act 结束后：① 本轮触碰过任务树（v0.38.0 起 = `task_plan`）→ 计数归零
       *   并记录 treeTouchedThisRun（完成门禁的「零写树」客观事实来源）；
       * ② 距上次触碰 ≥10 轮 → 经 pendingSystemHint 注入一次「检查任务树」提醒 + 内联树快照
       *   （v0.36.6 D127：纯轮数判定，无「有未收口项」前置，对齐 ZCode runtime-reminders），
       *   触发后归零（同 ZCode 双阈值防刷屏）。
       * 追加而非覆盖：保留本轮 Act 期间已设置的技能/预算/只读停滞提示。 */
      // v0.38.0（D156）：用「真正写账本」的守卫而不是「清单族」—— 一轮里调了已下架的
      // 旧名（软失败、清单没变）不算"有输出"，否则用户会连看若干轮空白。
      const calledPlanThisRound = actions.some((a) => isPlanWriteTool(a.tool))
      // v0.40.0（O2 信号采集）：把本轮的**客观事实**留给下一轮轮首的 plan-ops tick。
      // 只用「确实发起了哪些工具」+「模型说了什么」，不做任何成功/失败的推测 ——
      // 推测一旦错了，tick 会把错误的进展写进清单（比不动更糟）。
      planOpsJustSucceeded = actions.length > 0
      planOpsLastEvent =
        [
          actions.length > 0 ? `本轮调用了工具：${actions.map((a) => a.tool).slice(0, 5).join('、')}` : '',
          (response.content ?? '').trim().slice(0, 200),
        ]
          .filter(Boolean)
          .join('；') || '（本轮无工具调用、无正文）'
      itersSinceTreeTouch += 1
      if (touchesPlanTree(actions.map((a) => a.tool))) {
        itersSinceTreeTouch = 0
        treeTouchedThisRun = true
      } else if (shouldRemindTreeSync({ itersSinceTreeTouch, threshold: TREE_SYNC_REMIND_INTERVAL })) {
        itersSinceTreeTouch = 0
        // ============================================================
        // v0.39.0（W3 · F3）：陈旧清单 → **先重排，再提醒**。
        //
        // D126 的现场是：模型闷头干了十几轮，清单停在原地。v0.36.5 的对策是
        // 「段末注入提醒，请模型自己更新清单」—— 但**正在干活的模型最没空、也最
        // 没视角**去重新推演整张清单，它只会就地打个勾。所以本版先给规划通道一次
        // 机会（干净回合 + 失败摘要 + 当前清单），它产不出东西才回落到原提醒 ——
        // 提醒路径**行为零变更**，这是"不影响正常 LLM"的边界。
        // ============================================================
        let replanHandled = false
        try {
          const staleItems = await loadLedger(task.id)
          const items: PlannerRequestItem[] = (staleItems?.items ?? []).map((it) => ({
            id: it.id,
            text: it.text,
            status: String(it.status),
            parentId: it.parentId ?? null,
          }))
          const fp = draftFingerprint(items.map((i) => ({ text: i.text, status: i.status as 'todo' })))
          const gate = shouldRunPlanner({ state: plannerState, trigger: 'stale', now: Date.now(), fingerprint: fp })
          if (gate.run) {
            plannerState = notePlannerRun(plannerState, 'stale', Date.now(), fp)
            const res = await runPlannerPass({
              req: {
                taskId: task.id,
                trigger: 'stale',
                goal: safeSlice(task.input.text || '任务计划', 120),
                items,
                failures: [],
              },
              modelId: await getPlannerModelId(opts.modelId),
              signal,
            })
            if (res.ok && res.draft.length > 0) {
              const committed = await commitPlanDraft({
                task,
                iteration,
                draft: res.draft,
                reason: `清单已 ${TREE_SYNC_REMIND_INTERVAL} 轮未更新，规划通道重新推演`,
                source: 'planner',
              })
              if (committed.ok && committed.changed > 0) {
                replanHandled = true
                logger.info(
                  'Agent',
                  `stale replan 生效：${res.summary} → changed=${committed.changed}`,
                  task.id,
                )
                await emitTurnNote({
                  taskId: task.id,
                  iteration,
                  text: `清单已 ${TREE_SYNC_REMIND_INTERVAL} 轮未更新，引擎重新推演后已更新：${res.summary}。`,
                  via: 'plan-revision',
                })
                const replanHint = labelEngineHint(
                  `引擎已根据当前进展重新推演任务清单（${res.summary}）。请按新清单继续执行；` +
                    `若与你了解的事实不符，用 task_plan 提交你认可的完整清单覆盖它。\n` +
                    `当前清单快照：\n${renderPlanTreeSnapshot(task.planItems ?? []) || '（空）'}`,
                )
                pendingSystemHint = pendingSystemHint ? `${pendingSystemHint}\n\n---\n${replanHint}` : replanHint
              }
            }
          }
        } catch (err) {
          if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err
          logger.warn('Agent', `stale 重排异常（回落原提醒）：${(err as Error).message}`, task.id)
        }
        if (!replanHandled) {
          // v0.38.0（D154）：工具名收敛为 task_plan 单入口 —— 提醒文案不得再指向已下架的旧工具。
          const treeHint =
            `[引擎提示] 任务清单已 ${TREE_SYNC_REMIND_INTERVAL} 轮未更新。请检查任务清单：` +
            `① 已完成的段落用 task_plan 提交更新后的清单（status 置 done）；` +
            `② 清单若已与现实不符，用 task_plan 提交你当前认为正确的完整清单（引擎自动算差异）；` +
            `③ 全部完成后调用 task_complete 收尾。\n` +
            `当前清单快照：\n${renderPlanTreeSnapshot(task.planItems ?? []) || '（空）'}`
          pendingSystemHint = pendingSystemHint ? `${pendingSystemHint}\n\n---\n${treeHint}` : treeHint
          logger.info(
            'Agent',
            `tree-sync reminder injected (${TREE_SYNC_REMIND_INTERVAL} iters since last tree touch)`,
            task.id,
          )
        }
      }

      /* ---------- v0.38.0（D156）：阶段结论**兜底**节流 ----------
       * 现场形态：模型连续推理 8 轮无任何输出，然后一次性给最终结果 —— 用户无法区分
       * 「推进中」与「卡住」。`turn_note` 给了模型主动汇报的出口（自动结论由
       * plan-commit 的 done 转移触发），但模型可能整段都不汇报；本兜底保证
       * 连续 MAX_ROUNDS_WITHOUT_NOTE 轮无输出时，引擎主动要求一次进展说明。
       * 计数归零同样只在"有输出"时（`plan` 或 `note`），防刷屏。 */
      const calledNoteThisRound = actions.some((a) => a.tool === 'turn_note')
      const notePolicyStep = advanceNotePolicy(notePolicy, {
        plan: calledPlanThisRound,
        note: calledNoteThisRound,
      })
      notePolicy = notePolicyStep.state
      if (notePolicyStep.inject) {
        const noteHint =
          `[内部指令 · 请勿复述] 你已经连续 ${MAX_ROUNDS_WITHOUT_NOTE} 轮没有向用户汇报进展了。` +
          `请用 turn_note 说明：① 现在进展到哪一步；② 下一步要做什么。内容要具体，不要写"正在处理中"。`
        pendingSystemHint = pendingSystemHint
          ? `${pendingSystemHint}\n\n---\n${noteHint}`
          : noteHint
        logger.info('Agent', `note-policy: injected progress request after ${MAX_ROUNDS_WITHOUT_NOTE} silent rounds`, task.id)
      }

      /* ---------- v0.34.0（D52）：零产出轮终局守卫 ----------
       * 用户实测：小模型每轮都成功调用只读工具（file-reader，2ms）、内容全空、
       * 清单纹丝不动，既有保护（无工具调用 / 同签名 / 只读提示）一个都不触发，
       * 一直空转到 maxIterations=200（≈100 分钟）才暂停。
       * 本守卫是**正交维度**：不管调没调工具，只看这一轮「有没有实质进展」；
       * 连续 MAX_STALLED_ROUNDS 轮零产出 → 与 maxIter 超限同一条优雅暂停路径
       * （paused + ask_user），把「模型能力不足」的事实交给用户判断。 */
      const stalledRound = isStalledRound({
        hasToolCall: actions.length > 0,
        allReadonly:
          actions.length > 0 &&
          actions.every((a) =>
            a.tool === 'shell'
              ? !WRITE_COMMAND_RE.test(String((a.args as Record<string, unknown>)?.command ?? ''))
              : isReadonlyTool(a.tool),
          ),
        hasSayOutput: !!(response.say && response.say.trim()),
        hasNewThought: freshNarrative,
        planProgressed: planSignature(task.planItems) !== planSigBefore,
        // v0.34.4（D64）：本轮**每一个**请求的工具都被预算守卫拦截 ⇒ 拿不到任何新信息。
        // 此时 `hasNewThought` 的豁免会反噬（模型每轮都在写"换个办法"的新思考，
        // 于是 51 轮无一被判零产出，终局守卫一次都没到）。拦截轮定义上就是零产出，
        // 必须排在豁免之前 —— 见 stall.ts 的 isStalledRound 首行。
        // 真机：t1 · T-20260919-6c3v48，51 轮 / 86 调用 / 15 次被拦 / 零产物。
        allGuardBlocked: actions.length > 0 && exhaustedIndices.size === actions.length,
      })
      if (stalledRound) {
        consecutiveStalledRounds = advanceStallCounter(consecutiveStalledRounds, true)
        logger.warn(
          'Agent',
          `stalled round ${consecutiveStalledRounds}/${MAX_STALLED_ROUNDS} (no progress: tools=${actions.map((a) => a.tool).join(',') || 'none'})`,
          task.id,
        )
        if (isStallTerminal(consecutiveStalledRounds)) {
          // v0.34.x：暂停收尾抽至 pauseForStalledRounds（无工具分支同源共用）
          await pauseForStalledRounds(task, iteration, MAX_STALLED_ROUNDS)
          return
        }
      } else {
        // 有实质进展 → 一次即归零（不累计历史空转）
        consecutiveStalledRounds = advanceStallCounter(consecutiveStalledRounds, false)
      }

      // v0.6.0（F12）：异步写 checkpoint（fire-and-forget，不阻塞主循环）
      saveCheckpoint({
        id: checkpointId(task.id, iteration),
        taskId: task.id,
        iteration,
        agentId: agent.id,
        memorySnapshot: '',  // L1 已落盘，恢复时从 listEnabledL1 重建，无需冗余快照
        taskStatus: 'running',
        timestamp: Date.now(),
        parentCheckpointId: task.parentTaskId ?? undefined,
      })

      // v0.8.0 F801：token 阈值自动压缩（本轮完成后，不打断运行）
      await maybeAutoCompress(task.id, iteration)

      // 中断检查
      if (signal.aborted) {
        await handleAbort(task, iteration, stale)
        return
      }
    }

    // 超过迭代上限（v0.23.2：不再硬报错中断，改为优雅暂停 + ask_user 引导续跑）。
    // 旧逻辑直接置 failed → 前端进入错误态，用户被迫重开任务；现改为 paused +
    // 选项卡，用户可"继续运行"（appendMessage 自动续跑，迭代计数从 L1 继续）
    // 或"就此结束"（作为 user 消息传给 LLM，走 task_complete 正常收尾）。
    await emitEvent(task.id, { type: 'max_iterations_reached', iteration })
    await emitEvent(task.id, {
      type: 'ask_user',
      iteration,
      question: tFor(getUiLocale(), 'askUser.maxIterQuestion', { max: maxIter }),
      suggestions: [
        { label: tFor(getUiLocale(), 'suggest.resumeRun.label'), description: tFor(getUiLocale(), 'suggest.resumeRun.desc') },
        { label: tFor(getUiLocale(), 'suggest.finishHere.label'), description: tFor(getUiLocale(), 'suggest.finishHere.desc'), action: 'finish' },
      ],
    })
    // v0.30.2 D12：迭代上限暂停属 ask_user 交互（继续/结束选项卡）→ 打答复型续聊标记
    await updateTask(task.id, {
      status: 'paused',
      pendingAskUser: {
        question: tFor(getUiLocale(), 'askUser.maxIterQuestion', { max: maxIter }),
        askedAt: Date.now(),
      },
    })
    broadcastTaskStatus({ ...task, status: 'paused' })
    logger.warn('Agent', `max iterations reached for ${task.id} — paused for user decision`, task.id)
  } catch (err) {
    // v0.8.1：AbortError 属于用户主动中断（Esc/停止/暂停/取消），
    // 不是真正的失败——交给 handleAbort 统一处理 paused/cancelled，
    // 绝不再写 failed，否则会覆盖 cancelTask 已写好的 cancelled，
    // 且前端 Composer 会进入"错误态"RunConsole（无输入框）导致用户无法继续交互。
    if (signal.aborted || (err as Error)?.name === 'AbortError') {
      await handleAbort(task, 0, stale)
      return
    }
    const message = (err as Error).message
    logger.error('Agent', `ReAct loop failed: ${message}`, task.id)
    await emitEvent(task.id, { type: 'task_failed', iteration: 0, error: message })
    // markRunningPlanItemFailed 内部已含「节点收口 + 图级封口」（见 plan-sync:markRunningFailed），
    // 这里不再重复调用回合收口（否则会多一次空落盘，且图写失败时多一条告警噪音）。
    await markRunningPlanItemFailed(task)
    // v0.32.1（真实环境实测补漏）：与 runner 的 catch 路径同口径 —— 失败原因必须落进
    // 任务记录。实测（黑洞端点模型）：任务 `failed`、图 `failed`、清单 `failed`，
    // 唯独 `errorMessage` 为空 → 重启后 / 任务列表 / 诊断里只剩「失败」没有「为什么」。
    // 注意此处**只补原因，不改状态语义**（AbortError 早已在上方分流，不会被写 failed）。
    await updateTask(task.id, { status: 'failed', errorMessage: message })
    broadcastTaskStatus({ ...task, status: 'failed', errorMessage: message })
    // v0.39.0（D184）：**失败路径也要封账本**。
    //
    // 此前 `sealLedger` 只有两条成功路径在调（loop 最终答复 / turn-end 的
    // task_complete），失败与取消分支一处都没有 —— 于是：
    //   · 任务 `failed` ｜ 图 `failed` ｜ **账本仍 `open`** ❌
    // 后果：清单在 UI 里一直显示"进行中"，`renderSnapshot` 每轮继续把在途项喂给模型，
    // 且归档侧拿不到终态（`archiveLedger` 以 `outcome` 为判据）。
    //
    // 顺序：写在任务终态**之后**（与成功路径"先封、再写 done"相反 —— 失败路径不追求
    // 那一帧的原子性，且 `markRunningPlanItemFailed` 已在上方收过图）。
    // 封口失败只告警：不能让"记录失败"这件最重要的事再被失败打断。
    try {
      const sealRes = await sealLedger(task.id, 'failed', `运行失败：${message}`)
      if (!sealRes.ok) {
        logger.warn('Agent', `失败路径封账本未成功：${sealRes.error?.message ?? '未知'}`, task.id)
      }
    } catch (sealErr) {
      logger.warn('Agent', `失败路径封账本抛错（忽略）：${(sealErr as Error).message}`, task.id)
    }
    // v0.9.1 §Task 7：失败路径也尝试归档 L1，让失败的经验也能进入 L3b/L4a
    try {
      await runDoneMemoryHooks(task, agent, opts.modelId, '')
    } catch (hookErr) {
      logger.warn('Memory', `runDoneMemoryHooks on failed path errored: ${(hookErr as Error).message}`, task.id)
    }
  }
}
