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
import { saveGraph } from '../graph/store.js'
import { recordMetric } from '../graph/metrics.js'
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
      plan = await generatePlan(task, agent, modelId, signal, alwaysOnPlanHint, docDriven, () => {
        planDegraded = true
      })
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
    const replanHint = isReplyContinuation
      ? `## 答复型续聊（v0.30.2 D12）
本轮最新 user_message 是对引擎提问（门禁 / ask_user / 计划闸门 / 迭代上限）的**答复**，不是新指令：
1. 任务清单保持不变 —— 直接继续推进当前进行中的节点；门禁状态已由引擎写回。
2. 答复若隐含方向或范围调整 → 用 task_create 把调整挂为子任务，或 replan 增量补丁；禁止整体作废清单。`
      : `## 续聊指令与清单（v0.30.2 D12）
用户追加了新输入。先判断它与现有清单的关系，**三选一**处理（清单是活树，禁止未经批准擅自整体作废）：
1. **子任务/细化**（属于当前目标的分解或补充）→ 用 task_create 新建节点（parent_id 挂到相关节点下，add-only 第 1 级自动应用，侧边栏树形显示）。
2. **独立追加**（新增工作但不影响既有项）→ 用 replan 提交 add-only 补丁（第 1 级自动应用）。
3. **真正切换任务**（旧目标作废，按新指令重来）→ 用 replan 提交 remove+add 重构补丁 → 第 2 级**等待用户批准**，批准后自动应用；未获批准前旧清单原样保留。
4. 无清单的对话级任务 → 沿用对话式推进；新指令需要多步执行时用 task_create 建图登记。`
    pendingSystemHint = pendingSystemHint
      ? `${pendingSystemHint}\n\n---\n${replanHint}`
      : replanHint
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
    } else if (needsGraphMigration({ graphId: task.graphId, planItems: task.planItems })) {
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
  } catch (graphErr) {
    logger.warn(
      'Agent',
      `graph 初始化失败（回退扁平清单路径，任务继续执行）：${(graphErr as Error).message}`,
      task.id,
    )
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
