/* ============================================================
 * ArkWork — Bugfix Skill: mode (v0.14.0 Task 11.4)
 * 续跑模式（⌘K 可切换）：
 *  - multi-attempt：多轮续跑（默认）—— 评估 → 修复 → 验证循环，
 *    目标达成或推进路径耗尽才停止
 *  - single-attempt：单轮 定位→修复→验证，未达成直接汇报，不静默重试
 * ============================================================ */

export type BugfixMode = 'multi-attempt' | 'single-attempt'

const MODES: ReadonlySet<string> = new Set(['multi-attempt', 'single-attempt'])

let currentMode: BugfixMode = 'multi-attempt'

export function getBugfixMode(): BugfixMode {
  return currentMode
}

export function setBugfixMode(mode: BugfixMode): BugfixMode {
  if (!MODES.has(mode)) {
    throw new Error(`bugfix: 无效模式 ${String(mode)}（可选 multi-attempt / single-attempt）`)
  }
  currentMode = mode
  return currentMode
}
