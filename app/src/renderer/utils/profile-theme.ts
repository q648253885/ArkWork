/* ============================================================
 * ArkWork — 工作台主题覆盖的落地（v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §9.3
 *
 * 分工：
 *  · **纯函数**（`resolveThemeGroup` / `filterExistingTokens` / `collectThemeKeys`）
 *    可被 node:test 覆盖 —— 它们承载全部判断逻辑；
 *  · **DOM 写读**（`applyThemeOverride` / `clearThemeOverride`）只有三行，
 *    不做任何判断，因此不需要（也无法在密闭环境里）单测。
 *
 * 三条硬纪律：
 *  ① **只覆盖不新增**：键必须已存在于 `:root`（用 `getComputedStyle` 探测），
 *     否则 rejected。这是 v0.31.0 「新增 token 两步缺一即静默失效」纪律的
 *     运行时把守（对齐 TC-TOKEN-001..003）。
 *  ② **清除必须 removeProperty，不能置空串** —— 置空串会让 `var(--x, fallback)`
 *     的 fallback 失效（空串是**有效值**），于是「切回通用台」后样式继续错。
 *  ③ **键集合必须来自「上一次应用过的键」**，不能靠当下 tokens 反推 ——
 *     切台时新旧 token 集不同，按新集清理会留下旧台的残留。
 * ============================================================ */
import type { ThemeTokens, ThemeGroup } from '@shared/utils/theme-tokens'

/** 探测某个 token 是否已存在于文档根（注入的探针让本函数可密闭测试） */
export type TokenProbe = (key: string) => boolean

/**
 * 取当前主题分组应生效的 token 表。
 * `dark=true` 时优先 `dark` 组、缺失回落 `light` 组（单边声明的作者不必写两遍）。
 */
export function resolveThemeGroup(t: ThemeTokens | null | undefined, dark: boolean): Record<string, string> {
  if (!t) return {}
  const primary: ThemeGroup = dark ? 'dark' : 'light'
  const secondary: ThemeGroup = dark ? 'light' : 'dark'
  // 显式声明了该组 → 只用该组（作者意图明确，不做隐式合并）
  if (Object.keys(t[primary]).length > 0) return { ...t[primary] }
  return { ...t[secondary] }
}

/**
 * 「只覆盖已存在 token」的落地：把 token 表按存在性切成「可应用 / 缺失」两半。
 * 缺失的一律丢弃（不是错误 —— 新版本删过 token 会导致旧工作台带过期键）。
 */
export function filterExistingTokens(
  map: Record<string, string>,
  has: TokenProbe,
): { applied: Record<string, string>; missing: string[] } {
  const applied: Record<string, string> = {}
  const missing: string[] = []
  for (const [k, v] of Object.entries(map)) {
    if (has(k)) applied[k] = v
    else missing.push(k)
  }
  return { applied, missing }
}

/** 一次覆盖应用涉及的**全部**键（两个分组都算 —— 清理时不能漏） */
export function collectThemeKeys(t: ThemeTokens | null | undefined): string[] {
  if (!t) return []
  return Array.from(new Set([...Object.keys(t.light), ...Object.keys(t.dark)]))
}

/* ---------- DOM 写读（无判断逻辑） ---------- */

/** 默认探针：token 已在 `:root`/`.dark` 定义过 → `getPropertyValue` 非空串 */
export const domTokenProbe: TokenProbe = (key) => {
  if (typeof document === 'undefined') return false
  return document.documentElement.style.getPropertyValue(key).trim().length > 0
    || getComputedStyle(document.documentElement).getPropertyValue(key).trim().length > 0
}

/**
 * 应用一组 token 覆盖。返回实际写进去的键。
 *
 * 注意：写的是 `documentElement.style`（inline），因此**优先级高于** `:root`/`.dark`
 * 的样式表规则 —— 这是「覆盖」而非「新增」能成立的前提。
 */
export function applyThemeOverride(map: Record<string, string>): string[] {
  if (typeof document === 'undefined') return []
  const keys = Object.keys(map)
  for (const k of keys) document.documentElement.style.setProperty(k, map[k])
  return keys
}

/** 逐键 `removeProperty`（纪律 ②：不能置空串） */
export function clearThemeOverride(keys: string[]): void {
  if (typeof document === 'undefined') return
  for (const k of keys) document.documentElement.style.removeProperty(k)
}

/**
 * 便利入口：按当前主题求解 → 存在性过滤 → 应用。
 * 返回 `{ applied, missing }` 供诊断页展示（「哪些 token 已被宿主删除」）。
 */
export function applyResolvedTheme(
  tokens: ThemeTokens | null | undefined,
  dark: boolean,
  has: TokenProbe = domTokenProbe,
): { applied: Record<string, string>; missing: string[] } {
  const resolved = resolveThemeGroup(tokens, dark)
  const { applied, missing } = filterExistingTokens(resolved, has)
  applyThemeOverride(applied)
  return { applied, missing }
}
