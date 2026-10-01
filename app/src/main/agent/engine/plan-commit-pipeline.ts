/* ============================================================
 * ArkWork — 计划提交共享管线（v0.38.1 / D177）
 *
 * 为什么要有这个文件：
 *   task_plan 工具分支（act.ts）此前独占「提交完整清单」的落库管线：
 *   建账 → diffPlan → plan-commit → touch-sync → 图对账 → 阶段结论。
 *   D177 增加了第二个调用方（无工具答复的正则清单提取回退），按纪律⑧
 *   把管线收敛到这里 —— 两条入口共享同一条落库路径，杜绝第二套实现漂移。
 *
 * 边界：
 *   · 本模块不做参数形状校验（调用方各自校验：act.ts 校验模型原始 args，
 *     plan-regex 产出的 draft 由构造保证合法）。
 *   · 落库唯一写入口仍是账本 `plan-commit` 算子（TC-WIRE-008）。
 * ============================================================ */
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { diffPlan, type PlanDiffResult, type PlanDraftItem } from '../ledger/plan-diff.js'
import { loadLedger, ensureLedger, mutate } from '../ledger/engine.js'
import { TO_PLAN_STATUS } from '../ledger/project.js'
import type { Task } from '../../../shared/types/task'
import { reconcilePlanItemsToGraph } from '../graph/plan-sync.js'
import { broadcastStep } from '../events.js'
import { emitTurnNote } from './gate-channel.js'
import { buildPlanCommitNote, buildReplanNote } from './turn-note-policy.js'

export interface CommitPlanDraftResult {
  ok: boolean
  /** 拒绝原因（ok=false 时给人话） */
  errorMessage?: string
  /** 真实变更数（0 = 已检视无变化，是合法结果） */
  changed: number
  /** 提交后的清单总项数 */
  total: number
  /** 人话摘要（diff.summary） */
  summary: string
  /** 图通道是否降级（清单账本已生效，仅图未同步） */
  graphSyncDegraded: boolean
  /** 账本 revision（诊断用） */
  revision?: number
  /** 提交后的差异（供调用方组装 observation / 日志） */
  diff?: PlanDiffResult
  /**
   * 引擎自动纠正的人话回执（v0.42.2 · D214c）：I2 等不变量改写发生后，
   * 调用方（act.ts）必须拼进 observation —— 否则回执说「完成」、快照却是
   * [?]，模型收到自相矛盾的反馈只能反复重交（真机死循环直接驱动器）。
   */
  warnings?: string[]
}

export interface CommitPlanDraftArgs {
  task: Pick<Task, 'id' | 'graphId'>
  iteration: number
  draft: readonly PlanDraftItem[]
  /** 人话原因（进账本日志与阶段结论） */
  reason: string
  /**
   * 来源标识：`task-plan`（模型工具）｜`plan-regex`（v0.38.1 正文解析回退）
   * ｜`planner`（v0.39.0 规划通道的独立回合）。
   * 三者共用**同一条**落库管线 —— 新增入口不得自建第二条（纪律⑧）。
   */
  source: 'task-plan' | 'plan-regex' | 'planner'
}

/**
 * 把一份**已校验**的清单草案提交进账本并下推图投影。
 * 单一管线：建账 → diff → plan-commit → touch-sync → reconcile → 阶段结论。
 */
export async function commitPlanDraft(args: CommitPlanDraftArgs): Promise<CommitPlanDraftResult> {
  const { task, iteration, draft, reason, source } = args
  const taskId = task.id

  // ① 账本就绪（缺失时按既有 planItems 兜底建账）
  let current = await loadLedger(taskId)
  if (!current) {
    try {
      const t = await (await import('../../store/tasks.js')).getTask(taskId)
      if (t) current = await ensureLedger(t, { seedFromPlanItems: true })
    } catch (err) {
      logger.warn('Agent', `清单建账失败（${source}）：${(err as Error).message}`, taskId)
    }
  }

  // ② 差异比对（纯函数；I8 终态保护 / I1 单 doing 在函数内强制）
  const diff = diffPlan({ current: current?.items ?? [], draft })

  // ②b v0.43.0（R5）：**证据门禁** —— 落库前拦截（此处的 reason 是调用方原始
  // 传入，尚未经兜底合成；引擎/规划通道的 reason 由调用方负责组装）。
  //  · 状态修改必须有理由（改了什么状态、依据是什么）；
  //  · replan（新建项）必须有依据（基于什么新信息/证据），且轮次晋升后引擎会
  //    自动把它作为「本轮目标简介」发 turn_note 展示在交互区。
  const trimReason = reason.trim()
  if (diff.ops.some((o) => o.kind === 'status') && !trimReason) {
    const errMsg =
      '清单状态变更必须说明理由：请在 task_plan 的 reason 字段写明依据（如「已跑 npm test 通过」「用户确认了方案」），再重新提交完整清单。'
    logger.warn('Agent', `${source} 状态变更缺理由，已拒绝`, taskId)
    return { ok: false, errorMessage: errMsg, changed: 0, total: current?.items.length ?? 0, summary: '', graphSyncDegraded: false }
  }
  if (diff.ops.some((o) => o.kind === 'create') && !trimReason) {
    const errMsg =
      'replan / 新增任务必须说明依据：请在 task_plan 的 reason 字段写明本轮目标与新增理由（基于什么新信息或证据），再重新提交完整清单。'
    logger.warn('Agent', `${source} replan 缺依据，已拒绝`, taskId)
    return { ok: false, errorMessage: errMsg, changed: 0, total: current?.items.length ?? 0, summary: '', graphSyncDegraded: false }
  }

  // ③ 落库（plan-commit 唯一写入口）
  const res = await mutate(
    taskId,
    { kind: 'plan-commit', layout: diff.layout, reason: reason || diff.summary || '模型提交完整清单', source },
    { actor: source },
  )
  if (!res.ok) {
    const errMsg = `清单被任务清单引擎拒绝：${res.error?.message ?? '未知原因'}`
    logger.warn('Agent', `${source} 落库被拒：${errMsg}`, taskId)
    return { ok: false, errorMessage: errMsg, changed: 0, total: current?.items.length ?? 0, summary: '', graphSyncDegraded: false }
  }

  // ④ 清零门禁拒绝计数（唯一清零点 touch-sync，纪律⑧）
  //
  // v0.39.0（D180）：此前这里 `.catch(() => {})` 静默吞失败 —— 计数不清零，
  // 于是下一次收尾直接命中 over-limit 放行，TREE_SYNC / UNFINISHED / ARTIFACT
  // 三道判据**全部失效**（fail-open）。清单已经生效、工具也已向模型返回成功，
  // 这里失败必须留人话，否则日志里什么都查不到。
  try {
    const syncRes = await mutate(taskId, { kind: 'touch-sync' }, { actor: source })
    if (!syncRes.ok) {
      logger.warn('Agent', `${source} 门禁计数清零失败：${syncRes.error?.message ?? '未知'}`, taskId)
    }
  } catch (err) {
    logger.warn('Agent', `${source} 门禁计数清零异常：${(err as Error).message}`, taskId)
  }

  // ⑤ 图镜像下推（结构对账；失败只降级告警，不阻断、不回写清单）
  const fresh = await loadLedger(taskId)
  const freshItems = fresh?.items ?? []
  let graphSyncDegraded = false
  if (task.graphId) {
    try {
      const syncRes = await reconcilePlanItemsToGraph(
        { taskId, graphId: task.graphId, iteration },
        freshItems.map((it) => ({ id: it.id, text: it.text, status: TO_PLAN_STATUS[it.status] })),
        source,
        reason || diff.summary || undefined,
        // v0.43.0（R1）：本轮目标简介下推 graph.goal（轮次晋升时账本 goal 已更新）
        fresh?.goal || undefined,
      )
      if (!syncRes.ok) {
        graphSyncDegraded = true
        logger.warn('Agent', `${source} 图对账失败（清单账本已生效，图通道降级）：${syncRes.error?.message ?? 'unknown'}`, taskId)
      }
    } catch (err) {
      graphSyncDegraded = true
      logger.warn('Agent', `${source} 图对账异常（清单账本已生效，图通道降级）：${(err as Error).message}`, taskId)
    }
  }

  // ⑥ 自动阶段结论（P7 触发点①：不依赖模型自觉汇报）
  if (diff.changed > 0) {
    // v0.43.0（R5）：replan 依据回执 —— 含新建项且**提交前已有项**（真 replan）
    // 时，把依据展示在交互区，用户据此判断「凭什么改计划」。
    const creates = diff.ops.filter((o) => o.kind === 'create').length
    const replanNote = buildReplanNote(creates, (current?.items.length ?? 0) > 0, reason)
    if (replanNote) {
      await emitTurnNote({ taskId, iteration, text: replanNote, via: 'plan-commit' })
    }
    const nextDoing = freshItems.find((it) => it.status === 'running')?.text
    const noteText = buildPlanCommitNote(diff, nextDoing)
    if (noteText) {
      await emitTurnNote({ taskId, iteration, text: noteText, via: 'plan-commit' })
    }
  }

  // ⑦ v0.43.1（D216）：**重排计划卡** —— 含新建项的落库成功后，向交互区补发一条
  // `type:'plan'` 步骤（broadcastStep 自带 persistStep 持久化 + task:step 实时推送）。
  //
  // 为什么必须有这一步：交互区的计划卡来自 plan 步骤，而全仓唯一发射点此前只有
  // 开局计划（run-setup.ts）。规划通道重排 / 用户新指令 / plan-ops / 模型换计划
  // 都只改账本不发声 —— 旧卡因投影层数量相等守卫（planStatesOf：实时条数 ==
  // 卡片条数才同源刷新状态）永冻结在提交时刻（实机：重排 9→12 后旧卡停在 0/9，
  // 与右侧面板 12/12 完成直接矛盾）。
  // 发新卡后，新卡条数 == 实时 planItems → 数量守卫天然成立，新卡实时同源刷新；
  // 旧卡保留为历史（v0.30.2 既定语义）。纯状态提交（无新建项）不发卡（负腿
  // TC-PLANCARD-002）；plan.goal 取账本轮次目标（与面板标题同源，R1）。
  if (freshItems.length > 0 && diff.ops.some((o) => o.kind === 'create')) {
    try {
      await broadcastStep({
        id: genId('step'),
        taskId,
        iteration,
        type: 'plan',
        startedAt: Date.now(),
        durationMs: 0,
        status: 'success',
        plan: {
          goal: fresh?.goal || reason || diff.summary,
          items: freshItems.map((it) => it.text),
          parentIds: freshItems.map((it) => it.parentId),
          useResources: [],
          skipResources: [],
        },
      })
    } catch (err) {
      // 降级留痕（纪律⑨）：账本已生效，仅交互区少一张卡，不阻断管线结果。
      logger.warn('Agent', `重排计划卡广播失败（账本已生效，仅交互区少一张卡）：${(err as Error).message}`, taskId)
    }
  }

  logger.info('Agent', `${source}(ledger): changed=${diff.changed} r${res.revision}`, taskId)
  return {
    ok: true,
    changed: diff.changed,
    total: freshItems.length,
    summary: diff.summary,
    graphSyncDegraded,
    revision: res.revision,
    diff,
    warnings: res.warnings,
  }
}
