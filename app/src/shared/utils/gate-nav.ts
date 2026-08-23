/* ============================================================
 * ArkWork — gate-nav (v0.27.1 修三)
 * AskUserGate 键盘导航纯函数：
 *   - moveSelection：↑↓ 循环移动选中项（opencode 阻塞式选项向导风格）
 *   - digitToIndex：数字键 1-9 → 选项下标（仅快选，不直接提交，防误发）
 * 确定性纯函数，无 DOM 依赖，便于单测。
 * ============================================================ */

/** 循环移动选中项。count<=0 返回 -1（无选项）；任意步长按模运算首尾相接。
 *  双模写法（(c+d)%n + n) % n）保证结果恒为非负且不产生 -0。 */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return -1
  return (((current + delta) % count) + count) % count
}

/** 数字键 1-9 映射为 0-based 下标；其余返回 -1。 */
export function digitToIndex(digit: number): number {
  return digit >= 1 && digit <= 9 ? digit - 1 : -1
}
