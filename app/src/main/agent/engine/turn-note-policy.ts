/* ============================================================
 * ArkWork — 阶段结论投递策略（v0.38.0 / D156）
 * 设计文档：docs/versions/v0.38.0/04-system-design.md §6.5 / §3-interaction §三
 *
 * 为什么要有这个文件：
 *   现场形态是"模型连续推理 8 轮无任何输出，然后一次性给最终结果"——用户无法区分
 *   "推进中"与"卡住"。实测原因是**缺少过程输出出口**：模型没有义务中途汇报，
 *   引擎也没有任何机制要求它。
 *
 *   本模块给两条互补的出口：
 *     ① 自动：计划提交里出现 done 转移 → 引擎直接生成一条结论（不依赖模型自觉）；
 *     ② 兜底：连续 N 轮既无计划提交也无结论 → 注入"请说明进展"指令。
 *
 * 硬规则：纯函数、叶子模块（只依赖 ledger/plan-diff 的类型）。
 * ============================================================ */
import type { PlanDiffResult } from '../ledger/plan-diff.js'

/**
 * 连续多少轮"既没提交计划、也没投递结论"时，强制要求模型产出阶段结论。
 * 取 4 的理由：现场"8 轮无输出"是可观测的坏体验；4 轮已能保证 10 轮以上任务
 * 至少出现 2 次结论，同时不至于让每个只读轮都被打扰。
 */
export const MAX_ROUNDS_WITHOUT_NOTE = 4

export interface NotePolicyState {
  /** 距上次"有输出"已过的轮数 */
  roundsSinceNote: number
}

/** 本轮发生的事情（由 loop 统计） */
export interface NotePolicyInput {
  /** 本轮是否提交过计划（task_plan） */
  plan: boolean
  /** 本轮是否投递过结论（turn_note） */
  note: boolean
}

export interface NotePolicyResult {
  /** true → 本轮应注入"请说明当前进展"指令 */
  inject: boolean
  /** 推进后的状态（调用方须回写） */
  state: NotePolicyState
}

export function createNotePolicyState(): NotePolicyState {
  return { roundsSinceNote: 0 }
}

/**
 * 推进节流计数器。
 * - 本轮有输出（plan 或 note）→ 归零，不注入；
 * - 否则计数 +1；达到上限 → 注入并要求调用方把计数归零（防刷屏）。
 */
export function advanceNotePolicy(state: NotePolicyState, calledThisRound: NotePolicyInput): NotePolicyResult {
  if (calledThisRound.plan || calledThisRound.note) {
    return { inject: false, state: { roundsSinceNote: 0 } }
  }
  const next = state.roundsSinceNote + 1
  if (next >= MAX_ROUNDS_WITHOUT_NOTE) {
    return { inject: true, state: { roundsSinceNote: 0 } }
  }
  return { inject: false, state: { roundsSinceNote: next } }
}

/**
 * 由计划提交的差异生成**自动**阶段结论。
 *
 * 只在"有项转为 done"时返回文案（其余变更不打扰用户 —— 新增/改状态属于过程细节，
 * 用户能在清单面板看到）。返回 null 表示本轮不投递。
 *
 * @param nextDoingText 下一个进行中项的文本（可选）；由调用方从账本读取后传入，
 *        使本函数保持纯函数（不需要 IO）。
 */
export function buildPlanCommitNote(diff: PlanDiffResult, nextDoingText?: string): string | null {
  if (diff.changed === 0) return null
  const done = diff.ops.filter((o) => o.kind === 'status' && o.to === 'done')
  if (done.length === 0) return null

  const names = done.map((o) => `「${o.text.slice(0, 30)}」`).join('、')
  return nextDoingText
    ? `已完成 ${names}，接下来 ${nextDoingText.slice(0, 40)}。`
    : `已完成 ${names}。`
}
