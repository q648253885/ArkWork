/* ============================================================
 * ArkWork — 清单操作通道的轮次接线（v0.40.0）
 * 设计文档：docs/versions/v0.40.0/04-system-design.md §七（O1–O7）
 *
 * 为什么单独一个文件：
 *   `loop.ts` 已经 1800+ 行。再往里塞一段「读账本 → 选操作 → 发请求 →
 *   解析 → 落库」只会让接线更容易被 `continue` 跳过（D179 的病根就是
 *   判定块被埋在分支里）。独立成模块后：
 *     · 策略与 IO 边界清晰，**可注入 `completeFn` 跑成单测**（纪律⑫）；
 *     · loop 只有两处调用点（轮首 O2、空回合 O7），顺序一眼可验。
 *
 * 边界（与 `04-system-design.md` §一 的三条硬边界一致）：
 *   ① 只写清单，不产生任何工具副作用；
 *   ② 失败静默回落，**绝不**阻断主循环（除用户中止）；
 *   ③ 落库只经 `commitPlanDraft`（纪律⑧，不存在第二写入口）。
 * ============================================================ */
import type { Task } from '@shared/types/task'
import type { PlanDraftItem } from '../ledger/plan-diff.js'
import type { PlanOpsKind, PlanOpsState } from '../planning/ops/types.js'
import {
  initPlanOpsState,
  notePlanOpsRun,
  pickPlanOpsKind,
  shouldRunPlanOps,
  keepOnlyPreviouslyDone,
} from '../planning/ops/policy.js'
import { runPlanOps, getPlanOpsModelId, type PlanOpsLlmInput, type PlanOpsLlmOutput } from '../planning/ops/runner.js'
import { draftFingerprint } from '../planning/policy.js'
import { loadLedger } from '../ledger/engine.js'
import { commitPlanDraft } from './plan-commit-pipeline.js'
import { emitTurnNote } from './gate-channel.js'
import { logger } from '../../system/logger.js'

/** 上一轮的客观事实 —— tick 据此决定「该问什么」。刻意不含主观推测。 */
export interface PlanOpsSignals {
  /** 连续失败次数（与 W2 的 `failureDigest[].attempts` 同口径） */
  failedCount: number
  /** 距上次触碰清单的轮数（= loop 的 `itersSinceTreeTouch`） */
  staleRounds: number
  /** 上一轮有工具**执行成功**（有实质进展） */
  justSucceeded: boolean
  /** 上一轮只有正文、没有工具调用（弱模型常态；真机见 `policy.ts` 的 hadProse 注释） */
  hadProse: boolean
  /** 用户取消 / 项被判不需要 */
  cancelRequested: boolean
  /** 上一轮是空响应（D197 路径） */
  emptyRound: boolean
}

export interface PlanOpsTickInput {
  task: Task
  /** 当前轮次（iteration） */
  round: number
  modelId: string
  signal: AbortSignal
  state: PlanOpsState
  signals: PlanOpsSignals
  /** 上一轮发生了什么（人话，喂给 prompt 的 `event`） */
  event: string
  /** 任务目标；缺省取 `task.input.text` */
  goal?: string
  /**
   * 测试注入点：不传则走真实 adapter（纪律⑫）。
   * 有它才能在无网环境下把「一次完整的清单推进」跑成单测。
   */
  completeFn?: (input: PlanOpsLlmInput) => Promise<PlanOpsLlmOutput>
}

export interface PlanOpsTickResult {
  state: PlanOpsState
  /** 是否真的改了清单（changed > 0） */
  changed: boolean
  /** 实际执行的操作；`null` = 本轮不调用 */
  kind: PlanOpsKind | null
  /** 跳过 / 失败的原因（诊断通道用） */
  reason: string
}

/**
 * 一次清单推进尝试。
 *
 * **永不抛**（除用户中止）：任何异常都在这里收敛成 `{ changed: false }`，
 * 让主循环照常往下走 —— 清单维护是**增强**，不是主流程的前置条件（PRD K2）。
 */
export async function planOpsTick(input: PlanOpsTickInput): Promise<PlanOpsTickResult> {
  const { task, round, modelId, signal, signals, event, completeFn } = input
  let state = input.state ?? initPlanOpsState()

  let items: Array<{ id: string; text: string; status: string; parentId?: string | null }> = []
  try {
    const ledger = await loadLedger(task.id)
    items = (ledger?.items ?? []).map((it) => ({
      id: it.id,
      text: it.text,
      status: String(it.status),
      parentId: (it as { parentId?: string | null }).parentId ?? null,
    }))
  } catch (err) {
    // 账本读不到 = 没有可维护的对象；静默回落，不动主循环
    logger.warn('Agent', `plan-ops tick skipped (ledger unreadable): ${(err as Error).message}`, task.id)
    return { state, changed: false, kind: null, reason: 'ledger-unreadable' }
  }

  const kind = pickPlanOpsKind({
    round,
    hasPlan: items.length > 0,
    failedCount: signals.failedCount,
    staleRounds: signals.staleRounds,
    justSucceeded: signals.justSucceeded,
    hadProse: signals.hadProse,
    cancelRequested: signals.cancelRequested,
    emptyRound: signals.emptyRound,
  })
  if (!kind) return { state, changed: false, kind: null, reason: 'no-signal' }

  const fingerprint = draftFingerprint(items.map((i) => ({ text: i.text, status: i.status as 'todo' })))
  // create / cancel 是一次性收尾动作，豁免轮间隔；
  // 空回合的 update 同样豁免（它是「清单不能停摆」的最后一道兜底）。
  const force = kind === 'create' || kind === 'cancel' || signals.emptyRound
  const gate = shouldRunPlanOps({ state, kind, round, fingerprint, force })
  if (!gate.run) return { state, changed: false, kind, reason: gate.reason }

  state = notePlanOpsRun(state, kind, round, fingerprint)

  try {
    const res = await runPlanOps({
      req: {
        kind,
        taskId: task.id,
        goal: input.goal ?? task.input?.text ?? '（未给出目标）',
        snapshot: renderSnapshot(items),
        event,
      },
      modelId: await getPlanOpsModelId(modelId),
      signal,
      ...(completeFn ? { completeFn } : {}),
    })
    if (!res.ok || res.draft.length === 0) {
      // 失败原因已由 runner 落日志（含原文摘要）；此处不打扰主循环
      return { state, changed: false, kind, reason: res.skipped ?? 'unparsable' }
    }
    // D206：落库前过滤「新标 done」——只允许保留已完成状态，不许宣告新完成
    const { draft: guarded, downgraded } = keepOnlyPreviouslyDone(res.draft, items, kind)
    if (downgraded > 0) {
      logger.warn(
        'Agent',
        `plan-ops ${kind}: ${downgraded} 项自称完成但无确认证据 → 降级为待做（D181/D206 精神）`,
        task.id,
      )
    }
    const committed = await commitPlanDraft({
      task,
      iteration: round,
      draft: guarded,
      reason: `清单由引擎独立维护（${kind}）：${res.summary}`,
      source: 'planner',
    })
    if (!committed.ok || committed.changed === 0) {
      return { state, changed: false, kind, reason: 'no-change' }
    }
    logger.info('Agent', `plan-ops ${kind} 生效：${res.summary} → changed=${committed.changed}`, task.id)
    await emitTurnNote({
      taskId: task.id,
      iteration: round,
      text: `已按进展更新任务清单（${kindLabel(kind)}）：${committed.summary || res.summary}`,
      // 'plan-revision' = 清单被修订（既有枚举，不新增 —— UI 徽标的事实源只有一个）
      via: 'plan-revision',
    })
    return { state, changed: true, kind, reason: 'ok' }
  } catch (err) {
    // C6：用户中止必须原样上抛 —— 吞掉它会让「停止」按钮失灵
    if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err
    logger.warn('Agent', `plan-ops ${kind} aborted: ${(err as Error).message}`, task.id)
    return { state, changed: false, kind, reason: 'error' }
  }
}

/** 清单快照（给模型看的形态：序号 + 状态 + 文本，子项缩进） */
function renderSnapshot(items: Array<{ id: string; text: string; status: string; parentId?: string | null }>): string {
  if (items.length === 0) return '（当前没有任何任务）'
  const roots = items.filter((i) => !i.parentId)
  const childrenOf = (id: string) => items.filter((i) => i.parentId === id)
  const lines: string[] = []
  roots.forEach((r, ri) => {
    lines.push(`  ${ri + 1}. [${r.status}] ${r.text.slice(0, 60)}`)
    childrenOf(r.id).forEach((c, ci) => {
      lines.push(`    ${ri + 1}.${ci + 1} [${c.status}] ${c.text.slice(0, 60)}`)
    })
  })
  return lines.join('\n')
}

function kindLabel(kind: PlanOpsKind): string {
  switch (kind) {
    case 'create':
      return '新建清单'
    case 'update':
      return '同步进展'
    case 'complete':
      return '确认完成'
    case 'cancel':
      return '收尾'
    case 'replan':
      return '重新规划'
  }
}

/** 供 loop 初始化状态 */
export { initPlanOpsState }
export type { PlanDraftItem }
