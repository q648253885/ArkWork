/* ============================================================
 * ArkWork — 面板模型：插槽条目 → Inspector 面板 Tab（纯函数 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §7.1
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §3（ui.panel）
 *
 * 为什么独立成纯模块：这是 v0.33.0 的**核心转换**（插槽条目 → 可渲染 Tab），
 * 而 `Inspector.tsx` 顶层依赖 store / i18n / 若干面板组件，node:test 无法覆盖。
 * 把转换抽到这里，就能用表驱动用例逐条把守「position 插入 / 去重 / 非法跳过」。
 *
 * 三条纪律（对齐 `04-system-design.md` §12）：
 *  ① **顺序真源唯一 = manifest `position`** —— 内置 Tab 的相对顺序仍归用户偏好，
 *     但面板插入点只认 manifest（不引入 `Record<profileId, PanelPrefs>` 双源）。
 *  ② **非法条目跳过而不抛错** —— 插槽条目可能来自用户手改的磁盘文件。
 *  ③ **确定性** —— 同 position 按 ref 字典序，两次调用结果逐位相同。
 * ============================================================ */
import type { DockTabId } from '@shared/types/agent'
import type { SlotEntry } from '@shared/types/profile'
import { isPanelSlotPayload, type PanelData, type PanelInteract, type VLibComponentName } from '@shared/types/vlib'

/** Inspector 的内置 Tab（活组件 `Inspector.tsx` 的六项，非 RightDock 的 DockTabId） */
export const INSPECTOR_TAB_REFS = ['todos', 'context', 'files', 'logs', 'browser', 'terminal'] as const
export type InspectorTabRef0 = (typeof INSPECTOR_TAB_REFS)[number]

/**
 * `DockTabId` → Inspector Tab 的归一表。
 * `progress` 是 RightDock 时代的面板（v0.32.0 的 `PROFILE_DOCK_TABS` 含它），
 * 而 Inspector 里对应的是 `logs` —— 归一放在这里，上层不必知道这段历史。
 */
export const DOCK_TAB_TO_INSPECTOR: Record<DockTabId, string> = {
  files: 'files',
  context: 'context',
  terminal: 'terminal',
  browser: 'browser',
  todos: 'todos',
  progress: 'logs',
}

/** 一个可渲染的 Tab（内置或面板） */
export interface PanelTab {
  /** 内置：InspectorTabId；面板：`panel:<name>` */
  ref: string
  /** i18n key（内置）或字面量（插件面板标题） */
  title: string
  icon?: string
  /** 内置 Tab 也有值（供面板 Tab 复用同一渲染分支） */
  builtin: boolean
  /** 插件面板才有 */
  component?: VLibComponentName
  data?: PanelData
  pluginId?: string
  /** 面板插入序（内置 Tab 无） */
  position?: number
  /** v0.34.1：交互声明（行点击 → 浮窗打开面板） */
  interact?: PanelInteract
  /**
   * v0.34.1：面板打开参数（浮场景承载时由行点击传入）。
   * 参与 URL 模板替换 —— 「点哪只股票就看哪只股票」靠它。
   */
  params?: Record<string, unknown>
  /**
   * ★ v0.35.0：**代码视图**标记。
   *
   * 有它 → 该 Tab 的内容由 `PluginViewHost`（iframe 容器 + postMessage 桥）
   * 渲染；没有 → 走 `PanelHost`（白名单组件）。两者**根本不同**：
   * 前者是插件自己的任意 HTML/JS，后者是宿主白名单组件的声明式数据。
   *
   * 之所以标在 Tab 上而不是让渲染层去查列表：Tab 是渲染层唯一拿到的东西，
   * 让分支判定自包含，就不会出现「查表失败 → 渲染成白名单面板 → 报组件不存在」
   * 这种把「插件视图」误报成「面板坏掉」的错位（D78 类问题的同型）。
   */
  view?: { pluginId: string; viewRef: string; placement: 'dock' | 'float' }
}

/** 内置 Tab 的 i18n 标题键（与 `INSPECTOR_TAB_META` 的 label 保持一致） */
export const BUILTIN_TAB_TITLES: Record<string, string> = {
  todos: 'inspector.tab.todos',
  context: 'inspector.tab.context',
  files: 'inspector.tab.files',
  logs: 'inspector.tab.logs',
  browser: 'inspector.tab.browser',
  terminal: 'inspector.tab.terminal',
}

const PANEL_REF_RE = /^panel:[a-z0-9][\w.-]*$/

/**
 * `panelRef` → Inspector Tab ref（归一）。
 *  - 裸内置名（`files` 等）→ 归一后的内置 Tab ref
 *  - `panel:<name>`：内置六名 → 归一；其余 → 原样返回（插件面板）
 *  - 其余（空串 / 大写 / 含空格 / 冒号后非法起始）→ `null`
 */
export function panelRefToInspectorTab(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length === 0) return null
  if (!ref.includes(':')) {
    // 裸名只接受 DockTabId 全集的精确小写形式
    if (ref in DOCK_TAB_TO_INSPECTOR) return DOCK_TAB_TO_INSPECTOR[ref as DockTabId]
    return null
  }
  if (!PANEL_REF_RE.test(ref)) return null
  const name = ref.slice('panel:'.length)
  if (name in DOCK_TAB_TO_INSPECTOR) return DOCK_TAB_TO_INSPECTOR[name as DockTabId]
  return ref
}

/** 由内置 Tab ref 造一个 `PanelTab`（供 mergePanelOrder 的 base 用） */
export function builtinTabOf(ref: string): PanelTab | null {
  if (!(INSPECTOR_TAB_REFS as readonly string[]).includes(ref)) return null
  return { ref, title: BUILTIN_TAB_TITLES[ref] ?? ref, builtin: true }
}

/** 批量：内置 ref 列表 → PanelTab 列表（非法项丢弃） */
export function builtinTabsOf(refs: string[]): PanelTab[] {
  const out: PanelTab[] = []
  for (const r of refs) {
    const t = builtinTabOf(r)
    if (t) out.push(t)
  }
  return out
}

/**
 * 从插槽条目里挑出可渲染的面板 Tab。
 * 只认 `kind === 'ui.panel'` + 通过 `isPanelSlotPayload` 守卫的条目；
 * 内置面板（`panel:files` 等）`builtin=true` 且无 `component`。
 * 输出按 `position` 升序、同 position 按 `ref` 字典序（确定性）。
 */
export function panelTabsOf(entries: SlotEntry[] | undefined | null): PanelTab[] {
  const out: PanelTab[] = []
  const seen = new Set<string>()
  for (const e of entries ?? []) {
    if (!e || e.kind !== 'ui.panel') continue
    const ref = panelRefToInspectorTab(e.id)
    if (!ref) continue
    if (seen.has(ref)) continue

    // 内置面板：无 payload 形状要求（由 Inspector 的既有分支渲染）
    if ((INSPECTOR_TAB_REFS as readonly string[]).includes(ref)) {
      const t = builtinTabOf(ref)
      if (!t) continue
      // 内置标题以 i18n 为准，不接受 manifest 覆盖
      t.position = normalizePosition(e.position)
      seen.add(ref)
      out.push(t)
      continue
    }

    if (!isPanelSlotPayload(e.payload)) continue
    const p = e.payload
    seen.add(ref)
    out.push({
      ref,
      title: p.title,
      icon: p.icon,
      builtin: false,
      component: p.component,
      data: p.data,
      pluginId: p.pluginId,
      position: normalizePosition(e.position),
      // v0.34.1：交互与打开参数随条目一起流向渲染层（行点击 → 浮窗）
      ...(p.interact ? { interact: p.interact } : {}),
    })
  }
  return sortByPosition(out)
}

/** position 归一：仅接受非负整数，其余（含 NaN / 小数 / 负数 / 缺省）→ undefined */
function normalizePosition(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return undefined
  return v
}

/** 升序；同值按 ref 字典序（确定性） */
function sortByPosition(tabs: PanelTab[]): PanelTab[] {
  return [...tabs].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER
    const pb = b.position ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return a.ref.localeCompare(b.ref)
  })
}

/**
 * 内置 Tab 序列 + 面板 Tab → 最终展示顺序。
 *
 * 规则（逐条有用例）：
 *  ① 面板按 `position` 升序处理；缺省 → 追加到末尾；
 *  ② 有 `position` → 插入到 `clamp(position, 0, out.length)`（`0` = 置顶）；
 *  ③ 面板 `ref` 已存在于 base → **不重复插入**（以 base 位置为准）；
 *  ④ base 原样保留、相对顺序不变。
 */
export function mergePanelOrder(base: PanelTab[], panels: PanelTab[]): PanelTab[] {
  const out = [...base]
  const existing = new Set(out.map((t) => t.ref))
  let lastPos: number | undefined
  let lastIdx = -1
  for (const p of sortByPosition(panels.filter((x) => !x.builtin))) {
    if (existing.has(p.ref)) continue
    // position 归一与 panelTabsOf 同口径：仅接受非负整数，其余按缺省（追加末尾）
    const pos = typeof p.position === 'number' && Number.isInteger(p.position) && p.position >= 0
      ? p.position
      : undefined
    let idx: number
    if (pos === undefined) {
      idx = out.length
    } else if (pos === lastPos && lastIdx >= 0) {
      // 同 position 的后续面板紧跟前一个之后（groupBy 插入），
      // 否则逐个 splice 到同一下标会把字典序反转成 z→a
      idx = lastIdx + 1
    } else {
      idx = Math.min(pos, out.length)
    }
    out.splice(idx, 0, p)
    existing.add(p.ref)
    lastPos = pos
    lastIdx = idx
  }
  return out
}

/** 判断一个 Tab ref 是否是插件面板（非内置六项） */
export function isPanelTabRef(ref: string): boolean {
  return !(INSPECTOR_TAB_REFS as readonly string[]).includes(ref)
}

/**
 * v0.36.0（B11/P3-b）：按工作台插件白名单过滤面板 / 视图 Tab。
 *
 * `pluginRefs === null` = manifest 未声明 → 原样返回（不过滤，存量行为不变）；
 * 数组（含空）→ 只保留内置 Tab 与 pluginId 在白名单内的插件 Tab。
 * 判定依据是 Tab 自带的 `pluginId`（面板与代码视图都有），与 ref 形状解耦。
 */
export function filterTabsByPluginRefs(tabs: PanelTab[], pluginRefs: string[] | null): PanelTab[] {
  if (pluginRefs === null) return tabs
  const allow = new Set(pluginRefs)
  return tabs.filter((t) => t.builtin || (t.pluginId !== undefined && allow.has(t.pluginId)))
}

/* ============================================================
 * ★ v0.35.0：插件**代码视图** → Tab（M13 的建 Tab 半边）
 * ============================================================ */

/**
 * 视图 ref 形状：`view:<name>`。
 * 与面板的 `panel:<name>` **刻意分开命名空间** —— 两者渲染路径完全不同，
 * 同名会让「插件视图」与「白名单面板」在诊断与日志里无法区分。
 */
const VIEW_REF_RE = /^view:[a-z0-9][\w.-]*$/

/**
 * 视图 ref 形状守卫。
 *
 * 返回**类型谓词**而不是 `boolean`：调用点（渲染层把跨进程来的 ref 交给
 * `setInspectorTab`）正好需要「值级校验 + 类型收窄」一步到位。
 * 写成 boolean 的话调用点只能 `as` 一下，形状校验就被顺手丢掉了
 * —— 而这里守的正是**来自另一个进程**的字符串。
 */
export function isPluginViewRef(ref: unknown): ref is `view:${string}` {
  return typeof ref === 'string' && VIEW_REF_RE.test(ref)
}

/**
 * 插件视图贡献（来自 `ark.plugin.views()`）→ 可渲染 Tab。
 *
 * 与 `panelTabsOf` 的三条差异（都是刻意的）：
 *  ① 数据源不同：这里吃的是**运行期**视图列表（Host 半已激活才知道有哪些），
 *     不是磁盘扫描出的 `provides.views`；因此禁用一个插件后它自然消失；
 *  ② 不合并进 `profilePanels`：profile 是「工作台引用清单」，插件视图不受它管辖
 *     —— 合成一条会破坏 profile 的语义（也违反 v0.34.0 的 P3 重组裁决）；
 *  ③ 只接受合法 ref / 非空 title，其余整条丢弃（视图列表是跨进程来的）。
 *
 * `order` 升序、同序按 ref 字典序（确定性，与面板同口径）。
 */
export function pluginViewTabsOf(
  views:
    | ReadonlyArray<{
        pluginId: string
        viewRef: string
        title: string
        icon?: string | undefined
        placement: 'dock' | 'float'
        order: number
        active: boolean
      }>
    | undefined
    | null,
): PanelTab[] {
  const out: PanelTab[] = []
  const seen = new Set<string>()
  for (const v of views ?? []) {
    if (!v || typeof v.pluginId !== 'string' || v.pluginId.length === 0) continue
    if (!isPluginViewRef(v.viewRef)) continue
    if (seen.has(v.viewRef)) continue // 同 ref 只留第一条（跨插件重复 ref 由 main 侧拦，这里只兜底）
    const title = typeof v.title === 'string' && v.title.trim().length > 0 ? v.title : v.viewRef
    seen.add(v.viewRef)
    out.push({
      ref: v.viewRef,
      title,
      ...(v.icon ? { icon: v.icon } : {}),
      builtin: false,
      pluginId: v.pluginId,
      position: Number.isInteger(v.order) && v.order >= 0 ? v.order : undefined,
      view: { pluginId: v.pluginId, viewRef: v.viewRef, placement: v.placement === 'float' ? 'float' : 'dock' },
    })
  }
  return sortByPosition(out)
}

