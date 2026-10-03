/**
 * v0.27.0 R2（§3.1 引擎拆分）：广播辅助：安全截断与进度/事件发射（通用叶子模块）
 * 由 engine.ts 纯移动而来（行区间 107-116 / 1626-1644 / 1668-1686）。
 */

import { stripEventResultForBroadcast } from './event-payload.js'
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
/** 按 UTF-16 编码单元截断，但避免在 Unicode 代理对中间切开，防止产生 lone surrogate 导致 JSON 序列化 400 */
export function safeSlice(content: string, max: number): string {
  if (content.length <= max) return content
  let end = max
  const lead = content.charCodeAt(end - 1)
  if (lead >= 0xd800 && lead <= 0xdbff && content.charCodeAt(end) >= 0xdc00 && content.charCodeAt(end) <= 0xdfff) {
    end -= 1
  }
  return content.slice(0, end)
}

export async function emitEvent(taskId: string, event: ReActEvent): Promise<void>
export async function emitEvent(
  taskId: string,
  event: ReActEvent,
  opts: { broadcastWithoutResult?: boolean },
): Promise<void>
export async function emitEvent(
  taskId: string,
  event: ReActEvent,
  opts?: { broadcastWithoutResult?: boolean },
): Promise<void> {
  // v0.46.0（PERF-2 W10）：`broadcastWithoutResult` —— 广播载荷剥掉完整 `result`。
  // 纯函数 stripEventResultForBroadcast（event-payload.ts）可密闭单测。
  // 落盘不受影响：下方 appendSessionEvent 仍写原始 event（session.jsonl 是日志
  // 真源，session 导出 / 诊断不受影响）。
  const payload =
    opts?.broadcastWithoutResult ? stripEventResultForBroadcast(event) : event
  // 通过 IPC 推送给 renderer
  try {
    const { broadcast } = await import('../../window.js')
    broadcast('task:event', payload)
  } catch (err) {
    // v0.15.x Task 4：广播失败不得打断引擎主流程 —— 仅记 warn 后静默返回。
    // 若 broadcast 抛错（例如窗口已销毁、IPC 通道断开），不能让 ReAct 循环
    // 因一个事件推送失败而直接失败。
    logger.warn('Agent', `emitEvent broadcast failed (silent): ${(err as Error).message}`, event.type)
  }
  // v0.19.0 M2：事件流同时落盘 session.jsonl（唯一真源，先双轨 —— 日志为真源，
  // L1 仍作为索引缓存）。落盘失败同样静默降级，不打断引擎主流程。
  // 注意：落盘的始终是**原始 event**（含 result），只有广播载荷被瘦身。
  try {
    await appendSessionEvent(taskId, event)
  } catch (err) {
    logger.warn('Agent', `emitEvent session-log failed (silent): ${(err as Error).message}`, event.type)
  }
}

/**
 * Task 9：侧边栏进度摘要事件发射（轻量包装，避免 import cycle）。
 * - task_progress：阶段级（currentStage / overallPercentage / nextStepLabel）
 * - task_step_complete：SubTask 完成（按 stage 归类）
 * - task_milestone：里程碑节点到达
 */
export async function emitProgress(
  event:
    | { type: 'task_progress'; taskId: string; currentStage: string; stageIndex: number; overallPercentage: number; nextStepId?: string; nextStepLabel?: string }
    | { type: 'task_step_complete'; taskId: string; stepId: string; label: string; stage: string; ok: boolean; durationMs: number }
    | { type: 'task_milestone'; taskId: string; milestoneId: string; label: string; reachedAt: number; artifactPath?: string },
): Promise<void> {
  try {
    const { broadcast } = await import('../../window.js')
    broadcast('task:event', event as ReActEvent)
  } catch (err) {
    logger.warn('Agent', `emitProgress failed: ${(err as Error).message}`, event.taskId)
  }
}
