/* ============================================================
 * ArkWork — 展示名防御（v0.34.0 · D54）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §6.4 / §6.5
 *
 * 用户实测缺陷：右侧竖排栏的插件标签鼠标悬停后 tip 出 `{{titile}}`，
 * 竖排栏上标签本身也被撑破。两个成因，两条防线：
 *
 *  ① **未解析模板串** —— 上游（i18n 模板变量名错配，或用户侧
 *     plugin.json 手写坏数据）没被插值，宿主展示层就把 `{{…}}` 原样画出来。
 *     → 检测 + 原样展示（**不吞掉线索**）+ 截断 + warn。
 *     为什么原样展示而不是替换成空/省略：报障信息必须留在屏幕上，
 *     否则「看起来正常了、其实上游还是坏的」——静默修复比缺陷更糟。
 *
 *  ② **超长名** —— 竖排栏宽仅 44px、`white-space: nowrap`，
 *     长标签会溢出/换行错位（用户要求「名称不超过三个」的另一半是「别太长」）。
 *
 * 两个导出函数的**截断力度刻意不同**：
 *  - `guardLabel`   竖排栏用：模板防御 **+ 8 字符截断**（屏幕空间是硬约束）
 *  - `guardBodyTitle` 面板正文宿主用：**只做模板防御，不截断**
 *    （正文有充足宽度，「工作台与插件指南」这类正常长名被截成
 *     「工作台与插件指…」是明显退步 —— 防线只该拦真正坏的东西）
 *
 * 纯函数、零依赖：可直接密闭单测（TC-LBL 组）。
 * ============================================================ */

/** 未解析模板占位符（`{{` … `}}`；非贪婪，允许内部含空格与中文） */
export const UNRESOLVED_TEMPLATE_RE = /\{\{[^}]*\}\}/

/** 竖排栏标签字符上限（超出即截断为 7 字 + 省略号） */
export const RAIL_LABEL_MAX_CHARS = 8

/** 是否含未解析模板占位符（供校验器 / 调用方独立判定） */
export function hasUnresolvedTemplate(raw: unknown): boolean {
  return UNRESOLVED_TEMPLATE_RE.test(String(raw ?? ''))
}

/**
 * 竖排栏标签防御：模板串按原样截断，普通长名按字符数截断。
 * tooltip / aria 仍应使用**完整**原文（信息不丢，只压屏幕占位）。
 */
export function guardLabel(raw: string): string {
  const s = String(raw ?? '')
  if (hasUnresolvedTemplate(s)) {
    // 原样保留线索，只压长度；warn 便于定位上游
    console.warn('[label-guard] 标签含未解析模板占位符，已按原样截断展示：', s)
  }
  return s.length > RAIL_LABEL_MAX_CHARS ? `${s.slice(0, RAIL_LABEL_MAX_CHARS - 1)}…` : s
}

/**
 * 面板正文标题防御：**只**替换不出来的模板串，不做长度截断。
 *
 * 为什么正文不截断：面板容器宽度由用户拖拽决定，没有 44px 那种硬约束；
 * 截断正常标题是纯损失。
 */
export function guardBodyTitle(raw: string): string {
  const s = String(raw ?? '')
  if (hasUnresolvedTemplate(s)) {
    console.warn('[label-guard] 面板标题含未解析模板占位符：', s)
  }
  return s
}
