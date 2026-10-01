/* ============================================================
 * ArkWork — 完成横幅口径纯函数（v0.43.1 / D217）
 *
 * 为什么存在：`taskPanel.allDone` 模板此前硬编码 ` tokens` 后缀，而图快照
 * `budget.tokensUsed = sumTokens(nodes.tokensUsed)` 全仓从未写入非 0 值
 * （建节点路径恒 0，L-43-04）→ `formatTokens(0)` 返回空串，横幅渲染出
 * 无数字的「· tokens」（用户实机截图）。且 `progressCounts` 口径
 * （completed+cancelled）会把账本 `skipped` 项计成「完成」，文案与账本实况
 * （10 完成 + 2 跳过）不符。
 *
 * 本模块只管「展示层诚实」：无数据即隐藏 tokens 段；已跳过项显式补
 * 「含跳过 N」。统计语义（progressCounts / 头部 12/12）不动 —— 那是快照
 * 契约注释明示的面板口径，头部进度同源。
 * ============================================================ */

/** 只消费 status 字段 —— 账本条目（LedgerItemView）与测试夹具均可直接传入 */
export interface LedgerLikeStatus {
  status: string
}

/** 账本 9 态条目中「已跳过」计数；undefined / 空 → 0（null 视为无快照） */
export function skippedCountOf(items: ReadonlyArray<LedgerLikeStatus> | undefined | null): number {
  if (!items) return 0
  return items.filter((it) => it.status === 'skipped').length
}

/**
 * tokens 段标签：0 / undefined → `null`（调用方据此**整段不渲染**）。
 * 为什么不是显示 "0 tokens"：tokensUsed 结构性为 0 是数据未接线（L-43-04），
 * 显示 "0" 是假数据；诚实 UI = 无数据即隐藏。未来数据面接线后自动恢复显示。
 * 返回值已过 formatTokens（单一事实源，纪律⑦）。
 */
export function tokensLabelOf(tokensUsed: number | undefined, format: (n: number | undefined) => string): string | null {
  if (!tokensUsed) return null
  const label = format(tokensUsed)
  return label === '' ? null : label
}
