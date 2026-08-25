/**
 * v0.27.0 R2（§3.1 引擎拆分）：入口分发：chat / task 双通道路由与回合驱动
 * 由 engine.ts 纯移动而来（行区间 3571-3743）。
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

import { classifyRoute } from '../../router/classify-route.js'
import { routeAgent } from '../../router/route-agent.js'
import { builtinAgentRegistry } from '../../store/agents.js'
import { createTurn, runTurn } from '../../engine/phase-runner.js'
import type { Turn, TurnResult } from '../../engine/types.js'

/* ============================================================
 * v0.14.0 Task 4 §4.5 — chat/task 入口分流 wrapper
 *
 * 设计意图：
 *   - 保持既有 `runReActLoop` 主体一字不动；旧 `runner.runTask` 链路（task:run IPC
 *     → runTask → runReActLoop）继续可用，零调用方改动
 *   - 上层 Composer / IPC 如需走新 Turn 模型，可调用 `dispatchChatOrTask(input)` /
 *     `runTurnForTask(task, ...)`；chat 命中时绕过 runTurn 走单次 LLM 补全
 *   - dispatcher 命中 task kind 时，包成 Turn 并启动 runTurn（不破坏既有流）
 *
 * 约束：
 *   - 不删除/重写 runReActLoop 主体
 *   - chat 路径不创建 Task；task 路径复用既有 Task，附带创建 Turn 镜像
 * ============================================================ */
// Agent 类型已在文件顶部 import 复用（避免重复导入触发 TS2300）

/** v0.14.0 Task 4 §4.5 — chat/task 分流判定结果。 */
export type ChatOrTask = 'chat' | 'task'

/**
 * chat 路径单次补全：直接调 LLM 处理用户输入，不进入 runTurn / ReAct 循环。
 * 内部仍复用 `getAdapter` + `assembleMessages`（仅 system + L1），不做工具调用。
 *
 * Returns the assistant reply text. 调用方负责把 user/reply 写入 L1（与既有 chat 流一致）。
 */
export async function runChatOnce(
  input: string,
  opts: { modelId: string; agent?: Agent; signal?: AbortSignal; taskId?: string },
): Promise<string> {
  const adapter = await getAdapter(opts.modelId)
  const systemPrompt = opts.agent?.systemPrompt ?? ''
  const t0 = Date.now()
  // v0.27.0 R1：携带 taskId 时开启流式增量推送（scope='chat'，渲染加速通道）；
  // 完整回复仍以本函数返回值为唯一数据源。
  // holder 对象绕过 TS 闭包赋值窄化（let 变量会被收窄为 never）。
  const pumpRef: { current: TextDeltaPump | null } = { current: null }
  const response = await completeWithStream(
    adapter,
    {
      system: systemPrompt,
      messages: [{ role: 'user', content: input }],
      // chat 路径固定不挂工具；forceChat 流与现有 sendMessage 旧路径行为一致
      tools: undefined,
      signal: opts.signal,
    },
    {
      onText: (delta) => {
        if (!opts.taskId) return
        if (!pumpRef.current) {
          pumpRef.current = createTextDeltaPump(opts.taskId, 'chat', broadcastTextDelta)
        }
        pumpRef.current.push(delta)
      },
    },
  )
  pumpRef.current?.flush()
  logger.info(
    'LLM',
    `chat once (${opts.modelId}) ← ${response.tokensIn}+${response.tokensOut} tokens ⏱ ${Date.now() - t0}ms`,
  )
  return response.thought ?? response.content ?? ''
}

/**
 * task 路径入口：把 Task 包成一个 Turn 并启动 runTurn（Phase 0~3）。
 *
 * 不替换 runReActLoop — 既有的 task:run / runner.runTask 路径仍走 runReActLoop。
 * 本函数用于「新 Turn 模型」路径（如 Composer 在判定为 task 后直接构造 Turn）。
 */
export async function runTurnForTask(
  task: Task,
  opts: {
    modelId: string
    input: string
    signal: AbortSignal
    maxIterations?: number
  },
): Promise<TurnResult> {
  const { turn, maxIterations } = createTurn({
    task,
    input: opts.input,
    abortSignal: opts.signal,
    maxIterations: opts.maxIterations,
  })
  void routeAgent(turn.input, builtinAgentRegistry) // 预热：phase-1 内部还会调
  // 将多参数的真实签名收拢为 TurnDeps 的单参数契约
  const boundRouteAgent = (input: string) => routeAgent(input, builtinAgentRegistry)
  // invokeSkill 真实签名是 (skillId, args, ctx)；PhaseRunner 契约只取前两个
  const boundInvokeSkill = (skillId: string, args: Record<string, unknown>) =>
    invokeSkill(skillId, args, {
      taskId: task.id,
      signal: opts.signal,
      workspaceDir: getWorkspaceDir(),
      task,
      // agent 留空：PhaseRunner 在最小骨架内不调用需要 agent 的 skill
    })
  return runTurn(turn, {
    classifyRoute,
    routeAgent: boundRouteAgent,
    invokeSkill: boundInvokeSkill,
    faultTolerant: <T>(fn: () => Promise<T>, _ctx: import('../../engine/phase-runner.js').FaultContext) => {
      return (async () => {
        try {
          const value = await fn()
          return { ok: true as const, value, outcome: 'retry-succeeded' }
        } catch (err) {
          return {
            ok: false as const,
            outcome: 'no-impact',
            fault: { code: 'stub', message: (err as Error).message },
          }
        }
      })()
    },
    memoryPhase0: createMemoryPhase0({
      // Turn 实体无 taskId 字段，由引擎装配真实任务 id
      resolveTaskId: () => task.id,
      modelId: opts.modelId,
    }),
    maxIterations,
  })
}

/**
 * v0.14.0 Task 4 §4.5 — chat/task 分流 dispatcher。
 *
 * 行为：
 *   - chat kind  → runChatOnce（不创建 Task，仅一次 LLM 补全；renderer 把回复渲染为气泡）
 *   - task kind  → 复用既有 task:run IPC 路径（runReActLoop），保持 runTask 主体不变
 *
 * 不删除/重写既有 runTask 主体；本函数仅作为上层 Composer / 入口处的可选分流薄层。
 */
export async function dispatchChatOrTask(
  text: string,
  ctx: {
    /** 既有 task id（task 路径必填；chat 路径可空） */
    taskId?: string
    modelId: string
    agent?: Agent
    signal?: AbortSignal
    /** 手动覆盖 kind — 提供则直接采用，跳过 classifyRoute */
    forcedKind?: ChatOrTask
  },
): Promise<{ kind: ChatOrTask; reply?: string; turnResult?: TurnResult }> {
  const kind: ChatOrTask =
    ctx.forcedKind ??
    classifyRoute(text, { hasTools: false, lastTurnKind: undefined }).kind

  if (kind === 'chat') {
    const reply = await runChatOnce(text, {
      modelId: ctx.modelId,
      agent: ctx.agent,
      signal: ctx.signal,
      // v0.27.0 R1：透传 taskId → chat 回复同样走流式增量渲染
      taskId: ctx.taskId,
    })
    return { kind: 'chat', reply }
  }

  // task kind：转发给既有 task 路径（保持 runReActLoop 不变）
  if (!ctx.taskId) {
    throw new Error('dispatchChatOrTask: ctx.taskId required for task kind')
  }
  // 用动态 import 避免循环依赖（engine ↔ runner）
  const { runTask } = await import('../runner.js')
  await runTask(ctx.taskId)
  return { kind: 'task' }
}
