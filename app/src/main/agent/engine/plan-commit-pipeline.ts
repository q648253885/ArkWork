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
import { diffPlan, type PlanDiffResult, type PlanDraftItem } from '../ledger/plan-diff.js'
import { loadLedger, ensureLedger, mutate } from '../ledger/engine.js'
import { TO_PLAN_STATUS } from '../ledger/project.js'
import type { Task } from '../../../shared/types/task'
import { reconcilePlanItemsToGraph } from '../graph/plan-sync.js'
import { emitTurnNote } from './gate-channel.js'
import { buildPlanCommitNote } from './turn-note-policy.js'

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
    const nextDoing = freshItems.find((it) => it.status === 'running')?.text
    const noteText = buildPlanCommitNote(diff, nextDoing)
    if (noteText) {
      await emitTurnNote({ taskId, iteration, text: noteText, via: 'plan-commit' })
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
  }
}
