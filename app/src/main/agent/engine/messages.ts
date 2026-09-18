/**
 * v0.27.0 R2（§3.1 引擎拆分）：消息装配：assembleMessages、预压缩、工具调用账目对账、工具面组装
 * 由 engine.ts 纯移动而来（行区间 3012-3323）。
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
import { emitEvent } from './broadcast.js'

/**
 * Task 2 Layer 2 — 每轮调用前（plan 生成与主循环 Reason 共用）的上下文预算检查。
 * 用 estimatePayloadTokens 估算 L1 内容（content + raw.reasoningContent + meta），
 * 超预算（shouldCompact）时调用 compressMemory 做 LLM 摘要压缩（最后手段；
 * 内部摘要失败已降级为前缀截断）。全程 try/catch 熔断：
 * 失败仅记 warn 日志，不得抛错、不得递归、不得影响本轮运行。
 */
export async function maybePrecallCompact(task: Task, agent: Agent): Promise<void> {
  try {
    const items = await listEnabledL1(task.id)
    const messages: Array<LlmMessage & { meta?: unknown }> = items.map((m) => ({
      role: m.role,
      content: m.content,
      reasoningContent: (m.raw as { reasoningContent?: string } | undefined)?.reasoningContent,
      meta: m.meta,
    }))
    // 真实 payload = system（含人格/工作区提示）+ messages + tools schema，
    // 预算检查必须全口径计入，否则 UI 显示小、实际请求爆。memoryInjection 每轮
    // 都会拼进 system，这里用保守估算纳入（≤2,000 tokens，见 buildMemoryInjection）。
    const systemEst = estimateTextTokens(
      renderSystemPrompt(buildSystemSections({ agent, workspaceDir: getWorkspaceDir() })),
    ) + 2000 // memoryInjection 预算上限
    const tools = await assembleTools(agent, task)
    const toolsTokens = tools ? estimatePayloadTokens({ tools }) : 0
    const estimated = estimatePayloadTokens({ messages }) + systemEst + toolsTokens

    // agent 上下文窗口取模型配置的 contextWindow，取不到时 contextBudget 内部兜底 64000
    const model = await getModel(task.modelId)
    const budget = contextBudget(model?.contextWindow)
    if (!shouldCompact(estimated, budget)) return

    const policy: CompressPolicy = {
      keepSystem: true,
      keepRecentTurns: 4,
      keepUserTurns: true,
      keepFileRefs: true,
      dropFailed: true,
    }
    const result = await compressMemory(task.id, policy)
    logger.info(
      'Agent',
      `context auto-compacted: ${result.beforeTokens} → ${result.afterTokens} tokens (archived ${result.archivedIds.length})`,
      task.id,
    )
    await emitEvent(task.id, {
      type: 'context_compacted',
      iteration: 0,
      layer: 2,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      archivedCount: result.archivedIds.length,
    })
  } catch (err) {
    logger.warn('Agent', `precall compact failed (silent): ${(err as Error).message}`, task.id)
  }
}

export async function assembleMessages(
  task: Task,
  agent: Agent,
  opts?: { skipPrecallCompact?: boolean; excludePlanContext?: boolean },
): Promise<LlmMessage[]> {
  if (!opts?.skipPrecallCompact) await maybePrecallCompact(task, agent)
  const items = await listEnabledL1(task.id)
  const messages: LlmMessage[] = []

  // v0.6.5 修复：思考模式（DeepSeek 等）下，服务端要求所有带 tool_calls 的
  // assistant 消息都必须携带 reasoning_content 字段（原样传回）；若某轮响应
  // 未返回 reasoning_content 导致字段缺失，API 会 400 "must be passed back"。
  // 只要对话中任一历史 reasoning 携带过非空 reasoning_content，即视为思考模式，
  // 后续缺失的消息补空串占位（实测服务端只校验字段存在性，空串可接受）。
  const thinkingMode = items.some((m) => {
    const rc = (m.raw as { reasoningContent?: unknown } | undefined)?.reasoningContent
    return typeof rc === 'string' && rc.length > 0
  })

  let dropped = 0

  // v0.34.x（问候循环修复）：历史降噪三则。
  // 实测根因（T-20260918-4c1l4h，qwen3.5:9b）：① 引擎每轮迭代都写一条 plan_status
  // 进 L1，全量回放后单任务可达 30+ 条「[清单状态…]/[NOW]…」噪声块，把真正的
  // 用户指令淹没（小模型被历史带偏，对「帮我分析一下整个工作区」回复问候语）；
  // ② 计划被中断后全部条目收为 cancelled（死计划），却仍以「请严格按此计划执行」
  // 注入——诱导模型执行与新指令无关的陈旧步骤；③ 空 assistant 回合（content 空
  // 且无 toolCalls）被回放，进一步诱导模型继续产出空内容。
  // 对策：plan / plan_status / skill_instruction 只注入**最新一条**；死计划整体
  // 静默；空 assistant 回合丢弃。判定逻辑抽为纯函数（真值表可穷尽单测）。
  const dedup = decideHistoryDedup(items, task.planItems)
  // plan_status 改为「摘出历史位置、只保留最新一条、置于消息列表末尾」——
  // 引擎清单状态是每轮重写的最新权威快照，放在末尾最接近当前决策点；
  // 同时不破坏中间 assistant/tool 段的 append-only 前缀（缓存友好）。
  let planStatusTail: LlmMessage | undefined

  for (let idx = 0; idx < items.length; idx++) {
    const m = items[idx]
    if (m.archivedAt) continue
    if (m.kind === 'system_prompt') continue // 由 adapter 单独处理
    // v0.19.1：计划生成阶段排除历史 plan / plan_status，避免 LLM 复述旧清单状态
    // 生成出「已更新清单第 N 项…当前清单…」这类噪声项。
    if (opts?.excludePlanContext && (m.kind === 'plan' || m.kind === 'plan_status')) continue
    // plan_status 按 kind 匹配（不区分 role）：v0.30 图路径写入 role='user' +
    // kind='plan_status'，旧扁平路径为 role='assistant'。两形态统一走最新一条 +
    // 置尾 + 死计划静默的降噪管道（原「回放全部」是问候循环的噪声源之一）。
    if (m.kind === 'plan_status') {
      if (!dedup.planDead && idx === dedup.lastPlanStatusIdx) {
        planStatusTail = {
          role: 'user',
          content: `[清单状态 — 引擎独立判断（不是 LLM 自报），你必须以此为准]\n${m.content}`,
        }
      }
      continue
    }
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant' && m.kind === 'plan') {
      // v0.17.3：计划清单注入为 user 消息，让 LLM 在后续 Reason 轮次能看到自己生成的计划。
      // 此前 kind='plan' 不匹配任何分支被静默丢弃，导致 LLM 生成计划后"忘记"计划内容，
      // 执行动作与计划完全脱节。对齐 Claude Code TodoWrite 把清单注入每轮推理的做法。
      // v0.34.x：只注入最新一条快照；死计划（全部终态）不注入——对已收口计划说
      // 「严格按此执行」会诱导模型跑偏到与新指令无关的陈旧步骤。
      if (dedup.planDead || idx !== dedup.lastPlanIdx) continue
      messages.push({
        role: 'user',
        content: `[计划清单 — 请严格按此计划执行，每步完成后继续下一步]\n${m.content}`,
      })
    } else if (m.role === 'assistant' && m.kind === 'skill_instruction') {
      // v0.25.0 F1：on-demand 技能指令体（持续生效至任务结束，与 plan_status 同管道）。
      // 注入为独立 user 消息，让 LLM 在后续 Reason 轮次能持续看到准则型指令
      // （之前 pendingSystemHint 一轮清空 → 门禁遗漏；现以 L1 持久化 + 装载时最新一条去重）。
      // v0.34.x：注释声称的「最新一条去重」此前并未实现（每次装载全量回放），
      // 现补齐——同任务多次装载技能时只保留最新指令体。
      if (idx !== dedup.lastSkillInstructionIdx) continue
      messages.push({
        role: 'user',
        content: `[技能指令 — 已加载，持续生效至任务结束]\n${m.content}`,
      })
    } else if (m.role === 'assistant' && m.kind === 'reasoning') {
      // polish4 §A3.1：从 m.meta 解析 assistant 该轮的 actions（含 actionId + toolCallId）。
      // 支持三种 meta 形态：
      //   1. 新格式（polish4）：{ tool, args, actionId, toolCallId }  或  { multi: true, actions: [...] }
      //   2. 老格式：{ tool, args } 直接 ReActAction — 按 iteration 退化为 call_${iter}_${i}
      //   3. 更老格式：直接 { tool, args: {...} } 同样退化
      let toolCalls: LlmMessage['toolCalls'] | undefined
      let assistantActionIds: string[] = []
      if (m.meta) {
        try {
          const parsed = JSON.parse(m.meta) as Record<string, unknown>
          if (parsed.multi === true && Array.isArray(parsed.actions)) {
            const list = parsed.actions as Array<Record<string, unknown>>
            assistantActionIds = list.map((a) => String(a.toolCallId ?? a.actionId ?? ''))
            if (assistantActionIds.some((id) => id === '')) {
              // 老格式无 id，按 iteration 内顺序退化
              assistantActionIds = assistantActionIds.map((_, i) => `call_${m.iteration}_${i}`)
              list.forEach((a, i) => {
                if (!a.toolCallId && !a.actionId) {
                  a.toolCallId = assistantActionIds[i]
                  a.actionId = assistantActionIds[i]
                }
              })
            }
            toolCalls = list.map((a, i) => ({
              id: assistantActionIds[i],
              type: 'function' as const,
              function: {
                name: String(a.tool),
                arguments: JSON.stringify((a.args as Record<string, unknown>) ?? {}),
              },
            }))
          } else if (parsed.tool) {
            const id = String(parsed.toolCallId ?? parsed.actionId ?? '')
            assistantActionIds = [id || `call_${m.iteration}_0`]
            toolCalls = [
              {
                id: assistantActionIds[0],
                type: 'function' as const,
                function: {
                  name: String(parsed.tool),
                  arguments: JSON.stringify((parsed.args as Record<string, unknown>) ?? {}),
                },
              },
            ]
          }
        } catch {
          // ignore parse errors
        }
      }
      const rawRc = (m.raw as { reasoningContent?: string } | undefined)?.reasoningContent
      // v0.15.0 修复「续聊挂起」：DeepSeek 等思考模型的 reasoning_content 可能极长
      // （实测单轮可达 6.9 万字符），整包回传会让 prompt 膨胀到 10 万+ token，
      // 模型重新处理巨量历史要思考 50s+，且耗尽输出预算后 content 为空（finish=length）。
      // 服务端只校验字段存在性（空串可接受，见上方 thinkingMode 注释），
      // 截断到前 N 字符即可大幅提速且不影响对话连续性（已实测：114KB→47KB、54s→14s、正常返回内容）。
      const reasoningContent =
        typeof rawRc === 'string' && rawRc.length > 0
          ? rawRc.slice(0, MAX_REASONING_CONTENT)
          : thinkingMode
            ? ''
            : undefined
      // v0.34.x：哑回合不回放 —— content 空且无 toolCalls 的 assistant 条目
      // （典型：小模型思考预算耗尽的空产出，L1 实测单任务可达上百条）回放只会
      // 诱导模型继续输出空内容。带 toolCalls 的空 content 不受影响（工具配对必需）。
      if (!toolCalls && typeof m.content === 'string' && !m.content.trim()) continue
      messages.push({
        role: 'assistant',
        content: m.content,
        toolCalls,
        reasoningContent,
      })
    } else if (m.role === 'tool' && m.kind === 'observation') {
      // polish4 §A3.2：从 observation L1 meta 读 toolCallId；
      // 若 meta 缺失或无 id → 退化按 iteration 顺序
      let tcId: string | undefined
      let toolName = m.meta ?? 'tool'
      if (m.meta) {
        try {
          const parsed = JSON.parse(m.meta) as Record<string, unknown>
          tcId = (parsed.toolCallId as string | undefined) ?? (parsed.actionId as string | undefined)
          if (parsed.tool) toolName = String(parsed.tool)
        } catch {
          // 老格式 m.meta 直接是 tool 名字符串
          tcId = undefined
        }
      }
      // 若 meta 是纯字符串（无 JSON）也走老路径
      const tcFinal = tcId ?? `call_${m.iteration}_0`
      messages.push({
        role: 'tool',
        // Task 3：观察内容超长截断（完整内容见 L2），防止大工具输出撑爆 prompt
        content: truncateLongContent(m.content, MAX_OBSERVATION_CONTENT, OBSERVATION_TRUNCATED_MARK),
        name: toolName,
        toolCallId: tcFinal,
      })
    }
  }

  if (dropped > 0) {
    logger.warn('Agent', `dropped ${dropped} tool responses (no matching toolCall)`, task.id)
  }
  // v0.34.x：清单状态快照置尾（最新一条）——见循环前的降噪注释
  if (planStatusTail) messages.push(planStatusTail)
  // v0.23.2 缓存修复：移除每轮滑动的 applyMicroCompact。
  // 旧逻辑每迭代把"3 轮前"的完整工具结果原地替换为占位符 → 相邻两次请求的前缀
  // 在倒数第 3 轮处分叉，尾部全量内容永不命中前缀缓存（实测命中率 ~50%）。
  // DeepSeek/Claude 命中率 90%+ 的 harness 共性是「历史不可变」：消息只追加、
  // 绝不回改。现改为 append-only——上下文压力交给写时截断（MAX_OBSERVATION_CONTENT）
  // 与预算阀（maybePrecallCompact / maybeAutoCompress，压缩时一次性断缓存后再次稳定）。
  // applyMicroCompact 纯函数保留（context.test 仍覆盖），仅不再在组装路径调用。
  // v0.14.0 防御：剥离"悬空 tool_calls"——历史脏数据（如旧 ask_user/task_complete 分支
  // 未补写 observation）会在消息序列里留下带 tool_calls 却无配对 tool 响应的 assistant
  // 消息，OpenAI 兼容服务端会 400 "insufficient tool messages following tool_calls message"。
  return reconcileToolCalls(messages)
}

/* ------------------------------------------------------------
 * v0.34.x（问候循环修复）— 历史降噪判定（纯函数）
 *
 * 与 stall.ts（D52）同一抽取纪律：判定逻辑抽成真值表可穷举的纯函数，
 * 与「怎么用判定」的装配接线分离 —— 防止「判定全对、接线接错」照样全绿
 * （v0.32.1 D38-a 教训）。
 * ------------------------------------------------------------ */

export interface HistoryDedupDecision {
  /** 最后一条 plan 快照在 items 中的下标（-1 = 无） */
  lastPlanIdx: number
  /** 最后一条 plan_status 在 items 中的下标（-1 = 无） */
  lastPlanStatusIdx: number
  /** 最后一条 skill_instruction 在 items 中的下标（-1 = 无） */
  lastSkillInstructionIdx: number
  /**
   * 死计划：task.planItems 非空且全部处于终态（无 pending/running）。
   * 死计划不注入计划清单与清单状态 —— 对已收口计划说「严格按此执行」
   * 会诱导模型执行与新指令无关的陈旧步骤（问候循环根因之二）。
   * planItems 为空/未定义时不算死（老任务可能只有 plan 快照无结构化镜像，
   * 保持既有注入行为）。
   */
  planDead: boolean
}

export function decideHistoryDedup(
  items: ReadonlyArray<{ kind?: string; archivedAt?: unknown }>,
  planItems: ReadonlyArray<{ status: string }> | undefined,
): HistoryDedupDecision {
  let lastPlanIdx = -1
  let lastPlanStatusIdx = -1
  let lastSkillInstructionIdx = -1
  for (let i = 0; i < items.length; i++) {
    const m = items[i]
    if (!m || m.archivedAt) continue
    if (m.kind === 'plan') lastPlanIdx = i
    else if (m.kind === 'plan_status') lastPlanStatusIdx = i
    else if (m.kind === 'skill_instruction') lastSkillInstructionIdx = i
  }
  const hasActionable = (planItems ?? []).some(
    (p) => p.status === 'pending' || p.status === 'running',
  )
  const planDead = (planItems?.length ?? 0) > 0 && !hasActionable
  return { lastPlanIdx, lastPlanStatusIdx, lastSkillInstructionIdx, planDead }
}

/**
 * v0.14.0 防御：对带 toolCalls 的 assistant 消息做配对校验。
 * - 若其后紧跟的连续 role:'tool' 段无法为每个 toolCallId 提供响应，则剥离该 assistant
 *   的 toolCalls 字段，并丢弃紧随的无主 tool 消息（孤立 tool 消息同样会触发服务端 400）。
 * - v0.15.1 补充：压缩（compact sliceRecentContext）可能把前置 assistant tool_calls 归档
 *   而保留 tool 响应，产生"孤立 tool 消息"——此类消息前面没有配对的 assistant toolCalls，
 *   直接丢弃，避免 400 "must be a response to a preceding message with tool_calls"。
 */
export function reconcileToolCalls(messages: LlmMessage[]): LlmMessage[] {
  const out: LlmMessage[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // 收集紧随其后的连续 tool 消息提供的 toolCallId
      let k = i + 1
      const provided = new Set<string>()
      while (k < messages.length && messages[k].role === 'tool') {
        const tcId = messages[k].toolCallId
        if (tcId) provided.add(tcId)
        k++
      }
      const allPaired = m.toolCalls.every((tc) => (tc.id ? provided.has(tc.id) : false))
      if (!allPaired) {
        // 剥离 toolCalls，跳过紧随的 tool 段
        logger.warn(
          'Agent',
          `reconcileToolCalls: stripped dangling tool_calls (${m.toolCalls.length}), skipping ${k - i - 1} orphan tool message(s)`,
        )
        // v0.18.x fix: 阈值 4096→2048，4KB 仍会把 thought 区撑成长条；
        // 替换为摘要，避免污染 UI thought 区。
        let safeContent = m.content
        if (typeof safeContent === 'string' && safeContent.length > 2048 && /<</.test(safeContent)) {
          safeContent = `[shell 命令过长已截断，原文 ${safeContent.length} 字节]`
        }
        out.push({ ...m, toolCalls: undefined, content: safeContent })
        i = k
        continue
      }
      // 全配对：assistant + 其后全部 tool 段原样保留并整体跳过
      out.push(m)
      for (let j = i + 1; j < k; j++) out.push(messages[j])
      i = k
      continue
    }
    if (m.role === 'tool') {
      // 游离 tool 消息：前面没有配对的 assistant toolCalls（压缩切片遗留/脏数据），丢弃
      logger.warn(
        'Agent',
        `reconcileToolCalls: dropped orphan tool message (${m.toolCallId ?? m.name ?? 'unknown'})`,
      )
      i++
      continue
    }
    out.push(m)
    i++
  }
  return out
}

export async function assembleTools(agent: Agent, task: Task): Promise<LlmTool[] | undefined> {
  const skills = await listSkills()
  // v0.6.0（F1）：合并 agent 默认 skills + task 会话级 skills，去重，过滤已禁用
  // v0.24.2.1：补上 MCP — agent.defaultMcpIds 与 task.mcpIds 内的 server 对应的全部
  //   source='mcp' Skill 一并纳入工具集（与 automations.ts:204 的合并方式对齐）。
  const skillIdSet = new Set<string>([
    ...agent.defaultSkillIds,
    ...(task.skillIds || []),
  ])
  // v0.32.0 G1：当前工作台声明的技能**叠加**进来（只加不减）
  //   —— profile 的 capabilities/agents[].skills 是「这个垂直台需要的能力」，
  //     不是「替换掉 agent 默认工具」；做减法会让用户在切台后莫名失去工具，
  //     且难解释（工具消失比工具多余更难排查）。缺失项在装配时已降级记账，
  //     这里只取 `found: true` 的（没装上的本就不该出现在工具列表里）。
  try {
    const { getLastSnapshot } = await import('../../profile/store.js')
    const snap = await getLastSnapshot()
    if (snap) {
      for (const t of snap.layers.tools) {
        if (t.kind === 'skill' && t.found) skillIdSet.add(t.ref)
      }
    }
  } catch {
    // profile 模块不可用（未启用 / 加载失败）→ 不阻断主路径，工具集退回 v0.31 语义
  }
  const mcpServerIdSet = new Set<string>([
    ...(agent.defaultMcpIds || []),
    ...(task.mcpIds || []),
  ])
  for (const s of skills) {
    if (s.source === 'mcp' && s.mcpRef && mcpServerIdSet.has(s.mcpRef.serverId)) {
      skillIdSet.add(s.id)
    }
  }
  const mergedIds = [...skillIdSet]
  const available = skills.filter(
    (s) => mergedIds.includes(s.id) && s.enabled !== false,
  )
  if (available.length === 0) return undefined
  // v0.20.0 缓存优化：按工具名确定性排序，避免技能发现顺序抖动导致 tools 前缀变化
  //（MiniMax 缓存前缀顺序为 tools → system → messages，tools 抖动会破坏整段缓存）。
  return available
    .map(skillToLlmTool)
    .sort((a, b) => a.function.name.localeCompare(b.function.name))
}
