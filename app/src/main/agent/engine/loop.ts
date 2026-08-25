/**
 * v0.27.0 R2（§3.1 引擎拆分）：ReAct 主循环：预算控制、Reason/Act 编排、迭代推进、终止分支
 * 由 engine.ts 纯移动而来；v0.27.0 F7 接缝抽取：前置准备→run-setup.ts、
 * Reason→reason-phase.ts、终止收尾→turn-end.ts、中断→abort.ts（均纯移动）。
 */

import type { Task, PlanItem } from '@shared/types/task'
import type {
  ReActEvent,
  ReActAction,
  ReActStep,
  PlanContent,
} from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import { getAdapter, getModel } from '../../llm/registry.js'
import type { LlmMessage, LlmTool, LlmCompleteResponse } from '../../llm/adapter.js'
// agent-context-compaction-robustness：LLM 调用健壮性（120s 超时 / 中止短路 / 重试分级）
import { callLlmWithRetry, withLlmTimeout, isContextOverflowError } from '../llm-call.js'
import { invokeSkill, skillToLlmTool, skillToolName, listSkills, getSkill, type SkillContext } from '../registry.js'
// v0.19.0 M1：系统提示词组装器（收敛 parts.push 硬拼逻辑）
import { buildSystemSections, renderSystemPrompt, buildPersonalitySegment } from '../prompt-assembly.js'
// v0.25.0 F1：提示词契约层（契约注册 + always-on 技能段 + 契约装配 + 门禁状态机）
import { collectAlwaysOnSections, assembleSystemPrompt } from '../prompt/sections.js'
import {
  collectGateSpecs,
  initGateStates,
  checkGateBeforeAdvance,
  confirmGate,
  findGateForStageDoc,
  isDocDrivenAgent,
} from '../prompt/gates.js'
import type { GateSpec } from '@shared/types/agent'
// v0.19.0 M2：唯一真源会话事件日志（Reason/Act/tool 事件落盘 session.jsonl）
import { appendSessionEvent } from '../session-log.js'
// v0.19.0 M3：轮次/步骤收件箱 + 停止候选钩子（turn/step 语义）
import { drainContinuations } from '../inbox.js'
import { emitTurnStopping } from '../turn-stopping.js'
import {
  matchStageGate,
  isCoreSkillsEnabled,
  buildGateBlockObservation,
  describeGateForLog,
  computeAllowedStage,
  matchForbiddenWritePath,
  matchForbiddenShellCommand,
  type StageGate,
} from '../../skills/builtin/react-core-skills/stage-gates.js'
import { appendL1, listEnabledL1, listL1, totalTokens } from '../../memory/l1-working.js'
import { persistRawL2 } from '../../memory/l2-file.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { isNoisePlanItem } from '@shared/utils/plan-noise'
import { describeAction, describeActionKey } from '@shared/utils/action-description'
import { getUiLocale, tFor } from '../../i18n/messages.js'
import { createHash } from 'node:crypto'
import { updateTask, getTask } from '../../store/tasks.js'
import { getAgent } from '../../store/agents.js'
import {
  broadcastStep,
  broadcastTaskStatus,
  broadcastToolProgress,
  clearToolProgress,
  broadcastPlanItemStatus,
  broadcastPlanListSnapshot,
  broadcastTextDelta,
  type ToolProgress,
} from '../events.js'
// v0.27.0 R1：流式管道（completeWithStream 静默降级 + text-delta 增量泵）
import { completeWithStream, createTextDeltaPump, type TextDeltaPump } from '../llm-stream.js'
import { getWorkspaceDir } from '../../store/db.js'
import { saveCheckpoint, checkpointId } from '../../checkpoint/store.js'
// v0.8.0 记忆系统钩子
import { applyPending, getCuratedSnapshot } from '../../memory/l3-curated.js'
import { archiveTaskL1, initArchiveIndex } from '../../memory/l3-archive.js'
import { getProfile, synthesizeFromTaskL1 } from '../../memory/l4-profile.js'
import { evaluateDistillTrigger, autoPromoteDistill, getDistillMetrics } from '../../memory/distill.js'
import { runForSkillForge } from '../../memory/skill-forge.js'
import { compressMemory } from '../../ipc/memory.js'
// v0.15.0：统一压缩路径——自动压缩与 Turn Phase-0 均走两阶段 compact()（联动 L3b + 压缩后蒸馏）
import { compactTask } from '../../memory/compaction.js'
import { createMemoryPhase0 } from '../../memory/compaction-hook.js'
import type { CompressPolicy } from '@shared/types/memory'
// agent-context-compaction-robustness：上下文预算与分层压缩纯工具模块
import {
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
} from '../context.js'
import { getMemoryConfig, getSettings } from '../../ipc/settings.js'
// v0.8.0 知识库钩子
import { listKb, listEnabledKb } from '../../kb/store.js'
import { searchKb, initKbIndex } from '../../kb/index.js'
import { readFile } from 'node:fs/promises'
// Task 6：上下文占比可视化与下钻
import {
  computeContextBreakdown,
  type ContextBreakdownInput,
  type ContextBreakdownResult,
  type ContextToolEntry,
  type ContextSkillInstruction,
} from '../context-breakdown.js'

import { safeSlice, emitEvent, emitProgress } from './broadcast.js'
import { emitContextSizeReport } from './context.js'
import { buildFallbackAskUserQuestion, markRunningPlanItemFailed, discardIncompletePlanItems, isProductiveTool, decidePlanAdvance, emitPlanStatus } from './gates.js'
import { tryGeneratePlan, generatePlan } from './plan.js'
import { findPlanItemForStage } from './plan-parser.js'
import { injectSkillInstruction, broadcastSkillAutoLoaded } from './skills.js'
import { buildObservationSummary, collectActionsForIteration, appendPairedControlObservations, executeAct, toFinishedProgress } from './act.js'
import { maybePrecallCompact, assembleMessages, assembleTools } from './messages.js'
import { buildMemoryInjection, buildKbStatusLine, autoRecallKb, maybeAutoCompress, runDoneMemoryHooks, buildDistillContext } from './memory-hooks.js'
import type { ActContext, ActExecutionResult } from './act.js'
import { isPhaseHeader } from './plan-parser.js'
import { prepareRun } from './run-setup.js'
import { runReasonPhase } from './reason-phase.js'
import { finishViaTaskComplete, pauseViaAskUser } from './turn-end.js'
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
  /** 最大迭代数（默认 25） */
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
const READONLY_TOOLS = new Set([
  'file-reader',
  'glob-search',
  'grep-search',
  'web-search',
  'fetch-url',
  'session-search',
  'kb-search',
])

function getToolCategoryLimit(tool: string, readonlyLimit: number, defaultLimit: number): number {
  return READONLY_TOOLS.has(tool) ? readonlyLimit : defaultLimit
}

// v0.16.3：调用签名 key = MD5(toolName + args)
function getToolCallKey(tool: string, args: unknown): string {
  const payload = JSON.stringify({ tool, args })
  return createHash('md5').update(payload).digest('hex')
}

// v0.9.x：shell 写入命令特征（命中即视为产出性操作，清零只读停滞计数）
const WRITE_COMMAND_RE = /mkdir|tee|\bcp\b|\bmv\b|\becho\b|cat\s*>|>|\$\s*\(/i

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

  // 标记任务为 running
  await updateTask(task.id, { status: 'running', startedAt: Date.now() })
  broadcastTaskStatus({ ...task, status: 'running' })

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
    let pendingSystemHint = prepared.pendingSystemHint
    let iteration = startIter
    // v0.9.x：连续"只读探索"轮数（>=3 时注入产出提示，防空工作区无限探索）
    let consecutiveReadOnly = 0
    while (iteration < startIter + maxIter) {
      iteration += 1
      if (signal.aborted) {
        await handleAbort(task, iteration, stale)
        return
      }

      // -------- Reason --------
      // Reason 主体（消息组装 / system 契约装配 / 流式 LLM 调用 / 重试与
      // Reactive Fallback 压缩 / reasoning 落盘广播）→ reason-phase.ts（F7 纯移动）
      const { response } = await runReasonPhase({
        task,
        agent,
        modelId: opts.modelId,
        signal,
        iteration,
        pendingSystemHint,
        memoryInjection,
        alwaysOnContracts,
      })
      pendingSystemHint = undefined  // reason 内已消费（原 L695 语义），防陈旧 hint 重复注入
      // -------- 检查终止 --------
      // v0.14.x Task 1：以"是否确有工具调用"为准（collectActionsForIteration 会同时读
      // response.actions 与 response.action），防止适配器只回传 actions（未填 action 单
      // 字段）时把"还要继续跑"误判为最终答复 → 任务被提前置 done / 清单被提前勾完。
      const action = response.action
      const pendingActions = collectActionsForIteration(response)
      // v0.19.x：提前计算每个 action 对应的 toolCallId（与 Act 阶段口径一致），
      // 供 task_complete / ask_user 分支补写"跳过"observation。否则多 action 时
      // 只写控制动作的 observation，其余 assistant tool_calls 悬空，每轮触发
      // reconcileToolCalls "stripped dangling tool_calls"（并有 OpenAI 兼容端点 400 风险）。
      const pendingActionIds: string[] =
        response.toolCallIds && response.toolCallIds.length === pendingActions.length
          ? response.toolCallIds
          : pendingActions.map((_, i) => `call_${iteration}_${i}`)
      if (!action && pendingActions.length === 0) {
        // 模型未调用工具，认为是最终回复
        await emitEvent(task.id, {
          type: 'task_complete',
          iteration,
          summary: safeSlice(response.thought, 500),
        })
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

      // v0.14.0 Task 4：action 可能为 null（模型返回多个 pendingActions 时走下方并行 Act），
      // 单工具分支用可选链兜底，避免 null 穿透
      if (action?.tool === 'task_complete') {
        // v0.27.0 R2/F7：完成收尾（配对 observation / 完成态 / 里程碑 / 记忆钩子）→ turn-end.ts
        await finishViaTaskComplete(
          { task, agent, modelId: opts.modelId },
          action,
          response,
          pendingActions,
          pendingActionIds,
          iteration,
        )
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
      const actions = collectActionsForIteration(response)
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
          await updateTask(task.id, { status: 'paused' })
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
        // 连续 3 轮所有请求都被跳过 → 判定为无法继续，避免模型反复尝试已耗尽签名空转
        if (consecutiveSkippedIterations >= 3) {
          logger.warn('Agent', 'all tools exhausted for 3 consecutive iterations — fail task', task.id)
          await emitEvent(task.id, {
            type: 'task_failed',
            iteration,
            error: '所有工具均已达到调用上限，无法继续执行',
          })
          await markRunningPlanItemFailed(task)
          await updateTask(task.id, { status: 'failed' })
          broadcastTaskStatus({ ...task, status: 'failed' })
          await runDoneMemoryHooks(task, agent, opts.modelId, '')
          return
        }
        // 部分工具达上限但还有其他可用工具 → 注入强提示
        pendingSystemHint = `本次请求的工具（${actions.map((a) => a.tool).join(', ')}）均已达到调用上限。请改用其他可用工具，或基于已有信息推理完成任务。`
      } else {
        consecutiveSkippedIterations = 0
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
            const msg = `${toolName} ${reason}，请改用替代方法`
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
      for (const r of actResults) {
        if (r.additionalSystemHint) pendingSystemHint = r.additionalSystemHint
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
        if (task.planItems && task.planItems.length > 0) {
          const doneIdx = findPlanItemForStage(task.planItems, gate.stage)
          if (doneIdx >= 0) {
            task.planItems[doneIdx].status = 'done'
            task.planItems[doneIdx].completedAt = Date.now()
            task.planItems[doneIdx].updatedAt = Date.now()
            if (doneIdx + 1 < task.planItems.length && task.planItems[doneIdx + 1].status === 'pending') {
              task.planItems[doneIdx + 1].status = 'running'
              task.planItems[doneIdx + 1].updatedAt = Date.now()
            }
            await updateTask(task.id, { planItems: task.planItems })
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
        await updateTask(task.id, { status: 'paused' })
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
      } else if (actions.length > 0 && actions.every((a) => READONLY_TOOLS.has(a.tool))) {
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
        { label: tFor(getUiLocale(), 'suggest.finishHere.label'), description: tFor(getUiLocale(), 'suggest.finishHere.desc') },
      ],
    })
    await updateTask(task.id, { status: 'paused' })
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
    await markRunningPlanItemFailed(task)
    await updateTask(task.id, { status: 'failed' })
    broadcastTaskStatus({ ...task, status: 'failed' })
    // v0.9.1 §Task 7：失败路径也尝试归档 L1，让失败的经验也能进入 L3b/L4a
    try {
      await runDoneMemoryHooks(task, agent, opts.modelId, '')
    } catch (hookErr) {
      logger.warn('Memory', `runDoneMemoryHooks on failed path errored: ${(hookErr as Error).message}`, task.id)
    }
  }
}
