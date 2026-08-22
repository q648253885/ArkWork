/**
 * v0.27.0 R2（§3.1 引擎拆分）：上下文体量评估：任务上下文估算与明细拆解报告
 * 由 engine.ts 纯移动而来（行区间 1688-1857）。
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
import { describeAction } from '@shared/utils/action-description'
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
