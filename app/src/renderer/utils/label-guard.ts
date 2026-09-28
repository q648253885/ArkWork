/* ============================================================
 * ArkWork — 展示名防御（v0.34.0 · D54；v0.36.0 · D91 拆分两档力度）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §6.4 / §6.5
 *           docs/versions/v0.36.0/04-system-design.md §7（D91）
 *
 * 用户实测缺陷（v0.34.0）：右侧竖排栏的插件标签鼠标悬停后 tip 出 `{{titile}}`，
 * 竖排栏上标签本身也被撑破。两个成因，两条防线：
 *
 *  ① **未解析模板串** —— 上游（i18n 模板变量名错配，或用户侧
 *     plugin.json 手写坏数据）没被插值，宿主展示层就把 `{{…}}` 原样画出来。
 *     → 检测 + 原样展示（**不吞掉线索**）+ 截断 + warn。
 *     为什么原样展示而不是替换成空/省略：报障信息必须留在屏幕上，
 *     否则「看起来正常了、其实上游还是坏的」——静默修复比缺陷更糟。
 *
 *  ② **超长名** —— 竖排栏宽仅 44px、`white-space: nowrap`，
 *     长标签会溢出/换行错位。
 *
 * ★ v0.36.0（D91）用户复报：「侧边栏名称最多三个字」。
 *   实机测量（窗口 1440×818，1x）：竖排栏 44px，条目内容宽 43px，
 *     · 内置项最长「上下文」「浏览器」= 3 字 → 33px ✅
 *     · 插件项「Git Manager」经 8 字截断后 = 「Git Man…」→ 内容 52px，
 *       被渲染成 37px 后**裁切**（`scrollWidth 52 > clientWidth 37`）❌
 *   即「8 字上限」从一开始就大于栏宽能容纳的字数，等于没设上限。
 *   所以三个导出函数现在是**三档力度**，各自对准一个真实约束：
 *
 *     guardRailLabel   竖排栏用        **3 字**（与内置项同宽，栏宽硬约束）
 *     guardLabel       横向条用        **8 字**（「更多」弹层 / 插件来源条，
 *                                       宽度 ≥160px，不需要也不该砍到 3 字）
 *     guardBodyTitle   面板正文标题    **不截断**（宽度由用户拖拽决定）
 *
 *   为什么不做成「一个函数 + 一个参数」：三个调用点的**约束来源不同**
 *   （像素 / 版面 / 无），合成一个函数后「谁该传几」就变成了调用方的义务 ——
 *   而那正是本缺陷的成因（v0.34.0 把竖排栏与横向条并成同一个 8）。
 *   纯函数、零依赖：可直接密闭单测（TC-LBL 组）。
 * ============================================================ */

/** 未解析模板占位符（`{{` … `}}`；非贪婪，允许内部含空格与中文） */
export const UNRESOLVED_TEMPLATE_RE = /\{\{[^}]*\}\}/

/**
 * 竖排栏标签字符上限 —— **3**。
 *
 * 取值依据是栏宽而不是审美：44px 栏、条目内宽 43px、11px 字号下
 * 汉字与拉丁字母都约占 11px/字，3 字 = 33px 放得下、4 字 = 44px 已经贴边。
 * 内置六个 Tab 的中文名（清单/上下文/文件/日志/浏览器/终端）全在此限内，
 * 插件项由此对齐同一视觉节奏。
 */
export const RAIL_LABEL_MAX_CHARS = 3

/**
 * 横向条标签字符上限 —— **8**。
 * 适用「更多」弹层与插件来源条：宽度 ≥160px，8 字只为兜住真正的坏数据
 * （作者写了篇小作文当标题），不是版面约束。
 */
export const BAR_LABEL_MAX_CHARS = 8

/** 是否含未解析模板占位符（供校验器 / 调用方独立判定） */
export function hasUnresolvedTemplate(raw: unknown): boolean {
  return UNRESOLVED_TEMPLATE_RE.test(String(raw ?? ''))
}

/** 模板串按原样截断；普通长名按字符数截断。返回 `limit` 字符以内（含省略号）。 */
function truncate(raw: unknown, limit: number): string {
  const s = String(raw ?? '')
  if (hasUnresolvedTemplate(s)) {
    // 原样保留线索，只压长度；warn 便于定位上游
    console.warn('[label-guard] 标签含未解析模板占位符，已按原样截断展示：', s)
  }
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s
}

/**
 * 竖排栏标签防御（D91）：模板串按原样截断，普通长名收到 **3 字**。
 * tooltip / aria 仍应使用**完整**原文（信息不丢，只压屏幕占位）。
 */
export function guardRailLabel(raw: string): string {
  return truncate(raw, RAIL_LABEL_MAX_CHARS)
}

/**
 * 横向条标签防御：模板串按原样截断，普通长名收到 8 字。
 *
 * ⚠️ 不要把它用回竖排栏 —— 8 字在 44px 栏里放不下（D91 的成因）。
 */
export function guardLabel(raw: string): string {
  return truncate(raw, BAR_LABEL_MAX_CHARS)
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
