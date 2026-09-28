/* ============================================================
 * ArkWork — 性能模式状态（v0.36.4 · PERF-1）
 *
 * v0.31.1 的 perf-lite 只有 window.ts 内的一次性判定与 CSS 注入；
 * v0.36.4 起主进程其他模块（如 llm-stream 的流式攒批窗口）也需要
 * 知道「性能降级是否激活」。这里提供进程级开关：
 *  - window.ts 在 applyPerformanceMode 判定后写入（设置三态 + GPU 判定合并）；
 *  - 消费方只读，不感知判定来源（env / GPU / 设置）。
 *
 * 纪律：本模块不 import electron —— 保持可密闭单测（llm-stream 同款约束）。
 */

let perfLiteActive = false

/** window.ts 判定完成后写入；重复写同值无害 */
export function setPerfLiteActive(active: boolean): void {
  perfLiteActive = active
}

/** 性能降级是否激活（主进程内消费，如流式攒批窗口放大） */
export function isPerfLiteActive(): boolean {
  return perfLiteActive
}

/**
 * perf-lite 下的流式攒批窗口（设计 §二 PERF-1）：
 * 低配机上高频 IPC + markdown 重渲是抢 CPU 大户；正文落定的权威数据不受影响，
 * 只是流式刷新变疏（40–80ms → 150–250ms）。
 */
export const PERF_LITE_WINDOW_MIN_MS = 150
export const PERF_LITE_WINDOW_MAX_MS = 250
