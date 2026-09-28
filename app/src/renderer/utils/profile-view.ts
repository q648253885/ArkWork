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
  /**
   * v0.36.0（B11/P3-b）：工作台级插件白名单。
   * `null` = manifest 未声明（不过滤，全部插件面板照旧显示）；
   * 数组（含空）= 白名单生效。
   */
  pluginRefs: string[] | null
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
  if (!snapshot) return { dockTabs: null, homeModule: null, composerChips: [], pluginRefs: null }
  let dockTabs: DockTabId[] | null = null
  let homeModule: string | null = null
  let composerChips: string[] = []
  let pluginRefs: string[] | null = null
  for (const item of snapshot.layers.ui) {
    if (!item.applied) continue
    if (item.slot === 'ui.dockTabs' && item.value) {
      const tabs = item.value.split(',').filter(Boolean) as DockTabId[]
      if (tabs.length > 0) dockTabs = tabs
    } else if (item.slot === 'ui.homeModule' && item.value) {
      if (isHomeModuleValue(item.value)) homeModule = item.value
    } else if (item.slot === 'ui.composerChips' && item.value) {
      composerChips = item.value.split(',').filter(Boolean).slice(0, 8)
    } else if (item.slot === 'ui.pluginRefs') {
      // applied=true 的行无论 value 是否为空串都生效：空数组 = 全部隐藏
      pluginRefs = item.value.split(',').filter(Boolean)
    }
  }
  return { dockTabs, homeModule, composerChips, pluginRefs }
}

/* ============================================================
 * v0.33.0：插槽明细 → 派生量（★ v0.36.0 D5 收缩：去掉 rendererOverrides）
 *
 * 与 `projectUiLayer`（读**快照**）的分工：
 *   · 快照 = 人话级的「这一层生效了吗」（用于激活报告）
 *   · 插槽 = 真正可渲染的数据体（用于 Inspector 面板 / 主题）
 * 两者不可互相替代 —— 快照的 ui.theme 只登记**键名**，token 值只在插槽里。
 * ============================================================ */

export interface SlotDerivations {
  /** 可渲染面板 Tab（顺序真源 = manifest position） */
  panels: PanelTab[]
  /** token 覆盖（已过值白名单；键的存在性由应用层用 DOM 兜底） */
  theme: ThemeTokens
}

/** 空派生量（无插槽时的返回值，避免各处重复造对象） */
export const EMPTY_DERIVATIONS: SlotDerivations = { panels: [], theme: { light: {}, dark: {} } }

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
 * 纪律：**坏条目跳过，绝不抛错**（插槽可能来自用户手改的磁盘文件）。
 *
 * ★ v0.36.0（D5）：`ui.renderer` 分支已删除 —— 该插槽随契约收缩消失。
 * 扩展名 → 渲染器的判定不走这里：`detectRendererKind()` 直读
 * `shared/utils/renderer-ext.ts` 的内置表（唯一真源）；
 * 预览窗的「切换格式」是**本地 UI 状态**（`PreviewWindow` 的 `rendererOverrides`），
 * 与插槽无关 —— 两者同名不同物，别再被名字误导（这是 D101 的教训）。
 */
export function deriveFromSlots(slots: Partial<Record<SlotKind, SlotEntry[]>> | null | undefined): SlotDerivations {
  if (!slots) return EMPTY_DERIVATIONS
  const panels = panelTabsOf(slots['ui.panel'])

  const sets = (slots['ui.theme'] ?? []).map(themeTokensOf).filter((t): t is Partial<ThemeTokens> => t !== null)
  const merged = mergeThemeTokens(...sets)
  return { panels, theme: merged }
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
