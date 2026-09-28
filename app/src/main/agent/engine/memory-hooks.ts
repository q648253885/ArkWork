/**
 * v0.27.0 R2（§3.1 引擎拆分）：记忆六钩子：L1 注入、KB 召回、自动压缩、完成态蒸馏、画像沉淀
 * 由 engine.ts 纯移动而来（行区间 3325-3569）。
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
  initArchiveIndex,
  getProfile,
  compressMemory,
  compactTask,
  resolveAutoCompactThreshold,
  resolveModelMaxTokens,
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
// v0.36.0（F1.2）：任务级四步转化（L3b 归档 / L4a 合成 / 蒸馏 / 技能炼制）
// 统一由记忆转化管线编排 —— 钩子退化为「触发点」，不再自己串流程。
// buildDistillContext 也搬到管线（它属于转化链而非引擎）。
import { buildDistillContext, runMemoryPipeline } from '../../memory/pipeline.js'
export { buildDistillContext } from '../../memory/pipeline.js'
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
 * v0.36.0 F1.3：阈值改为**模型窗口驱动**（resolveAutoCompactThreshold）；
 * 用户显式设置的 compressThreshold 仅作覆盖上限。压缩完成后发射
 * memory_compressed 事件供 UI 展示 chip。
 */
export async function maybeAutoCompress(
  taskId: string,
  iteration: number,
): Promise<void> {
  const config = await getMemoryConfig()
  if (!config.autoCompress) return

  const task = await getTask(taskId)
  // 模型窗口驱动：无模型/解析失败回落 180_000（与 compactTask 口径一致）
  const modelMaxTokens = await resolveModelMaxTokens(task?.modelId)
  const threshold = resolveAutoCompactThreshold(
    modelMaxTokens,
    config.compressThresholdSet ? config.compressThreshold : undefined,
  )

  const enabled = await listEnabledL1(taskId)
  const used = totalTokens(enabled)
  if (used < threshold) return

  logger.info('Memory', `auto-compress triggered: ${used} >= ${threshold} tokens (window ${modelMaxTokens})`, taskId)
  try {
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
 * F803/F804/F805 run done 记忆钩子 —— **任务级转化的触发点**。
 *
 * v0.36.0（F1.2）起本函数只做一件事：把「任务终态」这个事实交给记忆转化管线
 * （`runMemoryPipeline(taskId, 'task-done')`），由管线按固定顺序执行
 * L3b 归档 → L4a 画像合成 → 蒸馏评估 → 技能炼制，并逐步上报 `memory_pipeline` 事件。
 *
 * 为什么改成委派而不是继续在这里串流程：
 *  ① 顺序与跳过语义只有一处真源（管线里的 PIPELINE_STAGES 表）；
 *  ② 「哪一步没跑到」从一条 warn 变成交互区可见的事件（记忆丢步最难查）；
 *  ③ 管线可注入可测，等价流程的测试不必再拉起整个引擎。
 *
 * 失败语义不变：**全程失败静默降级**，绝不影响任务完成态。
 */
export async function runDoneMemoryHooks(
  task: Task,
  agent: Agent,
  modelId: string,
  _finalThought: string,
): Promise<void> {
  try {
    const run = await runMemoryPipeline(task.id, 'task-done', { task, agent, modelId })
    if (!run.ok) {
      const bad = run.steps.filter((s) => !s.ok).map((s) => `${s.stage}(${s.detail})`)
      logger.warn('Memory', `转化管线有步骤失败：${bad.join('；')}`, task.id)
    }
  } catch (err) {
    // 管线自身已逐步隔离；这里兜的是「取任务/取 L1」这类管线外异常
    logger.warn('Memory', `run done memory hooks failed (silent): ${(err as Error).message}`, task.id)
  }
}
