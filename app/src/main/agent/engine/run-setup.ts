/**
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
      plan = await generatePlan(task, agent, modelId, signal, alwaysOnPlanHint, docDriven)
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
          modelId,
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
