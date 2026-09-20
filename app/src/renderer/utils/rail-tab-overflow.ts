/* ============================================================
 * ArkWork — 竖排 Tab 栏「铺满才折叠」（v0.34.3 · D58）
 *
 * 规格来源：docs/versions/v0.34.3/04-system-design.md §D58
 *
 * ★ 本版为什么再改一次（口径纠正，不是修 bug）：
 *   v0.34.2（D56-c）把用户的两句话读成了一条「双条件」规则：
 *       **可见条数 = min(名称上限 3, 可用高度能容纳的条数)**
 *   其中「≤3」被当成**用户的硬偏好**。用户本版给出真正的规则（实测原文）：
 *
 *       「在**铺满**的时候才有更多」
 *
 *   即：**「超过三个会挤压溢出」是对症状的描述，不是对数量的偏好** ——
 *   她的窗口恰好只能放 3 个，多了就溢出；而「>3」这个数字被误当成了偏好上限。
 *   后果很直接：在有 9 个名称、窗口却完全放得下时，仍然被强行折叠出「更多」。
 *
 *   故本版规则收敛为**单条件、纯高度驱动**：
 *
 *       **只有放不下，才折叠；折叠出来的部分才进「更多」。**
 *
 *     ① 放得下（`itemsHeight(total) ≤ usable`）→ 一条都不收，「更多」不出现；
 *     ② 放不下 → 先给「更多」触发器留位，再按剩余高度算能放几条；
 *     ③ 未测量（首帧 / 无 ResizeObserver / jsdom）→ **不折叠**（全显示）。
 *        既然规则是「铺满才折叠」，那么「还没量到高度」就**不能假定已铺满**；
 *        多渲染一条由 `.inspector-toolbar` 的 `overflow-y: auto` 兜底，
 *        而凭空冒出一个「更多」是更糟的假象。
 *
 *   想回到「≤3 硬上限」只有一处实参：`computeRailLayout({ …, maxVisible: 3 })`。
 *   `MAX_VISIBLE_NAMES` 常量保留导出（标 @deprecated）仅为不破坏历史 import。
 *
 * 代价与补偿（写在代码里，避免后来者以为是遗漏）：
 *   · 内置 Tab 也会被折叠 —— 但 ⌥1~⌥6 快捷键**不依赖可见性**（切 Tab 走
 *     `setInspectorTab`，与竖排栏渲染解耦），且「更多」弹层逐项列出完整名称
 *     + 快捷键，肌肉记忆靠键位而非像素位置保留；
 *   · 当前激活的面板**永远可见** —— `pickVisibleTabs` 会把激活项换进可见段，
 *     否则用户在「更多」里点完，竖排栏上找不到自己点的是哪一个。
 *
 * 纯函数、零依赖：可直接密闭单测（TC-OVF 组）。
 * ============================================================ */

/* ---------- 尺寸常量：全部来自 Inspector 现有样式，改样式必须同步改这里 ---------- */

/** 竖排栏单条高度（`.inspector-toolbar__item` height/min-height: 64px） */
export const RAIL_ITEM_H = 64
/** 条目间距（`.inspector-toolbar` gap: 2px） */
export const RAIL_ITEM_GAP = 2
/** 竖排栏上下内边距（`.inspector-toolbar` padding: 6px 0 → 12px 合计） */
export const RAIL_PADDING_Y = 12
/** 底部整栏折叠按钮（h-9 = 36px） */
export const RAIL_COLLAPSE_BTN_H = 36
/** 「更多」触发器区块高度：mt-1(4) + pt-2(8) + h-9(36) */
export const RAIL_OVERFLOW_TRIGGER_H = 48
/** 「已隐藏区」区块基础高度（与触发器同构：mt-1 + pt-2 + 首项 h-9） */
export const RAIL_HIDDEN_BLOCK_BASE_H = 48
/** 「已隐藏区」每多一项的增量（h-9 + gap-1） */
export const RAIL_HIDDEN_ITEM_H = 40

/**
 * @deprecated v0.34.3（D58）起**不再参与判定** —— 用户口径已纠正为「铺满才折叠」
 * （纯高度驱动），数量上限被判定为对症状的误读。
 * 常量仅为不破坏历史 import 而保留；如需恢复硬上限，请给 `computeRailLayout`
 * 显式传 `maxVisible`（见 TC-OVF-016）。
 */
export const MAX_VISIBLE_NAMES = 3

/** `maxVisible` 缺省值：不限（只有高度说了算） */
export const DEFAULT_MAX_VISIBLE = Number.POSITIVE_INFINITY

/** n 条连续条目占用的高度（n ≤ 0 → 0；含条目间 gap） */
export function itemsHeight(n: number): number {
  const count = Math.max(0, Math.floor(n))
  if (count === 0) return 0
  return count * RAIL_ITEM_H + (count - 1) * RAIL_ITEM_GAP
}

/** 「已隐藏区」（被拖出竖排栏的内置 Tab）占用高度；0 项 → 0（该区块不渲染） */
export function hiddenBlockHeight(count: number): number {
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return 0
  return RAIL_HIDDEN_BLOCK_BASE_H + (n - 1) * RAIL_HIDDEN_ITEM_H
}

/* ---------- 折叠计算 ---------- */

export interface RailLayoutInput {
  /** 合并后的完整条目数（内置 + 面板） */
  total: number
  /**
   * 竖排栏可用高度（`clientHeight`）。
   * `null` / `NaN` / `<= 0` = **尚未测量**（首帧、测试环境、jsdom）→
   * **不折叠**（全显示）：规则是「铺满才折叠」，没量到高度就不能假定已铺满。
   */
  availableHeight: number | null
  /** 额外预留高度（已隐藏区；缺省 0） */
  reservedHeight?: number
  /**
   * 可见条数上限。
   * **缺省不限**（`DEFAULT_MAX_VISIBLE`）—— D58 口径纠正后数量不再是判据；
   * 显式传入（如 `3`）可恢复 v0.34.2 的「≤3 硬上限」，仅供口径回退与测试使用。
   */
  maxVisible?: number
}

export interface RailLayout {
  /** 直接渲染在竖排栏上的条数 */
  visibleCount: number
  /** 收进「更多」弹层的条数 */
  overflowCount: number
  /** 是否处于折叠态（等价于 overflowCount > 0） */
  collapsed: boolean
}

/** `maxVisible` 归一：缺省 / 非有限 → 不限；其余取 ≥1 整数 */
function normalizeMaxVisible(value: number | undefined): number {
  if (value === undefined || value === null) return DEFAULT_MAX_VISIBLE
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_MAX_VISIBLE
  if (value === Number.POSITIVE_INFINITY) return DEFAULT_MAX_VISIBLE
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.floor(value))
}

/**
 * 计算竖排栏可见条数。
 *
 * 规则（逐条有用例）：
 *  ① `total = 0` → 全 0、不折叠（空栏连「更多」都不该有）；
 *  ② **未测量**（`availableHeight` 非法）→ `visibleCount = total`、不折叠；
 *  ③ **放得下**（`itemsHeight(total) ≤ usable` 且 `total ≤ maxVisible`）→ 不折叠；
 *  ④ 否则折叠：先给「更多」触发器留位，再按剩余高度算能放几条；
 *  ⑤ 可见条数夹在 `[1, min(maxVisible, total)]` —— 至少留 1 条（只剩一个「更多」
 *     按钮的竖排栏没有意义），且绝不出现「负上限」；
 *  ⑥ 高度极矮（连 1 条 + 触发器都放不下）→ 仍给 1 条，由 `.inspector-toolbar`
 *     的 `overflow-y: auto` 兜底滚动（最后一层保险，不再是常规路径）。
 *
 * 不变式（用例把守）：`visibleCount + overflowCount ≡ total`；
 * `overflowCount > 0 ⟹ itemsHeight(total) > usable`（**「更多」只在铺满时出现**）；
 * `H` 递增则 `visibleCount` 不减（高度单调）。
 */
export function computeRailLayout(input: RailLayoutInput): RailLayout {
  const total = Math.max(0, Math.floor(input.total))
  if (total === 0) return { visibleCount: 0, overflowCount: 0, collapsed: false }

  const H = input.availableHeight
  const measured = typeof H === 'number' && Number.isFinite(H) && H > 0

  // ② 未测量：不折叠（「铺满才折叠」⇒ 没量到高度就不能假定已铺满）
  if (!measured) {
    return { visibleCount: total, overflowCount: 0, collapsed: false }
  }

  const max = normalizeMaxVisible(input.maxVisible)
  const reserved = Math.max(0, Math.floor(input.reservedHeight ?? 0))
  const usable = (H as number) - RAIL_PADDING_Y - RAIL_COLLAPSE_BTN_H - reserved

  // ③ 放得下 → 一条都不收（「铺满的时候才有更多」）
  if (total <= max && itemsHeight(total) <= usable) {
    return { visibleCount: total, overflowCount: 0, collapsed: false }
  }

  // ④⑤⑥ 折叠：扣掉「更多」触发器（含它与上一项之间的 gap）后再算容量
  const usableForItems = usable - RAIL_OVERFLOW_TRIGGER_H - RAIL_ITEM_GAP
  const fit = Math.floor((usableForItems + RAIL_ITEM_GAP) / (RAIL_ITEM_H + RAIL_ITEM_GAP))
  const visibleCount = Math.max(1, Math.min(max, fit, total))
  return {
    visibleCount,
    overflowCount: total - visibleCount,
    collapsed: total - visibleCount > 0,
  }
}

/* ---------- 可见段选取（保证激活项可见） ---------- */

/**
 * 从合并序里挑出可见段与折叠段。
 *
 * 纪律：
 *   · 顺序**恒等于输入顺序**（既不重排内置，也不按 position 二次排序）；
 *   · `activeRef` 若落在折叠段 → 与可见段最后一位**对调**，保证当前面板的
 *     入口始终可见；对调而非重排，其余条目的相对次序不变；
 *   · 引用透传（不克隆元素），调用方拿到的是同一份对象；
 *   · `visibleCount ≤ 0` → 全部进折叠段（弹层仍可用）；`activeRef` 不在表内
 *     或为 null → 不做对调。
 */
export function pickVisibleTabs<T extends { ref: string }>(
  tabs: T[],
  visibleCount: number,
  activeRef?: string | null,
): { visible: T[]; hidden: T[] } {
  const n = Math.max(0, Math.min(Math.floor(visibleCount), tabs.length))
  if (n === 0) return { visible: [], hidden: [...tabs] }

  const visible = tabs.slice(0, n)
  const hidden = tabs.slice(n)

  if (!activeRef) return { visible, hidden }
  if (!tabs.some((t) => t.ref === activeRef)) return { visible, hidden }
  // 激活项不在折叠段 → 无需对调
  if (visible.some((t) => t.ref === activeRef)) return { visible, hidden }

  // 对调：可见段最后一位被换出（落入折叠段），激活项被换入。
  // 两段各自仍按**输入顺序**重建 —— 不重排，只改变「谁在可见段」。
  const keep = new Set<string>(visible.slice(0, -1).map((t) => t.ref))
  keep.add(activeRef)
  return {
    visible: tabs.filter((t) => keep.has(t.ref)),
    hidden: tabs.filter((t) => !keep.has(t.ref)),
  }
}
