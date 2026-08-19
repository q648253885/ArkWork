/* ============================================================
 * ArkWork — ReAct Engine
 * 设计文档 §9.1 — AsyncGenerator 推送事件流，可中断
 * ============================================================ */
import type { Task, PlanItem } from '@shared/types/task'
import type {
  ReActEvent,
  ReActAction,
  ReActStep,
  PlanContent,
} from '@shared/types/react'
import type { Agent } from '@shared/types/agent'
import { getAdapter, getModel } from '../llm/registry.js'
import type { LlmMessage, LlmTool, LlmCompleteResponse } from '../llm/adapter.js'
// agent-context-compaction-robustness：LLM 调用健壮性（120s 超时 / 中止短路 / 重试分级）
import { callLlmWithRetry, withLlmTimeout, isContextOverflowError } from './llm-call.js'
import { invokeSkill, skillToLlmTool, skillToolName, listSkills, getSkill, type SkillContext } from './registry.js'
// v0.19.0 M1：系统提示词组装器（收敛 parts.push 硬拼逻辑）
import { buildSystemSections, renderSystemPrompt, buildPersonalitySegment } from './prompt-assembly.js'
// v0.25.0 F1：提示词契约层（契约注册 + always-on 技能段 + 契约装配 + 门禁状态机）
import { collectAlwaysOnSections, assembleSystemPrompt } from './prompt/sections.js'
import {
  collectGateSpecs,
  initGateStates,
  checkGateBeforeAdvance,
  confirmGate,
  findGateForStageDoc,
  isDocDrivenAgent,
} from './prompt/gates.js'
import type { GateSpec } from '@shared/types/agent'
// v0.19.0 M2：唯一真源会话事件日志（Reason/Act/tool 事件落盘 session.jsonl）
import { appendSessionEvent } from './session-log.js'
// v0.19.0 M3：轮次/步骤收件箱 + 停止候选钩子（turn/step 语义）
import { drainContinuations } from './inbox.js'
import { emitTurnStopping } from './turn-stopping.js'
import {
  matchStageGate,
  isCoreSkillsEnabled,
  buildGateBlockObservation,
  describeGateForLog,
  computeAllowedStage,
  matchForbiddenWritePath,
  matchForbiddenShellCommand,
  type StageGate,
} from '../skills/builtin/react-core-skills/stage-gates.js'
import { appendL1, listEnabledL1, listL1, totalTokens } from '../memory/l1-working.js'
import { persistRawL2 } from '../memory/l2-file.js'
import { logger } from '../system/logger.js'
import { genId } from '@shared/utils/id'
import { isNoisePlanItem } from '@shared/utils/plan-noise'
import { describeAction } from '@shared/utils/action-description'
import { createHash } from 'node:crypto'
import { updateTask, getTask } from '../store/tasks.js'
import { getAgent } from '../store/agents.js'
import {
  broadcastStep,
  broadcastTaskStatus,
  broadcastToolProgress,
  clearToolProgress,
  broadcastPlanItemStatus,
  broadcastPlanListSnapshot,
  type ToolProgress,
} from './events.js'
import { getWorkspaceDir } from '../store/db.js'
import { saveCheckpoint, checkpointId } from '../checkpoint/store.js'
// v0.8.0 记忆系统钩子
import { applyPending, getCuratedSnapshot } from '../memory/l3-curated.js'
import { archiveTaskL1, initArchiveIndex } from '../memory/l3-archive.js'
import { getProfile, synthesizeFromTaskL1 } from '../memory/l4-profile.js'
import { evaluateDistillTrigger, autoPromoteDistill, getDistillMetrics } from '../memory/distill.js'
import { runForSkillForge } from '../memory/skill-forge.js'
import { compressMemory } from '../ipc/memory.js'
// v0.15.0：统一压缩路径——自动压缩与 Turn Phase-0 均走两阶段 compact()（联动 L3b + 压缩后蒸馏）
import { compactTask } from '../memory/compaction.js'
import { createMemoryPhase0 } from '../memory/compaction-hook.js'
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
} from './context.js'
import { getMemoryConfig, getSettings } from '../ipc/settings.js'
// v0.8.0 知识库钩子
import { listKb, listEnabledKb } from '../kb/store.js'
import { searchKb, initKbIndex } from '../kb/index.js'
import { readFile } from 'node:fs/promises'
// Task 6：上下文占比可视化与下钻
import {
  computeContextBreakdown,
  type ContextBreakdownInput,
  type ContextBreakdownResult,
  type ContextToolEntry,
  type ContextSkillInstruction,
} from './context-breakdown.js'

/** 按 UTF-16 编码单元截断，但避免在 Unicode 代理对中间切开，防止产生 lone surrogate 导致 JSON 序列化 400 */
function safeSlice(content: string, max: number): string {
  if (content.length <= max) return content
  let end = max
  const lead = content.charCodeAt(end - 1)
  if (lead >= 0xd800 && lead <= 0xdbff && content.charCodeAt(end) >= 0xdc00 && content.charCodeAt(end) <= 0xdfff) {
    end -= 1
  }
  return content.slice(0, end)
}

export interface RunOptions {
  task: Task
  agent: Agent
  modelId: string
  signal: AbortSignal
  /** 最大迭代数（默认 25） */
  maxIterations?: number
  /** 本运行是否已被新一次运行接管——被接管后退出时不再写入任务状态（v0.8.1） */
  stale?: () => boolean
  /**
   * v0.15.x Task 1+2：本运行的 generation（runner 在每次 runTask 时自增）。
   * 仅当 opts.stale 未传时使用此字段构造兜底 stale 闭包，避免重复维护 generation。
   * runner 通常直接传 stale()；独立调用方（如 task 直接走 engine）可仅传 startGeneration。
   */
  startGeneration?: number
}

const MAX_ITERATIONS = 80
// polish4 §D1.2：单 tool 调用次数上限（防 infinite loop / agent 反复调同 tool）
// v0.16.3 调整：预算拆为两层：
// 1. 调用签名层（MD5(toolName + args)）：防止同参数反复执行，上限统一 3
// 2. 工具类别层：防止整体工具过度使用，只读探索工具 16，其它 8
// v0.16.6：上调写入类预算（file-writer/file-editor/shell）。开发完整项目必然需要写
// 大量文件（10 关游戏 = 10+ JS 模块 + 多个 HTML 原型 + 10+ 文档），8 上限会强制 agent
// 在编码中途切换策略（被迫内联代码或拆任务），影响开发连贯性。
//  - 调用签名层（MD5）已能防"同参数反复执行"（同一文件相同内容写 3 次就拦）
//  - 因此把工具类别层上限放宽：写入/运行类 40（覆盖典型中型项目）
const MAX_PER_SIGNATURE = 3
// v0.19.x：工具类别上限统一提高到 200（用户反馈 32/40 太低，中型项目不够用）。
// 达到 200 视为"任务执行时间过长"信号：引擎中断并 ask_user 询问用户是否继续
// （见预算检查处的 budgetInterrupt 分支），而不是直接跳过执行。
const MAX_PER_TOOL_DEFAULT = 200
const MAX_PER_TOOL_READONLY = 200
const READONLY_TOOLS = new Set([
  'file-reader',
  'glob-search',
  'grep-search',
  'web-search',
  'fetch-url',
  'session-search',
  'kb-search',
])

function getToolCategoryLimit(tool: string): number {
  return READONLY_TOOLS.has(tool) ? MAX_PER_TOOL_READONLY : MAX_PER_TOOL_DEFAULT
}

// v0.16.3：调用签名 key = MD5(toolName + args)
function getToolCallKey(tool: string, args: unknown): string {
  const payload = JSON.stringify({ tool, args })
  return createHash('md5').update(payload).digest('hex')
}

// v0.9.x：shell 写入命令特征（命中即视为产出性操作，清零只读停滞计数）
const WRITE_COMMAND_RE = /mkdir|tee|\bcp\b|\bmv\b|\becho\b|cat\s*>|>|\$\s*\(/i

export async function runReActLoop(
  opts: RunOptions,
): Promise<void> {
  const { task, agent, signal } = opts
  const maxIter = opts.maxIterations ?? task.config.maxIterations ?? MAX_ITERATIONS
  // v0.15.x Task 1+2：stale 兜底 — runner 通常会传 opts.stale（基于其内部
  // generations Map）。若调用方只传 startGeneration（绕过 runner 跑 engine 的
  // 场景），engine 没有外部 generation 查询源，无法做真实 stale 检查 —— 此时
  // 返回一个始终为 false 的兜底闭包，避免误判接管导致静默退出。
  // 正常路径下优先使用 opts.stale。
  const startGenerationStored = opts.startGeneration
  const stale: ((() => boolean) | undefined) =
    opts.stale
    ?? (startGenerationStored !== undefined
      ? () => false  // 退化路径：engine 不知 generation 变化，永远不视为 stale
      : undefined)

  // polish4 §D1.2：单 tool 调用次数上限（防 infinite loop）
  // v0.16.3：拆为两层预算：调用签名（MD5(tool+args)）+ 工具类别
  const toolSignatureBudget = new Map<string, number>()
  const toolCategoryBudget = new Map<string, number>()
  // Phase A Task 1：同任务内同一调用签名已达预算上限仅记录一次 L2/L3 日志，避免 UI 日志噪音
  const budgetWarnedKeys = new Set<string>()
  // v0.19.x：达限中断状态 —— 类别预算触顶时只 ask_user 一次（本次 run 内），
  // 用户回复"继续"后新 run 会重置预算计数；同参数重复调用被拦截次数（重点关注信号）
  let budgetInterrupted = false
  let signatureBlockedTotal = 0
  // 连续多轮所有 action 均被跳过计数（避免模型反复尝试已耗尽签名导致空转）
  let consecutiveSkippedIterations = 0

  // 标记任务为 running
  await updateTask(task.id, { status: 'running', startedAt: Date.now() })
  broadcastTaskStatus({ ...task, status: 'running' })

  // Task 9：任务启动 → 初始化进度摘要（默认进入第一阶段「开源调研」，
  // 整体 5%；由 Renderer 收到 task_progress 事件后落地 taskProgress）
  await emitProgress({
    type: 'task_progress',
    taskId: task.id,
    currentStage: 'research',
    stageIndex: 0,
    overallPercentage: 5,
    nextStepLabel: '启动规划',
  })

  logger.info('Agent', `ReAct loop started for ${task.id} (@${agent.id})`, task.id)

  // polish4 §D1.1：循环顶部 stale guard（已在 handleAbort 里，但仍需顶部守门）
  if (stale?.()) {
    logger.warn('Agent', 'reconcile stale run at start', task.id)
    return
  }

  try {
    // v0.4.0-rev4：仅注入 system_prompt（当 L1 中无 system_prompt 时）。
    // 不再注入 user_message——用户消息由 appendUserMessage（续聊路径）或
    // createTask（新建任务路径，input.text 非空时）负责写入 L1。
    // 原逻辑用 l1Items.length === 0 判断，但 appendUserMessage 会先写入 user_message
    // 导致 system_prompt 不注入且 user_message 重复/空字符串注入，LLM 返回空。
    const l1Items = await listEnabledL1(task.id)
    const hasSystemPrompt = l1Items.some((m) => m.kind === 'system_prompt')
    if (!hasSystemPrompt) {
      await appendL1({
        taskId: task.id,
        role: 'system',
        kind: 'system_prompt',
        content: agent.systemPrompt,
        enabled: true,
      })
    }

    // 续聊：从已有 L1 的最大 iteration 继续，避免和之前的步骤冲突
    const allL1 = await listEnabledL1(task.id)
    const startIter = allL1.reduce((max, m) => Math.max(max, m.iteration), 0)

    // v0.8.0 F802/F804：run 启动——合并 L3a pending + 构建 L3a/L4a/KB 注入文本
    let memoryInjection = ''
    try {
      await applyPending(opts.modelId)
      memoryInjection = await buildMemoryInjection(agent, task)
    } catch (err) {
      logger.warn('Agent', `memory injection skipped: ${(err as Error).message}`, task.id)
    }

    // v0.8.0 F803：初始化档案索引（启动时加载 MiniSearch 快照）
    void initArchiveIndex().catch((e) =>
      logger.warn('Agent', `archive index init failed: ${(e as Error).message}`, task.id),
    )

    // v0.25.0 F1：常驻技能（always-on）+ 门禁状态机初始化。
    // 替代旧「preloadedCoreSkillHint 预加载 + docDriven 正则特判」：
    //  - 指令体经契约段 skill:{id} 注入 system 的 agent-static 段（任务全程生效，
    //    同一 agent 逐字节稳定 → 命中前缀缓存），不再走单轮 pendingSystemHint；
    //  - docDriven 改由「agent.alwaysOnSkillIds 技能的 planPrompt/名称」通用机制判定；
    //  - frontmatter gates 收集进 task.gateStates（持久化，todo_update 拦截 + ask_user 写回）。
    const alwaysOnContracts = await collectAlwaysOnSections(agent)
    const alwaysOnSkillIdSet = new Set(agent.alwaysOnSkillIds ?? [])
    const docDriven = isDocDrivenAgent(agent, []) || isCoreSkillsEnabled(task, agent)
    if (alwaysOnContracts.length > 0) {
      logger.info(
        'Agent',
        `always-on skills injected: ${alwaysOnContracts.map((c) => c.id).join(', ')}`,
        task.id,
      )
    }

    // 门禁初始化：always-on 技能 + 任务显式技能的 frontmatter gates → task.gateStates。
    // 续聊 run 重新收集（幂等合并：已存在的 gate 保留状态，仅刷新声明快照）。
    try {
      const gateSourceSkills = await Promise.all(
        [...(agent.alwaysOnSkillIds ?? []), ...(task.skillIds ?? [])].map((sid) =>
          getSkill(sid).catch(() => null),
        ),
      )
      const specs = await collectGateSpecs(gateSourceSkills.filter((s): s is NonNullable<typeof s> => !!s))
      if (specs.length > 0) {
        initGateStates(task, specs)
        logger.info('Agent', `gates initialized: ${specs.map((g) => g.id).join(', ')}`, task.id)
      }
    } catch (err) {
      logger.warn('Agent', `gate init skipped: ${(err as Error).message}`, task.id)
    }

    // v0.25.0 F1：消费 pendingGateBlock —— 上一次 run 被 todo_update 门禁拦截后，
    // LLM 已按指令 ask_user 且用户已答复（答复即本轮 run 的最新 user_message）。
    // 据答复写回 gateStates（含「跳过」语义识别），中断续聊后状态机不丢。
    if (task.pendingGateBlock) {
      const gateId = task.pendingGateBlock.gateId
      try {
        const latestUser = [...allL1]
          .reverse()
          .find((m) => m.kind === 'user_message' && m.content?.trim())
        const reply = (latestUser?.content ?? '').trim()
        const wantsSkip = /跳过|无需确认|不用确认|跳过该门禁|skip/i.test(reply)
        confirmGate(
          task,
          gateId,
          reply ? `用户答复：${reply.slice(0, 80)}` : '用户已答复门禁提问',
          wantsSkip ? 'skipped' : 'passed',
        )
        logger.info('Agent', `gate ${gateId} confirmed (${wantsSkip ? 'skipped' : 'passed'})`, task.id)
      } catch (err) {
        logger.warn('Agent', `gate confirm failed: ${(err as Error).message}`, task.id)
      }
      task.pendingGateBlock = undefined
      await updateTask(task.id, {
        gateStates: task.gateStates,
        pendingGateBlock: undefined,
      })
    }

    // v0.25.0 F1：常驻技能指令体供 generatePlan 注入（计划清单与阶段严格对齐，
    // 沿用 v0.17.x「清单与阶段关联」硬约束文本）。
    let alwaysOnPlanHint: string | undefined
    if (alwaysOnContracts.length > 0) {
      const texts = await Promise.all(
        alwaysOnContracts.map(async (c) => {
          try {
            return await c.build({ agent, workspaceDir: getWorkspaceDir() })
          } catch {
            return null
          }
        }),
      )
      const joined = texts.filter((t): t is string => !!t && t.trim().length > 0).join('\n\n---\n')
      if (joined) {
        alwaysOnPlanHint =
          `${joined}\n\n---\n` +
          `## 清单与阶段关联（硬约束 · v0.17.4）\n` +
          `计划清单已按文档驱动开发阶段生成（开源调研 → PRD → 交互文档 → HTML 原型 → 系统设计 → 编码 → 功能测试 → UI 测试 → UX 校验 → 交付打包）。\n` +
          `HTML 原型是设计文档的一部分（产出 docs/v1.0/prototype/*.html），不是编码步骤。\n` +
          `在系统设计（03-system-design.md）冻结前，禁止执行任何编码/脚手架操作（初始化项目、搭建 src、写 package.json、实现功能、写测试）。\n` +
          `每步执行前声明"正在执行计划第 N 步"，完成后继续下一步，禁止跳步。`
      }
    }

    // v0.17.x：阶段感知写入守卫 —— 仅在 react-core-skills 启用时生效。
    // 从工作区已产出的阶段文档推导「当前允许推进到的阶段」，越级脚手架写入（src/、
    // package.json 等）在文档阶段会被拦截。对齐 opencode / Claude Code 的清单↔阶段关联。
    // v0.17.5：优先使用 docDriven（已通过 getSkill 名称匹配），兜底 isCoreSkillsEnabled
    const coreSkillsEnabled = docDriven || isCoreSkillsEnabled(task, agent)
    let allowedStage = 0
    if (coreSkillsEnabled) {
      try {
        allowedStage = computeAllowedStage(getWorkspaceDir())
        logger.info('Agent', `stage write guard on: allowedStage=${allowedStage}`, task.id)
      } catch (err) {
        logger.warn('Agent', `computeAllowedStage failed: ${(err as Error).message}`, task.id)
      }
    }

    // 任务计划清单必须先于记忆召回和任何 ReAct 思考/工具操作出现。
    // polish4 §B1：新任务流程必须经过 Plan，但 plan 生成失败时**不**写 fallback plan 到 L1，
    // 避免模型下一轮引用兜底清单。仅当 generatePlan 真正成功时才落入 plan_start 事件 + L1。
    if (startIter === 0) {
      const planStartedAt = Date.now()
      let plan: PlanContent | null = null
      try {
        plan = await generatePlan(task, agent, opts.modelId, signal, alwaysOnPlanHint, docDriven)
      } catch (err) {
        logger.warn('Agent', `plan generation failed: ${(err as Error).message}`, task.id)
        plan = null
      }
      if (plan && plan.items.length > 0) {
        // v0.17.3：把 PlanContent.items 转为 Task.planItems（带 id/status），
        // 让 system prompt 能注入计划进度，UI 能展示计划状态。
        // v0.17.5：过滤纯阶段标题型条目（"阶段 N：xxx" 这种总结性条目不应该是可勾选项，
        // 否则 LLM 调一次 file-reader 就把整阶段标 done）。只保留含具体动作动词的子项。
        const filteredItems = plan.items.filter((text) => !isPhaseHeader(text))
        // v0.24.x fix：全被阶段标题过滤为空时回退原始 items —— 否则清单恒为空，
        // LLM 调 todo_update 会以 item_index=0 越界（清单共 0 项）报错并死循环。
        const keepItems = filteredItems.length > 0 ? filteredItems : plan.items
        const now = Date.now()
        const planItems: PlanItem[] = keepItems.map((text, i) => ({
          id: `plan_${i}_${now}`,
          text,
          // v0.18.x：首项直接进入 running，让清单在任务开始就有反应，
          // 而不是等到第一个 act 完成才被动推进。
          status: i === 0 ? 'running' as const : 'pending' as const,
          createdAt: now,
          updatedAt: now,
        }))
        task.planItems = planItems
        await updateTask(task.id, { planItems })
        // v0.18.0 F1/F2：plan 全量生成走 snapshot 通道（与 patch 分开，避免队列交叉）；
        // 一次性把整 planItems 推到 Renderer 端 hydrate 三视图 + reconcile。
        broadcastPlanListSnapshot(task.id, planItems, 'plan-regen')
        if (filteredItems.length < plan.items.length) {
          logger.warn(
            'Agent',
            `plan filtered: kept ${filteredItems.length}/${plan.items.length} (removed ${plan.items.length - filteredItems.length} phase-header items)`,
            task.id,
          )
        }
        // 真正成功 → 写 L1 + 广播事件 + 渲染
        await appendL1({
          taskId: task.id,
          role: 'assistant',
          kind: 'plan',
          iteration: 0,
          content: ['## 计划清单', ...plan.items.map((it, i) => `${i + 1}. ${it}`)].join('\n'),
        })
        await emitEvent(task.id, { type: 'plan_start', taskId: task.id })
        const planStep: ReActStep = {
          id: genId('step'),
          taskId: task.id,
          iteration: 0,
          type: 'plan',
          plan,
          startedAt: planStartedAt,
          durationMs: Date.now() - planStartedAt,
          status: 'success',
        }
        broadcastStep(planStep)
        await emitEvent(task.id, {
          type: 'plan_end',
          taskId: task.id,
          plan,
          durationMs: planStep.durationMs,
        })
      } else {
        // polish4 §B1.2：plan 失败不污染 L1，ReAct 循环从 step 1 直接进入 Reason
        logger.warn('Agent', 'plan skipped (generatePlan returned null / empty)', task.id)
        // v0.24.x fix：plan 生成失败时仍写入兜底单步清单（仅 UI/索引用，不写 L1）。
        // 否则清单恒为空，LLM 调 todo_update(item_index=0) 会以"清单共 0 项"越界报错并死循环。
        const fallbackText = task.input?.text?.trim() || task.title || '执行用户请求'
        const nowFallback = Date.now()
        const fallbackPlanItems: PlanItem[] = [
          {
            id: `plan_fallback_${nowFallback}`,
            // v0.24.x：不走 sanitizePlanItemText，避免用户原标题较长时被截断 → 列表项为空。
            // 兜底项本身就是用户原文，"执行用户请求"是占位。
            text: fallbackText.slice(0, 80).trimEnd() || '执行用户请求',
            status: 'running' as const,
            createdAt: nowFallback,
            updatedAt: nowFallback,
          },
        ]
        task.planItems = fallbackPlanItems
        await updateTask(task.id, { planItems: fallbackPlanItems })
        broadcastPlanListSnapshot(task.id, fallbackPlanItems, 'plan-fallback')
        logger.info('Agent', `plan-fallback: 写入兜底单步清单（${fallbackPlanItems[0]?.text}）`, task.id)
      }
    }

    // v0.16.7+：续聊路径强制注入"重新评估 plan"提示——
    // 用户中途改变目标时，原 plan 与新指令可能不一致；Agent 必须先做计划 diff，
    // 再决定：(a) 沿用旧 plan、(b) 用 ask_user 让用户选调整方式、(c) 重新生成 plan。
    // 该 hint 推迟到 pendingSystemHint 声明后设置（let 块级变量）。

    // 规划已展示后再启动异步召回，避免用户先看到思考/操作再看到清单。
    void autoRecallKb(task).catch((e) =>
      logger.warn('Agent', `KB auto-recall failed: ${(e as Error).message}`, task.id),
    )

    let iteration = startIter
    // v0.25.0 F1：pendingSystemHint 仅承载「运行期瞬时提示」（工具预算告警 / 续聊
    // plan 重评 / 只读停滞提醒），当轮消息尾部注入后清空。
    // 技能指令体不再走此通道 —— on-demand 技能经 appendL1 kind='skill_instruction'
    // 持续生效至任务结束（与 plan_status 同管道，复用归档/压缩策略）；
    // always-on 技能经契约段 skill:{id} 进 system（见 collectAlwaysOnSections）。
    let pendingSystemHint: string | undefined

    // v0.24.1：显式要求技能自动加载 —— 用户说 "Use Skill: X" 后 task.skillIds 会带上该技能，
    // 引擎在首轮 Reason 前自动加载其 SKILL.md 指令并广播一个可见步骤，保证「调用技能且真正使用」，
    // 不再依赖模型自觉 invoke（用户反馈过“调用了 skill 却没实现使用技能”）。
    // v0.25.0 F1：注入方式改为 L1 skill_instruction（持续生效），always-on 技能已在 system。
    if (startIter === 0) {
      const explicitSkillIds = Array.from(new Set((task.skillIds ?? []).filter((x): x is string => typeof x === 'string')))
      for (const sid of explicitSkillIds) {
        try {
          const s = await getSkill(sid)
          if (!s?.instructionMd) continue
          if (alwaysOnSkillIdSet.has(sid)) {
            // 常驻技能指令体已进 system agent-static 段 —— 只广播可见步骤
            broadcastSkillAutoLoaded(task, s.name, s.instructionMd)
            continue
          }
          const full = await readFile(s.instructionMd, 'utf-8')
          const body = full.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() || full
          const block =
            `## 技能「${s.name}」指令（用户显式要求使用，必须严格遵循执行）\n` +
            (body.length > 8000 ? body.slice(0, 8000) + `\n\n...（指令超过 8KB，已截断，完整内容见技能文件 ${s.instructionMd}）` : body)
          await injectSkillInstruction(task, { id: s.id, name: s.name }, block, 0)
          broadcastSkillAutoLoaded(task, s.name, s.instructionMd)
          logger.info('Tool', `skill auto-loaded: ${s.id} (${body.length} chars)`, task.id)
        } catch (err) {
          logger.warn('Tool', `skill auto-load skipped: ${(err as Error).message}`, task.id)
        }
      }
    }
    // v0.16.7+：续聊路径 plan 重评提示（紧跟 react-core-skills preload 后）
    if (startIter > 0) {
      // v0.24.x：plan-regen 决策（替代 v0.21.0 continuation 兜底）
      // 旧逻辑只在「旧 plan 全部完成」时追加一个「续接新需求」承接项。
      // 用户体验上：旧清单全部 done 后新指令仍要 Agent 自己 plan，无脑追加「续接新需求」
      // 反而成了「原任务完成 + 新任务承接」两条线、不一致。
      // 新逻辑：若旧 plan 全部 done / failed / cancelled / skipped
      //   → 调 generatePlan 重新生成 planItems，覆盖旧 plan（broadcastPlanListSnapshot source='plan-regen'）。
      // 若旧 plan 还有 running/pending 项
      //   → 保留旧 plan + 追加 continuation 承接项（保持 v0.21.0 行为，避免打断在飞清单）。
      const planItems = task.planItems ?? []
      const hasActive = planItems.some(
        (p) => p.status === 'running' || p.status === 'pending',
      )
      const isAllFinished =
        planItems.length > 0 &&
        planItems.every(
          (p) =>
            p.status === 'done' ||
            p.status === 'failed' ||
            p.status === 'cancelled' ||
            p.status === 'skipped',
        )
      if (planItems.length > 0 && !hasActive && isAllFinished) {
        // 旧 plan 全部完成 / 失败 / 跳过：自动重新生成 plan（不沿用旧 plan）
        let newPlan: PlanContent | null = null
        try {
          newPlan = await generatePlan(
            task,
            agent,
            opts.modelId,
            signal,
            alwaysOnPlanHint,
            docDriven,
          )
        } catch (err) {
          logger.warn(
            'Agent',
            `plan-regen failed: ${(err as Error).message}`,
            task.id,
          )
          newPlan = null
        }
        if (newPlan && newPlan.items.length > 0) {
          const filtered = newPlan.items.filter((text) => !isPhaseHeader(text))
          const now = Date.now()
          const newPlanItems: PlanItem[] = filtered.map((text, i) => ({
            id: `plan_${i}_${now}_regen`,
            text,
            status: i === 0 ? 'running' : 'pending',
            createdAt: now,
            updatedAt: now,
            source: 'plan-regen',
          }))
          task.planItems = newPlanItems
          await updateTask(task.id, { planItems: newPlanItems })
          broadcastPlanListSnapshot(task.id, newPlanItems, 'plan-regen')
          logger.info(
            'Agent',
            `plan-regen: ${filtered.length} items (replaced ${planItems.length} finished items)`,
            task.id,
          )
          // plan-regen 成功 → 直接继续（不再追加 continuation、不再注入 replan hint）
          // fall through 到下面的循环即可
        } else {
          // generatePlan 失败 → 降级到 v0.21.0 续接模式，确保任务不会卡死
          const latestUser = [...allL1]
            .reverse()
            .find((m) => m.kind === 'user_message' && m.content?.trim())
          const brief = (latestUser?.content ?? '').trim().replace(/\s+/g, ' ')
          const text = brief
            ? `续接新需求：${brief.length > 80 ? brief.slice(0, 80) + '…' : brief}`
            : '处理用户追加的新需求'
          const now = Date.now()
          const continuation: PlanItem = {
            id: genId('plan'),
            text,
            status: 'running',
            createdAt: now,
            updatedAt: now,
            source: 'continuation',
          }
          task.planItems = [...planItems, continuation]
          await updateTask(task.id, { planItems: task.planItems })
          broadcastPlanListSnapshot(task.id, task.planItems, 'continuation')
          logger.warn(
            'Agent',
            `plan-regen failed → fallback to continuation: ${text}`,
            task.id,
          )
        }
      } else if (planItems.length > 0 && !hasActive) {
        // 旧 plan 空但仍有「非结束态」空壳（理论不会发生）→ 同上兜底
        const continuation: PlanItem = {
          id: genId('plan'),
          text: '处理用户追加的新需求',
          status: 'running',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: 'continuation',
        }
        task.planItems = [...planItems, continuation]
        await updateTask(task.id, { planItems: task.planItems })
        broadcastPlanListSnapshot(task.id, task.planItems, 'continuation')
      }
      // 旧 plan 还有 active 项（running/pending）→ 保留原 plan，不追加 continuation，
      // 让 Agent 自然推进已有清单；replanHint 仍然注入提示 Agent 评估新旧指令一致性。

      const replanHint = `## 续聊计划重评（v0.24.x）
用户追加了新指令。先评估现有 plan 与新指令的一致性：
1. 若新指令仍属于当前 plan 的某一步 → 直接继续，标记该 step 为 in_progress。
2. 若新指令偏离原 plan 但属于同一目标 → 用 ask_user 让用户确认是否调整 plan。
3. 若新指令是全新目标（已有 plan 已全部完成 / 失败 / 跳过）→ 引擎已自动重新生成 plan，按新 plan 推进。
禁止在没经用户确认时静默重置进行中的 plan。`
      pendingSystemHint = pendingSystemHint
        ? `${pendingSystemHint}\n\n---\n${replanHint}`
        : replanHint
    }
    // v0.9.x：连续"只读探索"轮数（>=3 时注入产出提示，防空工作区无限探索）
    let consecutiveReadOnly = 0
    while (iteration < startIter + maxIter) {
      iteration += 1
      if (signal.aborted) {
        await handleAbort(task, iteration, stale)
        return
      }

      // -------- Reason --------
      await emitEvent(task.id, { type: 'reason_start', iteration })

      // v0.17.5：计划项状态推进 — 仅在首轮把第一个 pending 标为 running。
      // 后续轮次不再自动推进/重置，改由 LLM reasoning 声明驱动（见 act 后的逻辑）。
      // 此前每轮都把 running 重置为 pending 再标下一个，导致状态频繁跳动且与实际执行脱节。
      if (iteration === 0 && task.planItems && task.planItems.length > 0) {
        const firstPendingIdx = task.planItems.findIndex((it) => it.status === 'pending')
        if (firstPendingIdx >= 0) {
          task.planItems[firstPendingIdx].status = 'running'
          task.planItems[firstPendingIdx].updatedAt = Date.now()
          await updateTask(task.id, { planItems: task.planItems })
        }
      }

      // v0.17.6：每轮 Reason 前注入引擎独立判断的清单状态（独立 user 消息，非 system prompt 文本）。
      // 模型必须以这条消息为准，避免"LLM 自报已完成"的失真。
      if (task.planItems && task.planItems.length > 0) {
        try {
          await emitPlanStatus(task, iteration, '迭代开始')
        } catch (e) {
          logger.warn('Agent', `emitPlanStatus skipped: ${(e as Error).message}`, task.id)
        }
      }

      const startedAt = Date.now()
      // v0.15.0 Task 2 SubTask 2.5：Reactive Fallback 压缩后需重新组装，故用 let
      let messages = await assembleMessages(task, agent)
      const tools = await assembleTools(agent, task)

      // v0.20.0 缓存优化：动态 skill 指令不再拼进 system prompt（会破坏前缀缓存），
      // 改为追加到消息尾部（瞬时、不进 L1）。system 保持整轮字节稳定才能命中缓存。
      if (pendingSystemHint) {
        messages = [...messages, { role: 'user', content: `[Skill 指令]\n${pendingSystemHint}` }]
      }

      // 合并 system prompt + 人格段 + 工作区路径 + 记忆注入
      // v0.6.4：注入 workspaceDir 绝对路径，让 agent 知道工作区位置可正确列目录
      // v0.8.0 F822：注入人格段（role/goal/backstory/styleGuide）
      // v0.8.0：注入 L3a 策展记忆 + L4a 用户画像（memoryInjection 在 run 启动时构建）
      // 必须先于 adapter.complete 构建 systemPrompt，否则下一轮 Reason 会 TDZ 报错。
      // v0.19.0 M1：由 prompt-assembly 组装器统一渲染
      // v0.25.0 F1：按契约装配 system prompt（替代 buildSystemSections 的散段逻辑）。
      // alwaysOnContracts 已在 run 入口加载并完成预算/合法性校验（required 缺失启动期 throw）；
      // 同 agent 逐字节稳定 → 命中前缀缓存。pendingSystemHint 仅承载运行期瞬时提示。
      const systemPrompt = (
        await assembleSystemPrompt(
          {
            agent,
            workspaceDir: getWorkspaceDir(),
            memoryInjection,
            planItems: task.planItems,
          },
          alwaysOnContracts,
        )
      ).text
      pendingSystemHint = undefined  // 用完即清，下一轮若不调用 skill 则不再注入

      const adapter = await getAdapter(opts.modelId)
      const model = await getModel(opts.modelId)
      await emitContextSizeReport({
        taskId: task.id,
        iteration,
        systemPrompt,
        messages,
        tools,
        memoryInjection,
        contextWindow: model?.contextWindow,
      })
      // polish4 §D1.3：LLM 调用错误分级重试包装（120s 超时 + 重试 + 中止短路）
      let response: LlmCompleteResponse
      try {
        response = await callLlmWithRetry(
          () =>
            withLlmTimeout(
              (sig) =>
                adapter.complete({
                  system: systemPrompt,
                  messages,
                  tools,
                  temperature: task.config.temperature ?? agent.defaultConfig.temperature ?? 0.5,
                  maxTokens: task.config.maxTokens,
                  signal: sig,
                }),
              120_000,
              signal,
            ),
          signal,
        )

        // v0.15.0 Task 5：思考模型输出预算被思考耗尽（finish=length + content 空 + 无 tool action）
        // → 提高 maxTokens 到 8192 重试一次；仍空则注入占位答复，避免任务静默 done 且无内容。
        if (
          response.finishReason === 'length' &&
          !response.content &&
          !(response.actions && response.actions.length > 0) &&
          response.reasoningContent
        ) {
          logger.warn('Agent', 'reasoning exhausted output budget (finish=length, empty content) — retry with maxTokens=8192', task.id)
          await emitContextSizeReport({
            taskId: task.id,
            iteration,
            systemPrompt,
            messages,
            tools,
            memoryInjection,
            contextWindow: model?.contextWindow,
          })
          const retryResp = await withLlmTimeout(
            (sig) =>
              adapter.complete({
                system: systemPrompt,
                messages,
                tools,
                temperature: task.config.temperature ?? agent.defaultConfig.temperature ?? 0.5,
                maxTokens: 8192,
                signal: sig,
              }),
            120_000,
            signal,
          )
          if (retryResp.content || (retryResp.actions && retryResp.actions.length > 0)) {
            response = retryResp
          } else {
            const placeholder = '模型思考时间过长，未产出有效内容，请重试或更换模型'
            response = { ...response, content: placeholder, thought: placeholder }
          }
        }
      } catch (err) {
        // v0.15.0 Task 2 SubTask 2.5 Layer 3 Reactive Fallback：
        // context 超限类错误 → 激进压缩（保留更少轮次）后重试一次，避免任务直接失败
        if (isContextOverflowError(err)) {
          logger.warn('Agent', `context overflow — aggressive compact + retry once: ${(err as Error).message}`, task.id)
          try {
            const result = await compressMemory(task.id, {
              keepSystem: true,
              keepRecentTurns: 1, // 激进：只保留最近 1 轮
              keepUserTurns: true,
              keepFileRefs: false,
              dropFailed: true,
            })
            await emitEvent(task.id, {
              type: 'context_compacted',
              iteration,
              layer: 3,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
              archivedCount: result.archivedIds.length,
            })
          } catch (compactErr) {
            logger.warn('Agent', `reactive compact failed (silent): ${(compactErr as Error).message}`, task.id)
          }
          // 压缩后重新组装 messages（compressMemory 已归档旧条目，L1 变小）
          messages = await assembleMessages(task, agent)
          await emitContextSizeReport({
            taskId: task.id,
            iteration,
            systemPrompt,
            messages,
            tools,
            memoryInjection,
            contextWindow: model?.contextWindow,
          })
          // 压缩后重试一次（直接单次调用，不再走 callLlmWithRetry 的多轮重试）
          response = await withLlmTimeout(
            (sig) =>
              adapter.complete({
                system: systemPrompt,
                messages,
                tools,
                temperature: task.config.temperature ?? agent.defaultConfig.temperature ?? 0.5,
                maxTokens: task.config.maxTokens,
                signal: sig,
              }),
            120_000,
            signal,
          )
        } else {
          // 非 context 超限错误 → 走原 catch (line 383)，转为 task_failed
          throw err
        }
      }

      const durationMs = Date.now() - startedAt

      // 写入 L1：assistant reasoning — content 只存纯文本，action 放 meta
      // polish4 §A2.1：assistant meta 含完整多 tool actions（含 toolCallIds）
      // 单一 tool 时直接平铺；多 tool 时 multi=true + actions[] 数组
      const rActions = response.actions ?? (response.action ? [response.action] : [])
      const rToolIds = response.toolCallIds ?? (response.toolCallId ? [response.toolCallId] : [])
      const reasoningMeta = rActions.length > 0
        ? JSON.stringify(rActions.length === 1
            ? {
                tool: rActions[0].tool,
                args: rActions[0].args,
                actionId: rToolIds[0] ?? `call_${iteration}_0`,
                toolCallId: rToolIds[0] ?? `call_${iteration}_0`,
              }
            : {
                multi: true,
                actions: rActions.map((a, i) => ({
                  tool: a.tool,
                  args: a.args,
                  actionId: rToolIds[i] ?? `call_${iteration}_${i}`,
                  toolCallId: rToolIds[i] ?? `call_${iteration}_${i}`,
                })),
              })
        : undefined
      const reasoningItem = await appendL1({
        taskId: task.id,
        role: 'assistant',
        kind: 'reasoning',
        content: response.thought,
        iteration,
        meta: reasoningMeta,
        // DeepSeek 思考模式的 reasoning_content，存入 raw 供下一轮传回
        raw: response.reasoningContent ? { reasoningContent: response.reasoningContent } : undefined,
      })

      const reasonStep: ReActStep = {
        id: genId('step'),
        taskId: task.id,
        iteration,
        type: 'reason',
        thought: response.thought,
        // v0.25.0 F4：阶段叙述（结论 + 下一步），与 thought 分离；缺省 → UI 回落旧版 hint
        say: response.say,
        action: response.action ?? undefined,
        startedAt,
        durationMs,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        cacheHitTokens: response.cache?.hitTokens,
        cacheMissTokens: response.cache?.missTokens,
        status: 'success',
      }
      broadcastStep(reasonStep)

      await emitEvent(task.id, {
        type: 'reason_end',
        iteration,
        thought: response.thought,
        say: response.say,
        action: response.action,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        cacheHitTokens: response.cache?.hitTokens,
        cacheMissTokens: response.cache?.missTokens,
        durationMs,
      })

      logger.info(
        'LLM',
        `POST /chat (${model?.name ?? opts.modelId}) ← ${response.tokensIn}+${response.tokensOut} tokens` +
          (response.cache ? ` (cache hit ${response.cache.hitTokens})` : '') +
          ` ⏱ ${durationMs}ms`,
        task.id,
      )

      // -------- 检查终止 --------
      // v0.14.x Task 1：以"是否确有工具调用"为准（collectActionsForIteration 会同时读
      // response.actions 与 response.action），防止适配器只回传 actions（未填 action 单
      // 字段）时把"还要继续跑"误判为最终答复 → 任务被提前置 done / 清单被提前勾完。
      const action = response.action
      const pendingActions = collectActionsForIteration(response)
      // v0.19.x：提前计算每个 action 对应的 toolCallId（与 Act 阶段口径一致），
      // 供 task_complete / ask_user 分支补写"跳过"observation。否则多 action 时
      // 只写控制动作的 observation，其余 assistant tool_calls 悬空，每轮触发
      // reconcileToolCalls "stripped dangling tool_calls"（并有 OpenAI 兼容端点 400 风险）。
      const pendingActionIds: string[] =
        response.toolCallIds && response.toolCallIds.length === pendingActions.length
          ? response.toolCallIds
          : pendingActions.map((_, i) => `call_${iteration}_${i}`)
      if (!action && pendingActions.length === 0) {
        // 模型未调用工具，认为是最终回复
        await emitEvent(task.id, {
          type: 'task_complete',
          iteration,
          summary: safeSlice(response.thought, 500),
        })
        await updateTask(task.id, { status: 'done', completedAt: Date.now() })
        broadcastTaskStatus({ ...task, status: 'done', completedAt: Date.now() })
        // Task 9：任务完成 → 推进进度到 100% + 标记「编码完成」里程碑
        await emitProgress({
          type: 'task_progress',
          taskId: task.id,
          currentStage: 'ops',
          stageIndex: 8,
          overallPercentage: 100,
          nextStepLabel: undefined,
        })
        await emitProgress({
          type: 'task_milestone',
          taskId: task.id,
          milestoneId: 'code-done',
          label: '编码完成',
          reachedAt: Date.now(),
        })
        // v0.8.0 F803/F804/F805：run done 归档 + 画像合成 + 蒸馏评估
        await runDoneMemoryHooks(task, agent, opts.modelId, response.thought)
        return
      }

      // v0.14.0 Task 4：action 可能为 null（模型返回多个 pendingActions 时走下方并行 Act），
      // 单工具分支用可选链兜底，避免 null 穿透
      if (action?.tool === 'task_complete') {
        // v0.14.0 修复：task_complete 由模型以 tool_calls 形式触发，但本分支直接完成
        // 不执行工具。若不补写配对的 tool observation，assistant 的 tool_calls 将悬空，
        // 下次 assembleMessages 重建消息时服务端会 400
        // "tool messages responding to each tool_call_id"。
        // v0.19.x：多 action 时（如 [task_complete, file-writer]）为每个 action 补写配对
        // observation，非控制动作写"跳过"，避免 reconcileToolCalls 剥离悬空 tool_calls。
        await appendPairedControlObservations({
          taskId: task.id,
          iteration,
          actions: pendingActions,
          actionIds: pendingActionIds,
          controlTool: 'task_complete',
          controlContent: '[task_complete] 任务已完成',
          skipPrefix: '[skipped] 任务已完成，跳过：',
        })
        await emitEvent(task.id, {
          type: 'task_complete',
          iteration,
          summary: (action.args.summary as string) ?? safeSlice(response.thought, 500),
          // v0.15.0 Task 7：透传 Agent 附带的建议（由 LLM 真实生成，不再前端硬编码映射）
          suggestions: Array.isArray(action.args.suggestions)
            ? (action.args.suggestions as Array<{ label: string; description?: string; recommended?: boolean }>)
                .filter((s) => s && typeof s.label === 'string')
                .slice(0, 4)
            : undefined,
        })
        await updateTask(task.id, { status: 'done', completedAt: Date.now() })
        broadcastTaskStatus({ ...task, status: 'done', completedAt: Date.now() })
        // Task 9：task_complete 工具分支同样推进到完成态
        await emitProgress({
          type: 'task_progress',
          taskId: task.id,
          currentStage: 'ops',
          stageIndex: 8,
          overallPercentage: 100,
          nextStepLabel: undefined,
        })
        await emitProgress({
          type: 'task_milestone',
          taskId: task.id,
          milestoneId: 'code-done',
          label: '编码完成',
          reachedAt: Date.now(),
        })
        // v0.8.0 F803/F804/F805：run done 归档 + 画像合成 + 蒸馏评估
        await runDoneMemoryHooks(task, agent, opts.modelId, response.thought)
        return
      }

      if (action?.tool === 'ask_user') {
        // v0.18.x fix：放宽校验 — 只强制 question 有效，suggestions 不再硬性要求 2~4 个。
        // 此前「suggestions < 2 即拒绝重试」会让 LLM 在「参数解析持续失败」里空转，
        // 进而跳过门禁、继续编码，甚至因后续参数截断导致整个任务中断。
        // 现在：suggestions 不足时注入兜底选项，仍保留「门禁 + 选择」体验，但不再触发重试循环。
        const rawQuestion = action.args.question
        const rawSuggestions = action.args.suggestions
        const validatedSuggestions = Array.isArray(rawSuggestions)
          ? (rawSuggestions as Array<{ label?: unknown; description?: unknown; recommended?: unknown }>)
              .filter((s) => s && typeof s.label === 'string' && (s.label as string).trim().length > 0)
              .slice(0, 4)
              .map((s) => ({
                label: String(s.label),
                description: typeof s.description === 'string' ? s.description : undefined,
                recommended: s.recommended === true,
              }))
          : []
        const tcId = response.toolCallId ?? `call_${iteration}_0`
        const invalidAskUser =
          typeof rawQuestion !== 'string' ||
          rawQuestion.trim().length === 0
        if (invalidAskUser) {
          const reason = 'ask_user.question 缺失或为空字符串'
          logger.warn('Agent', `ask_user rejected: ${reason} — 重试`, task.id)
          // 1) 写入 L1 observation，触发下一轮 Reason 重试（多 action 时其余写"跳过"）
          await appendPairedControlObservations({
            taskId: task.id,
            iteration,
            actions: pendingActions,
            actionIds: pendingActionIds,
            controlTool: 'ask_user',
            controlContent: `[ask_user] failed: ${reason}。ask_user 必须给出非空 question。请立即重试调用 ask_user 并补全 question。`,
            skipPrefix: `[skipped] ask_user 参数不合规，跳过：`,
          })
          // 2) 广播 act_end 失败事件，让 UI 看到错误（不影响 UI 主体渲染）
          await emitEvent(task.id, {
            type: 'act_end',
            iteration,
            result: { error: reason },
            resultSummary: `ask_user 参数不合规：${reason}`,
            durationMs: 0,
            ok: false,
            errorMessage: reason,
          })
          // 3) 写一条失败的 ReActStep（供 Steps UI 可见）
          const failedStep: ReActStep = {
            id: tcId,
            taskId: task.id,
            iteration,
            type: 'act',
            toolName: 'ask_user',
            toolArgs: JSON.stringify(action.args ?? {}),
            startedAt: Date.now(),
            durationMs: 0,
            status: 'failed',
            resultSummary: `ask_user 参数不合规：${reason}`,
            errorMessage: reason,
            softFail: true,
          }
          await broadcastStep(failedStep)
          // 不暂停任务，继续下一轮 Reason
          continue
        }
        // v0.18.x：suggestions 不足 2 个时注入兜底选项，避免前端拿不到建议卡
        const finalSuggestions =
          validatedSuggestions.length >= 2
            ? validatedSuggestions
            : [
                ...validatedSuggestions,
                { label: '继续', description: '保持当前方向继续执行' },
                { label: '暂停', description: '先暂停，我来说明补充信息' },
              ].slice(0, 2)
        // v0.14.0 修复：与 task_complete 同理，补写配对 tool observation，
        // 避免 assistant tool_calls 悬空导致后续交互 400。
        // v0.19.x：多 action 时为每个 action 补写配对 observation。
        await appendPairedControlObservations({
          taskId: task.id,
          iteration,
          actions: pendingActions,
          actionIds: pendingActionIds,
          controlTool: 'ask_user',
          controlContent: '[ask_user] 已向用户提问，等待用户回复',
          skipPrefix: '[skipped] 已暂停等待用户，跳过：',
        })
        await emitEvent(task.id, {
          type: 'ask_user',
          iteration,
          question: rawQuestion as string,
          // 透传 Agent 附带的建议选项（不足时已兜底为 2 项）
          suggestions: finalSuggestions,
        })
        // v0.19.0 M3：停止候选——先给监听器注入 continuation 的机会，注入则同轮继续
        if (await continueTurnIfInjected(task, iteration)) continue
        await updateTask(task.id, { status: 'paused' })
        broadcastTaskStatus({ ...task, status: 'paused' })
        return
      }

      // -------- Act --------
      // v0.14.0 Task 4：同一轮 Reason 可能返回多个无依赖工具调用；
      // 我们按"工具维度"并行执行，但每条 act 仍写入独立 ReActStep 并
      // 通过单一 `task:progress` 通道聚合回流，保证 UI 不漂移。
      const actStartedAt = Date.now()
      const actions = collectActionsForIteration(response)
      const groupId = genId('group')
      // polish4 §A2 + §D1.1 + §D1.2：每个 action 独立 id，并入 toolCallBudget
      // actionIds 优先采用 response.toolCallIds（adapter 已收集的真实 id），
      // 退化用 `call_${iteration}_${i}`。
      const actionIds: string[] = (response.toolCallIds && response.toolCallIds.length === actions.length)
        ? response.toolCallIds
        : actions.map((_, i) => `call_${iteration}_${i}`)
      // 工具预算检查：达上限不硬中断，改为软警告 + 跳过执行
      // Phase A Task 1：UI 层静默化 —— 不再弹 toast，仅写 L2/L3 日志；同调用签名仅首次记录
      const exhaustedIndices = new Set<number>()
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const signatureKey = getToolCallKey(a.tool, a.args)
        const categoryLimit = getToolCategoryLimit(a.tool)
        const signaturePrev = toolSignatureBudget.get(signatureKey) ?? 0
        const categoryPrev = toolCategoryBudget.get(a.tool) ?? 0

        // 两层预算：调用签名（防同参数反复执行）+ 工具类别（防整体过度使用）
        const signatureExhausted = signaturePrev >= MAX_PER_SIGNATURE
        const categoryExhausted = categoryPrev >= categoryLimit
        // v0.19.x：同参数重复调用被拦截 → 计入重点关注统计（供达限询问时向用户披露）
        if (signatureExhausted) signatureBlockedTotal += 1
        // v0.19.x：类别预算触顶（200）→ 任务可能执行过长/已卡住，中断询问用户是否继续。
        // 复用 ask_user 交互：暂停任务并弹出问题卡，用户回复后作为新 run 继续。
        if (categoryExhausted && !budgetInterrupted) {
          budgetInterrupted = true
          const repeatHint = signatureBlockedTotal > 0
            ? `（重点关注：已拦截同参数重复调用 ${signatureBlockedTotal} 次，存在循环嫌疑）`
            : ''
          const question = `工具「${a.tool}」调用已达 ${categoryLimit} 次上限，任务执行时间可能过长或已陷入循环${repeatHint}。是否继续执行？`
          logger.warn('Agent', `tool budget interrupt: ${a.tool} (${categoryPrev}/${categoryLimit}) — ask user`, task.id)
          await emitEvent(task.id, {
            type: 'ask_user',
            iteration,
            question,
            suggestions: [
              { label: '继续执行', description: '重置调用计数并继续当前任务', recommended: true },
              { label: '停止任务', description: '结束当前任务，稍后重新规划' },
            ],
          })
          await updateTask(task.id, { status: 'paused' })
          broadcastTaskStatus({ ...task, status: 'paused' })
          return
        }
        if (signatureExhausted || categoryExhausted) {
          exhaustedIndices.add(i)
          if (!budgetWarnedKeys.has(signatureKey)) {
            budgetWarnedKeys.add(signatureKey)
            const reason = signatureExhausted
              ? `same signature (${signaturePrev}/${MAX_PER_SIGNATURE})`
              : `tool category (${categoryPrev}/${categoryLimit})`
            logger.warn(
              'Agent',
              `tool budget exceeded: ${a.tool} (${reason}) — soft warn, skip execution`,
              task.id,
            )
          }
        } else {
          if (categoryPrev >= categoryLimit - 2) {
            pendingSystemHint = `${a.tool} 已调用 ${categoryPrev + 1}/${categoryLimit} 次，即将达限。请考虑切换替代方法或收敛任务。`
            logger.info('Agent', `tool budget warning: ${a.tool} (${categoryPrev}/${categoryLimit})`, task.id)
          }
          // v0.19.1 fix：仅在「实际执行」时递增预算计数，达限即停；
          // 此前对已耗尽工具仍无条件递增，导致计数越过上限一路涨到 33/32、36/32。
          toolSignatureBudget.set(signatureKey, signaturePrev + 1)
          toolCategoryBudget.set(a.tool, categoryPrev + 1)
        }
      }

      // 本轮所有 action 均被跳过
      if (exhaustedIndices.size === actions.length && actions.length > 0) {
        consecutiveSkippedIterations += 1
        // 连续 3 轮所有请求都被跳过 → 判定为无法继续，避免模型反复尝试已耗尽签名空转
        if (consecutiveSkippedIterations >= 3) {
          logger.warn('Agent', 'all tools exhausted for 3 consecutive iterations — fail task', task.id)
          await emitEvent(task.id, {
            type: 'task_failed',
            iteration,
            error: '所有工具均已达到调用上限，无法继续执行',
          })
          await markRunningPlanItemFailed(task)
          await updateTask(task.id, { status: 'failed' })
          broadcastTaskStatus({ ...task, status: 'failed' })
          await runDoneMemoryHooks(task, agent, opts.modelId, '')
          return
        }
        // 部分工具达上限但还有其他可用工具 → 注入强提示
        pendingSystemHint = `本次请求的工具（${actions.map((a) => a.tool).join(', ')}）均已达到调用上限。请改用其他可用工具，或基于已有信息推理完成任务。`
      } else {
        consecutiveSkippedIterations = 0
      }
      const actSteps: ReActStep[] = actions.map((a) => ({
        id: genId('step'),
        taskId: task.id,
        iteration,
        type: 'act',
        toolName: a.tool,
        toolArgs: JSON.stringify(a.args, null, 2),
        // v0.21.0：人类可读动作意图（如「执行命令：npm test」），交互区每个操作展示简介
        intent: describeAction(a.tool, a.args),
        startedAt: actStartedAt,
        durationMs: 0,
        status: 'running',
      }))

      // 先广播 act_start + 进度 running（让 UI 立即看到该轮的全部并行工具）
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const step = actSteps[i]
        await emitEvent(task.id, { type: 'act_start', iteration, tool: a.tool, args: a.args })
        broadcastToolProgress({
          taskId: task.id,
          groupId,
          requestId: step.id,
          tool: a.tool,
          status: 'running',
          startedAt: actStartedAt,
        })
      }

      // 并行执行所有 act 调用；已耗尽预算的工具跳过执行，返回合成结果
      const actCtx: ActContext = { task, agent, signal, coreSkillsEnabled, allowedStage, iteration }
      const actResults = await Promise.all(
        actions.map((a, i) => {
          if (exhaustedIndices.has(i)) {
            const toolName = a.tool
            const signatureKey = getToolCallKey(toolName, a.args)
            const signaturePrev = toolSignatureBudget.get(signatureKey) ?? 0
            const categoryPrev = toolCategoryBudget.get(toolName) ?? 0
            const categoryLimit = getToolCategoryLimit(toolName)
            const reason = signaturePrev >= MAX_PER_SIGNATURE
              ? `同参数调用已达上限（${signaturePrev}/${MAX_PER_SIGNATURE}）`
              : `工具类别调用已达上限（${categoryPrev}/${categoryLimit}）`
            const msg = `${toolName} ${reason}，请改用替代方法`
            return Promise.resolve<ActExecutionResult>({
              completedStep: {
                ...actSteps[i],
                status: 'failed',
                result: { error: msg },
                resultSummary: msg,
                durationMs: 0,
                errorMessage: msg,
                // v0.19.x：预算拦截是引擎主动行为而非工具报错，标 softFail（前端橙色警告态）
                softFail: true,
              },
              result: { error: msg },
              resultSummary: msg,
              durationMs: 0,
              ok: false,
              errorMessage: msg,
            })
          }
          return executeAct(a, actSteps[i], actCtx)
        }),
      )

      // v0.6.0：捕获任意一个 act 注入的渐进式披露 hint，下一轮 Reason 合并到 system prompt
      for (const r of actResults) {
        if (r.additionalSystemHint) pendingSystemHint = r.additionalSystemHint
      }

      let lastObservationSummary = ''
      // v0.16.x：阶段门禁信号 — 本轮迭代触发了文档驱动开发门禁（写完 PRD / 交互 / 原型 /
      // 系统设计等）。引擎强制暂停任务并自动 ask_user，避免 LLM 写完不询问直接跳下一阶段。
      let stageGateHit: import('../skills/builtin/react-core-skills/stage-gates.js').StageGate | null = null
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i]
        const step = actSteps[i]
        const r = actResults[i]
        broadcastStep(r.completedStep)
        broadcastToolProgress(toFinishedProgress(r.completedStep, groupId))
        await emitEvent(task.id, {
          type: 'act_end',
          iteration,
          result: r.result,
          resultSummary: r.resultSummary,
          durationMs: r.durationMs,
          ok: r.ok,
          errorMessage: r.errorMessage,
          // v0.19.x：透传软失败标记（门禁/预算拦截），前端日志按 WARN（橙）而非 ERROR（红）
          softFail: (r.completedStep as ReActStep).softFail === true,
        })
        // Task 9：每个 act 完成 → 同步回流到进度摘要（按工具名推断阶段）
        // 编码类工具：shell / file-reader / delegate-agent → 'code'
        // 调研类工具：web-search / fetch-url → 'research'
        // 其余通用 → 'code'（保守归类）
        const stage = ((): 'research' | 'code' | 'test' => {
          const t = a.tool
          if (t === 'web-search' || t === 'fetch-url' || t === 'session-search') return 'research'
          if (t === 'shell' || t === 'file-reader' || t === 'delegate-agent') return 'code'
          return 'code'
        })()
        await emitProgress({
          type: 'task_step_complete',
          taskId: task.id,
          stepId: step.id,
          label: `${a.tool}: ${safeSlice(r.resultSummary, 60) || a.tool}`,
          stage,
          ok: r.ok,
          durationMs: r.durationMs,
        })
        // 每个 act 写一条 observation
        const observationSummary = buildObservationSummary(a.tool, r.result, r.resultSummary, r.ok)
        await appendL1({
          taskId: task.id,
          role: 'tool',
          kind: 'observation',
          content: observationSummary,
          iteration,
          // polish4 §A2.2：meta 含 toolCallId（=actionId），用于 assembleMessages 精确配对
          meta: JSON.stringify({
            tool: a.tool,
            toolCallId: actionIds[i],
            actionId: actionIds[i],
          }),
        })
        lastObservationSummary = observationSummary

        // v0.16.x：react-core-skills 阶段门禁识别 —
        // file-writer 写出阶段产物文档（00-opensource-research.md / 01-prd.md /
        // 02-interaction.md / prototype/*.html / 03-system-design.md）后，
        // 推 task_progress 推进 ProgressPanel 阶段 + 推 task_milestone +
        // 标记本轮必须 ask_user 暂停（取最高阶段，避免一次写多文件匹配到低阶段）
        if (r.ok && a.tool === 'file-writer') {
          const filePath = (r.result as { path?: string } | undefined)?.path
          if (filePath) {
            const gate = matchStageGate(filePath)
            if (gate) {
              const { isCoreSkillsEnabled } = await import(
                '../skills/builtin/react-core-skills/stage-gates.js'
              )
              if (isCoreSkillsEnabled(task, agent)) {
                if (!stageGateHit || gate.stageIndex > stageGateHit.stageIndex) {
                  stageGateHit = gate
                }
              }
            }
          }
        }
      }
      // 兼容原单 act 事件：最后一组（无并行/单 act 时）通过 observation 事件告知
      await emitEvent(task.id, {
        type: 'observation',
        iteration,
        summary: lastObservationSummary,
      })
      // 该 group 全部完成 → 清理进度聚合（避免 UI 上遗留 running）
      clearToolProgress(task.id, groupId)

      // v0.17.5：计划项完成检测改为「阶段门禁驱动」。
      // 此前 v0.17.3 的激进方案是「本轮 act 全部成功 → running 项标 done」，
      // 导致 file-reader 列个目录、shell ls 都被当作完成一步，清单与实际进度
      // 严重脱节（调研阶段就跳到"设计关卡布局"）。
      // 现在改为：只有阶段门禁（产物文档真正写完）触发时才标 done，
      // 对齐 TraeWork「tasks.md 状态随产物落地自动更新」的做法。

      // v0.16.x：阶段门禁 — 写完产物后立即推 task_progress + milestone，并
      // 自动 ask_user + 暂停任务（强制门禁）。修复「写完文档没询问直接开始」。
      if (stageGateHit) {
        const gate = stageGateHit
        logger.info(
          'Agent',
          `react-core-skills 阶段门禁触发：${describeGateForLog(gate)}`,
          task.id,
        )
        // v0.17.5：把对应阶段的 planItem 标 done，下一个标 running（清单↔阶段产物对齐）
        if (task.planItems && task.planItems.length > 0) {
          const doneIdx = findPlanItemForStage(task.planItems, gate.stage)
          if (doneIdx >= 0) {
            task.planItems[doneIdx].status = 'done'
            task.planItems[doneIdx].completedAt = Date.now()
            task.planItems[doneIdx].updatedAt = Date.now()
            if (doneIdx + 1 < task.planItems.length && task.planItems[doneIdx + 1].status === 'pending') {
              task.planItems[doneIdx + 1].status = 'running'
              task.planItems[doneIdx + 1].updatedAt = Date.now()
            }
            await updateTask(task.id, { planItems: task.planItems })
          }
        }
        // 1) 推进 ProgressPanel 阶段显示
        await emitProgress({
          type: 'task_progress',
          taskId: task.id,
          currentStage: gate.stage,
          stageIndex: gate.stageIndex,
          overallPercentage: Math.round(((gate.stageIndex + 1) / 9) * 100),
          nextStepLabel: '等待用户确认门禁',
        })
        // 2) 标记里程碑到达（带产物路径）
        await emitProgress({
          type: 'task_milestone',
          taskId: task.id,
          milestoneId: gate.milestoneId,
          label: gate.label,
          reachedAt: Date.now(),
        })
        // 3) 写 L1 user 消息让 LLM 在下一轮 Reason 知道必须通过门禁。
        //    注意：不能写成 role:'tool' 的 observation —— 引擎自动 ask_user
        //    并非 LLM 发起的 tool_call，写成 tool observation 会变成无配对
        //    toolCallId 的孤立 tool 消息，导致 OpenAI 兼容端点 400 (2013)
        //    "tool result's tool id not found"。
        await appendL1({
          taskId: task.id,
          role: 'user',
          kind: 'user_message',
          content: buildGateBlockObservation(gate),
          iteration,
        })
        // 4) 同步广播 ask_user 事件并暂停任务（无需等 LLM 主动 ask_user，
        //    引擎直接推送 + 暂停）。LLM 下一轮 Reason 看到 user 消息会继续执行。
        await emitEvent(task.id, {
          type: 'ask_user',
          iteration,
          question: gate.question,
          suggestions: gate.suggestions,
        })
        // v0.19.0 M3：停止候选——先给监听器注入 continuation 的机会，注入则同轮继续
        if (await continueTurnIfInjected(task, iteration)) continue
        await updateTask(task.id, { status: 'paused' })
        broadcastTaskStatus({ ...task, status: 'paused' })
        return
      }

      // v0.9.x：只读停滞检测 — 连续 N 轮仅做只读探索（未开始产出）→ 注入产出提示。
      // 设置于本迭代 Act 之后：pendingSystemHint 会在下一迭代 Reason 构建
      // systemPrompt（parts.push）时注入并在随后清零，符合"上一迭代设置 → 下一迭代注入"。
      // 无工具调用（最终回复）已在终止检查处 return，不会进入此处，计数保持不变。
      const anyWrite = actions.some((a) =>
        a.tool === 'shell'
          ? WRITE_COMMAND_RE.test(String((a.args as Record<string, unknown>)?.command ?? ''))
          : a.tool === 'task_complete' || a.tool === 'ask_user' || a.tool === 'delegate-agent',
      )
      if (anyWrite) {
        consecutiveReadOnly = 0
      } else if (actions.length > 0 && actions.every((a) => READONLY_TOOLS.has(a.tool))) {
        consecutiveReadOnly += 1
        if (consecutiveReadOnly >= 3) {
          logger.debug(
            'Agent',
            `stalled: ${consecutiveReadOnly} consecutive read-only rounds — injecting produce hint`,
            task.id,
          )
          pendingSystemHint = `你已经连续探索 ${consecutiveReadOnly} 轮仍未开始产出。若工作区为空或与任务无关，请立即用 shell mkdir 创建项目目录并开始实现；若已有足够信息，直接开始执行。`
          consecutiveReadOnly = 0  // 避免下一轮重复注入
        }
      }

      // v0.6.0（F12）：异步写 checkpoint（fire-and-forget，不阻塞主循环）
      saveCheckpoint({
        id: checkpointId(task.id, iteration),
        taskId: task.id,
        iteration,
        agentId: agent.id,
        memorySnapshot: '',  // L1 已落盘，恢复时从 listEnabledL1 重建，无需冗余快照
        taskStatus: 'running',
        timestamp: Date.now(),
        parentCheckpointId: task.parentTaskId ?? undefined,
      })

      // v0.8.0 F801：token 阈值自动压缩（本轮完成后，不打断运行）
      await maybeAutoCompress(task.id, iteration)

      // 中断检查
      if (signal.aborted) {
        await handleAbort(task, iteration, stale)
        return
      }
    }

    // 超过迭代上限（v0.23.2：不再硬报错中断，改为优雅暂停 + ask_user 引导续跑）。
    // 旧逻辑直接置 failed → 前端进入错误态，用户被迫重开任务；现改为 paused +
    // 选项卡，用户可"继续运行"（appendMessage 自动续跑，迭代计数从 L1 继续）
    // 或"就此结束"（作为 user 消息传给 LLM，走 task_complete 正常收尾）。
    await emitEvent(task.id, { type: 'max_iterations_reached', iteration })
    await emitEvent(task.id, {
      type: 'ask_user',
      iteration,
      question: `已达到单次运行迭代上限（${maxIter} 轮），任务尚未标记完成。进度已保留，可以继续运行或就此结束。`,
      suggestions: [
        { label: '继续运行', description: '从中断处继续执行任务' },
        { label: '就此结束', description: '保留当前进度并收尾' },
      ],
    })
    await updateTask(task.id, { status: 'paused' })
    broadcastTaskStatus({ ...task, status: 'paused' })
    logger.warn('Agent', `max iterations reached for ${task.id} — paused for user decision`, task.id)
  } catch (err) {
    // v0.8.1：AbortError 属于用户主动中断（Esc/停止/暂停/取消），
    // 不是真正的失败——交给 handleAbort 统一处理 paused/cancelled，
    // 绝不再写 failed，否则会覆盖 cancelTask 已写好的 cancelled，
    // 且前端 Composer 会进入"错误态"RunConsole（无输入框）导致用户无法继续交互。
    if (signal.aborted || (err as Error)?.name === 'AbortError') {
      await handleAbort(task, 0, stale)
      return
    }
    const message = (err as Error).message
    logger.error('Agent', `ReAct loop failed: ${message}`, task.id)
    await emitEvent(task.id, { type: 'task_failed', iteration: 0, error: message })
    await markRunningPlanItemFailed(task)
    await updateTask(task.id, { status: 'failed' })
    broadcastTaskStatus({ ...task, status: 'failed' })
    // v0.9.1 §Task 7：失败路径也尝试归档 L1，让失败的经验也能进入 L3b/L4a
    try {
      await runDoneMemoryHooks(task, agent, opts.modelId, '')
    } catch (hookErr) {
      logger.warn('Memory', `runDoneMemoryHooks on failed path errored: ${(hookErr as Error).message}`, task.id)
    }
  }
}

/**
 * v0.8.1：统一处理用户中断（Esc/停止/暂停/取消）。
 * - 若运行已被新一次 runTask 接管（stale 返回 true）：静默退出，不动任务状态。
 * - 若当前 DB 状态已是 cancelled：保留 cancelled（cancelTask 已写）。
 * - 否则按 paused 处理（Esc/暂停场景）。
 */
async function handleAbort(
  task: Task,
  iteration: number,
  stale?: () => boolean,
): Promise<void> {
  if (stale?.()) return
  const current = await getTask(task.id)
  if (current?.status === 'cancelled') {
    await emitEvent(task.id, { type: 'task_paused', iteration })
    await discardIncompletePlanItems(current ?? task, '任务已取消，未完成清单项丢弃')
    return
  }
  await emitEvent(task.id, { type: 'task_paused', iteration })
  await updateTask(task.id, { status: 'paused' })
  await discardIncompletePlanItems(current ?? task, '任务已暂停，未完成清单项丢弃')
  broadcastTaskStatus({ ...task, status: 'paused' })
}

/**
 * v0.18.x fix：任务级失败时，把当前 running（无则首个 pending）的清单项标 failed，
 * 让清单与真实执行进度一致 —— 此前任务失败（超迭代 / ReAct 崩溃）时清单纹丝不动，
 * 用户看不到任何失败反馈。
 */
async function markRunningPlanItemFailed(task: Task): Promise<void> {
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
async function discardIncompletePlanItems(task: Task, reason: string): Promise<void> {
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

async function emitEvent(taskId: string, event: ReActEvent): Promise<void> {
  // 通过 IPC 推送给 renderer
  try {
    const { broadcast } = await import('../window.js')
    broadcast('task:event', event)
  } catch (err) {
    // v0.15.x Task 4：广播失败不得打断引擎主流程 —— 仅记 warn 后静默返回。
    // 若 broadcast 抛错（例如窗口已销毁、IPC 通道断开），不能让 ReAct 循环
    // 因一个事件推送失败而直接失败。
    logger.warn('Agent', `emitEvent broadcast failed (silent): ${(err as Error).message}`, event.type)
  }
  // v0.19.0 M2：事件流同时落盘 session.jsonl（唯一真源，先双轨 —— 日志为真源，
  // L1 仍作为索引缓存）。落盘失败同样静默降级，不打断引擎主流程。
  try {
    await appendSessionEvent(taskId, event)
  } catch (err) {
    logger.warn('Agent', `emitEvent session-log failed (silent): ${(err as Error).message}`, event.type)
  }
}

/**
 * v0.19.0 M3：停止候选处判断是否注入 continuation 让同轮继续。
 * 触发 stop-hook 监听器 → 若注入 continuation，则写为 L1 user 消息并返回 true
 * （调用方 `continue` 进入下一 step）；否则返回 false（调用方按原路径暂停/结束）。
 * 副作用：可能写 L1；清空收件箱 pending continuation。
 */
async function continueTurnIfInjected(task: Task, iteration: number): Promise<boolean> {
  emitTurnStopping(task.id, { task })
  const continuations = drainContinuations(task.id)
  if (continuations.length === 0) return false
  for (const c of continuations) {
    await appendL1({
      taskId: task.id,
      role: 'user',
      kind: 'user_message',
      content: c,
      iteration,
    })
  }
  return true
}

/**
 * Task 9：侧边栏进度摘要事件发射（轻量包装，避免 import cycle）。
 * - task_progress：阶段级（currentStage / overallPercentage / nextStepLabel）
 * - task_step_complete：SubTask 完成（按 stage 归类）
 * - task_milestone：里程碑节点到达
 */
async function emitProgress(
  event:
    | { type: 'task_progress'; taskId: string; currentStage: string; stageIndex: number; overallPercentage: number; nextStepId?: string; nextStepLabel?: string }
    | { type: 'task_step_complete'; taskId: string; stepId: string; label: string; stage: string; ok: boolean; durationMs: number }
    | { type: 'task_milestone'; taskId: string; milestoneId: string; label: string; reachedAt: number; artifactPath?: string },
): Promise<void> {
  try {
    const { broadcast } = await import('../window.js')
    broadcast('task:event', event as ReActEvent)
  } catch (err) {
    logger.warn('Agent', `emitProgress failed: ${(err as Error).message}`, event.taskId)
  }
}

/** v0.15.x：在每次 LLM 调用前报告真实 payload token 用量（system + messages + tools + memory injection） */
async function emitContextSizeReport(opts: {
  taskId: string
  iteration: number
  systemPrompt: string
  messages: LlmMessage[]
  tools: LlmTool[] | undefined
  memoryInjection?: string
  contextWindow?: number
}): Promise<void> {
  const { total, breakdown } = estimatePayloadTokensDetailed({
    system: opts.systemPrompt,
    messages: opts.messages,
    tools: opts.tools,
  })
  // systemPrompt 已内嵌 memoryInjection（engine 拼接 parts 时 push 进 system），
  // 分项展示时从 systemTokens 中扣除 memoryInjectionTokens，避免 UI 双重计数。
  const memTokens = opts.memoryInjection ? estimateTextTokens(opts.memoryInjection) : undefined
  await emitEvent(opts.taskId, {
    type: 'context_size_report',
    taskId: opts.taskId,
    iteration: opts.iteration,
    payloadTokens: total,
    budget: contextBudget(opts.contextWindow),
    systemTokens: breakdown.systemTokens - (memTokens ?? 0),
    messagesTokens: breakdown.messagesTokens,
    toolsTokens: breakdown.toolsTokens,
    memoryInjectionTokens: memTokens,
    modelContextWindow: opts.contextWindow ?? 64000,
  })
}

/**
 * v0.15.x：按需计算某任务的真实 payload 估算（system + messages + tools + memory injection）。
 * 与 emitContextSizeReport 同口径，但不触发压缩副作用（skipPrecallCompact），
 * 供上下文面板/输入框在非运行态（空闲、完成、切换任务）也如实展示真实用量。
 * @returns null 表示任务不存在或估算失败（调用方回落 L1 累加）
 */
export async function estimateTaskContext(taskId: string): Promise<{
  taskId: string
  payloadTokens: number
  budget: number
  breakdown: {
    systemTokens: number
    messagesTokens: number
    toolsTokens: number
    memoryInjectionTokens?: number
  }
  modelContextWindow: number
} | null> {
  try {
    const task = await getTask(taskId)
    if (!task) return null
    const agent = await getAgent(task.agentId)
    if (!agent) return null
    const model = await getModel(task.modelId)

    // 与 runReActLoop 相同拼装：personality + wsHint + memoryInjection
    let memoryInjection = ''
    try {
      memoryInjection = await buildMemoryInjection(agent, task)
    } catch { /* 注入失败按空处理 */ }
    const systemPrompt = renderSystemPrompt(
      buildSystemSections({ agent, workspaceDir: getWorkspaceDir(), memoryInjection }),
    )

    const messages = await assembleMessages(task, agent, { skipPrecallCompact: true })
    const tools = await assembleTools(agent, task)
    const { total, breakdown } = estimatePayloadTokensDetailed({
      system: systemPrompt,
      messages,
      tools,
    })
    const memTokens = memoryInjection ? estimateTextTokens(memoryInjection) : undefined
    return {
      taskId,
      payloadTokens: total,
      budget: contextBudget(model?.contextWindow),
      breakdown: {
        systemTokens: breakdown.systemTokens - (memTokens ?? 0),
        messagesTokens: breakdown.messagesTokens,
        toolsTokens: breakdown.toolsTokens,
        memoryInjectionTokens: memTokens,
      },
      modelContextWindow: model?.contextWindow ?? 64000,
    }
  } catch (err) {
    logger.warn('Agent', `estimateTaskContext failed: ${(err as Error).message}`, taskId)
    return null
  }
}

/**
 * Task 6：按分类计算上下文占比明细（system / files / tools / messages / mcp / skills / other）。
 * 与 estimateTaskContext 同口径装配 system / messages / tools / memoryInjection，
 * 再按分类拆分并附可下钻明细，供上下文侧边栏占比可视化使用。
 * 非运行态（空闲 / 完成 / 切换任务）也可如实展示。
 * @returns null 表示任务不存在或装配失败
 */
export async function getTaskContextBreakdown(taskId: string): Promise<ContextBreakdownResult | null> {
  try {
    const task = await getTask(taskId)
    if (!task) return null
    const agent = await getAgent(task.agentId)
    if (!agent) return null
    const model = await getModel(task.modelId)
    const budget = contextBudget(model?.contextWindow)

    // system prompt（不含记忆注入）：agent.systemPrompt + 人格段 + 工作区指令
    // v0.19.0 M1：同时保留有序 section，供上下文面板按段下钻展示。
    const systemSections = buildSystemSections({ agent, workspaceDir: getWorkspaceDir() })
    const systemPrompt = renderSystemPrompt(systemSections)

    // 记忆注入（策展记忆 / 用户画像 / 知识库状态行）
    let memoryInjection = ''
    try {
      memoryInjection = await buildMemoryInjection(agent, task)
    } catch {
      /* 注入失败按空处理 */
    }

    // 装配对话消息（与真实 payload 同口径，跳过 precall 压缩副作用）
    const messages = await assembleMessages(task, agent, { skipPrecallCompact: true })

    // L1 条目：file_ref 单独归类为「文件」
    const l1 = await listEnabledL1(task.id)
    const fileItems = l1.filter((m) => m.kind === 'file_ref')

    // 技能：合并 agent 默认 + 任务会话级，过滤已禁用（与 assembleTools 同口径）
    const skills = await listSkills()
    const mergedIds = [...new Set([...agent.defaultSkillIds, ...(task.skillIds || [])])]
    const available = skills.filter((s) => mergedIds.includes(s.id) && s.enabled !== false)
    const lockedSet = new Set(agent.defaultSkillIds)
    const toolEntries: ContextToolEntry[] = available.map((s) => ({
      skillId: s.id,
      skillName: s.name,
      source: s.source,
      tool: skillToLlmTool(s),
      isMcp: s.source === 'mcp',
      locked: lockedSet.has(s.id),
    }))

    // 技能 instruction.md 指令体（按需加载，仅 enabled 技能；与 invokeSkill 渐进式披露一致）
    const skillInstructions: ContextSkillInstruction[] = []
    for (const s of available) {
      if (!s.instructionMd) continue
      try {
        const content = await readFile(s.instructionMd, 'utf-8')
        skillInstructions.push({ skillId: s.id, skillName: s.name, content, locked: lockedSet.has(s.id) })
      } catch {
        /* 读取失败按无指令体处理 */
      }
    }

    const input: ContextBreakdownInput = {
      maxTokens: budget,
      systemPrompt,
      systemSections,
      memoryInjection,
      fileItems,
      messages,
      toolEntries,
      skillInstructions,
    }
    return computeContextBreakdown(input)
  } catch (err) {
    logger.warn('Agent', `getTaskContextBreakdown failed: ${(err as Error).message}`, taskId)
    return null
  }
}

/* ============================================================
 * v0.9.1 计划生成（TraeWork 式 Spec/Plan/对话三模式）
 * 用一次轻量 LLM 调用，先评估任务复杂度，再自主决定是否产出计划及粒度。
 * 生成失败（解析失败/超时/中断）或评估为对话级任务时返回 null，任务照常运行。
 * ============================================================ */
const PLAN_SYSTEM_PROMPT = `你是一个任务规划助手。你需要先评估用户请求的复杂度，再自主决定是否产出步骤清单：

**对话级（简单任务，不产出计划）**
- 适用：问答、查询、单文件小改、解释说明、代码片段补全、单一概念解释
- 判断依据：单文件改动、无架构决策、边界清晰、预估工作量小
- 输出：空数组 []（不得编造步骤凑数）

**Plan 级（中等任务，concise 计划）**
- 适用：功能开发、bugfix、模块重构、多文件改动但范围明确
- 判断依据：影响多个文件、有清晰范围但需分步推进、工作量适中
- 输出：3~6 个步骤，按执行顺序排列；每步一行、20 字以内的动宾短语，一行内说清"做什么"，不带解释和修饰

**Spec 级（复杂任务，分阶段详细计划）**
- 适用：系统级、跨多模块、架构改动、新项目搭建、技术选型
- 判断依据：跨多文件/多模块、需架构决策、边界待澄清、工作量大
- 输出：按"阶段"组织的详细计划，每阶段含子步骤；阶段标题前置"阶段 N："或"Phase N："，子步骤紧跟其后
- **关键约束（v0.17.5）**：
  - 阶段标题（"阶段 1：技术选型与架构设计"）只是分组标签，**不要作为可勾选清单项**——只列出该阶段下可验证的子步骤（如"调研 GitHub 热门项目并提炼玩法机制"）
  - 每个清单项必须包含具体动作动词（调研/写/实现/测试/打包/运行/...），描述"做什么"而不是"是什么阶段"
  - 子步骤应是单次或少数几次工具调用就能完成的可验证动作，不要过于宽泛

**通用要求**：
- 步骤必须基于对项目代码（文件、模块、调用关系）的分析，禁止使用通用模板或凭空想象
- 步骤之间相互独立、按执行顺序排列
- 每步一行短句（参考样式："整体验证：typecheck + npm test"、"electron-builder 打包 .app"），禁止长句、子句嵌套或多行描述
- 只输出 JSON 字符串数组，不要任何解释、前后缀或代码块标记
- **硬性格式约束（v0.24.1）**：最终回复必须只包含 JSON 数组本身（如 ["a","b"]），禁止 Markdown 代码块、禁止序号前缀（"1. "）、禁止任何正文说明。若你是思考型模型，思考过程只放在内部，不要把思考写进回复。
- 如果实在无法给出有效步骤，输出 []（空数组）即可

**示例输出（对话级）**：[]
**示例输出（Plan 级）**：["定位 auth middleware 文件并梳理流程", "在 session.ts 中修复 token 校验逻辑", "补全单元测试覆盖回归用例", "运行 typecheck 与 lint 确认无回归"]
**示例输出（Spec 级）**：["阶段 1：架构调研", "梳理现有模块依赖与边界", "输出 ADR 草案", "阶段 2：搭建脚手架", "初始化目录结构", "接入核心依赖", "阶段 3：实现核心能力", "实现 A 模块", "实现 B 模块", "阶段 4：联调与验收", "端到端测试", "文档与发布"]`

/**
 * v0.17.4：文档驱动开发专用计划 prompt。
 * 当 react-core-skills 启用时替换通用 PLAN_SYSTEM_PROMPT，强制计划项 1:1 对齐
 * 文档驱动开发阶段。解决「清单与执行内容不匹配」——旧 prompt 的 Spec 级示例
 * 用自建阶段（架构调研→搭建脚手架→…），与文档驱动开发阶段完全不对齐。
 */
const PLAN_SYSTEM_PROMPT_DOC_DRIVEN = `你是文档驱动开发的任务规划助手。请将用户请求拆解为按文档驱动开发阶段排列的计划清单。

**阶段清单（必须严格按此顺序，不得跳阶段、不得重命名阶段）**：
1. 开源调研：搜索 GitHub 等开源社区类似项目，评估借鉴/自研，产出 docs/v1.0/00-opensource-research.md
2. PRD：明确目标用户、核心问题、功能清单（P0/P1/P2），产出 docs/v1.0/01-prd.md
3. 交互文档：页面清单、主流程图、五态设计、设计 token，产出 docs/v1.0/02-interaction.md
4. HTML 原型：纯静态 HTML 交互原型（设计稿，非编码），产出 docs/v1.0/prototype/index.html
5. 系统设计：技术选型、架构分层、数据模型、接口契约，产出 docs/v1.0/03-system-design.md
6. 编码：按系统设计实现功能（此阶段才允许写 src/、package.json 等代码文件）
7. 功能测试：冒烟→详测→验收，产出 docs/v1.0/04-function-test-report.md
8. UI 测试：对照原型逐页验证，产出 docs/v1.0/05-ui-test-report.md
9. UX 校验：用户视角走查，产出 docs/v1.0/06-ux-review-report.md
10. 交付打包：构建产物 + 快速开始说明

**关键约束**：
- HTML 原型（阶段 4）是设计文档的一部分，不是编码。产出物是 docs/v1.0/prototype/*.html
- 阶段 1~5 都是文档/设计产出，禁止在此期间安排任何编码步骤（初始化项目、搭建 src、写代码）
- 编码步骤只能出现在阶段 6，测试步骤只能出现在阶段 7~9
- 每个清单项格式："阶段 N：xxx"，N 对应上方阶段编号；xxx 为 20 字以内动宾短语
- 小型功能允许合并阶段 1~5 为一份精简设计文档，但阶段顺序不变

**只输出 JSON 字符串数组，不要任何解释、前后缀或代码块标记**
- **硬性格式约束（v0.24.1）**：最终回复必须只包含 JSON 数组本身；禁止 Markdown 代码块、禁止序号前缀、禁止正文说明。思考型模型的思考过程只放内部。
- 每个清单项含动作动词（调研/编写/产出/编码/测试/打包…），不要纯阶段标题

**示例**：["阶段 1：调研开源项目并产出调研文档", "阶段 2：编写 PRD 与功能范围", "阶段 3：编写交互文档与设计 token", "阶段 4：产出 HTML 交互原型", "阶段 5：编写系统设计文档", "阶段 6：编码实现核心功能", "阶段 7：功能测试并产出报告", "阶段 8：UI 测试并产出报告", "阶段 9：执行 UX 校验", "阶段 10：打包交付"]`

/** v0.9.x：generatePlan 首次解析失败时的降级精简 prompt（强制 3~5 步紧凑清单） */
const PLAN_SYSTEM_PROMPT_RETRY = `你是一个任务规划助手。请将用户请求拆解为 3~5 个简短、可执行的步骤清单。
要求：
- 每步一行、20 字以内动宾短语，按执行顺序排列
- 步骤应针对具体任务（如涉及新项目，包含"创建项目目录""实现核心功能""测试运行"等实际步骤），禁止通用模板
- 只输出 JSON 字符串数组，不要任何解释、前后缀或代码块标记
- **硬性格式约束（v0.24.1）**：最终回复必须只包含 JSON 数组本身；思考型模型的思考过程只放内部，不要写进回复
示例输出：["创建项目目录并初始化结构", "实现核心功能", "编写测试并运行验证"]`

/**
 * v0.9.x：单次计划生成尝试（首次 + 降级重试共用）。
 * 解析失败（含 Spec 级长计划被 maxTokens 截断）时返回 null，由调用方决定是否降级重试。
 */
async function tryGeneratePlan(
  systemPrompt: string,
  maxTokens: number,
  temperature: number,
  task: Task,
  agent: Agent,
  modelId: string,
  signal: AbortSignal,
  extraSystemHint?: string,
): Promise<PlanContent | null> {
  const messages = await assembleMessages(task, agent, { excludePlanContext: true })
  const adapter = await getAdapter(modelId)
  const planModel = await getModel(modelId)
  // v0.17.x：计划生成同样注入 skill 准则，保证计划项与文档驱动开发阶段对齐
  const planSystemPrompt = extraSystemHint
    ? `${systemPrompt}\n\n---\n${extraSystemHint}`
    : systemPrompt
  await emitContextSizeReport({
    taskId: task.id,
    iteration: 0,
    systemPrompt: planSystemPrompt,
    messages,
    tools: undefined,
    contextWindow: planModel?.contextWindow,
  })
  // v0.15.0 Task 5：计划生成同样受 120s 超时保护（用户中止原样抛出，超时抛 LlmTimeoutError）
  const response = await withLlmTimeout(
    (sig) =>
      adapter.complete({
        system: planSystemPrompt,
        messages,
        temperature,
        maxTokens,
        signal: sig,
      }),
    120_000,
    signal,
  )
  const raw = response.thought || response.content
  logger.info('Agent', `plan LLM raw (maxTokens=${maxTokens}): ${safeSlice(String(raw ?? ''), 200)}`)
  const items = parsePlanItems(raw)
  if (!items || items.length === 0) {
    logger.debug('Agent', 'plan parse failed — items empty/null, will fall back')
    return null
  }
  logger.info('Agent', `plan parsed: ${items.length} items`)
  return {
    goal: safeSlice(task.input.text || '任务计划', 80),
    items: items.slice(0, 12),
    useResources: [],
    skipResources: [],
  }
}

async function generatePlan(
  task: Task,
  agent: Agent,
  modelId: string,
  signal: AbortSignal,
  extraSystemHint?: string,
  docDriven?: boolean,
): Promise<PlanContent | null> {
  // v0.17.4：react-core-skills 启用时，用文档驱动开发专用 prompt 替换通用 prompt。
  // v0.17.5：docDriven 由引擎层传入（已通过 getSkill 名称匹配），兜底 isCoreSkillsEnabled
  const useDocDriven = docDriven ?? isCoreSkillsEnabled(task, agent)
  const basePrompt = useDocDriven ? PLAN_SYSTEM_PROMPT_DOC_DRIVEN : PLAN_SYSTEM_PROMPT
  // 首次：完整 Spec/Plan/对话三模式 prompt。v0.9.x 由 maxTokens 400 提升至 1024，
  // 避免 Spec 级 12 步中文计划被截断导致 parsePlanItems 返回 null。
  const plan = await tryGeneratePlan(
    basePrompt,
    1024,
    0.3,
    task,
    agent,
    modelId,
    signal,
    extraSystemHint,
  )
  if (plan) return plan
  // v0.15.0：思考模型（deepseek-v4-flash 等）可能在 1024 输出预算内只完成思考
  // （finish=length、content 空、plan 解析失败）。此时加大输出预算重试一次；
  // 旧的 512 降级重试对思考模型只会更快耗尽预算，故放在最后兜底。
  const planBig = await tryGeneratePlan(
    basePrompt,
    4096,
    0.3,
    task,
    agent,
    modelId,
    signal,
    extraSystemHint,
  )
  if (planBig) return planBig
  // 降级重试：精简 3~5 步 prompt + 512 maxTokens + 0.2 temperature
  logger.debug('Agent', 'plan generation first pass failed — retrying with condensed prompt (512 tok, t=0.2)')
  return tryGeneratePlan(
    PLAN_SYSTEM_PROMPT_RETRY,
    512,
    0.2,
    task,
    agent,
    modelId,
    signal,
    extraSystemHint,
  )
}

/** 从 LLM 回复中解析步骤数组（容忍代码块围栏 / 前后缀文本，过滤噪声项） */
/**
 * v0.19.x：清单项文本规范化 —— 强制单行 + 长度硬上限。
 * 用户反馈清单项内容太多，必须一行内说清"做什么"（如"electron-builder 打包 .app"）。
 * 多行折叠为空格；超过 40 字截断加省略号。
 */
function sanitizePlanItemText(x: string): string {
  const oneLine = x.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return oneLine.length > 40 ? oneLine.slice(0, 40).trimEnd() + '…' : oneLine
}

function parsePlanItems(raw: string): string[] | null {
  if (!raw) return null
  // 1) 主格式：JSON 字符串数组（可容忍代码块围栏 / 前后缀文本）
  const jsonItems = parsePlanItemsJson(raw)
  if (jsonItems && jsonItems.length > 0) return jsonItems
  // 2) 容错：编号 / 无序列表行（"1. xxx" / "- xxx" / "• xxx"）
  const lineItems = parsePlanItemsLines(raw)
  if (lineItems && lineItems.length > 0) return lineItems
  // 3) 容错：箭头链（"定位问题 → 直接修复 → 验证 → 汇报"）
  const arrowItems = parsePlanItemsArrows(raw)
  if (arrowItems && arrowItems.length > 0) return arrowItems
  return null
}

/** 主解析：从文本中提取 JSON 数组（容忍 ``` 围栏 / 前后缀）。 */
function parsePlanItemsJson(raw: string): string[] | null {
  let text = raw.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return null
    const items = arr
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => sanitizePlanItemText(x))
      .filter((x) => !isNoisePlanItem(x))
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}

/** 容错：编号 / 无序列表行解析（v0.24.1 —— 思考型模型常输出散文式步骤而非 JSON）。 */
function parsePlanItemsLines(raw: string): string[] | null {
  const lines = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
  const items: string[] = []
  for (const line of lines) {
    const m = line.match(/^(?:\d+[.、)）:]|[一二三四五六七八九十]+[、.．]|[-*•·])\s*(.+?)[。；;]?\s*$/)
    if (!m) continue
    const text = sanitizePlanItemText(m[1])
    if (text && !isNoisePlanItem(text)) items.push(text)
  }
  return items.length > 0 ? items : null
}

/** 容错：箭头链解析（"A → B → C" / "A -> B" / "A => B"）。 */
function parsePlanItemsArrows(raw: string): string[] | null {
  const parts = raw.split(/\s*(?:→|->|=>|⇒|→)\s*/)
  if (parts.length < 2) return null
  const items: string[] = []
  for (const part of parts) {
    const cleaned = part
      .replace(/^[\s\-*•·\d.、)）:：]+/, '')
      .replace(/[。；;,.，]$/, '')
      .trim()
    const text = sanitizePlanItemText(cleaned)
    if (text && !isNoisePlanItem(text)) items.push(text)
  }
  return items.length >= 2 ? items.slice(0, 12) : null
}

/**
 * v0.17.5：根据文档驱动开发阶段（CoreStageId）匹配 planItem 的索引。
 * 阶段门禁触发时，把对应阶段的计划项标 done。匹配策略：
 *  1. 优先文本关键词（"调研"/"PRD"/"交互"/"原型"/"系统设计"）
 *  2. 兜底"阶段 N"编号（N 对应阶段序号）
 * 返回 -1 表示未匹配（可能计划项未按阶段标注，或该阶段被合并）。
 */
function findPlanItemForStage(planItems: PlanItem[], stage: string): number {
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
function isProductiveTool(tool: string): boolean {
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
function decidePlanAdvance(
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
async function emitPlanStatus(
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

/**
 * v0.17.5：判断 planItem 文本是否为「阶段标题型」总结性条目（不可勾选）。
 * 阶段标题只是把若干子项打包成组的标签，模型一旦把阶段标题当成可勾选项，
 * 调一次工具就把整阶段都标 done，与真实执行进度脱节。
 *
 * 命中规则（满足任一即视为阶段标题）：
 *  - 以 "阶段 N" / "Phase N" 开头且没有具体动作动词（调研/写/实现/测试/...）
 *  - 文本中没有可识别的动词，仅含"技术选型/架构设计/搭建脚手架"等抽象总结词
 */
function isPhaseHeader(text: string): boolean {
  const t = text.trim()
  // 规则 1：纯阶段标题前缀（如 "阶段 1：xxx" / "Phase 1: xxx"），后面无任何动作动词
  const phasePrefix = /^(阶段|phase|step|step\s*\d+)\s*\d*\s*[:：、]?\s*/i
  if (!phasePrefix.test(t)) return false
  const afterPrefix = t.replace(phasePrefix, '').trim()
  // 阶段标题通常 ≤ 20 字且不含具体动作动词
  if (afterPrefix.length > 30) return false
  const actionVerbs =
    /调研|搜索|写|实现|开发|编码|测试|部署|打包|封装|接入|初始化|创建|搭建|执行|产出|读取|列出|修复|补|跑|运行|完成|确认|导出|下载|配置/i
  return !actionVerbs.test(afterPrefix)
}

/**
 * v0.25.0 F1：on-demand 技能指令体注入 L1 skill_instruction（持续生效至任务结束）。
 * 替代旧 `pendingSystemHint` 单轮机制 —— 同一技能按 skillId 去重取最新一条，
 * 装配阶段 assembleMessages 把 skill_instruction 作为独立 user 消息注入（与 plan_status 同管道），
 * 复用既有归档/压缩策略（压缩时与 system_prompt 同等保留）。
 * 错误场景：appendL1 失败 → 抛错（让 invokeSkill 上层走软失败通道）。
 */
async function injectSkillInstruction(
  task: Task,
  skill: { id: string; name: string },
  text: string,
  iteration: number,
): Promise<void> {
  if (!text || !text.trim()) return
  // 按 skillId 去重：先 archive 旧 skill_instruction（同 skillId），再 appendL1 写入最新一条。
  try {
    const { archiveL1 } = await import('../memory/l1-working.js')
    const { listEnabledL1 } = await import('../memory/l1-working.js')
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
function broadcastSkillAutoLoaded(task: Task, skillName: string, instructionMd: string): void {
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

function buildObservationSummary(
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
function collectActionsForIteration(response: LlmCompleteResponse): ReActAction[] {
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
async function appendPairedControlObservations(args: {
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

interface ActExecutionResult {
  completedStep: ReActStep
  result: unknown
  resultSummary: string
  durationMs: number
  ok: boolean
  errorMessage?: string
  additionalSystemHint?: string
}

interface ActContext {
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

async function executeAct(
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

function toFinishedProgress(step: ReActStep, groupId: string): ToolProgress {
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

/**
 * Task 2 Layer 2 — 每轮调用前（plan 生成与主循环 Reason 共用）的上下文预算检查。
 * 用 estimatePayloadTokens 估算 L1 内容（content + raw.reasoningContent + meta），
 * 超预算（shouldCompact）时调用 compressMemory 做 LLM 摘要压缩（最后手段；
 * 内部摘要失败已降级为前缀截断）。全程 try/catch 熔断：
 * 失败仅记 warn 日志，不得抛错、不得递归、不得影响本轮运行。
 */
async function maybePrecallCompact(task: Task, agent: Agent): Promise<void> {
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

async function assembleMessages(
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

  for (let idx = 0; idx < items.length; idx++) {
    const m = items[idx]
    if (m.archivedAt) continue
    if (m.kind === 'system_prompt') continue // 由 adapter 单独处理
    // v0.19.1：计划生成阶段排除历史 plan / plan_status，避免 LLM 复述旧清单状态
    // 生成出「已更新清单第 N 项…当前清单…」这类噪声项。
    if (opts?.excludePlanContext && (m.kind === 'plan' || m.kind === 'plan_status')) continue
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant' && m.kind === 'plan') {
      // v0.17.3：计划清单注入为 user 消息，让 LLM 在后续 Reason 轮次能看到自己生成的计划。
      // 此前 kind='plan' 不匹配任何分支被静默丢弃，导致 LLM 生成计划后"忘记"计划内容，
      // 执行动作与计划完全脱节。对齐 Claude Code TodoWrite 把清单注入每轮推理的做法。
      messages.push({
        role: 'user',
        content: `[计划清单 — 请严格按此计划执行，每步完成后继续下一步]\n${m.content}`,
      })
    } else if (m.role === 'assistant' && m.kind === 'plan_status') {
      // v0.17.6：引擎独立判断的清单状态（结构化），覆盖文本版 system prompt 注入。
      // 每轮 act 后引擎会写入一条 plan_status（kind='plan_status'），LLM 必须读取此处的
      // 机器判断结果，而不是从自己上轮的记忆里拼凑。结构化字段：
      //   { items: [{i, text, status, engineDecision, reason}], runningIndex, doneCount }
      messages.push({
        role: 'user',
        content: `[清单状态 — 引擎独立判断（不是 LLM 自报），你必须以此为准]\n${m.content}`,
      })
    } else if (m.role === 'assistant' && m.kind === 'skill_instruction') {
      // v0.25.0 F1：on-demand 技能指令体（持续生效至任务结束，与 plan_status 同管道）。
      // 注入为独立 user 消息，让 LLM 在后续 Reason 轮次能持续看到准则型指令
      // （之前 pendingSystemHint 一轮清空 → 门禁遗漏；现以 L1 持久化 + 装载时最新一条去重）。
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

async function assembleTools(agent: Agent, task: Task): Promise<LlmTool[] | undefined> {
  const skills = await listSkills()
  // v0.6.0（F1）：合并 agent 默认 skills + task 会话级 skills，去重，过滤已禁用
  // v0.24.2.1：补上 MCP — agent.defaultMcpIds 与 task.mcpIds 内的 server 对应的全部
  //   source='mcp' Skill 一并纳入工具集（与 automations.ts:204 的合并方式对齐）。
  const skillIdSet = new Set<string>([
    ...agent.defaultSkillIds,
    ...(task.skillIds || []),
  ])
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
async function buildMemoryInjection(agent: Agent, task: Task): Promise<string> {
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
async function buildKbStatusLine(task: Task): Promise<string> {
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
async function autoRecallKb(task: Task): Promise<void> {
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
 * 压缩完成后发射 memory_compressed 事件供 UI 展示 chip。
 */
async function maybeAutoCompress(
  taskId: string,
  iteration: number,
): Promise<void> {
  const config = await getMemoryConfig()
  if (!config.autoCompress) return

  const enabled = await listEnabledL1(taskId)
  const used = totalTokens(enabled)
  if (used < config.compressThreshold) return

  logger.info('Memory', `auto-compress triggered: ${used} >= ${config.compressThreshold} tokens`, taskId)
  try {
    const task = await getTask(taskId)
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
 * F803/F804/F805 run done 记忆钩子——任务完成后：
 * 1. 归档：该任务全部 L1 条目异步入库 L3b 档案（ADD-only，跳过 system_prompt）；
 * 2. 画像合成：L4a 辩证合成（提取观察 → LLM 合成 → 版本+1），更新后发射 profile_updated；
 * 3. 蒸馏评估：按规模门槛评估触发，命中则自动蒸馏（晋升 L3/L4 并清理 L1/L2），
 *    完成后发射 distill_completed 轻量提示（不再弹"是否需要蒸馏"建议卡）。
 * 全程失败静默降级（不影响任务完成）。
 */
async function runDoneMemoryHooks(
  task: Task,
  agent: Agent,
  modelId: string,
  _finalThought: string,
): Promise<void> {
  const l1Items = await listL1(task.id)

  // 1. F803 归档到 L3b
  try {
    const taskTitle = safeSlice(task.input?.text ?? '', 80) || task.id
    await archiveTaskL1(task.id, taskTitle, l1Items)
  } catch (err) {
    logger.warn('Memory', `L3b archive failed (silent): ${(err as Error).message}`, task.id)
  }

  // 2. F804 L4a 画像合成
  try {
    const synthResult = await synthesizeFromTaskL1(task.id, l1Items, modelId)
    if (synthResult.synthesisUpdated) {
      await emitEvent(task.id, {
        type: 'profile_updated',
        iteration: 0,
        version: synthResult.profile.version,
        newObservations: synthResult.newObservations,
      })
    }
  } catch (err) {
    logger.warn('Memory', `L4a synthesis failed (silent): ${(err as Error).message}`, task.id)
  }

  // 3. F805 蒸馏评估（Task 10：仅规模门槛命中才自动执行，完成后发轻量完成提示）
  try {
    const ctx = buildDistillContext(task.id, l1Items)
    const metrics = await getDistillMetrics(task.id, l1Items)
    const evalResult = await evaluateDistillTrigger({ ...ctx, ...metrics })
    if (evalResult.trigger && evalResult.category) {
      const message = await autoPromoteDistill({ ...ctx, ...metrics }, evalResult.category, modelId)
      await emitEvent(task.id, {
        type: 'distill_completed',
        iteration: 0,
        taskId: task.id,
        category: evalResult.category,
        message,
      })
    }
  } catch (err) {
    logger.warn('Memory', `distill evaluation failed (silent): ${(err as Error).message}`, task.id)
  }

  // 4. v0.25.0 F3：技能创建严格管线（skill-forge 五阶段）—— L2 步骤产物为唯一合法候选
  try {
    const forgeResult = await runForSkillForge(task.id, modelId)
    if (forgeResult.skill) {
      await emitEvent(task.id, {
        type: 'distill_completed',
        iteration: 0,
        taskId: task.id,
        category: 'skill',
        message: forgeResult.reason,
      })
    } else if (forgeResult.stage === 'value-judge' || forgeResult.stage === 'integrity') {
      // 评估未通过 / 校验未过：发轻量事件给 UI（任务完成提示中说明）
      logger.info('Memory', `skill-forge ${forgeResult.stage} not passed: ${forgeResult.reason}`, task.id)
    }
  } catch (err) {
    logger.warn('Memory', `skill-forge failed (silent): ${(err as Error).message}`, task.id)
  }
}

/** 从 L1 条目构建蒸馏触发上下文（启发式提取信号） */
function buildDistillContext(
  taskId: string,
  l1Items: import('@shared/types/memory').MemoryItem[],
): import('../memory/distill.js').DistillTriggerContext {
  const observations = l1Items.filter((m) => m.kind === 'observation' && !m.archivedAt)
  const toolCallCount = observations.length
  const hadErrorRecovery = observations.some(
    (m, i) => /\]\s*failed:/.test(m.content) && observations.slice(i + 1).some((n) => !/\]\s*failed:/.test(n.content)),
  )
  const userMessages = l1Items.filter((m) => m.kind === 'user_message')
  const hadUserCorrection = userMessages.some((m) =>
    /不对|错了|不是|纠正|应该|重新|重做/.test(m.content),
  )
  const hadPreferenceExpression = userMessages.some((m) =>
    /我喜欢|我习惯|请用|不要|偏好|希望|最好/.test(m.content),
  )
  return { taskId, l1Items, toolCallCount, hadErrorRecovery, hadUserCorrection, hadPreferenceExpression }
}

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
import { classifyRoute } from '../router/classify-route.js'
import { routeAgent } from '../router/route-agent.js'
import { builtinAgentRegistry } from '../store/agents.js'
import { createTurn, runTurn } from '../engine/phase-runner.js'
import type { Turn, TurnResult } from '../engine/types.js'
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
  opts: { modelId: string; agent?: Agent; signal?: AbortSignal },
): Promise<string> {
  const adapter = await getAdapter(opts.modelId)
  const systemPrompt = opts.agent?.systemPrompt ?? ''
  const t0 = Date.now()
  const response = await adapter.complete({
    system: systemPrompt,
    messages: [{ role: 'user', content: input }],
    // chat 路径固定不挂工具；forceChat 流与现有 sendMessage 旧路径行为一致
    tools: undefined,
    signal: opts.signal,
  })
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
    faultTolerant: <T>(fn: () => Promise<T>, _ctx: import('../engine/phase-runner.js').FaultContext) => {
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
    })
    return { kind: 'chat', reply }
  }

  // task kind：转发给既有 task 路径（保持 runReActLoop 不变）
  if (!ctx.taskId) {
    throw new Error('dispatchChatOrTask: ctx.taskId required for task kind')
  }
  // 用动态 import 避免循环依赖（engine ↔ runner）
  const { runTask } = await import('./runner.js')
  await runTask(ctx.taskId)
  return { kind: 'task' }
}
