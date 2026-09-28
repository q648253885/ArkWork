/**
 * v0.27.0 R2（§3.1 引擎拆分）：上下文体量评估：任务上下文估算与明细拆解报告
 * 由 engine.ts 纯移动而来（行区间 1688-1857）。
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
import { emitEvent } from './broadcast.js'
import { buildMemoryInjection } from './memory-hooks.js'
import { assembleMessages, assembleTools } from './messages.js'

/** v0.15.x：在每次 LLM 调用前报告真实 payload token 用量（system + messages + tools + memory injection） */
export async function emitContextSizeReport(opts: {
  taskId: string
  iteration: number
  systemPrompt: string
  messages: LlmMessage[]
  tools: LlmTool[] | undefined
  memoryInjection?: string
  contextWindow?: number
}): Promise<void> {
  const { total, breakdown } = estimatePayloadTokensDetailed({
    system: opts.systemPrompt,
    messages: opts.messages,
    tools: opts.tools,
  })
  // systemPrompt 已内嵌 memoryInjection（engine 拼接 parts 时 push 进 system），
  // 分项展示时从 systemTokens 中扣除 memoryInjectionTokens，避免 UI 双重计数。
  const memTokens = opts.memoryInjection ? estimateTextTokens(opts.memoryInjection) : undefined
  await emitEvent(opts.taskId, {
    type: 'context_size_report',
    taskId: opts.taskId,
    iteration: opts.iteration,
    payloadTokens: total,
    budget: contextBudget(opts.contextWindow),
    systemTokens: breakdown.systemTokens - (memTokens ?? 0),
    messagesTokens: breakdown.messagesTokens,
    toolsTokens: breakdown.toolsTokens,
    memoryInjectionTokens: memTokens,
    modelContextWindow: opts.contextWindow ?? 64000,
  })
}

/**
 * v0.15.x：按需计算某任务的真实 payload 估算（system + messages + tools + memory injection）。
 * 与 emitContextSizeReport 同口径，但不触发压缩副作用（skipPrecallCompact），
 * 供上下文面板/输入框在非运行态（空闲、完成、切换任务）也如实展示真实用量。
 * @returns null 表示任务不存在或估算失败（调用方回落 L1 累加）
 */
export async function estimateTaskContext(taskId: string): Promise<{
  taskId: string
  payloadTokens: number
  budget: number
  breakdown: {
    systemTokens: number
    messagesTokens: number
    toolsTokens: number
    memoryInjectionTokens?: number
  }
  modelContextWindow: number
} | null> {
  try {
    const task = await getTask(taskId)
    if (!task) return null
    const agent = await getAgent(task.agentId)
    if (!agent) return null
    const model = await getModel(task.modelId)

    // 与 runReActLoop 相同拼装：personality + wsHint + memoryInjection
    let memoryInjection = ''
    try {
      memoryInjection = await buildMemoryInjection(agent, task)
    } catch { /* 注入失败按空处理 */ }
    const systemPrompt = renderSystemPrompt(
      buildSystemSections({ agent, workspaceDir: getWorkspaceDir(), memoryInjection }),
    )

    const messages = await assembleMessages(task, agent, { skipPrecallCompact: true })
    const tools = await assembleTools(agent, task)
    const { total, breakdown } = estimatePayloadTokensDetailed({
      system: systemPrompt,
      messages,
      tools,
    })
    const memTokens = memoryInjection ? estimateTextTokens(memoryInjection) : undefined
    return {
      taskId,
      payloadTokens: total,
      budget: contextBudget(model?.contextWindow),
      breakdown: {
        systemTokens: breakdown.systemTokens - (memTokens ?? 0),
        messagesTokens: breakdown.messagesTokens,
        toolsTokens: breakdown.toolsTokens,
        memoryInjectionTokens: memTokens,
      },
      modelContextWindow: model?.contextWindow ?? 64000,
    }
  } catch (err) {
    logger.warn('Agent', `estimateTaskContext failed: ${(err as Error).message}`, taskId)
    return null
  }
}

/**
 * Task 6：按分类计算上下文占比明细（system / files / tools / messages / mcp / skills / other）。
 * 与 estimateTaskContext 同口径装配 system / messages / tools / memoryInjection，
 * 再按分类拆分并附可下钻明细，供上下文侧边栏占比可视化使用。
 * 非运行态（空闲 / 完成 / 切换任务）也可如实展示。
 * @returns null 表示任务不存在或装配失败
 */
export async function getTaskContextBreakdown(taskId: string): Promise<ContextBreakdownResult | null> {
  try {
    const task = await getTask(taskId)
    if (!task) return null
    const agent = await getAgent(task.agentId)
    if (!agent) return null
    const model = await getModel(task.modelId)
    const budget = contextBudget(model?.contextWindow)

    // system prompt（不含记忆注入）：agent.systemPrompt + 人格段 + 工作区指令
    // v0.19.0 M1：同时保留有序 section，供上下文面板按段下钻展示。
    const systemSections = buildSystemSections({ agent, workspaceDir: getWorkspaceDir() })
    const systemPrompt = renderSystemPrompt(systemSections)

    // 记忆注入（策展记忆 / 用户画像 / 知识库状态行）
    let memoryInjection = ''
    try {
      memoryInjection = await buildMemoryInjection(agent, task)
    } catch {
      /* 注入失败按空处理 */
    }

    // 装配对话消息（与真实 payload 同口径，跳过 precall 压缩副作用）
    const messages = await assembleMessages(task, agent, { skipPrecallCompact: true })

    // L1 条目：file_ref 单独归类为「文件」
    const l1 = await listEnabledL1(task.id)
    const fileItems = l1.filter((m) => m.kind === 'file_ref')

    // 技能：合并 agent 默认 + 任务会话级，过滤已禁用（与 assembleTools 同口径）
    const skills = await listSkills()
    const mergedIds = [...new Set([...agent.defaultSkillIds, ...(task.skillIds || [])])]
    const available = skills.filter((s) => mergedIds.includes(s.id) && s.enabled !== false)
    const lockedSet = new Set(agent.defaultSkillIds)
    const toolEntries: ContextToolEntry[] = available.map((s) => ({
      skillId: s.id,
      skillName: s.name,
      source: s.source,
      tool: skillToLlmTool(s),
      isMcp: s.source === 'mcp',
      locked: lockedSet.has(s.id),
    }))

    // 技能 instruction.md 指令体（按需加载，仅 enabled 技能；与 invokeSkill 渐进式披露一致）
    const skillInstructions: ContextSkillInstruction[] = []
    for (const s of available) {
      if (!s.instructionMd) continue
      try {
        const content = await readFile(s.instructionMd, 'utf-8')
        skillInstructions.push({ skillId: s.id, skillName: s.name, content, locked: lockedSet.has(s.id) })
      } catch {
        /* 读取失败按无指令体处理 */
      }
    }

    const input: ContextBreakdownInput = {
      maxTokens: budget,
      systemPrompt,
      systemSections,
      memoryInjection,
      fileItems,
      messages,
      toolEntries,
      skillInstructions,
    }
    return computeContextBreakdown(input)
  } catch (err) {
    logger.warn('Agent', `getTaskContextBreakdown failed: ${(err as Error).message}`, taskId)
    return null
  }
}
