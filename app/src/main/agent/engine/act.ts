/**
 * v0.27.0 R2（§3.1 引擎拆分）：Act 执行段：动作收集、观察摘要、executeAct 工具执行循环
 * 由 engine.ts 纯移动而来（行区间 2416-3010）。
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

import { safeSlice } from './broadcast.js'
import { injectSkillInstruction } from './skills.js'
import { sanitizePlanItemText } from './plan-parser.js'
import { decidePlanAdvance } from './gates.js'

export function buildObservationSummary(
  tool: string,
  result: unknown,
  summary: string,
  ok: boolean,
): string {
  // 失败时根据工具名返回可操作的替代建议，引导 LLM 自主恢复
  const suggestionFor = (t: string): string => {
    switch (t) {
      case 'web-search':
        return '\n\n💡 替代建议：1) 用 fetch-url 直接访问可能包含答案的网站 2) 用 shell 执行 curl 检查网络连通性 3) 基于已有知识推理并说明信息缺口。'
      case 'shell':
        return '\n\n💡 替代建议：1) 用 file-reader 读取文件内容 2) 调整命令参数后重试 3) 检查路径是否正确。'
      case 'fetch-url':
        return '\n\n💡 替代建议：1) 检查 URL 是否正确 2) 用 web-search 搜索相似内容 3) 尝试其他 URL。'
      case 'file-reader':
        // v0.17.x：shell 的 ls/cat 已被文件工具守卫拦截，此处不得再建议 shell ls，
        // 否则会形成「失败 → 建议 shell ls → 又被拦截」的死循环。改为指向专用文件工具。
        return '\n\n💡 替代建议：1) 用 glob-search({ pattern: "<dir>/**/*" }) 列出目录/查找文件 2) 用 file-reader({ path: "." }) 列出工作区根目录 3) 检查路径是否正确（相对路径基于工作区根目录解析）。'
      case 'task_complete':
      case 'ask_user':
        return ''
      default:
        return '\n\n💡 替代建议：尝试换一种方法或基于已有信息推理。'
    }
  }
  if (!ok) {
    return `[${tool}] failed: ${summary}${suggestionFor(tool)}`
  }
  // v0.24.0：统一消费 result.hint（防重读警告 / 拦截指令 / 零命中提示）。
  // v0.16.6 引入 hint 后一直没人读它——警告从未到达模型，这是"重读打转"未被纠正的根因之一。
  const hintText =
    result !== null && typeof result === 'object' &&
    typeof (result as Record<string, unknown>).hint === 'string'
      ? (result as Record<string, unknown>).hint as string
      : ''
  const withHint = (body: string) => (hintText ? `${body}\n\n⚠️ ${hintText}` : body)
  // v0.6.1：防御非标准返回结构（如用户拒绝执行 → { error }，或工具返回非对象）
  // 修复 v0.6.0 缺陷：result 缺字段时访问 .slice 抛 TypeError，导致整个 ReAct loop failed
  if (result === null || typeof result !== 'object') {
    return `[${tool}] ${summary}`
  }
  const anyResult = result as Record<string, unknown>
  if (typeof anyResult.error === 'string') {
    // 非标准失败返回（如用户拒绝执行、工具内部返回 error）：对执行类工具追加替代建议
    return `[${tool}] ${anyResult.error}${suggestionFor(tool)}`
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (tool === 'file-reader') {
    const r = result as { content: string; lines: number; size: number; truncated: boolean; path: string }
    // v0.24.x fix: 200→4000，避免 thought stream 只显示头注释导致 LLM 误判文件已读完。
    // 实测：user 反馈 file-reader 反复返回 "...(truncated)" 头注释（200 字符太少），
    // LLM 看不清实际代码 → 反复调 file-reader 换 maxLines 重读同一文件 → 触发防重读 block。
    // 4000 字符 ≈ 60~80 行 JS/CSS，能容纳大多数 UI/工具函数实现段，
    // 详情在 Inspector 面板按需查看全文。
    const preview = safeSlice(str(r.content), 4000)
    return withHint(`[file-reader] ${r.path} (${r.lines} lines, ${r.size} bytes)\n\n${preview}${r.truncated ? '\n\n… (truncated, 继续读用 startLine/maxLines=0)' : ''}`)
  }
  // v0.18.x fix：写文件 / 编辑文件只回传摘要（路径 + 字节/行数/替换数），
  // 不回写文件内容，避免把整段代码透传进 thought stream / 工具卡，导致显示过长。
  if (tool === 'file-writer') {
    const r = result as { path: string; bytes: number; lines: number; created: boolean }
    return `[file-writer] ${r.path} (${r.bytes} bytes, ${r.lines} lines${r.created ? ', 新建' : ', 覆盖'})`
  }
  if (tool === 'file-editor') {
    const r = result as { path: string; replacements: number }
    return `[file-editor] ${r.path} (${r.replacements} replacements)`
  }
  if (tool === 'web-search') {
    const r = result as { results: Array<{ title: string; url: string; snippet: string }>; total: number; query: string }
    const results = r.results ?? []
    const lines = results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n\n')
    // 空结果等同于搜索失败：追加替代建议
    const emptySuggestion = results.length === 0 || r.total === 0 ? suggestionFor('web-search') : ''
    return `[web-search] query: "${r.query}" · ${r.total} results\n\n${lines}${emptySuggestion}`
  }
  if (tool === 'fetch-url') {
    const r = result as { url: string; finalUrl: string; title: string; text: string; chars: number; truncated: boolean; status: number }
    const header = `[fetch-url] ${r.url}${r.finalUrl !== r.url ? ` → ${r.finalUrl}` : ''} (status=${r.status}, ${r.chars} chars${r.truncated ? ', truncated' : ''})${r.title ? `\n标题：${r.title}` : ''}`
    const preview = safeSlice(str(r.text), 1500)
    return `${header}\n\n${preview}${r.truncated ? '\n\n… (truncated)' : ''}`
  }
  if (tool === 'shell') {
    const r = result as { command: string; cwd: string; stdout: string; stderr: string; exitCode: number | null; durationMs: number; timedOut: boolean }
    const out = safeSlice(str(r.stdout), 800)
    const err = safeSlice(str(r.stderr), 400)
    // v0.18.x fix：命令本身可能内嵌 heredoc 全文（写文件场景），截断避免泄露整段内容
    const cmd = safeSlice(str(r.command), 120)
    const header = `[shell] \`${cmd}\` exit=${r.exitCode} · ${r.durationMs}ms${r.timedOut ? ' · timed out' : ''}`
    return `${header}\n\nstdout:\n${out}${str(r.stdout).length > 800 ? '\n… (truncated)' : ''}${err ? `\n\nstderr:\n${err}${str(r.stderr).length > 400 ? '\n… (truncated)' : ''}` : ''}`
  }
  if (tool === 'delegate-agent') {
    const r = result as { agentId: string; taskId: string; status: string; summary: string; iterations: number }
    return `[delegate-agent] 委派给 @${r.agentId}（子任务 ${r.taskId}）· status=${r.status} · ${r.iterations} iterations\n\n摘要：\n${str(r.summary)}`
  }
  if (tool === 'session-search') {
    const r = result as { query: string; total: number; hits: Array<{ taskTitle: string; snippet: string; createdAt: number }> }
    const lines = (r.hits ?? []).map((h, i) => `${i + 1}. ${h.taskTitle}\n   ${safeSlice(h.snippet, 400)}`).join('\n\n')
    return `[session-search] query: "${r.query}" · ${r.total} archive hits\n\n${lines}`
  }
  // v0.24.0：default 分支剥离 hint 字段（已由 withHint 前置送达），避免 JSON 里重复一遍
  const { hint: _stripped, ...rest } = anyResult as Record<string, unknown>
  return withHint(`[${tool}] ${summary}\n\n${safeSlice(JSON.stringify(rest), 800)}`)
}

/* ============================================================
 * v0.14.0 Task 4：并行 Act 工具调用辅助
 *  - collectActionsForIteration：从 LLM 响应中提取所有工具调用；
 *    适配器同时回传 actions: ReActAction[]，旧路径退化为 [action]
 *  - executeAct：单条 act 的实际执行包装（错误隔离，单条失败不阻塞同组其它 act）
 *  - toFinishedProgress：act 完成后构造用于广播的 ToolProgress
 * ============================================================ */
export function collectActionsForIteration(response: LlmCompleteResponse): ReActAction[] {
  if (response.actions && response.actions.length > 0) return response.actions
  if (response.action) return [response.action]
  return []
}

/**
 * v0.19.x：控制工具（task_complete / ask_user）分支在暂停/完成任务时不再进入 Act 阶段，
 * 若本轮 LLM 并行返回多个 action，则除控制动作外的 assistant tool_calls 会悬空。
 * 为每个 pending action 补写配对 observation（控制动作写真实结果，其余写"跳过"），
 * 避免 assembleMessages 的 reconcileToolCalls 每轮剥离 dangling tool_calls。
 */
export async function appendPairedControlObservations(args: {
  taskId: string
  iteration: number
  actions: ReActAction[]
  actionIds: string[]
  controlTool: 'task_complete' | 'ask_user'
  controlContent: string
  skipPrefix: string
}): Promise<void> {
  for (let i = 0; i < args.actions.length; i++) {
    const a = args.actions[i]
    const callId = args.actionIds[i] ?? `call_${args.iteration}_${i}`
    const isControl = a.tool === args.controlTool
    await appendL1({
      taskId: args.taskId,
      role: 'tool',
      kind: 'observation',
      content: isControl ? args.controlContent : `${args.skipPrefix}${a.tool}`,
      iteration: args.iteration,
      meta: JSON.stringify({
        tool: a.tool,
        toolCallId: callId,
        actionId: callId,
        ...(isControl ? {} : { skipped: true }),
      }),
    })
  }
}

export interface ActExecutionResult {
  completedStep: ReActStep
  result: unknown
  resultSummary: string
  durationMs: number
  ok: boolean
  errorMessage?: string
  additionalSystemHint?: string
}

export interface ActContext {
  task: Task
  agent: Agent
  signal: AbortSignal
  /** v0.17.x：react-core-skills 阶段写入守卫开关 */
  coreSkillsEnabled?: boolean
  /** v0.17.x：当前允许推进到的阶段（0~5），仅 coreSkillsEnabled 时有效 */
  allowedStage?: number
  /** v0.18.0：当前 ReAct 迭代编号（用于 patch payload 的 ts_iteration 字段） */
  iteration?: number
}

export async function executeAct(
  action: ReActAction,
  placeholder: ReActStep,
  ctx: ActContext,
): Promise<ActExecutionResult> {
  const actStartedAt = placeholder.startedAt
  // Task 8：会话级 KB 开关 = 全局开关 × 任务级开关（任一关闭即关闭，切换立即生效）
  const settings = await getSettings()
  const skillCtx: SkillContext = {
    taskId: placeholder.taskId,
    signal: ctx.signal,
    workspaceDir: getWorkspaceDir(),
    agent: ctx.agent,
    task: ctx.task,
    // Task 8：会话级 KB 开关（task.kbEnabled 默认 undefined = 视为开启）
    kbSessionEnabled: settings.kbEnabled !== false && ctx.task?.kbEnabled !== false,
    // v0.25.0 F1：技能指令体生命周期回调（三态）
    //  - always-on：指令体已在 system agent-static 段（collectAlwaysOnSections），跳过注入
    //  - on-demand：appendL1 kind='skill_instruction'，持续生效至任务结束
    //  - hint-only：不注入指令体（仅 description 进 tools 列表）
    onInstructionLoaded: async (payload) => {
      if (payload.instructionMode === 'hint-only') {
        logger.debug('Tool', `skill '${payload.skillId}' hint-only — skip instruction injection`, placeholder.taskId)
        return
      }
      if (payload.instructionMode === 'always-on') {
        logger.debug('Tool', `skill '${payload.skillId}' always-on — instruction already in system`, placeholder.taskId)
        return
      }
      // on-demand：写 L1 skill_instruction（持久化，与 plan_status 同管道）
      await injectSkillInstruction(
        ctx.task,
        { id: payload.skillId, name: payload.skillName },
        payload.text,
        ctx.iteration ?? 0,
      )
    },
  }
  let result: unknown
  let resultSummary = ''
  let rawL2Path: string | undefined
  let ok = true
  let errorMessage: string | undefined
  try {
    // v0.17.x：阶段感知写入守卫（react-core-skills 启用时）——
    // 拦截文档阶段越级写脚手架/源码，或写入 ArkWork 保留路径（tasks.json / .arkwork / .git）。
    if (ctx.coreSkillsEnabled) {
      const allowedStage = ctx.allowedStage ?? 0
      const actArgs = (action.args ?? {}) as Record<string, unknown>
      let guard: { blocked: boolean; reason: string } = { blocked: false, reason: '' }
      if (action.tool === 'file-writer' || action.tool === 'file-editor') {
        guard = matchForbiddenWritePath(String(actArgs.path ?? ''), allowedStage)
      } else if (action.tool === 'shell') {
        guard = matchForbiddenShellCommand(String(actArgs.command ?? ''), allowedStage)
      }
      if (guard.blocked) {
        const durationMs = Date.now() - actStartedAt
        const blockedStep: ReActStep = {
          ...placeholder,
          result: { error: guard.reason },
          resultSummary: guard.reason,
          durationMs,
          status: 'failed',
          errorMessage: guard.reason,
          softFail: true,
        }
        logger.warn('Tool', `${action.tool} blocked by stage guard: ${guard.reason}`, placeholder.taskId)
        return {
          completedStep: blockedStep,
          result: { error: guard.reason },
          resultSummary: guard.reason,
          durationMs,
          ok: false,
          errorMessage: guard.reason,
        }
      }
    }

    // v0.17.5：todo_update — LLM 主动更新清单状态（对齐 Claude Code TodoWrite）。
    // 引擎层不再全凭感觉自动打标，改为 LLM 每完成一个阶段操作后主动调用本工具。
    // 在 invokeSkill 之前拦截（todo_update 是控制类工具，不走普通 skill 调用）。
    if (action.tool === 'todo-update' || action.tool === 'todo_update') {
      const args = (action.args ?? {}) as Record<string, unknown>
      const itemIndex = typeof args.item_index === 'number' ? args.item_index : Number(args.item_index)
      const status = String(args.status ?? '')
      const comment = typeof args.comment === 'string' ? args.comment : ''
      const VALID_STATUSES = new Set(['done', 'running', 'pending', 'skipped', 'failed', 'cancelled'])
      const planItems = ctx.task.planItems ?? []
      const durationMs = Date.now() - actStartedAt

      // 校验：索引越界或状态非法 → 返回失败，让 LLM 下一轮修正。
      // v0.24.x：清单为空时宽容 —— 自动追加被引用项（以 comment 或占位文本），
      // 避免 LLM 因"清单共 0 项"反复报错死循环。
      if (planItems.length === 0 && itemIndex === 0) {
        const nowAppend = Date.now()
        const appended: PlanItem = {
          id: `plan_append_${nowAppend}`,
          text: sanitizePlanItemText(comment || '执行任务'),
          status: (status === 'done' ? 'done' : 'running') as PlanItem['status'],
          createdAt: nowAppend,
          updatedAt: nowAppend,
        }
        if (status === 'done' || status === 'failed' || status === 'skipped' || status === 'cancelled') {
          appended.completedAt = nowAppend
        }
        planItems.push(appended)
        await updateTask(placeholder.taskId, { planItems })
        broadcastPlanItemStatus(placeholder.taskId, [
          {
            planItemId: appended.id,
            index: 0,
            fromStatus: 'pending',
            status: appended.status,
            source: 'todo-update',
            reason: comment || '清单为空自动追加',
            ts_iteration: ctx.iteration,
          },
        ])
        return {
          completedStep: { ...placeholder, result: { item_index: 0, status, overview: `[~] 1. ${appended.text}` }, resultSummary: `清单为空，已自动追加第 1 项：${appended.text}`, durationMs, status: 'success' },
          result: { item_index: 0, status, overview: `[~] 1. ${appended.text}` },
          resultSummary: `清单为空，已自动追加第 1 项：${appended.text}`,
          durationMs,
          ok: true,
        }
      }
      if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= planItems.length) {
        const errMsg = `todo_update 参数非法：item_index=${itemIndex} 越界（清单共 ${planItems.length} 项，索引 0~${planItems.length - 1}）`
        logger.warn('Agent', errMsg, placeholder.taskId)
        return {
          completedStep: { ...placeholder, result: { error: errMsg }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
          result: { error: errMsg }, resultSummary: errMsg, durationMs, ok: false, errorMessage: errMsg,
        }
      }
      if (!VALID_STATUSES.has(status)) {
        const errMsg = `todo_update 参数非法：status=${status}（合法值 done/running/pending/skipped/failed/cancelled）`
        logger.warn('Agent', errMsg, placeholder.taskId)
        return {
          completedStep: { ...placeholder, result: { error: errMsg }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
          result: { error: errMsg }, resultSummary: errMsg, durationMs, ok: false, errorMessage: errMsg,
        }
      }

      // v0.25.0 F1：门禁拦截 —— 标 done 时若存在与该条目关联的 pending gate，
      // 拦截返回 softFail + 行动指令（不 throw）。LLM 据此调 ask_user 完成确认，
      // 用户答复后下一轮 run 由 pendingGateBlock 消费写回 gateStates。
      // 失败/取消/跳过不拦截（仅「done」代表阶段真正完成 → 才需要门禁通过）。
      if (status === 'done') {
        const itemText = planItems[itemIndex]?.text ?? String(args.item_index ?? '')
        const gateBlock = checkGateBeforeAdvance(ctx.task, itemText)
        if (gateBlock) {
          logger.warn(
            'Agent',
            `todo_update blocked by gate ${gateBlock.gateId} on item=${itemIndex}`,
            placeholder.taskId,
          )
          // 写 pendingGateBlock 供下次 run 入口消费
          ctx.task.pendingGateBlock = { gateId: gateBlock.gateId }
          await updateTask(placeholder.taskId, { pendingGateBlock: ctx.task.pendingGateBlock })
          const errMsg = gateBlock.instruction
          return {
            completedStep: { ...placeholder, result: { error: errMsg, gateId: gateBlock.gateId }, resultSummary: errMsg, durationMs, status: 'failed', errorMessage: errMsg, softFail: true },
            result: { error: errMsg, gateId: gateBlock.gateId },
            resultSummary: errMsg,
            durationMs,
            ok: false,
            errorMessage: errMsg,
          }
        }
      }

      // 更新目标项 + 自动推进（标 done 时把下一项标 running）
      const target = planItems[itemIndex]
      const fromStatus = target.status
      target.status = status as PlanItem['status']
      target.updatedAt = Date.now()
      // v0.18.0 F4：记录 source 字段（LLM 主动调用 todo_update，不带"引擎"徽标）
      target.source = 'todo-update'
      if (status === 'done' || status === 'failed' || status === 'skipped' || status === 'cancelled') {
        target.completedAt = Date.now()
      }
      // v0.24.x fix：记录是否自动推进了下一项。原代码在第二个 if 里重新判断
      // planItems[itemIndex+1].status === 'pending'，但该状态已在上面被改成 'running'，
      // 导致「下一项标 running」的 patch 永远不广播 —— 清单只能 done 当前项、下一项卡在 pending。
      let advancedNext = false
      if (status === 'done' && itemIndex + 1 < planItems.length && planItems[itemIndex + 1].status === 'pending') {
        planItems[itemIndex + 1].status = 'running'
        planItems[itemIndex + 1].updatedAt = Date.now()
        advancedNext = true
      }
      await updateTask(placeholder.taskId, { planItems })

      // v0.18.0 F1：todo_update 拦截后也通过 patch 通道广播；
      // 多项变更（done → 自动推进下一项）走串行 N 次广播（version 自增）。
      broadcastPlanItemStatus(placeholder.taskId, [
        {
          planItemId: target.id,
          index: itemIndex,
          fromStatus,
          status: status as PlanItem['status'],
          source: 'todo-update',
          reason: comment || undefined,
          ts_iteration: ctx.iteration,
        },
      ])
      if (advancedNext) {
        const next = planItems[itemIndex + 1]
        broadcastPlanItemStatus(placeholder.taskId, [
          {
            planItemId: next.id,
            index: itemIndex + 1,
            fromStatus: 'pending',
            status: 'running',
            source: 'todo-update',
            reason: 'todo-update 后自动推进',
            ts_iteration: ctx.iteration,
          },
        ])
      }

      // 构造清单概览（反馈给 LLM，让它知道更新后的状态）
      // v0.18.x fix: 复用 engine-decision 同款五档 mark（done/running/failed/skipped/pending），
      // 之前 LLM 主动 todo_update 写 failed 时会落到默认 [ ] 分支，跟路径 B 的 [!] 符号不一致。
      const overview = planItems.map((p, i) => {
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
        return `${mark} ${i + 1}. ${p.text}`
      }).join('\n')
      const summary = `已更新清单第 ${itemIndex + 1} 项为「${status}」${comment ? `：${comment}` : ''}\n当前清单：\n${overview}`
      logger.info('Agent', `todo_update: item=${itemIndex} status=${status}`, placeholder.taskId)
      return {
        completedStep: { ...placeholder, result: { item_index: itemIndex, status, overview }, resultSummary: summary, durationMs, status: 'success' },
        result: { item_index: itemIndex, status, overview },
        resultSummary: summary,
        durationMs,
        ok: true,
      }
    }

    // 找到 skill id：按 LLM 工具名匹配（v0.6.1：兼容 SkillHub 中文名技能，见 skillToolName）
    const skills = await listSkills()
    const skill = skills.find((s) => skillToolName(s) === action.tool)
    if (!skill) throw new Error(`Tool not found: ${action.tool}`)

    const r = await invokeSkill(skill.id, action.args, skillCtx)
    result = r.result
    resultSummary = r.summary

    // 大结果落 L2
    const resultJson = JSON.stringify(result)
    if (resultJson.length > 4000) {
      rawL2Path = await persistRawL2(placeholder.taskId, placeholder.id, result)
    }
  } catch (err) {
    ok = false
    errorMessage = (err as Error).message
    result = { error: errorMessage }
    resultSummary = `failed: ${errorMessage}`
    logger.error('Tool', `${action.tool} failed: ${errorMessage}`, placeholder.taskId)
  }
  // v0.23.0：判定软失败（橙色警告）vs 真实失败（红色错误）。
  // 软失败：工具未找到 / 参数非法 / 权限拒绝 / 用户拒绝 / 命令确认超时 / shell 退出码非 0
  // （用户禁用 shell 等场景均为非致命，提示用户修改命令即可，不该让 step 变红）。
  // 真实失败：网络 5xx / MCP 子进程退出 / 文件系统权限等致命错。
  let isSoftFail = false
  if (!ok && errorMessage) {
    const msg = errorMessage
    if (
      msg.includes('Tool not found') ||
      msg.includes('tool-not-found') ||
      msg.includes('参数非法') ||
      msg.includes('参数错误') ||
      msg.includes('schema') ||
      msg.includes('validation failed') ||
      msg.includes('invalid argument') ||
      msg.includes('参数校验') ||
      msg.includes('Permission denied') ||
      msg.includes('permission denied') ||
      msg.includes('用户拒绝') ||
      msg.includes('用户已取消') ||
      msg.includes('命令确认') ||
      msg.includes('确认超时') ||
      msg.includes('确认已取消') ||
      msg.includes('exited with code') ||
      msg.includes('exit code') ||
      msg.includes('退出码') ||
      msg.includes('exitCode')
    ) {
      isSoftFail = true
    }
  }
  // v0.17.6：引擎独立决策——基于 act 结果推进清单状态，**不依赖 LLM 自调 todo_update**。
  // 决策规则（详见 decidePlanAdvance）：
  //   1. act 失败 → running 项自动 failed
  //   2. act 成功 + 产成性工具（file-writer / file-editor / shell / spec / ...）→ running 项自动 done 并推进下一项
  //   3. act 成功 + 只读工具（file-reader / web-search / ...）→ 保持 running，让 LLM 决定
  // v0.18.0 F1：决策落定后通过 broadcastPlanItemStatus 推单条 patch（不调整对象广播）。
  // 写入顺序：先落盘（updateTask）→ 再广播 patch，保证内存/磁盘/三视图一致。
  if (ctx.task.planItems && ctx.task.planItems.length > 0 && action.tool !== 'todo-update' && action.tool !== 'todo_update') {
    try {
      const { planItems: nextItems, decisions } = decidePlanAdvance(
        ctx.task.planItems,
        action.tool,
        ok,
        errorMessage,
      )
      if (decisions.length > 0) {
        ctx.task.planItems = nextItems
        // 1) 把 source 字段写到 planItem（v0.18.0 新增），便于 Renderer 端显示"引擎"徽标
        for (const d of decisions) {
          const item = nextItems[d.index]
          if (!item) continue
          item.source = d.after === 'failed' ? 'engine-fail' : 'engine-decide'
        }
        // 2) 持久化（落盘后再广播）
        await updateTask(placeholder.taskId, { planItems: nextItems })
        // 3) 单条 patch 广播（F1 通道激活）；多 decisions 串行 N 次 + version 单调自增
        for (const d of decisions) {
          const item = nextItems[d.index]
          if (!item) continue
          broadcastPlanItemStatus(placeholder.taskId, [
            {
              planItemId: item.id,
              index: d.index,
              fromStatus: d.before,
              status: d.after,
              source: d.after === 'failed' ? 'engine-fail' : 'engine-decide',
              reason: d.reason,
              ts_iteration: ctx.iteration,
            },
          ])
        }
        const overview = nextItems.map((p, i) => {
          const mark =
            p.status === 'done'
              ? '[x]'
              : p.status === 'running'
                ? '[~]'
                : p.status === 'failed'
                  ? '[!]'
                  : p.status === 'skipped'
                    ? '[-]'
                    : '[ ]'
          return `${mark} ${i + 1}. ${p.text}`
        }).join('\n')
        // v0.18.x fix: reason 截 80 字防爆行；overview 已在路径 A 打印过，
        // 路径 B 走 patch 通道（broadcastPlanItemStatus）让 Renderer 维护当前态，
        // 这里不重复打印整张清单，避免 thought stream 被压成 10+ 行扁平文本。
        const decisionList = decisions
          .map((d) => {
            const reason = (d.reason ?? '').length > 80
              ? (d.reason ?? '').slice(0, 80) + '…'
              : d.reason ?? ''
            return `  - 第 ${d.index + 1} 项：${d.before} → ${d.after}（${reason}）`
          })
          .join('\n')
        resultSummary += `\n\n[engine-decision] 引擎独立判断清单状态：\n${decisionList}`
        // 记日志
        if (decisions.some((d) => d.after === 'done' || d.after === 'failed')) {
          logger.info(
            'Agent',
            `engine-decision tool=${action.tool} ok=${ok} ${decisions.map((d) => `${d.index}:${d.before}->${d.after}`).join(',')}`,
            placeholder.taskId,
          )
        }
      }
    } catch (decideErr) {
      logger.warn('Agent', `engine-decide skipped: ${(decideErr as Error).message}`, placeholder.taskId)
    }
  }
  const durationMs = Date.now() - actStartedAt
  return {
    completedStep: {
      ...placeholder,
      result,
      resultSummary,
      rawL2Path,
      durationMs,
      status: ok ? 'success' : 'failed',
      errorMessage,
      // v0.23.0：软失败标记供 Renderer 区分橙色警告与红色错误
      softFail: !ok && isSoftFail,
    },
    result,
    resultSummary,
    durationMs,
    ok,
    errorMessage,
    additionalSystemHint: skillCtx.additionalSystemHint,
  }
}

export function toFinishedProgress(step: ReActStep, groupId: string): ToolProgress {
  return {
    taskId: step.taskId,
    groupId,
    requestId: step.id,
    tool: step.toolName ?? 'unknown',
    status: step.status === 'success'
      ? 'success'
      : step.status === 'cancelled'
        ? 'cancelled'
        : 'failed',
    startedAt: step.startedAt,
    finishedAt: step.startedAt + step.durationMs,
    durationMs: step.durationMs,
    errorMessage: step.errorMessage,
    resultSummary: step.resultSummary,
  }
}
