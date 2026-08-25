/**
 * v0.27.0 R2（§3.1 引擎拆分）：技能指令注入与自动加载广播
 * 由 engine.ts 纯移动而来（行区间 2356-2414）。
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

/**
 * v0.25.0 F1：on-demand 技能指令体注入 L1 skill_instruction（持续生效至任务结束）。
 * 替代旧 `pendingSystemHint` 单轮机制 —— 同一技能按 skillId 去重取最新一条，
 * 装配阶段 assembleMessages 把 skill_instruction 作为独立 user 消息注入（与 plan_status 同管道），
 * 复用既有归档/压缩策略（压缩时与 system_prompt 同等保留）。
 * 错误场景：appendL1 失败 → 抛错（让 invokeSkill 上层走软失败通道）。
 */
export async function injectSkillInstruction(
  task: Task,
  skill: { id: string; name: string },
  text: string,
  iteration: number,
): Promise<void> {
  if (!text || !text.trim()) return
  // 按 skillId 去重：先 archive 旧 skill_instruction（同 skillId），再 appendL1 写入最新一条。
  try {
    const { archiveL1 } = await import('../../memory/l1-working.js')
    const { listEnabledL1 } = await import('../../memory/l1-working.js')
    const existing = await listEnabledL1(task.id)
    const oldIds = existing
      .filter((m) => m.kind === 'skill_instruction' && (m.meta ?? '').includes(`"skillId":"${skill.id}"`))
      .map((m) => m.id)
    if (oldIds.length > 0) {
      await archiveL1(task.id, oldIds[0]) // archiveL1 接受单 id；其余 batch archive
      for (let i = 1; i < oldIds.length; i++) await archiveL1(task.id, oldIds[i])
    }
  } catch (err) {
    logger.warn('Agent', `injectSkillInstruction dedupe skipped: ${(err as Error).message}`, task.id)
  }
  await appendL1({
    taskId: task.id,
    role: 'assistant',
    kind: 'skill_instruction',
    iteration,
    content: text,
    meta: JSON.stringify({ skillId: skill.id, skillName: skill.name }),
  })
  logger.info('Tool', `skill_instruction injected: ${skill.id} (${text.length} chars)`, task.id)
}

/** v0.24.1：广播「技能已自动加载」可见步骤（显式 Use Skill: X 时，首轮 Reason 前调用）。 */
export function broadcastSkillAutoLoaded(task: Task, skillName: string, instructionMd: string): void {
  const now = Date.now()
  const step: ReActStep = {
    id: genId('step'),
    taskId: task.id,
    iteration: 0,
    type: 'act',
    toolName: skillName,
    toolArgs: JSON.stringify({ action: '自动加载指令' }, null, 2),
    intent: `自动加载技能「${skillName}」指令`,
    startedAt: now,
    durationMs: 0,
    status: 'success',
    result: { instructionLoaded: true, instructionMd },
    resultSummary: `已自动加载技能「${skillName}」指令（${instructionMd}），请严格按指令执行`,
  }
  broadcastStep(step)
}
