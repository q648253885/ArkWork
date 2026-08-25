/**
 * v0.27.0 R2（§3.1 引擎拆分）：门禁与计划推进判定：ask_user 兜底、阶段门禁、计划项失败/丢弃处理
 * 由 engine.ts 纯移动而来（行区间 171-175 / 1558-1624 / 2170-2332）。
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

import { findPlanItemForStage } from './plan-parser.js'
import { getUiLocale, tFor } from '../../i18n/messages.js'

// v0.25.2：ask_user 的 question 缺失/为空时注入的兜底问题。
// 与 suggestions 兜底同策略，保证门禁交互始终可用，避免「拒绝重试 → 空转报错」。
export function buildFallbackAskUserQuestion(): string {
  return tFor(getUiLocale(), 'askUser.fallbackQuestion')
}

/**
 * v0.18.x fix：任务级失败时，把当前 running（无则首个 pending）的清单项标 failed，
 * 让清单与真实执行进度一致 —— 此前任务失败（超迭代 / ReAct 崩溃）时清单纹丝不动，
 * 用户看不到任何失败反馈。
 */
export async function markRunningPlanItemFailed(task: Task): Promise<void> {
  const planItems = task.planItems ?? []
  if (planItems.length === 0) return
  const runningIdx = planItems.findIndex((p) => p.status === 'running')
  const targetIdx = runningIdx >= 0 ? runningIdx : planItems.findIndex((p) => p.status === 'pending')
  if (targetIdx < 0) return
  const target = planItems[targetIdx]
  const fromStatus = target.status
  target.status = 'failed'
  target.updatedAt = Date.now()
  target.completedAt = Date.now()
  target.source = 'engine-fail'
  await updateTask(task.id, { planItems })
  broadcastPlanItemStatus(task.id, [
    {
      planItemId: target.id,
      index: targetIdx,
      fromStatus,
      status: 'failed',
      source: 'engine-fail',
      reason: '任务失败，引擎标记当前项 failed',
    },
  ])
}

/**
 * v0.19.1：任务中断/取消时，把清单里未完成（running / pending）的项标记为 cancelled（丢弃），
 * 让交互区清单与实际状态一致；已完成（done / failed / skipped / cancelled）的项保持不变。
 * 用户 v0.19.0 反馈：中断或换路线时，原有清单未执行完的项应变为丢弃，而不是纹丝不动。
 */
export async function discardIncompletePlanItems(task: Task, reason: string): Promise<void> {
  const planItems = task.planItems ?? []
  if (planItems.length === 0) return
  const decisions: Array<{ index: number; fromStatus: PlanItem['status'] }> = []
  const now = Date.now()
  for (let i = 0; i < planItems.length; i++) {
    const p = planItems[i]
    if (p.status === 'running' || p.status === 'pending') {
      decisions.push({ index: i, fromStatus: p.status })
      p.status = 'cancelled'
      p.updatedAt = now
      p.completedAt = now
      p.source = 'user-cancel'
    }
  }
  if (decisions.length === 0) return
  await updateTask(task.id, { planItems })
  for (const d of decisions) {
    const item = planItems[d.index]
    if (!item) continue
    broadcastPlanItemStatus(task.id, [
      {
        planItemId: item.id,
        index: d.index,
        fromStatus: d.fromStatus,
        status: 'cancelled',
        source: 'user-cancel',
        reason,
      },
    ])
  }
}

/**
 * v0.17.6：判断一个工具名是否属于"产成性"工具——成功调用通常意味着清单项可标 done。
 * 非产成性工具（只读探索 / 信息检索 / 阶段内中间写入）成功后由 LLM 自行决定是否推进清单。
 *
 * v0.18.x fix：file-writer / file-editor / shell 三项**不再**自动推进清单。
 * 原因：一个清单项往往需要多次写入 / 多次命令（尤其 frontend-design 等插件会连续写多个文件），
 * 若每次成功都自动把当前项标 done 并推进下一项，清单会"抢跑"，与真实执行进度错位。
 * 这些阶段内工具成功后保持 running，由 LLM 通过 todo_update 在真正完成一个子任务时显式推进。
 *
 * 产成性（可自动标 done）：task_complete / ask_user / spec / plan / bugfix / react-core-skills 等
 * 只读性：file-reader / glob-search / grep-search / web-search / fetch-url / kb-search / session-search 等
 */
export function isProductiveTool(tool: string): boolean {
  const PRODUCTIVE = new Set([
    'todo-update', 'todo_update',
    'task_complete', 'ask_user', 'spec', 'plan', 'bugfix', 'react-core-skills',
  ])
  return PRODUCTIVE.has(tool)
}

/**
 * v0.17.6：基于 act 结果独立推进清单状态，**不依赖 LLM 自调 todo_update**。
 *
 * 决策规则（优先级从高到低）：
 *  1. act 失败 → 保持 running（v0.19.x fix：单次工具失败多为可重试的瞬时错误，
 *     如路径写错/网络抖动，模型读到失败 observation 后会自纠重试；此前直接永久标
 *     failed，导致清单卡死无法恢复，后续项在任务结束时被批量标 cancelled）
 *  2. act 成功 + 产成性工具 → running 项自动 done + 自动推进下一项为 running
 *  3. act 成功 + 只读工具 → 保持 running，让 LLM 在下一轮决定
 *  4. 当前无 running 项 → 若还有 pending 项则自动恢复推进首个 pending（v0.19.x fix）
 *
 * 同时把判断结果与原 planItems 差异记入 "engineDecision" 字段，让 LLM 看到机器视角的判断。
 */
export function decidePlanAdvance(
  planItems: PlanItem[],
  toolName: string,
  ok: boolean,
  errorMessage?: string,
): {
  planItems: PlanItem[]
  decisions: Array<{ index: number; before: PlanItem['status']; after: PlanItem['status']; reason: string }>
} {
  const next = planItems.map((p) => ({ ...p }))
  const decisions: Array<{ index: number; before: PlanItem['status']; after: PlanItem['status']; reason: string }> = []
  const runningIdx = next.findIndex((p) => p.status === 'running')
  if (runningIdx < 0) {
    // v0.19.x fix：无 running 项时自动恢复——把首个 pending 提升为 running。
    // 修复"清单卡死"：此前 running 项被标 failed 后 decidePlanAdvance 永远空转，
    // 后续 pending 项只能等任务结束时被批量标 cancelled。
    const pendingIdx = next.findIndex((p) => p.status === 'pending')
    if (pendingIdx >= 0) {
      next[pendingIdx].status = 'running'
      next[pendingIdx].updatedAt = Date.now()
      decisions.push({
        index: pendingIdx,
        before: 'pending',
        after: 'running',
        reason: '清单无 running 项，引擎自动恢复推进下一项',
      })
    }
    return { planItems: next, decisions }
  }

  const before = next[runningIdx].status
  if (!ok) {
    // v0.19.x fix：瞬时失败保持 running，等模型读到失败 observation 后自纠重试。
    // 真正的失败仍由任务级 markRunningPlanItemFailed（超迭代/引擎崩溃）标记。
    decisions.push({
      index: runningIdx,
      before,
      after: 'running',
      reason: `${toolName} 调用失败（瞬时，保持 running 待重试）：${(errorMessage ?? '').slice(0, 100)}`,
    })
  } else if (isProductiveTool(toolName)) {
    next[runningIdx].status = 'done'
    next[runningIdx].updatedAt = Date.now()
    next[runningIdx].completedAt = Date.now()
    decisions.push({
      index: runningIdx,
      before,
      after: 'done',
      reason: `${toolName} 调用成功，引擎判定该项已完成`,
    })
    // 自动推进下一项
    if (runningIdx + 1 < next.length && next[runningIdx + 1].status === 'pending') {
      next[runningIdx + 1].status = 'running'
      next[runningIdx + 1].updatedAt = Date.now()
      decisions.push({
        index: runningIdx + 1,
        before: 'pending',
        after: 'running',
        reason: `引擎自动推进（上一项已完成）`,
      })
    }
  } else {
    // 只读工具成功：保持 running，让 LLM 决定
    decisions.push({
      index: runningIdx,
      before,
      after: 'running',
      reason: `${toolName} 为只读探索，引擎不自动推进；等待 LLM 在下一轮确认进度`,
    })
  }
  return { planItems: next, decisions }
}

/**
 * v0.17.6：把引擎独立判断后的 planItems 状态写入 L1 + 持久化 planItems。
 * 写入的 kind='plan_status' 在 assembleMessages 时被注入为独立 user 消息，LLM 必须以它为准。
 */
export async function emitPlanStatus(
  task: Task,
  iteration: number,
  trigger: string,
): Promise<void> {
  if (!task.planItems || task.planItems.length === 0) return
  const items = task.planItems.map((p, i) => {
    const mark =
      p.status === 'done'
        ? '[x]'
        : p.status === 'running'
          ? '[~]'
          : p.status === 'failed'
            ? '[!]'
            : p.status === 'skipped'
              ? '[-]'
              : p.status === 'cancelled'
                ? '[·]'
                : '[ ]'
    return `${i + 1}. ${mark} ${p.text}`
  })
  const counts = task.planItems.reduce(
    (acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
  const runningIdx = task.planItems.findIndex((p) => p.status === 'running')
  const content =
    `（触发点：${trigger}）\n` +
    `总项数=${task.planItems.length}  done=${counts.done ?? 0}  ` +
    `running=${counts.running ?? 0}  pending=${counts.pending ?? 0}  ` +
    `failed=${counts.failed ?? 0}  skipped=${counts.skipped ?? 0}  ` +
    `cancelled=${counts.cancelled ?? 0}\n` +
    `当前运行：${runningIdx >= 0 ? `第 ${runningIdx + 1} 项` : '无'}\n\n` +
    items.join('\n') +
    `\n\n[同步义务 · v0.19.1] 若当前 running 项已实际完成，本轮 Reason 必须调用 todo_update 把它标 done 并说明下一步；` +
    `若某项不再需要，标 skipped 或 cancelled。禁止累积多步后一次性批量修正——清单必须与实际执行实时一致。`
  await appendL1({
    taskId: task.id,
    role: 'assistant',
    kind: 'plan_status',
    iteration,
    content,
    meta: JSON.stringify({
      trigger,
      runningIndex: runningIdx,
      counts,
      total: task.planItems.length,
    }),
  })
}
