/* ============================================================
 * ArkWork — 上下文键（v0.31.0 B0）
 *
 * `when` 门控的唯一状态源。**默认 false**：未显式置位的键一律不满足，
 * 因此新增 context 键不会意外放宽已有键位的触发条件（失败方向安全）。
 *
 * 纯模块（无 React / 无 store）：置位方是组件与 slice，读取方是 registry。
 * 谁置位谁负责在卸载时复位 —— 违背会导致键位「卡在可用」。
 * ============================================================ */
import { WHEN_KEYS, type WhenKey } from './types'

const state = new Map<WhenKey, boolean>()

/** 置位 / 复位某个上下文键 */
export function setContextKey(k: WhenKey, v: boolean): void {
  if (v) state.set(k, true)
  else state.delete(k)
}

/** 读取单个上下文键（未置位 = false） */
export function getContextKey(k: WhenKey): boolean {
  return state.get(k) === true
}

/** 快照：`when` 判定的输入。返回新对象，调用方不得缓存 */
export function snapshotContext(): Record<WhenKey, boolean> {
  const out = {} as Record<WhenKey, boolean>
  for (const k of WHEN_KEYS) out[k] = state.get(k) === true
  return out
}

/**
 * 全量复位。用途有二：
 *   1. 单测之间清理（避免用例互相污染）；
 *   2. 处理域整体卸载（如浮窗关闭）时的兜底。
 */
export function resetContext(): void {
  state.clear()
}
