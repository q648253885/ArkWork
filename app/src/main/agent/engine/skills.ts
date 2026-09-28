/**
 * v0.27.0 R2（§3.1 引擎拆分）：技能指令注入与自动加载广播
 * 由 engine.ts 纯移动而来（行区间 2356-2414）。
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
