/**
 * v0.27.0 R2（§3.1 引擎拆分）：计划解析适配层：单源共享解析器再导出 + 阶段匹配（叶子模块）
 * 由 engine.ts 纯移动而来（行区间 2126-2168）。
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
export { parsePlanItems, parsePlanItemsJson, parsePlanItemsLines, parsePlanItemsArrows, sanitizePlanItemText, isPhaseHeader } from '@shared/utils/plan-parse'
// v0.36.5（D125）：清单树快照渲染器（实现在共享 plan-parse 零依赖模块，此处按设计文档契约再导出）
export { renderPlanTreeSnapshot } from '@shared/utils/plan-parse'

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
