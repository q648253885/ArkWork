/**
 * v0.27.0 R2/F7：运行前置准备（由 loop.ts 纯移动，行为不变）。
 * system_prompt 注入 / startIter 推导 / 记忆与档案索引初始化 / always-on 契约与
 * 门禁状态机初始化 / pendingGateBlock 消费 / alwaysOnPlanHint / 阶段写守卫 /
 * 首轮 Plan 生成（含 phase-header 过滤与兜底清单）/ 续聊 plan-regen 与
 * continuation 兜底 / 显式技能自动加载 / KB 异步召回。
 */

import type { Task, PlanItem } from '@shared/types/task'
import type { PlanContent, ReActStep } from '@shared/types/react'
import type { PlanApproval } from '@shared/types/graph'
import type { Agent } from '@shared/types/agent'
import { readFile } from 'node:fs/promises'
import { appendL1, listEnabledL1 } from '../../memory/l1-working.js'
import { applyPending } from '../../memory/l3-curated.js'
import { initArchiveIndex } from '../../memory/l3-archive.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { updateTask, getTask } from '../../store/tasks.js'
import { getWorkspaceDir } from '../../store/db.js'
import { getSkill } from '../registry.js'
import { collectAlwaysOnSections } from '../prompt/sections.js'
import { collectGateSpecs, initGateStates, confirmGate, isDocDrivenAgent } from '../prompt/gates.js'
import { isCoreSkillsEnabled, computeAllowedStage } from '../../skills/builtin/react-core-skills/stage-gates.js'
import { broadcastStep, broadcastPlanListSnapshot, broadcastReActEvent } from '../events.js'
import { emitEvent } from './broadcast.js'
import { autoRecallKb, buildMemoryInjection } from './memory-hooks.js'
import { generatePlan } from './plan.js'
// v0.30.0：TaskGraph 初始化（迁移 / 载入 / 建图广播）
import { migrateToGraph, needsGraphMigration } from '../graph/migrate.js'
import { getPlanApproval, registerPlanApproval } from '../graph/pending.js'
import { getGraphById, putGraphCache } from '../graph/sync.js'
import { findGraphIdByTaskId, saveGraph } from '../graph/store.js'
import { recordMetric } from '../graph/metrics.js'
import { isPhaseHeader, renderPlanTreeSnapshot } from './plan-parser.js'
import { injectSkillInstruction, broadcastSkillAutoLoaded } from './skills.js'
// v0.38.0（D155）：新输入的「请先判断」指令（system 通道 · 禁复述）
import { injectInputJudgement, emitTurnNote } from './gate-channel.js'
// v0.39.0（W4）：用户新指令 → 规划通道重排（判据 = 规划结果是否与当前清单不同）
import { runPlannerPass, getPlannerModelId } from '../planning/runner.js'
import type { PlannerRequestItem } from '../planning/types.js'
import { commitPlanDraft } from './plan-commit-pipeline.js'
import { safeSlice } from './broadcast.js'
// v0.37.0：TaskLedger —— 任务清单唯一真相源（唯一写入口 + 恢复点语义）
import {
  ensureLedger,
  loadLedger,
  resumeLedger,
  sweepStale,
  renderSnapshot,
  hasResumePoint,
  toPlanItems,
  DEFAULT_STALE_MAX_IDLE_MS,
} from '../ledger/index.js'

export type AlwaysOnContracts = Awaited<ReturnType<typeof collectAlwaysOnSections>>

export interface PreparedRun {
  startIter: number
  memoryInjection: string
  alwaysOnContracts: AlwaysOnContracts
  docDriven: boolean
  coreSkillsEnabled: boolean
  allowedStage: number
  pendingSystemHint: string | undefined
  /**
   * v0.38.1（D170）：对话级任务标记 —— 首轮 plan 生成时模型显式表态「无需清单」
   * （Tier 0：`[]` 或 direct-answer JSON）。此后的 ReAct 循环中，模型的正文答复
   * 即为对用户的最终答复（答复即终局），不再按「未完成工作」走停滞守卫暂停。
   */
  chatMode: boolean
}

export async function prepareRun(args: {
  task: Task
  agent: Agent
  modelId: string
  signal: AbortSignal
}): Promise<PreparedRun> {
  const { task, agent, modelId, signal } = args
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
    await applyPending(modelId)
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

  // v0.30.2 D12：答复型续聊判定 —— 必须在消费标记**前**捕获。
  // 门禁答复（pendingGateBlock）与 ask_user/计划闸门/迭代上限答复（pendingAskUser）
  // 都是对引擎提问的回应，不是新指令：清单保持不变，replanHint 走「答复型」文案。
  const isReplyContinuation = Boolean(task.pendingGateBlock || task.pendingAskUser)

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

  // v0.30.2 D12：消费 ask_user 暂停标记 —— 答复已到（即本轮最新 user_message），
  // isReplyContinuation 已捕获；清除标记避免影响后续 run 的性质判定。
  if (task.pendingAskUser) {
    task.pendingAskUser = undefined
    await updateTask(task.id, { pendingAskUser: undefined })
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

  // v0.38.1（D170）：对话级任务标记 —— 首轮 plan 生成时模型显式表态「无需清单」
  // （Tier 0：`[]` 或 direct-answer JSON）→ 本 run 为对话级（loop 守卫「答复即终局」）。
  let chatMode = false
  // 任务计划清单必须先于记忆召回和任何 ReAct 思考/工具操作出现。
  // polish4 §B1：新任务流程必须经过 Plan，但 plan 生成失败时**不**写 fallback plan 到 L1，
  // 避免模型下一轮引用兜底清单。仅当 generatePlan 真正成功时才落入 plan_start 事件 + L1。
  if (startIter === 0) {
    const planStartedAt = Date.now()
    let plan: PlanContent | null = null
    // v0.30.0 / P8：三级降级链全部失败（且非模型显式空计划）时置位 ——
    // 决定是否登记 Plan 闸门**错误态**（原型 page-08 error），让用户看见"为何没有图"。
    let planDegraded = false
    try {
      plan = await generatePlan(
        task,
        agent,
        modelId,
        signal,
        alwaysOnPlanHint,
        docDriven,
        () => {
          planDegraded = true
        },
        () => {
          chatMode = true
        },
      )
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
      // v0.30.0 D9：本分支在 `startIter === 0` 时执行；`startIter` 由 L1 最大 iteration 推导，
      // 故此刻任务必为**全新任务、尚无 graphId** —— 直写与 v0.29 等价；紧随其后的
      // 「确保任务图存在」块会据这份 planItems 建图（migrateToGraph），两通道按构造一致。
      task.planItems = planItems
      await updateTask(task.id, { planItems })
      // v0.41.0（D209）：计划步快照透传父引用 —— **必须与 plan.items 对齐**（PlanBlock
      // 渲染的是 plan.items），而 planItems 经阶段标题过滤后可能比 plan.items 短，
      // 故按「保留项在原 items 中的下标」回映射。初次生成的 items 是扁平的（层级引用
      // 由 task_plan / PlanOps 落账后产生，活体层级展示在 TodoPanel）；本透传链让
      // PlanBlock 具备与 TodoPanel 相同的层级渲染能力（TC-TDP-005）。
      {
        const keptSet = new Set(keepItems)
        const keptOriginalIdx: number[] = []
        plan.items.forEach((text, j) => {
          if (keptSet.has(text)) keptOriginalIdx.push(j)
        })
        plan.parentIds = plan.items.map((_text, j) => {
          const i = keptOriginalIdx.indexOf(j)
          return i >= 0 ? (planItems[i]?.parentId ?? null) : null
        })
      }
      // v0.37.0：清单落账 —— 从这一刻起 TaskLedger 是唯一真相源，
      // Task.planItems 降级为它的只读投影（由 ledger 单一写入者回写）。
      try {
        await ensureLedger(task, { goal: (task.input.text || task.title).split('\n')[0]?.slice(0, 200) })
      } catch (err) {
        logger.warn('Agent', `ledger 建账失败（清单仍可用，仅失去恢复点能力）：${(err as Error).message}`, task.id)
      }
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
      // v0.30.0 D9：同 8a —— `startIter === 0` 时任务尚无 graphId，直写等价 v0.29，
      // 随后的建图块据这份兜底清单建图，两通道一致。
      task.planItems = fallbackPlanItems
      await updateTask(task.id, { planItems: fallbackPlanItems })
      broadcastPlanListSnapshot(task.id, fallbackPlanItems, 'plan-fallback')
      // v0.37.0：兜底清单同样落账（保证后续 todo_update 有真相源可写）
      try {
        await ensureLedger(task, { goal: (task.input.text || task.title).split('\n')[0]?.slice(0, 200), mode: 'chat' })
      } catch (err) {
        logger.warn('Agent', `ledger 建账失败（兜底清单）：${(err as Error).message}`, task.id)
      }
      logger.info('Agent', `plan-fallback: 写入兜底单步清单（${fallbackPlanItems[0]?.text}）`, task.id)
      // v0.30.0 / P8：三级降级链全败（且非模型显式空计划）→ 登记 Plan 闸门**错误态**。
      // 卡片 `PlanApprovalCard` 据此展示原型 page-08 的 error 态（三级降级顺序 + 重试/接受）。
      // 注意：闸门是瞬时内存态，任务结束/重启即清空；此处只负责"让它可达"。
      if (planDegraded) {
        const degradedPlan: PlanApproval = {
          taskId: task.id,
          graphId: task.graphId,
          state: 'pending',
          proposedAt: getPlanApproval(task.id)?.proposedAt ?? Date.now(),
          uncovered: [],
          degraded: true,
        }
        registerPlanApproval(degradedPlan)
        broadcastReActEvent({
          type: 'graph_plan_gate',
          taskId: task.id,
          graphId: task.graphId ?? '',
          plan: degradedPlan,
        })
        logger.warn('Agent', 'P8: 计划生成失败，已登记 Plan 闸门错误态（degraded）', task.id)
      }
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
  // v0.16.7+ → v0.30.2 D12 v2：续聊清单语义（用户澄清取向：清单是活树）
  // 引擎侧**不再清空重建**（v0.30.2 首版方案在 UAT 中误伤门禁答复，见 04-system-design §2.4）——
  // 图与清单的写入权回归受审计的 Replan 通道（task_create / replan 工具），引擎只注入性质判定提示。
  if (startIter > 0) {
    // ============================================================
    // v0.37.0（缺陷 D135）：**续聊绝不允许重建清单**。
    //
    // 旧路径问题：tasks.json 丢 graphId 时，`needsGraphMigration` 只看
    // graphId 字段 → 用「过期全 pending 清单」重建第二张图 → 模型照单重做
    // 已完成的任务（用户实测"续聊重复执行第一个任务"的直接来源，D122 残留）。
    //
    // 现在：清单真相源是账本文件，`ensureLedger` 在文件已存在时**原样返回**，
    // 不重建、不整表替换；随后若存在中断痕迹，按产出物做三段式恢复判定。
    // ============================================================
    let ledger = null as Awaited<ReturnType<typeof loadLedger>>
    try {
      ledger = await ensureLedger(task, { seedFromPlanItems: true })
      // 关键：把内存里的清单换成**账本投影**。后续图迁移 / 提示词装配都以它为准，
      // 否则仍会拿 tasks.json 里可能过期的副本去重建（D135）。
      if (ledger) task.planItems = toPlanItems(ledger)
    } catch (err) {
      logger.warn('Agent', `续聊建账失败（沿用既有清单）：${(err as Error).message}`, task.id)
    }
    let resumeHintText = ''
    if (ledger && hasResumePoint(ledger)) {
      try {
        const resumed = await resumeLedger(task.id, '新一轮执行开始：按产出物判定中断项')
        ledger = resumed.ledger ?? ledger
        resumeHintText = resumed.ledger?.resume?.hint ?? ''
        logger.info('Agent', `ledger resume：${resumeHintText.slice(0, 80)}`, task.id)
      } catch (err) {
        logger.warn('Agent', `恢复点判定失败：${(err as Error).message}`, task.id)
      }
    }
    // 过期任务巡检：running 太久无进展 → paused（终态不动，防止误伤已完成项）
    if (ledger) {
      try {
        const swept = await sweepStale(task.id, DEFAULT_STALE_MAX_IDLE_MS, '过期巡检')
        if (swept.ok && swept.effective && swept.effective.length > 0) {
          logger.info('Agent', `sweep-stale 暂停 ${swept.effective.length} 项无进展清单项`, task.id)
          ledger = swept.ledger
        }
      } catch (err) {
        logger.warn('Agent', `过期巡检失败：${(err as Error).message}`, task.id)
      }
    }
    // 账本权威快照：模型重评的基准**必须是文件当前状态**，不是历史消息里的旧快照。
    // v0.37.0：整份快照的注入**收口到 `messages.ts`（每轮 L1 段，D138）**，
    // 这里只在"没有账本"（旧任务）时用树快照兜底 —— 同轮两处渲染同一份清单
    // 既费 token，也让同一状态出现两种措辞（模型可能按其中一份行事）。
    const resumeBlock = resumeHintText
      ? `\n\n**上次中断的恢复点**：${resumeHintText}\n已完成项**不要重做**；确实需要重做的，先用 task_plan 提交把它改回 doing 并说明原因。`
      : ''
    // v0.36.5 D125：新指令型 hint 内联整棵树快照（ZCode：模型必须能看见权威快照才谈得上重评）。
    // 答复型续聊不加快照 —— 门禁/ask_user 答复不是新指令，清单保持不变（D12 v2 不变量）。
    const treeSnapshot = isReplyContinuation ? '' : renderPlanTreeSnapshot(task.planItems ?? [])
    // v0.38.0（D154）：清单控制面收敛为 `task_plan` 单入口 —— 本节文案不得再出现
    //   `task_create` / `replan` / `todo_update` 等已下架工具名（否则模型没有唯一答案）。
    const replanHint = isReplyContinuation
      ? `## 答复型续聊（v0.30.2 D12）
本轮最新 user_message 是对引擎提问（门禁 / ask_user / 计划闸门 / 迭代上限）的**答复**，不是新指令：
1. 任务清单保持不变 —— 直接继续推进当前进行中的节点；门禁状态已由引擎写回。
2. 答复若隐含方向或范围调整 → 用 task_plan 提交更新后的**完整清单**（引擎自动比对差异）；禁止整体作废清单。`
      : `## 续聊指令与清单（v0.38.0 — 先判断，后作答）
用户追加了新输入，而当前生效清单是**上一段任务**留下的快照（见下方清单快照）。
第一步只有一件事：判断「**这次输入是否产生了需要跟踪的新工作**」（不是"用户是否发了消息"）：
1. **需要新工作**（新增 / 调整 / 切换目标）→ 用 task_plan 提交你更新后的**完整清单**（新增项、状态变化、删除项由引擎自动比对并保留已完成项），再开始执行。
2. **只读问答 / 闲聊**（不产生需要跟踪的工作）→ 清单无需变化：用 task_plan 提交与现在**相同**的清单即可（引擎会记录你已做过检视判断），然后直接回答用户。
重评口径：已完成项保持 done 不动（终态不可回退）；与新输入无关且未开始的项先保持原状。`
    // v0.38.0（D155）：把"用户原输入 + 清单快照"直接摆给模型，让它**先读先判**（system 通道）。
    //   取代此前由 `isReplyContinuation` 这类代理变量预判 —— 代理变量判不出
    //   「只读提问」与「新指令」的区别（D150 根因）。
    if (!isReplyContinuation && ledger) {
      const latestUser = await listEnabledL1(task.id)
        .then((ms) => [...ms].reverse().find((m) => m.kind === 'user_message' && m.content?.trim()))
        .catch(() => undefined)
      const userInputText = latestUser?.content?.trim() || task.input?.text || task.title
      await injectInputJudgement({
        taskId: task.id,
        iteration: startIter,
        inputText: userInputText,
        items: ledger.items,
      })
      // ============================================================
      // v0.39.0（W4 · F4）：**用户新指令 → 规划通道重排**。
      //
      // 上面那条指令是让模型「自己判、自己改」；这里先给规划通道一次机会 ——
      // 它带着「用户新输入 + 当前清单」跑一个干净的回合，产出的清单直接提交。
      //
      // 判据刻意**不是**「用户有没有说话」（那是 D150 教训里的代理变量），而是
      // **规划结果与当前清单是否不同**：相同 → 幂等不动（changed=0，什么都不发生）；
      // 不同 → 提交并通过 `plan-revision` 通道告知用户「清单变了，是引擎重新规划的」。
      //
      // 失败即回落：planner 不可用 / 解析不出 / 落库失败 → 只有上面那条指令生效，
      // 行为与 v0.38.1 完全一致。超时用默认 20s（非开局），不拖慢续聊手感。
      // ============================================================
      try {
        const items: PlannerRequestItem[] = ledger.items.map((it) => ({
          id: it.id,
          text: it.text,
          status: String(it.status),
          parentId: it.parentId ?? null,
        }))
        const res = await runPlannerPass({
          req: {
            taskId: task.id,
            trigger: 'new-instruction',
            goal: safeSlice(String(userInputText ?? ''), 120),
            items,
            failures: [],
          },
          modelId: await getPlannerModelId(modelId),
          signal,
        })
        if (res.ok && res.draft.length > 0) {
          const committed = await commitPlanDraft({
            task,
            iteration: startIter,
            draft: res.draft,
            reason: '用户新指令，规划通道重新推演',
            source: 'planner',
          })
          if (committed.ok && committed.changed > 0) {
            logger.info(
              'Agent',
              `new-instruction replan 生效：${res.summary} → changed=${committed.changed}`,
              task.id,
            )
            await emitTurnNote({
              taskId: task.id,
              iteration: startIter,
              text: `收到新指令，引擎已重新规划：${res.summary}。`,
              via: 'plan-revision',
            })
          }
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err
        logger.warn('Agent', `新指令重排异常（回落既有判定提示）：${(err as Error).message}`, task.id)
      }
    }
    const snapshotBlock = ledger
      ? resumeBlock
      : treeSnapshot
        ? `\n\n**当前清单快照（重评基准）**：\n${treeSnapshot}${resumeBlock}`
        : resumeBlock
    const hintWithSnapshot = `${replanHint}${snapshotBlock}`
    pendingSystemHint = pendingSystemHint
      ? `${pendingSystemHint}\n\n---\n${hintWithSnapshot}`
      : hintWithSnapshot
  }
  // ============================================================
  // v0.30.0：确保任务图存在（TaskGraph 化的统一出入口）
  //
  // 放在 prepareRun 的**最后**，覆盖上面全部 planItems 写入路径
  // （首次计划 / 兜底清单；v0.30.2 D12 v2 起续聊分支不再写 planItems，
  // 子任务与重构分别经 task_create / replan 受审计通道，镜像由 persist 回写）。
  //
  // 三个分支：
  //  1. 已有 graphId 且图可加载 → 载入内存缓存，供本轮 Sync 使用
  //  2. 无 graphId 但有 planItems → 迁移成图（`migrateToGraph`），落盘并回写 Task
  //  3. 无 planItems → 轻量模式（tier 0/1），**不建图**（F20：不该用的时候别用）
  //
  // 失败一律不阻断任务：迁移/加载异常只记日志，任务按 v0.29 的扁平清单路径继续跑。
  // ============================================================
  try {
    const fresh = await getTask(task.id)
    if (fresh?.graphId) {
      const g = await getGraphById(fresh.graphId)
      if (g) {
        task.graphId = g.id
        task.graphRevision = g.graphRevision
        logger.info('Agent', `graph loaded: ${g.id}（${Object.keys(g.nodes).length} 节点）`, task.id)
      } else {
        logger.warn('Agent', `graph 加载失败（graphId=${fresh.graphId}），回退扁平清单路径`, task.id)
      }
    } else {
      // v0.36.4（D122）：tasks.json 可能因 D119 写失败丢过 graphId（镜像回写被跳过的历史窗口）。
      // `needsGraphMigration` 只看 graphId 字段 → 会用过期全 pending 清单**重建第二张图**，
      // 模型照单重做已完成的任务（用户实测续聊重做根因）。迁移前先查 specs 索引：
      // 查到且可加载 → 收养既有图，绝不再迁移。
      let adoptId: string | null = null
      try {
        adoptId = await findGraphIdByTaskId(task.id)
      } catch {
        /* 索引不可用按无图处理，回落迁移判定 */
      }
      if (adoptId) {
        const adopted = await getGraphById(adoptId)
        if (adopted) {
          task.graphId = adopted.id
          task.graphRevision = adopted.graphRevision
          logger.warn(
            'Agent',
            `graph adopted via index: ${adopted.id}（tasks.json 缺 graphId，防过期清单再迁移）`,
            task.id,
          )
        }
      }
      if (!task.graphId && needsGraphMigration({ graphId: task.graphId, planItems: task.planItems })) {
      const migrated = migrateToGraph({
        taskId: task.id,
        title: task.title,
        goal: (task.input.text || task.title).split('\n')[0].slice(0, 200),
        planItems: task.planItems ?? [],
      })
      if (migrated) {
        // 首次迁移跳过写前快照（没有"上一次状态"值得快照）
        const saved = await saveGraph(migrated, {
          revision: {
            by: { kind: 'system' },
            op: 'migrate',
            targetId: migrated.id,
            reason: `v0.28.x planItems（${task.planItems?.length ?? 0} 项）→ TaskGraph`,
          },
          skipSnapshot: true,
          taskId: task.id,
        })
        putGraphCache(saved)
        task.graphId = saved.id
        task.graphRevision = saved.graphRevision
        broadcastReActEvent({
          type: 'graph_created',
          taskId: task.id,
          graphId: saved.id,
          tier: saved.policy.tier,
          nodeCount: Object.keys(saved.nodes).length,
        })
        recordMetric('tier_decided', { tier: saved.policy.tier })
        logger.info(
          'Agent',
          `graph migrated: ${saved.id}（${Object.keys(saved.nodes).length} 节点，来自 ${task.planItems?.length ?? 0} 条扁平清单）`,
          task.id,
        )
      }
      }
    }
  } catch (graphErr) {
    logger.warn(
      'Agent',
      `graph 初始化失败（回退扁平清单路径，任务继续执行）：${(graphErr as Error).message}`,
      task.id,
    )
  }

  // ============================================================
  // v0.38.0（D150/D151）：**已删除** v0.36.6 的「续聊树同步欠账」判定
  //
  //   `const pendingTreeSync = startIter > 0 && !isReplyContinuation && Boolean(task.graphId)`
  //
  // 删除理由：三个条件**全是代理变量**，没有一处读用户输入内容 ——
  //   `startIter > 0`（不是首轮）、`!isReplyContinuation`（不是对引擎提问的答复）、
  //   `Boolean(graphId)`（有图）。于是「这个工作区是什么」这类**纯只读提问**被判成
  //   "新指令型续聊"，完成门禁要求它先写清单 → 现场连续三轮被拦。
  //
  // 替代：判据下沉到「本 run 实际调用过哪些工具」（`work-class.ts`），由
  // `guardFinish({ workClass, touchedTree })` 客观裁决；续聊是否需要写清单，
  // 由模型看到 `injectInputJudgement` 注入的「原输入 + 清单快照」后自己判断。
  // ============================================================

  return {
    startIter,
    memoryInjection,
    alwaysOnContracts,
    docDriven,
    coreSkillsEnabled,
    allowedStage,
    pendingSystemHint,
    chatMode,
  }
}
