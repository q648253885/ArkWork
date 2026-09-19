/* ============================================================
 * ArkWork — 竖排 Tab 栏「高度自适应折叠」（v0.34.2 · D56）
 *
 * 规格来源：docs/versions/v0.34.2/04-system-design.md §2
 *
 * 用户诉求原文（v0.34.2 实测复报）：
 *   ① 「显示的侧边栏名称超过三个会挤压溢出」
 *   ② 「右侧侧边栏栏目如果超过侧边栏容纳范围高度，需要有折叠机制」
 *
 * 与 v0.34.0（D54）的差别 —— D54 把诉求读成了「插件面板 ≤ 3，内置全留」，
 * 结果竖排栏仍渲染 6 内置 + 3 插件 = 9 个名称（实测），用户复报同一问题。
 * 本版的读法是两句话合起来的一条规则：
 *
 *   **可见条数 = min(名称上限 3, 可用高度能容纳的条数)**
 *
 *   · 「≤3」来自诉求① —— 三个以上就开始挤压，这是用户的硬偏好；
 *   · 「高度能容纳」来自诉求② —— 高度不够时继续减，而不是撑出滚动条；
 *   · 被折叠的项**全部**进底部「更多」弹层（内置与插件一视同仁：
 *     诉求①说的是「名称」总数，不是「插件名称」）。
 *
 * 代价与补偿（写在代码里，避免后来者以为是遗漏）：
 *   · 内置 Tab 也会被折叠 —— 但 ⌥1~⌥6 快捷键**不依赖可见性**（切 Tab 走
 *     `setInspectorTab`，与竖排栏渲染解耦），且「更多」弹层逐项列出完整名称
 *     + 快捷键，肌肉记忆靠键位而非像素位置保留；
 *   · 当前激活的面板**永远可见** —— `pickVisibleTabs` 会把激活项换进可见段，
 *     否则用户在「更多」里点完，竖排栏上找不到自己点的是哪一个。
 *
 * 纯函数、零依赖：可直接密闭单测（TC-RTO 组）。
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
 * 竖排栏「名称」总数上限（用户定调：超过三个会挤压溢出）。
 * 改动此常量 = 改动需求，必须先回到用户确认。
 */
export const MAX_VISIBLE_NAMES = 3

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
   * 退化为「只按名称上限」判定，保证首帧与终帧同一口径、不闪跳。
   */
  availableHeight: number | null
  /** 额外预留高度（已隐藏区；缺省 0） */
  reservedHeight?: number
  /** 名称上限（缺省 MAX_VISIBLE_NAMES；仅用于测试与后续可配置化） */
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

/**
 * 计算竖排栏可见条数。
 *
 * 规则（逐条有用例）：
 *  ① `total ≤ 上限` 且高度放得下 → 全可见、不折叠（够用时绝不提前收纳）；
 *  ② 否则折叠：先给「更多」触发器留位，再按剩余高度算能放几条；
 *  ③ 可见条数夹在 `[1, min(上限, total)]` —— 至少留 1 条（只剩一个「更多」
 *     按钮的竖排栏没有意义），且绝不出现「负上限」；
 *  ④ 未测量（availableHeight 非法）→ 退化为 `min(上限, total)`；
 *  ⑤ 高度极矮（连 1 条 + 触发器都放不下）→ 仍给 1 条，由 `.inspector-toolbar`
 *     的 `overflow-y: auto` 兜底滚动（最后一层保险，不再是常规路径）。
 */
export function computeRailLayout(input: RailLayoutInput): RailLayout {
  const total = Math.max(0, Math.floor(input.total))
  const max = Math.max(1, Math.floor(input.maxVisible ?? MAX_VISIBLE_NAMES))
  if (total === 0) return { visibleCount: 0, overflowCount: 0, collapsed: false }

  const H = input.availableHeight
  const measured = typeof H === 'number' && Number.isFinite(H) && H > 0

  // ④ 未测量：只按名称上限（首帧稳定，不依赖测量时序）
  if (!measured) {
    const visibleCount = Math.min(max, total)
    return {
      visibleCount,
      overflowCount: total - visibleCount,
      collapsed: total > visibleCount,
    }
  }

  const reserved = Math.max(0, input.reservedHeight ?? 0)
  const usable = (H as number) - RAIL_PADDING_Y - RAIL_COLLAPSE_BTN_H - reserved

  // ① 全放得下 → 一条都不收
  if (total <= max && itemsHeight(total) <= usable) {
    return { visibleCount: total, overflowCount: 0, collapsed: false }
  }

  // ②③ 折叠：扣掉「更多」触发器（含它自己的 gap）后再算容量
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
