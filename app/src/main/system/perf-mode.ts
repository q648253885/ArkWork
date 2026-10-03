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
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

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

/* ============================================================
 * v0.46.0（PERF-2 W14/W15）：低配档（软件渲染环境）启动期决策 + 粘滞缓存
 *
 * 背景：perf-lite 判中软件渲染后只压动画与 IPC 频率，Chromium 仍走 SwiftShader
 * 合成路径（GPU 进程 + 软件光栅化全开销照跑）。`app.disableHardwareAcceleration()`
 * 与 `js-flags` 堆上限**只能在 app ready 之前**生效，而 GPU 判定
 * （app.getGPUFeatureStatus）在 ready 后才可用 —— 解法是把上一轮的判定结果
 * 落盘粘滞化（perf-cache.json）：云端 VM 的 GPU 状态跨启动几乎不变，
 * 第二次启动起即可在 ready 前拿全量收益。
 *
 * 本模块不 import electron —— 保持可密闭单测（文件读写经 node:fs，路径由调用方传入）。
 */

export const LOW_SPEC_MAX_OLD_SPACE_MB = 1024

export interface PerfCache {
  /** 上一轮启动时是否判中软件渲染（auto 档粘滞判据） */
  gpuSoftwareLastRun?: boolean
}

/** perf-cache.json 读取（缺文件/损坏返回 {}，绝不抛） */
export function readPerfCache(arkworkDir: string): PerfCache {
  try {
    const raw = readFileSync(join(arkworkDir, 'perf-cache.json'), 'utf-8')
    const parsed = JSON.parse(raw) as PerfCache
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** perf-cache.json 写入（尽力而为，失败静默 —— 缓存丢失只影响下一轮判定来源） */
export function writePerfCache(arkworkDir: string, cache: PerfCache): void {
  try {
    mkdirSync(arkworkDir, { recursive: true })
    writeFileSync(join(arkworkDir, 'perf-cache.json'), JSON.stringify(cache, null, 2), 'utf-8')
  } catch {
    /* 缓存写失败不构成功能问题 */
  }
}

/** 同步读 settings.json 的 perfMode 三态（仅供启动期 ready 前使用；读失败按 auto） */
export function readPerfModeFileSync(settingsPath: string): 'auto' | 'on' | 'off' {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { perfMode?: 'auto' | 'on' | 'off' }
    const mode = parsed.perfMode
    return mode === 'on' || mode === 'off' ? mode : 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * ready 前低配档判定（W14 纯函数，真值表用例钉死）。
 * 语义与运行期 applyPerformanceMode 对齐：
 *  - on → 恒低配（用户显式选择）；
 *  - off → 恒不低配（显式关闭，连 env 逃生门也让位）；
 *  - auto → env 逃生门 或 上轮判中软渲染（粘滞）。
 */
export function decidePreReadyLowSpec(
  perfMode: 'auto' | 'on' | 'off',
  cachedSoftware: boolean | undefined,
  envLite: boolean,
): { lowSpec: boolean; source: 'settings' | 'sticky' | 'env' | 'none' } {
  if (perfMode === 'on') return { lowSpec: true, source: 'settings' }
  if (envLite && perfMode !== 'off') return { lowSpec: true, source: 'env' }
  if (perfMode === 'auto' && cachedSoftware === true) return { lowSpec: true, source: 'sticky' }
  return { lowSpec: false, source: 'none' }
}
