/**
 * v0.27.0 R2（§3.1 引擎拆分）：记忆六钩子：L1 注入、KB 召回、自动压缩、完成态蒸馏、画像沉淀
 * 由 engine.ts 纯移动而来（行区间 3325-3569）。
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

import { safeSlice, emitEvent, emitProgress } from './broadcast.js'

/* ============================================================
 * v0.8.0 记忆系统钩子
 * F801 token 阈值自动压缩 / F802-F804 启动注入 / F803-F805 run done 归档与蒸馏
 * ============================================================ */

/**
 * 构建记忆注入文本——run 启动时读取 L3a 策展快照 + L4a 画像合成 + KB 状态行，拼为 system prompt 片段。
 * 预算硬顶：画像 + 策展合计 ≤2,000 tokens（字符级约 6,000，先压策展后压画像）。
 * v0.8.0 F822：智能体可通过 memoryScope.useProfile=false 关闭画像注入。
 * v0.8.0 F812：追加知识库状态行（启用列表 + chunks 数），Agent 据此自主调用 kb-search。
 * @returns 注入文本（空串表示无内容可注入）
 */
export async function buildMemoryInjection(agent: Agent, task: Task): Promise<string> {
  const snapshot = await getCuratedSnapshot()
  // v0.8.0 F822：memoryScope.useProfile 默认 true
  const useProfile = agent.memoryScope?.useProfile !== false
  const profile = useProfile ? await getProfile() : null

  const parts: string[] = []
  if (snapshot.memoryMd.trim()) {
    parts.push(`## 工作区策展记忆\n${snapshot.memoryMd.trim()}`)
  }
  if (snapshot.userMd.trim()) {
    parts.push(`## 用户记忆笔记\n${snapshot.userMd.trim()}`)
  }
  if (profile && profile.synthesis.trim()) {
    parts.push(`## 用户画像\n${profile.synthesis.trim()}`)
  }

  // v0.8.0 F812：知识库状态行——始终包含（即使为空也告知 Agent 无可用 KB）
  const kbHint = await buildKbStatusLine(task)
  if (kbHint) parts.push(kbHint)

  return parts.join('\n\n')
}

/**
 * v0.8.0 F812：构建知识库状态行。
 * 检索范围 = task.kbIds 优先，缺省继承面板 enabled 集合。
 * 有启用时列出名称+chunks 数，提示 Agent 可用 kb-search；无启用时省略。
 */
export async function buildKbStatusLine(task: Task): Promise<string> {
  try {
    // Task 8：全局/会话级任一关闭 → 不注入知识库状态行（关闭后不再提示 Agent 可用 kb-search）
    const settings = await getSettings()
    if (settings.kbEnabled === false || task.kbEnabled === false) return ''
    let kbIds = task.kbIds ?? null
    let kbList = await listEnabledKb()
    if (kbIds && kbIds.length > 0) {
      // task 级覆盖：只取交集（task 启用的且面板 enabled 的）
      const idSet = new Set(kbIds)
      kbList = kbList.filter((k) => idSet.has(k.id))
    }
    if (kbList.length === 0) return ''
    const summary = kbList.map((k) => `${k.name}(${k.chunks ?? 0} chunks)`).join('、')
    return `## 知识库\n已启用知识库：${summary}；可用 kb-search 检索相关片段。`
  } catch (err) {
    logger.warn('Agent', `KB status line failed (silent): ${(err as Error).message}`, task.id)
    return ''
  }
}

/**
 * v0.8.0 F812：自动召回——run 启动时用用户首条消息检索 KB top-3，
 * 命中片段作为 kind:'kb_hit' L1 条目注入（enabled 默认 true，用户可取消勾选）。
 * 自动召回为空时不产生任何条目与 UI 噪音。
 */
export async function autoRecallKb(task: Task): Promise<void> {
  const userText = task.input?.text?.trim()
  if (!userText) return

  try {
    // Task 8：全局/会话级任一关闭 → 不自动召回（否则关闭后仍会注入 kb_hit）
    const settings = await getSettings()
    if (settings.kbEnabled === false || task.kbEnabled === false) {
      logger.info('Agent', 'KB auto-recall skipped (toggle off)', task.id)
      return
    }
  } catch {
    // settings 读取失败不阻断，继续走后续逻辑
  }

  try {
    await initKbIndex()
    let kbIds = task.kbIds ?? null
    if (!kbIds || kbIds.length === 0) {
      const enabled = await listEnabledKb()
      kbIds = enabled.map((k) => k.id)
    }
    if (kbIds.length === 0) return

    const hits = await searchKb(userText, kbIds, 3)
    if (hits.length === 0) return

    // 注入 kb_hit L1 条目（在 system_prompt 之后，reason 之前）
    for (const hit of hits) {
      await appendL1({
        taskId: task.id,
        role: 'system',
        kind: 'kb_hit',
        content: `[知识库 · ${hit.kbName} #${hit.seq}] ${hit.text}`,
        enabled: true,
        iteration: 0,
      })
    }
    logger.info('Agent', `KB auto-recall: ${hits.length} hits injected`, task.id)
  } catch (err) {
    logger.warn('Agent', `KB auto-recall failed (silent): ${(err as Error).message}`, task.id)
  }
}

/**
 * F801 token 阈值自动压缩——每轮完成后检查 enabled L1 的 token 量，
 * 超过阈值时自动执行压缩（v0.15.0 统一走两阶段 compact()，联动 L3b 归档
 * 与压缩后蒸馏；沿用 CompressPolicy 语义，不打断运行）。
 * 压缩完成后发射 memory_compressed 事件供 UI 展示 chip。
 */
export async function maybeAutoCompress(
  taskId: string,
  iteration: number,
): Promise<void> {
  const config = await getMemoryConfig()
  if (!config.autoCompress) return

  const enabled = await listEnabledL1(taskId)
  const used = totalTokens(enabled)
  if (used < config.compressThreshold) return

  logger.info('Memory', `auto-compress triggered: ${used} >= ${config.compressThreshold} tokens`, taskId)
  try {
    const task = await getTask(taskId)
    const result = await compactTask(taskId, { modelId: task?.modelId ?? undefined })
    // 无实质压缩（无丢弃条目）不发射事件，避免 UI 展示无效压缩 chip
    if (result.stats.droppedMessageCount === 0 && result.tokenAfter >= result.tokenBefore) return
    await emitEvent(taskId, {
      type: 'memory_compressed',
      iteration,
      beforeTokens: result.tokenBefore,
      afterTokens: result.tokenAfter,
      archivedCount: result.stats.droppedMessageCount,
      summaryId: genId('comp'),
      auto: true,
    })
  } catch (err) {
    logger.warn('Memory', `auto-compress failed (silent): ${(err as Error).message}`, taskId)
  }
}

/**
 * F803/F804/F805 run done 记忆钩子——任务完成后：
 * 1. 归档：该任务全部 L1 条目异步入库 L3b 档案（ADD-only，跳过 system_prompt）；
 * 2. 画像合成：L4a 辩证合成（提取观察 → LLM 合成 → 版本+1），更新后发射 profile_updated；
 * 3. 蒸馏评估：按规模门槛评估触发，命中则自动蒸馏（晋升 L3/L4 并清理 L1/L2），
 *    完成后发射 distill_completed 轻量提示（不再弹"是否需要蒸馏"建议卡）。
 * 全程失败静默降级（不影响任务完成）。
 */
export async function runDoneMemoryHooks(
  task: Task,
  agent: Agent,
  modelId: string,
  _finalThought: string,
): Promise<void> {
  const l1Items = await listL1(task.id)

  // 1. F803 归档到 L3b
  try {
    const taskTitle = safeSlice(task.input?.text ?? '', 80) || task.id
    await archiveTaskL1(task.id, taskTitle, l1Items)
  } catch (err) {
    logger.warn('Memory', `L3b archive failed (silent): ${(err as Error).message}`, task.id)
  }

  // 2. F804 L4a 画像合成
  try {
    const synthResult = await synthesizeFromTaskL1(task.id, l1Items, modelId)
    if (synthResult.synthesisUpdated) {
      await emitEvent(task.id, {
        type: 'profile_updated',
        iteration: 0,
        version: synthResult.profile.version,
        newObservations: synthResult.newObservations,
      })
    }
  } catch (err) {
    logger.warn('Memory', `L4a synthesis failed (silent): ${(err as Error).message}`, task.id)
  }

  // 3. F805 蒸馏评估（Task 10：仅规模门槛命中才自动执行，完成后发轻量完成提示）
  try {
    const ctx = buildDistillContext(task.id, l1Items)
    const metrics = await getDistillMetrics(task.id, l1Items)
    const evalResult = await evaluateDistillTrigger({ ...ctx, ...metrics })
    if (evalResult.trigger && evalResult.category) {
      const message = await autoPromoteDistill({ ...ctx, ...metrics }, evalResult.category, modelId)
      await emitEvent(task.id, {
        type: 'distill_completed',
        iteration: 0,
        taskId: task.id,
        category: evalResult.category,
        message,
      })
    }
  } catch (err) {
    logger.warn('Memory', `distill evaluation failed (silent): ${(err as Error).message}`, task.id)
  }

  // 4. v0.25.0 F3：技能创建严格管线（skill-forge 五阶段）—— L2 步骤产物为唯一合法候选
  try {
    const forgeResult = await runForSkillForge(task.id, modelId)
    if (forgeResult.skill) {
      await emitEvent(task.id, {
        type: 'distill_completed',
        iteration: 0,
        taskId: task.id,
        category: 'skill',
        message: forgeResult.reason,
      })
    } else if (forgeResult.stage === 'value-judge' || forgeResult.stage === 'integrity') {
      // 评估未通过 / 校验未过：发轻量事件给 UI（任务完成提示中说明）
      logger.info('Memory', `skill-forge ${forgeResult.stage} not passed: ${forgeResult.reason}`, task.id)
    }
  } catch (err) {
    logger.warn('Memory', `skill-forge failed (silent): ${(err as Error).message}`, task.id)
  }
}

/** 从 L1 条目构建蒸馏触发上下文（启发式提取信号） */
export function buildDistillContext(
  taskId: string,
  l1Items: import('@shared/types/memory').MemoryItem[],
): import('../../memory/distill.js').DistillTriggerContext {
  const observations = l1Items.filter((m) => m.kind === 'observation' && !m.archivedAt)
  const toolCallCount = observations.length
  const hadErrorRecovery = observations.some(
    (m, i) => /\]\s*failed:/.test(m.content) && observations.slice(i + 1).some((n) => !/\]\s*failed:/.test(n.content)),
  )
  const userMessages = l1Items.filter((m) => m.kind === 'user_message')
  const hadUserCorrection = userMessages.some((m) =>
    /不对|错了|不是|纠正|应该|重新|重做/.test(m.content),
  )
  const hadPreferenceExpression = userMessages.some((m) =>
    /我喜欢|我习惯|请用|不要|偏好|希望|最好/.test(m.content),
  )
  return { taskId, l1Items, toolCallCount, hadErrorRecovery, hadUserCorrection, hadPreferenceExpression }
}
