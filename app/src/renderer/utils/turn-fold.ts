/* ============================================================
 * ArkWork — 交互区轮次折叠（v0.34.0 · D52）
 *
 * 背景（用户实测）：小模型空转时每轮都往交互区追加步骤卡（内容全空），
 * 页面高度持续增长 —— 「交互区一直在变化增加距离」。
 * 根因是渲染层对轮数**没有上限**。本模块给出折叠区间计算：
 * 只保留最近 `threshold` 轮，更早的折叠成一条摘要条（可展开）。
 *
 * 为什么只折叠「更早的轮」而不是虚拟滚动：动效/贴底跟随/滚动锚点
 * （scroll-to-tool / scroll-to-plan-step）都依赖真实 DOM 存在，
 * 折叠是成本最低且不破坏这些机制的方案（设计 §2.4）。
 *
 * 纯函数、零依赖：可直接密闭单测（TC-FOLD 组）。
 * ============================================================ */

/** 超过该轮数即触发折叠（只保留最近的） */
export const TURN_FOLD_THRESHOLD = 30

export interface TurnFoldRange {
  /** 被折叠的轮数（0 表示不折叠） */
  hiddenCount: number
  /** 可见区间的起始下标（对 turns 数组切片用） */
  startIndex: number
}

/**
 * 计算折叠区间。
 *
 * @param total    当前轮总数
 * @param expanded 用户是否手动展开（展开态永不折叠）
 * @param threshold 折叠阈值（缺省 TURN_FOLD_THRESHOLD）
 *
 * 边界：total ≤ threshold → 不折叠；threshold ≤ 0 → 全部折叠
 *  （startIndex = total，调用方须同时渲染折叠条，避免空白）。
 *
 * **脏输入一律「失败开放」（不折叠、全显示）**：NaN / Infinity 阈值、
 * 负数或 NaN 的 total 都不是正常输入，此时把内容藏起来比多显示更糟
 * （`slice(NaN)` 会退化成 `slice(0)`，但 `hiddenCount=NaN` 会渲染出
 * 「已折叠 NaN 轮」这种可见缺陷 —— 因此必须显式归一，不能听任传播）。
 */
export function foldTurnRange(
  total: number,
  expanded: boolean,
  threshold: number = TURN_FOLD_THRESHOLD,
): TurnFoldRange {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  // 非有限阈值 → 视为「永不超过」 → 不折叠（失败开放）
  const t = Number.isFinite(threshold) ? Math.max(0, Math.floor(threshold)) : Number.POSITIVE_INFINITY
  if (expanded || n <= t) return { hiddenCount: 0, startIndex: 0 }
  return { hiddenCount: n - t, startIndex: n - t }
}
