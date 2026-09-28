/* ============================================================
 * ArkWork — 清单操作通道预算与触发策略（v0.40.0）
 * 设计文档：docs/versions/v0.40.0/04-system-design.md §五
 *
 * 为什么把策略抽成纯函数（与 v0.39.0 planning/policy.ts 同款理由）：
 *   清单操作通道是一次**额外的** LLM 调用。没有预算就会变成「每轮都问」
 *   （token 与时延翻倍），过严则永远轮不到它。策略与 IO 分离后，
 *   阈值可以用穷举真值表钉死，改动一眼可验。
 * ============================================================ */
import type { PlanDraftItem } from '../../ledger/plan-diff.js'
import type { PlanOpsKind, PlanOpsSkipReason, PlanOpsState } from './types.js'
import {
  MAX_PLAN_OPS_PER_RUN,
  PLAN_OPS_MIN_ROUND_GAP,
  PLAN_OPS_STALE_ROUNDS,
  PLAN_OPS_FAILURE_THRESHOLD,
} from './types.js'

export type PlanOpsGateReason = PlanOpsSkipReason | 'ok'

/**
 * 放行原因与跳过原因共用一张真值表，便于穷举。
 *
 * 状态是**只读**的：所有函数返回新对象，便于在单测里穷举序列。
 */
export function initPlanOpsState(): PlanOpsState {
  return { passes: 0, lastRound: {}, lastFingerprint: undefined }
}

/**
 * 是否应该发起一次清单操作调用。
 *
 * 判定顺序（先命中先返回）：**预算 → 轮间隔 → 幂等 → 放行**。
 *
 * 顺序为什么是这个：
 *   · 预算在最前 —— 它是唯一「绝对」的限制，达上限后任何豁免都不能越过
 *     （O7 的 `force` 只豁免轮间隔，就是为了让空回合不会变成无限调用）；
 *   · 幂等只对 `update` 生效 —— `complete` / `cancel` / `replan` 即使清单
 *     文本没变也要问（它们要的是「判定」，不是「新文本」）。
 */
export function shouldRunPlanOps(args: {
  state: PlanOpsState
  kind: PlanOpsKind
  /** 当前轮次（iteration） */
  round: number
  /** 当前清单指纹（由调用方用 `planning/policy.ts` 的 `draftFingerprint` 求） */
  fingerprint: string
  /** 一次性操作（create / cancel）豁免轮间隔 */
  force?: boolean
}): { run: boolean; reason: PlanOpsGateReason } {
  const { state, kind, round, fingerprint } = args
  if (state.passes >= MAX_PLAN_OPS_PER_RUN) return { run: false, reason: 'budget' }
  if (!args.force) {
    const last = state.lastRound[kind]
    if (last !== undefined && round - last < PLAN_OPS_MIN_ROUND_GAP) {
      return { run: false, reason: 'cooldown' }
    }
  }
  if (kind === 'update' && state.lastFingerprint !== undefined && state.lastFingerprint === fingerprint) {
    return { run: false, reason: 'duplicate' }
  }
  return { run: true, reason: 'ok' }
}

/** 记一次调用结果（返回新 state；纯函数，便于测试） */
export function notePlanOpsRun(
  state: PlanOpsState,
  kind: PlanOpsKind,
  round: number,
  fingerprint: string,
): PlanOpsState {
  return {
    passes: state.passes + 1,
    lastRound: { ...state.lastRound, [kind]: round },
    lastFingerprint: fingerprint,
  }
}

/**
 * 本轮该跑哪一类操作（先命中先返回）。
 *
 * 返回 `null` = 本轮不调用。
 */
export function pickPlanOpsKind(args: {
  round: number
  /** 清单是否为空 */
  hasPlan: boolean
  /** 连续失败次数 */
  failedCount: number
  /** 距上次触碰清单的轮数 */
  staleRounds: number
  /** 上一轮有工具**执行成功** */
  justSucceeded: boolean
  /**
   * 上一轮只有正文、没有工具调用（**弱模型的常态**）。
   *
   * v0.40.0 真机发现（`T-20260928-4t5z6k`，本地 `qwen3.5:0.8b`）：
   * 只凭 `justSucceeded` 判定时，弱模型**永远不触发**清单维护 —— 它从不调工具，
   * 于是 `justSucceeded` 恒 false、`emptyRound` 也 false（它有正文，不是空回合），
   * 一路烧到 D168 的 6 轮暂停，清单停在初始状态（实测 `plan-ops` 日志**零命中**）。
   *
   * 而「模型在用正文干活」恰恰是**其他 agent 都能正常交互**的原因 ——
   * 它们把正文当产出解析（Cline 范式）。所以这里必须把它算作一种进展信号。
   */
  hadProse: boolean
  /** 用户取消 / 项被判不需要 */
  cancelRequested: boolean
  /** 上一轮是空响应（D197 路径） */
  emptyRound: boolean
}): PlanOpsKind | null {
  // 取消优先：收尾形态必须留痕，不能让清单留一堆悬空的 doing
  if (args.cancelRequested) return 'cancel'
  // 没有清单就无从推进（开局或清单被整体作废）
  if (!args.hasPlan) return 'create'
  // 连续失败 → 重排（与 W2 同判据，出口统一到 PlanOps）
  if (args.failedCount >= PLAN_OPS_FAILURE_THRESHOLD) return 'replan'
  // 陈旧 → 重排（与 D126 的 itersSinceTreeTouch 同判据）
  if (args.staleRounds >= PLAN_OPS_STALE_ROUNDS) return 'replan'
  // 空回合 → 兜底推进（D201：不能因为模型空响应就让清单停摆）
  if (args.emptyRound) return 'update'
  // 工具执行成功：偶数轮确认完成、奇数轮同步清单。
  // 交替是为了避免连续两轮撞上「同类操作的轮间隔」而白等。
  if (args.justSucceeded) return args.round % 2 === 0 ? 'complete' : 'update'
  // 只有正文（弱模型常态）→ 一律 `update`，**不走 complete**：
  // `complete` 要求「有可核对的结果」，光说话不构成完成证据（prompt 里明写）。
  if (args.hadProse) return 'update'
  return null
}

/* ---------------- 落库前的完成态过滤（D206） ---------------- */

/** 文本归一化键 —— 只用来做「是不是同一项」的比对，不参与展示 */
export function planItemKey(text: string): string {
  return text.replace(/[\s\p{P}]/gu, '').slice(0, 24).toLowerCase()
}

/**
 * 过滤「本次**新标** done」的项 —— 只保留**当前清单里已经是 done** 的那些（D206）。
 *
 * 为什么需要：
 *   `update` 必须放行 `done`（否则模型「输出完整清单」会把已完成项回退成待做 ——
 *   清单倒退，见 `runner.ts` 的 `allowDoneFor`）。但放行有真实副作用 —— 实测
 *   （打包 0.40.0 + 本地 `qwen3.5:0.8b`，第三轮真机验收）模型把**五项全部标成
 *   `done`**，而任务实际什么都没产出、`summary` 为空：又一次「静默假成功」
 *   （与 D197 同族 —— 本仓最危险的缺陷种类）。
 *
 * 规则（与 D181 的精神一致 —— 引擎不代模型宣告完成，也不许模型自证完成）：
 *   · `create` / `update` / `replan`：**只允许保留**已完成状态，不许**宣告**新完成；
 *   · `complete` / `cancel`：不过滤 —— 前者职责就是确认完成，后者要保留既有 done。
 *
 * @returns 过滤后的草案（新标 done 的项降级为 `todo` 并留 note 说明原因）
 */
export function keepOnlyPreviouslyDone(
  draft: readonly PlanDraftItem[],
  current: ReadonlyArray<{ text: string; status: string }>,
  kind: PlanOpsKind,
): { draft: PlanDraftItem[]; downgraded: number } {
  if (kind === 'complete' || kind === 'cancel') return { draft: draft.slice(), downgraded: 0 }
  if (!draft.some((d) => d.status === 'done')) return { draft: draft.slice(), downgraded: 0 }
  const alreadyDone = new Set(current.filter((i) => i.status === 'done').map((i) => planItemKey(i.text)))
  let downgraded = 0
  const out = draft.map((d) => {
    if (d.status !== 'done' || alreadyDone.has(planItemKey(d.text))) return d
    downgraded += 1
    return {
      ...d,
      status: 'todo' as PlanDraftItem['status'],
      note: d.note ? `${d.note}｜未经完成确认，降级为待做` : '未经过完成确认，降级为待做',
    }
  })
  return { draft: out, downgraded }
}
