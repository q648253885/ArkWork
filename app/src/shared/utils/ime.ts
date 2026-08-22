/* ============================================================
 * v0.26.x — IME 组合态判定
 *
 * 背景：聊天输入框 / 运行控制台曾把「拼音确认回车」误判为发送，
 * 用户中文输一半消息就飞了。根因是 keydown 处理未区分 IME 组合态。
 * 组合态语义：回车=确认上屏、↑↓=候选翻页、Esc=取消组合——
 * 全部应交还输入法，业务层（发送/提交/菜单选择）不得响应。
 *
 * 使用：if (isImeComposing(e.nativeEvent)) return
 * ============================================================ */

/**
 * 判断键盘事件是否处于 IME 组合态。
 * @param e 携带 isComposing / keyCode 的事件对象（原生 KeyboardEvent 或 React synthetic 的 e.nativeEvent 均可）
 * @returns true = 组合态，调用方应直接 return 不做任何处理；false = 非组合态，按常规键位处理
 */
export function isImeComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  // keyCode 229：部分浏览器/输入法在组合期间把所有 keydown 统一上报为 229（历史兼容标记）
  return e.isComposing === true || e.keyCode === 229
}
