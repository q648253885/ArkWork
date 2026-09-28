/* ============================================================
 * ArkWork — 规划通道预算与冷却（v0.39.0 · F1）
 *
 * 为什么把策略抽成纯函数：
 *   规划通道是一次**额外的** LLM 调用。没有预算就会变成「每轮都规划」
 *   （token 与时延翻倍），过严则永远轮不到它。策略与 IO 分离后，
 *   阈值可以用穷举真值表钉死，改动一眼可验。
 * ============================================================ */
import type { PlanDraftItem } from '../ledger/plan-diff.js'
import type { PlannerTrigger } from './types.js'
import type { PlannerSkipReason } from './types.js'

/** 放行原因与跳过原因共用一张真值表，便于穷举 */
export type PlannerGateReason = PlannerSkipReason | 'ok'
import {
  MAX_PLANNER_PASSES_PER_RUN,
  MAX_REGEX_COMMITS_PER_RUN,
  PLANNER_COOLDOWN_MS,
} from './types.js'

export interface PlannerRunState {
  /** 本 run 已发生的规划调用次数 */
  passes: number
  /** 每个 trigger 上次触发的时间戳（ms） */
  lastAt: Partial<Record<PlannerTrigger, number>>
  /** 上次产出的清单指纹（用于幂等） */
  lastFingerprint?: string
  /** 本 run 已由「无工具应答的文本解析」代为落库的次数 */
  regexCommits: number
}

export function initPlannerState(): PlannerRunState {
  return { passes: 0, lastAt: {}, regexCommits: 0 }
}

/** 清单指纹 —— 只看「要做什么」与「现在什么状态」，不看 note / id / 时间戳 */
export function draftFingerprint(draft: readonly PlanDraftItem[]): string {
  return draft
    .map((d) => `${d.text.trim().slice(0, 40)}|${d.status}`)
    .join('§')
}

/**
 * 是否应该发起一次规划调用。
 *
 * 判定顺序（先命中先返回）：预算 → 冷却（failure 豁免）→ 幂等 → 放行。
 */
export function shouldRunPlanner(args: {
  state: PlannerRunState
  trigger: PlannerTrigger
  now: number
  fingerprint: string
}): { run: boolean; reason: PlannerGateReason } {
  const { state, trigger, now, fingerprint } = args
  if (state.passes >= MAX_PLANNER_PASSES_PER_RUN) return { run: false, reason: 'budget' }
  // failure 不受冷却约束：失败是当前最需要立刻重新思考的时刻，
  // 让它等 15 秒等于把用户的任务拖死。
  if (trigger !== 'failure') {
    const last = state.lastAt[trigger]
    if (last !== undefined && now - last < PLANNER_COOLDOWN_MS) return { run: false, reason: 'cooldown' }
  }
  if (state.lastFingerprint && state.lastFingerprint === fingerprint) {
    return { run: false, reason: 'duplicate' }
  }
  return { run: true, reason: 'ok' }
}

/** 记一次调用结果（返回新 state；纯函数，便于测试） */
export function notePlannerRun(
  state: PlannerRunState,
  trigger: PlannerTrigger,
  now: number,
  fingerprint: string,
): PlannerRunState {
  return {
    ...state,
    passes: state.passes + 1,
    lastAt: { ...state.lastAt, [trigger]: now },
    lastFingerprint: fingerprint,
  }
}

/**
 * 无工具应答里提取到的清单，是否可以代为落库（D179/D182 的顺序与频控收口）。
 *
 * 为什么必须放在这里而不是散在 loop 里：这四个条件（对话级 / 伪调用 /
 * 停滞已达 griefing 阈值 / 每 run 上限）此前各自在 loop 的不同位置判断，
 * 是「顺序错乱/条件遗漏」的温床（D179 的根因形态）。
 */
export function shouldCommitRegexDraft(args: {
  chatMode: boolean
  pseudoHit: boolean
  noToolStallHit: boolean
  regexCommits: number
}): boolean {
  if (args.chatMode) return false // D182：对话级任务的解释性答复不算清单
  if (args.pseudoHit) return false // D179：先把「伪调用」当伪调用处理，不许被解析救场
  if (args.noToolStallHit) return false // 停滞已达阈值 → 让既有有界暂停先生效
  return args.regexCommits < MAX_REGEX_COMMITS_PER_RUN
}
