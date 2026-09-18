/* ============================================================
 * ArkWork — 竖排 Tab 栏「插件面板」溢出收纳（v0.34.0 D54）
 *
 * 背景（用户实测）：Inspector 右侧竖排栏在安装多个能力插件后无限增高 ——
 * 每多一个插件面板就多一个 Tab，窗口高度不增时标签被挤压/换行，
 * 用户要求「右侧显示的名称不超过三个」。
 *
 * 语义（刻意区分内置与插件）：
 *  - **内置 Tab 全部保留**（清单/上下文/文件/日志/浏览器/终端 —— 它们有
 *    稳定语义与快捷键，收纳会破坏肌肉记忆）；
 *  - **插件面板最多可见 `max` 个**，其余按文档序收进「更多」弹层；
 *  - 输出保持**输入原顺序**（既不重排内置，也不重排插件）。
 *
 * 纯函数、零依赖：可直接密闭单测（TC-OVF 组）。
 * ============================================================ */

/** 插件面板在竖排栏上的可见上限（用户定调：不超过三个） */
export const MAX_VISIBLE_PLUGIN_TABS = 3

export interface TabLike {
  ref: string
  builtin: boolean
}

export interface TabSplit<T extends TabLike> {
  /** 直接渲染在竖排栏上的 Tab（全部内置 + 前 max 个插件面板） */
  visible: T[]
  /** 收进「更多」弹层的插件面板（保持原相对顺序） */
  hidden: T[]
}

/**
 * 按「内置全留 + 插件截断」规则切分 Tab 序列。
 *
 * @param tabs 合并后的完整 Tab 序列（builtinTabsOf + mergePanelOrder 的结果，已含 position 序）
 * @param max  插件面板可见上限（缺省 MAX_VISIBLE_PLUGIN_TABS）
 * @returns    visible / hidden 两段，元素引用与输入同一份（不克隆）
 *
 * 边界：插件数 ≤ max → hidden 为空；max ≤ 0 → 全部插件面板进 hidden；
 *       无插件 → visible 即原序列（逐元素相等）。
 */
export function splitPluginTabs<T extends TabLike>(
  tabs: T[],
  max: number = MAX_VISIBLE_PLUGIN_TABS,
): TabSplit<T> {
  const visible: T[] = []
  const hidden: T[] = []
  let pluginSeen = 0
  for (const tab of tabs) {
    if (tab.builtin) {
      visible.push(tab)
      continue
    }
    pluginSeen += 1
    if (pluginSeen <= Math.max(0, max)) visible.push(tab)
    else hidden.push(tab)
  }
  return { visible, hidden }
}
