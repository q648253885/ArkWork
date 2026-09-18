/* ============================================================
 * ArkWork — Profile 视图投影（纯函数 · v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.12
 *
 * 为什么独立成纯模块（沿用 `shared/utils/flow-fold.ts` 与
 * `renderer/utils/plan-status.ts` 的同一先例）：
 *  - `store/slices/profileSlice.ts` 经 `ipc/client` 顶层读 window、
 *    经 `store/meta` 顶层读 `import.meta.env` —— node:test 无法导入；
 *  - 而「快照 ui 层 → 视图三字段」恰恰是最容易被写错的转换
 *    （字符串逗号分隔 / homeModule 白名单 / applied=false 要跳过），
 *    必须能被密闭单测逐条把守。
 * ============================================================ */
import type { DockTabId } from '@shared/types/agent'
import type { CompositionSnapshot, Degradation, SlotEntry, SlotKind } from '@shared/types/profile'
import type { ModulePage } from '../store/types'
import { panelTabsOf, type PanelTab } from '@shared/utils/panel-model'
import { isEmptyTheme, mergeThemeTokens, sanitizeThemeTokens, type ThemeTokens } from '@shared/utils/theme-tokens'

export interface ProjectedProfileView {
  /** null = 不覆盖（沿用用户/智能体原有偏好） */
  dockTabs: DockTabId[] | null
  /**
   * v0.33.0 起放宽为 `string`：内置六名 或 `module:<id>`（插件贡献的首页模块）。
   * 仍是 `null` 表示「不覆盖」——与「声明了但非法被丢弃」必须区分。
   */
  homeModule: string | null
  composerChips: string[]
}

/** 合法的 CenterStage 内置首页模块白名单（与 store ModulePage 同源，值级校验） */
const HOME_MODULES: readonly ModulePage[] = ['automations', 'skills', 'agents', 'kb', 'memory', 'settings']

/** 插件贡献的首页模块引用形态：`module:<id>` */
const MODULE_REF_RE = /^module:[\w.-]+$/

/** 取值是否可落地为首页模块：内置名 或 `module:<id>` */
export function isHomeModuleValue(v: string): boolean {
  return (HOME_MODULES as readonly string[]).includes(v) || MODULE_REF_RE.test(v)
}

/**
 * 装配快照 → 视图字段。
 *
 * 四条纪律：
 *  ① `applied=false` 的项**必须跳过** —— 快照里带上没生效的值等于骗用户；
 *  ② dockTabs 空串不可用：声明了却为空数组时不覆盖（留给用户/智能体偏好）；
 *  ③ composerChips 上限 8 条（manifest 解析层已截断，这里再兜一次防御）；
 *  ④ homeModule 取值必须过 `isHomeModuleValue` —— 非法值丢弃而不是当成
 *     「有覆盖」，否则首页会白屏（v0.33.0 放宽为开放引用后的必要守卫）。
 */
export function projectUiLayer(snapshot: CompositionSnapshot | null): ProjectedProfileView {
  if (!snapshot) return { dockTabs: null, homeModule: null, composerChips: [] }
  let dockTabs: DockTabId[] | null = null
  let homeModule: string | null = null
  let composerChips: string[] = []
  for (const item of snapshot.layers.ui) {
    if (!item.applied) continue
    if (item.slot === 'ui.dockTabs' && item.value) {
      const tabs = item.value.split(',').filter(Boolean) as DockTabId[]
      if (tabs.length > 0) dockTabs = tabs
    } else if (item.slot === 'ui.homeModule' && item.value) {
      if (isHomeModuleValue(item.value)) homeModule = item.value
    } else if (item.slot === 'ui.composerChips' && item.value) {
      composerChips = item.value.split(',').filter(Boolean).slice(0, 8)
    }
  }
  return { dockTabs, homeModule, composerChips }
}

/* ============================================================
 * v0.33.0：插槽明细 → 三份派生量
 *
 * 与 `projectUiLayer`（读**快照**）的分工：
 *   · 快照 = 人话级的「这一层生效了吗」（用于激活报告）
 *   · 插槽 = 真正可渲染的数据体（用于 Inspector 面板 / 渲染器覆盖 / 主题）
 * 两者不可互相替代 —— 快照的 ui.theme 只登记**键名**，token 值只在插槽里。
 * ============================================================ */

export interface SlotDerivations {
  /** 可渲染面板 Tab（顺序真源 = manifest position） */
  panels: PanelTab[]
  /** 扩展名 → 渲染器名（profile 的 previewRenderers ∪ 插件 renderer 贡献） */
  rendererOverrides: Record<string, string>
  /** token 覆盖（已过值白名单；键的存在性由应用层用 DOM 兜底） */
  theme: ThemeTokens
}

/** 空派生量（无插槽时的返回值，避免各处重复造对象） */
export const EMPTY_DERIVATIONS: SlotDerivations = { panels: [], rendererOverrides: {}, theme: { light: {}, dark: {} } }

/** `ui.renderer` 条目的载荷形状守卫（插槽来自磁盘，必须值级校验） */
function rendererOverrideOf(e: SlotEntry): Array<[string, string]> | null {
  if (e.kind !== 'ui.renderer') return null
  const p = e.payload
  if (typeof p !== 'object' || p === null) return null
  const rec = p as unknown as Record<string, unknown>
  const kind = rec.rendererKind
  if (typeof kind !== 'string' || kind.length === 0) return null
  const exts = rec.extensions
  const list = Array.isArray(exts) ? exts.filter((x): x is string => typeof x === 'string') : []
  if (list.length === 0) return null
  return list.map((x) => [x.toLowerCase(), kind] as [string, string])
}

/** `ui.theme` 条目的载荷形状守卫（**再净化一次**：插槽可能来自插件或手改磁盘） */
function themeTokensOf(e: SlotEntry): Partial<ThemeTokens> | null {
  if (e.kind !== 'ui.theme') return null
  const p = e.payload
  if (typeof p !== 'object' || p === null) return null
  const rec = p as unknown as Record<string, unknown>
  const { tokens } = sanitizeThemeTokens({ light: rec.light, dark: rec.dark })
  if (isEmptyTheme(tokens)) return null
  return tokens
}

/**
 * 插槽明细 → 派生量。
 *
 * 纪律：**坏条目跳过，绝不抛错**（插槽可能来自用户手改的磁盘文件）；
 * 同一扩展名被多条声明覆盖时，**后者胜**（与 `resolveSlots` 的注册序一致）。
 */
export function deriveFromSlots(slots: Partial<Record<SlotKind, SlotEntry[]>> | null | undefined): SlotDerivations {
  if (!slots) return EMPTY_DERIVATIONS
  const panels = panelTabsOf(slots['ui.panel'])

  const rendererOverrides: Record<string, string> = {}
  for (const e of slots['ui.renderer'] ?? []) {
    const pairs = rendererOverrideOf(e)
    if (!pairs) continue
    for (const [ext, kind] of pairs) rendererOverrides[ext] = kind
  }

  const sets = (slots['ui.theme'] ?? []).map(themeTokensOf).filter((t): t is Partial<ThemeTokens> => t !== null)
  const merged = mergeThemeTokens(...sets)
  return { panels, rendererOverrides, theme: merged }
}

/** 主题覆盖是否为空（空集不触发样式重算，也不写 documentElement） */
export function hasThemeOverride(t: ThemeTokens | null | undefined): boolean {
  return !isEmptyTheme(t)
}

/** 阻断项：这类降级意味着「这次没切成」，必须能被 UI 追问 */
export function blockingDegradations(snapshot: CompositionSnapshot | null): Degradation[] {
  return (snapshot?.degraded ?? []).filter((d) => d.blocking)
}

/** 非阻断降级计数（UI 橙点用；阻断用红点，两者互斥展示） */
export function warningCount(snapshot: CompositionSnapshot | null): number {
  return (snapshot?.degraded ?? []).filter((d) => !d.blocking).length
}
