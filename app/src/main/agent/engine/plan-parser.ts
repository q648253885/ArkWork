/**
 * v0.27.0 R2（§3.1 引擎拆分）：计划解析适配层：单源共享解析器再导出 + 阶段匹配（叶子模块）
 * 由 engine.ts 纯移动而来（行区间 2126-2168）。
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

export { parsePlanItems, parsePlanItemsJson, parsePlanItemsLines, parsePlanItemsArrows, sanitizePlanItemText, isPhaseHeader } from '@shared/utils/plan-parse'

/**
 * v0.17.5：根据文档驱动开发阶段（CoreStageId）匹配 planItem 的索引。
 * 阶段门禁触发时，把对应阶段的计划项标 done。匹配策略：
 *  1. 优先文本关键词（"调研"/"PRD"/"交互"/"原型"/"系统设计"）
 *  2. 兜底"阶段 N"编号（N 对应阶段序号）
 * 返回 -1 表示未匹配（可能计划项未按阶段标注，或该阶段被合并）。
 */
export function findPlanItemForStage(planItems: PlanItem[], stage: string): number {
  const keywordMap: Record<string, RegExp> = {
    research: /调研|research/i,
    prd: /PRD|产品|需求/i,
    interaction: /交互|interaction/i,
    prototype: /原型|prototype/i,
    'system-design': /系统设计|system.?design|架构|技术选型/i,
  }
  const stageNumMap: Record<string, number> = {
    research: 1,
    prd: 2,
    interaction: 3,
    prototype: 4,
    'system-design': 5,
  }
  const keyword = keywordMap[stage]
  const stageNum = stageNumMap[stage]
  // 第一遍：关键词匹配（从前往后，取第一个未完成的）
  if (keyword) {
    for (let i = 0; i < planItems.length; i++) {
      if (keyword.test(planItems[i].text)) return i
    }
  }
  // 第二遍：编号匹配（"阶段 N" 或 "第 N 步"）
  if (stageNum) {
    const numRe = new RegExp(`(?:阶段|phase|step)\\s*${stageNum}(?:\\s*[:：]|\\b)`, 'i')
    for (let i = 0; i < planItems.length; i++) {
      if (numRe.test(planItems[i].text)) return i
    }
  }
  // 第三遍：顺序兜底 —— 若 planItem 数量等于阶段数，用 stageNum-1 作为索引
  if (stageNum && stageNum - 1 < planItems.length) {
    return stageNum - 1
  }
  return -1
}
