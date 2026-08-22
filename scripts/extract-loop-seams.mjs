#!/usr/bin/env node
/**
 * v0.27.0 R2/F7：loop.ts 接缝抽取（纯移动）
 *
 * loop.ts(1578行) → 4 个新模块 + 瘦身后的 loop.ts(≤800)：
 *   1. abort.ts        ← persistAbortedReason / handleAbort / continueTurnIfInjected
 *   2. run-setup.ts    ← 运行前置准备（L235-631：system_prompt/记忆/门禁/Plan/plan-regen）
 *   3. reason-phase.ts ← Reason 阶段（L640-898：组装/流式调用/重试/Reactive Fallback/落盘广播）
 *   4. turn-end.ts     ← 终止收尾（task_complete / ask_user 分支体）
 *
 * 纪律：切片逐字移动（仅统一缩进 + opts.modelId→modelId 参数化），行为不变。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOOP = join(ROOT, 'app/src/main/agent/engine/loop.ts')
const DIR = join(ROOT, 'app/src/main/agent/engine')

const src = readFileSync(LOOP, 'utf-8')
const lines = src.split('\n') // 0-indexed；行号 N → lines[N-1]
const L = (n) => lines[n - 1]

// ---------- 断言锚点（防止行号漂移导致错切） ----------
const expect = (n, frag) => {
  if (!L(n).includes(frag)) {
    console.error(`锚点失配 @L${n}: 期望含「${frag}」，实际：${L(n)}`)
    process.exit(1)
  }
}
expect(235, 'v0.4.0-rev4')
expect(476, 'let iteration = startIter')
expect(630, '只读探索')
expect(631, 'consecutiveReadOnly = 0')
expect(640, "type: 'reason_start'")
expect(895, '⏱ ${durationMs}ms`')
expect(945, "if (action?.tool === 'task_complete')")
expect(946, 'v0.14.0 修复')
expect(991, 'runDoneMemoryHooks(task, agent, opts.modelId')
expect(996, 'v0.18.x fix')
expect(1073, '})')
expect(1075, 'continueTurnIfInjected(task, iteration)) continue')
expect(1503, 'async function persistAbortedReason')

// ---------- 切片工具 ----------
const slice = (a, b) => lines.slice(a - 1, b)
const dedent = (arr, n) =>
  arr.map((s) => (s.trim() === '' ? '' : s.startsWith(' '.repeat(n)) ? s.slice(n) : s))
const stripModelId = (arr) => arr.map((s) => s.replaceAll('opts.modelId', 'modelId'))
const dropLines = (arr, dropped, base) =>
  arr.filter((_, i) => !dropped.has(base + i))

// ---------- 1. abort.ts ----------
const abortTs = `/**
 * v0.27.0 R2/F7：中断与停止候选收尾（由 loop.ts 纯移动，行为不变）。
 * - persistAbortedReason：用户中断时把本轮已流出文本落盘（R1 流式管道配套）
 * - handleAbort：统一处理用户中断（stale 静默 / cancelled 保留 / paused 兜底）
 * - continueTurnIfInjected：停止候选处注入 continuation 则同轮继续（M3）
 */

import type { Task } from '@shared/types/task'
import { appendL1 } from '../../memory/l1-working.js'
import { updateTask, getTask } from '../../store/tasks.js'
import { broadcastStep, broadcastTaskStatus } from '../events.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { drainContinuations } from '../inbox.js'
import { emitTurnStopping } from '../turn-stopping.js'
import { emitEvent } from './broadcast.js'
import { discardIncompletePlanItems } from './gates.js'

${dedent(slice(1497, lines.length), 0).join('\n').replace(/\n$/, '')}
`
writeFileSync(join(DIR, 'abort.ts'), abortTs)

// ---------- 2. run-setup.ts ----------
const setupBody = stripModelId(
  dropLines(slice(235, 631), new Set([476, 630, 631]), 235),
)
const setupTs = `/**
 * v0.27.0 R2/F7：运行前置准备（由 loop.ts 纯移动，行为不变）。
 * system_prompt 注入 / startIter 推导 / 记忆与档案索引初始化 / always-on 契约与
 * 门禁状态机初始化 / pendingGateBlock 消费 / alwaysOnPlanHint / 阶段写守卫 /
 * 首轮 Plan 生成（含 phase-header 过滤与兜底清单）/ 续聊 plan-regen 与
 * continuation 兜底 / 显式技能自动加载 / KB 异步召回。
 */

import type { Task, PlanItem } from '@shared/types/task'
import type { PlanContent, ReActStep } from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import { readFile } from 'node:fs/promises'
import { appendL1, listEnabledL1 } from '../../memory/l1-working.js'
import { applyPending } from '../../memory/l3-curated.js'
import { initArchiveIndex } from '../../memory/l3-archive.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { updateTask } from '../../store/tasks.js'
import { getWorkspaceDir } from '../../store/db.js'
import { getSkill } from '../registry.js'
import { collectAlwaysOnSections } from '../prompt/sections.js'
import { collectGateSpecs, initGateStates, confirmGate, isDocDrivenAgent } from '../prompt/gates.js'
import { isCoreSkillsEnabled, computeAllowedStage } from '../../skills/builtin/react-core-skills/stage-gates.js'
import { broadcastStep, broadcastPlanListSnapshot } from '../events.js'
import { emitEvent } from './broadcast.js'
import { autoRecallKb, buildMemoryInjection } from './memory-hooks.js'
import { generatePlan } from './plan.js'
import { isPhaseHeader } from './plan-parser.js'
import { injectSkillInstruction, broadcastSkillAutoLoaded } from './skills.js'

export type AlwaysOnContracts = Awaited<ReturnType<typeof collectAlwaysOnSections>>

export interface PreparedRun {
  startIter: number
  memoryInjection: string
  alwaysOnContracts: AlwaysOnContracts
  docDriven: boolean
  coreSkillsEnabled: boolean
  allowedStage: number
  pendingSystemHint: string | undefined
}

export async function prepareRun(args: {
  task: Task
  agent: Agent
  modelId: string
  signal: AbortSignal
}): Promise<PreparedRun> {
  const { task, agent, modelId, signal } = args
${dedent(setupBody, 2).join('\n')}
  return {
    startIter,
    memoryInjection,
    alwaysOnContracts,
    docDriven,
    coreSkillsEnabled,
    allowedStage,
    pendingSystemHint,
  }
}
`
writeFileSync(join(DIR, 'run-setup.ts'), setupTs)

// ---------- 3. reason-phase.ts ----------
const reasonBody = stripModelId(slice(640, 897))
const reasonTs = `/**
 * v0.27.0 R2/F7：Reason 阶段（由 loop.ts 纯移动，行为不变）。
 * 清单状态推进 / 消息与工具组装 / system 契约装配（前缀缓存稳定）/ 流式 LLM 调用
 * （completeWithStream + text-delta 泵）/ 思考预算重试 / Reactive Fallback 压缩重试 /
 * reasoning 落盘 L1 + reason step 广播 + reason_end 事件。
 */

import type { Task } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import type { LlmCompleteResponse } from '../../llm/adapter.js'
import { getAdapter, getModel } from '../../llm/registry.js'
import { callLlmWithRetry, withLlmTimeout, isContextOverflowError } from '../llm-call.js'
import { completeWithStream, createTextDeltaPump, type TextDeltaPump } from '../llm-stream.js'
import { assembleSystemPrompt } from '../prompt/sections.js'
import { appendL1 } from '../../memory/l1-working.js'
import { compressMemory } from '../../ipc/memory.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { updateTask } from '../../store/tasks.js'
import { getWorkspaceDir } from '../../store/db.js'
import { broadcastStep, broadcastTextDelta } from '../events.js'
import { emitEvent } from './broadcast.js'
import { emitPlanStatus } from './gates.js'
import { assembleMessages, assembleTools } from './messages.js'
import { emitContextSizeReport } from './context.js'
import { persistAbortedReason } from './abort.js'
import type { AlwaysOnContracts } from './run-setup.js'

export interface ReasonPhaseArgs {
  task: Task
  agent: Agent
  modelId: string
  signal: AbortSignal
  iteration: number
  pendingSystemHint: string | undefined
  memoryInjection: string
  alwaysOnContracts: AlwaysOnContracts
}

export async function runReasonPhase(
  args: ReasonPhaseArgs,
): Promise<{ response: LlmCompleteResponse }> {
  const { task, agent, modelId, signal, iteration, memoryInjection, alwaysOnContracts } = args
  let pendingSystemHint = args.pendingSystemHint
${dedent(reasonBody, 4).join('\n')}
  return { response }
}
`
writeFileSync(join(DIR, 'reason-phase.ts'), reasonTs)

// ---------- 4. turn-end.ts ----------
const tcBody = stripModelId(slice(946, 991))
const auBody = slice(996, 1073)
const turnEndTs = `/**
 * v0.27.0 R2/F7：终止控制动作收尾（由 loop.ts 纯移动，行为不变）。
 * - finishViaTaskComplete：task_complete 分支（配对 observation + 完成态 + 里程碑 + 记忆钩子）
 * - pauseViaAskUser：ask_user 分支（参数兜底校验 + 配对 observation + continuation 注入判定）
 */

import type { Task } from '@shared/types/task'
import type { ReActAction } from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import type { LlmCompleteResponse } from '../../llm/adapter.js'
import { logger } from '../../system/logger.js'
import { updateTask } from '../../store/tasks.js'
import { broadcastTaskStatus } from '../events.js'
import { emitEvent, emitProgress, safeSlice } from './broadcast.js'
import { appendPairedControlObservations } from './act.js'
import { runDoneMemoryHooks } from './memory-hooks.js'
import { buildFallbackAskUserQuestion } from './gates.js'
import { continueTurnIfInjected } from './abort.js'

export interface TurnEndCtx {
  task: Task
  agent: Agent
  modelId: string
}

export async function finishViaTaskComplete(
  ctx: TurnEndCtx,
  action: ReActAction,
  response: LlmCompleteResponse,
  pendingActions: ReActAction[],
  pendingActionIds: string[],
  iteration: number,
): Promise<void> {
  const { task, agent, modelId } = ctx
${dedent(tcBody, 6).join('\n')}
}

export async function pauseViaAskUser(
  ctx: TurnEndCtx,
  action: ReActAction,
  pendingActions: ReActAction[],
  pendingActionIds: string[],
  iteration: number,
): Promise<boolean> {
  const { task } = ctx
${dedent(auBody, 6).join('\n')}
  // v0.19.0 M3：停止候选——先给监听器注入 continuation 的机会，注入则同轮继续
  if (await continueTurnIfInjected(task, iteration)) return true
  await updateTask(task.id, { status: 'paused' })
  broadcastTaskStatus({ ...task, status: 'paused' })
  return false
}
`
writeFileSync(join(DIR, 'turn-end.ts'), turnEndTs)

// ---------- 5. 重写 loop.ts ----------
const SETUP_BLOCK = `    // v0.27.0 R2/F7：运行前置准备（system_prompt 注入 / 记忆·门禁·技能初始化 /
    // 首轮 Plan 生成与续聊 plan-regen）抽至 run-setup.ts（纯移动，行为不变）。
    const prepared = await prepareRun({ task, agent, modelId: opts.modelId, signal })
    const { startIter, memoryInjection, alwaysOnContracts, docDriven, coreSkillsEnabled, allowedStage } = prepared
    let pendingSystemHint = prepared.pendingSystemHint
    let iteration = startIter
    // v0.9.x：连续"只读探索"轮数（>=3 时注入产出提示，防空工作区无限探索）
    let consecutiveReadOnly = 0`

const REASON_BLOCK = `      // Reason 主体（消息组装 / system 契约装配 / 流式 LLM 调用 / 重试与
      // Reactive Fallback 压缩 / reasoning 落盘广播）→ reason-phase.ts（F7 纯移动）
      const { response } = await runReasonPhase({
        task,
        agent,
        modelId: opts.modelId,
        signal,
        iteration,
        pendingSystemHint,
        memoryInjection,
        alwaysOnContracts,
      })
      pendingSystemHint = undefined  // reason 内已消费（原 L695 语义），防陈旧 hint 重复注入`

const TURNEND_BLOCK = `      if (action?.tool === 'task_complete') {
        // v0.27.0 R2/F7：完成收尾（配对 observation / 完成态 / 里程碑 / 记忆钩子）→ turn-end.ts
        await finishViaTaskComplete(
          { task, agent, modelId: opts.modelId },
          action,
          response,
          pendingActions,
          pendingActionIds,
          iteration,
        )
        return
      }

      if (action?.tool === 'ask_user') {
        // v0.27.0 R2/F7：暂停收尾（兜底问题 / 兜底选项 / continuation 注入判定）→ turn-end.ts
        if (await pauseViaAskUser({ task }, action, pendingActions, pendingActionIds, iteration)) continue
        return
      }`

const IMPORT_BLOCK = `import { prepareRun } from './run-setup.js'
import { runReasonPhase } from './reason-phase.js'
import { finishViaTaskComplete, pauseViaAskUser } from './turn-end.js'
import { handleAbort, continueTurnIfInjected } from './abort.js'`

const out = []
for (let i = 1; i <= lines.length; i++) {
  if (i === 118) {
    out.push(L(118))
    out.push(IMPORT_BLOCK)
    continue
  }
  if (i >= 235 && i <= 631) {
    if (i === 235) out.push(SETUP_BLOCK)
    continue
  }
  if (i >= 640 && i <= 898) {
    if (i === 640) out.push(REASON_BLOCK)
    continue
  }
  if (i >= 945 && i <= 1079) {
    if (i === 945) out.push(TURNEND_BLOCK)
    continue
  }
  if (i >= 1496) continue
  out.push(L(i))
}
// 头部注释补 F7 说明（splice 保留「 */」收尾，避免破坏注释闭合）
out.splice(
  2,
  2,
  ' * 由 engine.ts 纯移动而来；v0.27.0 F7 接缝抽取：前置准备→run-setup.ts、',
  ' * Reason→reason-phase.ts、终止收尾→turn-end.ts、中断→abort.ts（均纯移动）。',
  ' */',
)

writeFileSync(LOOP, out.join('\n') + '\n')
console.log('抽取完成。行数：')
for (const f of ['loop.ts', 'run-setup.ts', 'reason-phase.ts', 'turn-end.ts', 'abort.ts']) {
  const n = readFileSync(join(DIR, f), 'utf-8').split('\n').length
  console.log(`  ${f}: ${n}`)
}
