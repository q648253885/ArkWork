/* ============================================================
 * ArkWork — 插件注册表（v0.33.0 引入；v0.34.0 P4 去掉「内置通道」）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §5
 *
 * 职责：
 *  ① **纯磁盘扫描**（随包示例插件在首启时已落盘，见 seed.ts）→ `InstalledPlugin[]`
 *  ② 启停 / 卸载（`bundled` 来源不可卸载）
 *  ③ 把**启用的**插件的贡献点转成插槽条目（`pluginContributions()`）
 *  ④ `refreshPluginSlots()`：清 `plugin` 来源 → 重注册（免重启插拔）
 *
 * ★ v0.34.0 变更（用户实测「内置测试插件不该内置」）：
 *  原实现把四个示例插件当**代码字面量内置**并默认启用 → 每个工作台的右侧竖排栏
 *  都被「数据表 / 插件指南」污染，且与「能力」页的插件概念重叠。
 *  现在：示例插件首启落盘（默认禁用），注册表**只有磁盘一条通道**；
 *  `source` 由 id 是否属于随包示例决定（`bundled` 不可卸载 / `local` 可卸载）。
 *
 * 三条纪律（对齐 v0.33.0 §12）：
 *  ① **逐插件隔离** —— 一个坏插件不得影响其他插件，也不得阻断启动；
 *  ② **绝不半注册** —— 校验有 error 即整插件不产出任何条目；
 *  ③ **不越权接管** —— `renderer` 插件命中已被内置占用的扩展名且未 `override`
 *     时**不产出条目**（正本 04 §5：接管文件类型是高影响动作，必须显式）。
 * ============================================================ */
import { existsSync, rmSync } from 'node:fs'
import { isSamplePlugin, sampleManifestForExport } from './sample-plugins.js'
import { ensureSamplePlugins } from './seed.js'
import {
  getEnabledMap,
  invalidatePluginCache,
  pluginsDir,
  scanUserPlugins,
  setEnabled,
  type ScannedPlugin,
} from './store.js'
import { parsePluginManifest, contributionLabelOf } from '@shared/utils/plugin-manifest'
import { BUILTIN_EXTENSIONS } from '@shared/utils/renderer-ext'
import type { InstalledPlugin, PluginManifest, PluginSource, PluginSummary } from '@shared/types/plugin'
import type { PanelSlotPayload, SlotEntry } from '@shared/types/profile'
import { registerSlot, resetProfileSlots, resolveSlots } from '../profile/slots.js'
import { logger } from '../system/logger.js'

/** 内置 Inspector 面板 ref（供 V2 引用闭合使用；与 DockTabId 全集同源） */
export const BUILTIN_PANEL_REFS = [
  'panel:files',
  'panel:context',
  'panel:terminal',
  'panel:browser',
  'panel:todos',
  'panel:progress',
]

let cache: InstalledPlugin[] | null = null

/** 汇总插件（带缓存）。`invalidatePlugins()` 后重扫。 */
export async function listPlugins(): Promise<InstalledPlugin[]> {
  if (cache) return cache
  // v0.34.0（P4）：首启把随包示例插件落盘（目录已有插件时不动作），
  // 之后所有插件都走同一条磁盘扫描 + 校验路径 —— 注册表里没有内置通道。
  ensureSamplePlugins(pluginsDir())
  const enabledMap = await getEnabledMap()
  const out: InstalledPlugin[] = []

  // ---- 磁盘插件（随包示例 + 用户自建；逐插件隔离） ----
  const scanned = scanUserPlugins()
  for (const s of scanned) {
    const built = buildScanEntry(s, enabledMap)
    if (built.entry) out.push(built.entry)
    if (built.invalid) {
      logger.warn('System', `[plugin] 跳过非法插件 ${s.dirName}：${built.invalid}`)
    }
  }

  cache = out
  return out
}

/** 单个磁盘插件的构建（永不抛错） */
function buildScanEntry(
  s: ScannedPlugin,
  enabledMap: Record<string, boolean>,
): { entry?: InstalledPlugin; invalid?: string } {
  if (s.readError || s.raw === undefined) {
    return { invalid: s.readError ?? '读取失败' }
  }
  let parsed: ReturnType<typeof parsePluginManifest>
  try {
    parsed = parsePluginManifest(s.raw)
  } catch (err) {
    return { invalid: `校验期异常：${String(err)}` }
  }
  if (!parsed.manifest) {
    return { invalid: parsed.issues.filter((i) => i.level === 'error').map((i) => `${i.rule} ${i.path}: ${i.message}`).join('；') || '清单非法' }
  }
  const m = parsed.manifest
  const dirMismatch = s.dirName !== m.id
  // v0.34.0：来源由「是否随包示例」决定（bundled 不可卸载；local 可卸载）
  const source: PluginSource = isSamplePlugin(m.id) ? 'bundled' : 'local'
  return {
    entry: {
      manifest: m,
      source,
      dir: s.dir,
      enabled: enabledMap[m.id] ?? m.enabledByDefault !== false,
      ...(dirMismatch ? { invalidReason: `目录名（${s.dirName}）与插件 id 不一致，以 id 为准` } : {}),
    },
  }
}

/** 列表行（UI 用；不含数据体） */
export function pluginSummaries(plugins: InstalledPlugin[]): PluginSummary[] {
  return plugins.map((p) => {
    // 禁用 / 校验失败的插件不得贡献「可选项」—— 否则编辑器会把勾不上的面板列出来
    const usable = p.enabled && !p.invalidReason
    const panelRefs =
      usable && p.manifest.kind === 'panel'
        ? [p.manifest.provides.panel, ...(p.manifest.provides.panels ?? [])]
            .filter((x): x is NonNullable<typeof x> => !!x)
            .map((x) => x.panelRef)
        : []
    const homeModules = usable && p.manifest.kind === 'homeModule' && p.manifest.provides.homeModule
      ? [p.manifest.provides.homeModule.module]
      : []
    return {
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      author: p.manifest.author,
      description: p.manifest.description,
      kind: p.manifest.kind,
      source: p.source,
      enabled: p.enabled,
      dir: p.dir,
      contributionLabel: contributionLabelOf(p.manifest),
      panelRefs,
      homeModules,
      invalidReason: p.invalidReason,
      uninstallable: p.source === 'local',
    }
  })
}

/** 清缓存（重新扫描 / 测试用） */
export function invalidatePlugins(): void {
  cache = null
  invalidatePluginCache()
}

/* ============================================================
 * 贡献点 → 插槽条目
 * ============================================================ */

/**
 * 把启用的插件贡献点转成插槽条目。
 *
 * 关键规则：`renderer` 插件命中**已被内置占用**的扩展名且未 `override: true`
 * → 该扩展名不产出条目（正本 04 §5）。
 */
export function pluginContributions(plugins: InstalledPlugin[]): SlotEntry[] {
  const out: SlotEntry[] = []
  for (const p of plugins) {
    if (!p.enabled || p.invalidReason) continue
    const m = p.manifest
    try {
      switch (m.kind) {
        case 'panel': {
          // v0.34.1：一个插件可贡献多个面板（`provides.panels`）—— 同属一个插件
          // 的面板必须同生共死，否则「列表开着、详情没开」会让行点击点不动。
          const list = [m.provides.panel, ...(m.provides.panels ?? [])].filter(
            (x): x is NonNullable<typeof x> => !!x,
          )
          for (const pd of list) {
            out.push({
              id: pd.panelRef,
              kind: 'ui.panel',
              label: pd.title,
              source: 'plugin',
              payload: {
                panelRef: pd.panelRef,
                title: pd.title,
                icon: pd.icon,
                component: pd.component,
                data: pd.data,
                pluginId: m.id,
                // v0.34.1：交互声明（行点击 → 浮窗）随载荷一起进入插槽
                interact: pd.interact,
              },
            })
          }
          break
        }
        case 'renderer': {
          const rd = m.provides.renderer
          if (!rd) break
          rd.extensions.forEach((ext, i) => {
            const taken = BUILTIN_EXTENSIONS.includes(ext)
            if (taken && rd.override !== true) {
              logger.warn(
                'System',
                `[plugin] ${m.id} 想接管已被内置占用的扩展名 .${ext}，但未声明 override:true → 已忽略`,
              )
              return
            }
            out.push({
              id: `renderer:${ext}`,
              kind: 'ui.renderer',
              label: m.name,
              source: 'plugin',
              position: i,
              payload: {
                rendererKind: rd.rendererKind,
                extensions: [ext],
                override: rd.override === true,
                labelKey: rd.labelKey ?? 'preview.registry.fallback',
              },
            })
          })
          break
        }
        case 'action': {
          const ad = m.provides.action
          if (!ad) break
          out.push({
            id: `action:${ad.actionId}`,
            kind: 'ui.action',
            label: ad.label,
            source: 'plugin',
            payload: { actionId: ad.actionId, label: ad.label, origin: `plugin:${m.id}` },
          })
          break
        }
        case 'homeModule': {
          const hd = m.provides.homeModule
          if (!hd) break
          out.push({
            id: `${hd.module}`,
            kind: 'ui.homeModule',
            label: hd.title,
            source: 'plugin',
            payload: { module: hd.module, title: hd.title, icon: hd.icon, pluginId: m.id },
          })
          break
        }
        case 'theme': {
          const td = m.provides.theme
          if (!td) break
          out.push({
            id: `theme:${m.id}`,
            kind: 'ui.theme',
            label: m.name,
            source: 'plugin',
            payload: { light: td.light ?? {}, dark: td.dark ?? {}, pluginId: m.id },
          })
          break
        }
        default:
          break
      }
    } catch (err) {
      // 逐插件隔离：一个插件产条目时炸了，不影响其他插件
      logger.warn('System', `[plugin] ${m.id} 贡献点生成失败：${String(err)}`)
    }
  }
  return out
}

/**
 * 清 `plugin` 来源 → 重注册当前启用插件的贡献。
 * **不动** `profile` 与 `builtin` 来源（缺陷 D42 的修复语义）。
 */
export async function refreshPluginSlots(): Promise<{ registered: number; plugins: InstalledPlugin[] }> {
  const plugins = await listPlugins()
  const entries = pluginContributions(plugins)
  resetProfileSlots('plugin')
  let registered = 0
  for (const e of entries) {
    // 当前工作台已装配同 id 的 ui.panel（profile 来源）→ **跳过插件条目**：
    // profile 条目携带 manifest position（顺序真源唯一，D48），插件贡献若再注册
    // 会撞「profile 占用不能由 plugin 覆盖」的约束；禁用插件后残留的 profile
    // 条目由下一次装配收敛（激活报告会如实登记）。
    if (
      e.kind === 'ui.panel' &&
      resolveSlots(e.kind, { source: 'profile' }).some((p) => p.id === e.id)
    ) {
      continue
    }
    try {
      // 与 builtin 来源同 id 时允许覆盖（插件接管需显式 override），
      // 这里再兜一层 try/catch，避免单个冲突让整轮刷新失败。
      registerSlot(e.kind, e, 'plugin')
      registered += 1
    } catch (err) {
      logger.warn('System', `[plugin] 插槽注册失败（${e.kind} ${e.id}）：${String(err)}`)
    }
  }
  logger.info('System', `[plugin] 刷新插槽：plugin 来源 ${registered} 条（共 ${plugins.length} 个插件）`)
  return { registered, plugins }
}

/* ============================================================
 * 可用面板 / 模块（V2 引用闭合的事实源）
 * ============================================================ */

/** 可用面板 ref：内置六面板（裸名 + `panel:` 前缀双写法）+ 启用插件贡献的面板 */
export async function availablePanelRefs(): Promise<string[]> {
  const plugins = await listPlugins()
  const out = new Set<string>(BUILTIN_PANEL_REFS)
  for (const r of BUILTIN_PANEL_REFS) out.add(r.slice('panel:'.length))
  for (const p of plugins) {
    if (!p.enabled || p.invalidReason) continue
    if (p.manifest.kind !== 'panel') continue
    for (const pd of [p.manifest.provides.panel, ...(p.manifest.provides.panels ?? [])]) {
      if (pd?.panelRef) out.add(pd.panelRef)
    }
  }
  return Array.from(out)
}

/** 可用首页模块：六个内置模块名 + 启用插件贡献的 `module:` */
export async function availableHomeModules(): Promise<string[]> {
  const plugins = await listPlugins()
  const out = new Set<string>(['automations', 'skills', 'agents', 'kb', 'memory', 'settings'])
  for (const p of plugins) {
    if (!p.enabled || p.invalidReason) continue
    if (p.manifest.kind !== 'homeModule') continue
    const m = p.manifest.provides.homeModule?.module
    if (m) out.add(m)
  }
  return Array.from(out)
}

/** 启用插件贡献的面板载荷（`panel:<name>` → 载荷）；装配器据此解析 `dockPanels` */
export async function pluginPanelPayloads(): Promise<Map<string, PanelSlotPayload>> {
  const plugins = await listPlugins()
  const out = new Map<string, PanelSlotPayload>()
  for (const p of plugins) {
    if (!p.enabled || p.invalidReason) continue
    if (p.manifest.kind !== 'panel') continue
    for (const pd of [p.manifest.provides.panel, ...(p.manifest.provides.panels ?? [])]) {
      if (!pd) continue
      out.set(pd.panelRef, {
        panelRef: pd.panelRef,
        title: pd.title,
        icon: pd.icon,
        component: pd.component,
        data: pd.data,
        pluginId: p.manifest.id,
        interact: pd.interact,
      })
    }
  }
  return out
}

/* ============================================================
 * 启停 / 卸载
 * ============================================================ */

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const plugins = await listPlugins()
  const target = plugins.find((p) => p.manifest.id === id)
  if (!target) return { ok: false, reason: 'not-found' }
  // 随包示例（bundled）与本地插件都可禁用 —— 显式记录用户选择
  await setEnabled(id, enabled)
  invalidatePlugins()
  await refreshPluginSlots()
  logger.info('System', `[plugin] ${id} → ${enabled ? '启用' : '禁用'}`)
  return { ok: true }
}

export async function uninstallPlugin(id: string): Promise<{ ok: boolean; reason?: string }> {
  const plugins = await listPlugins()
  const target = plugins.find((p) => p.manifest.id === id)
  if (!target) return { ok: false, reason: 'not-found' }
  if (target.source === 'bundled') return { ok: false, reason: 'bundled' }
  if (!target.dir || !existsSync(target.dir)) {
    invalidatePlugins()
    return { ok: false, reason: 'dir-missing' }
  }
  try {
    rmSync(target.dir, { recursive: true, force: true })
  } catch (err) {
    logger.warn('System', `[plugin] 卸载 ${id} 失败：${String(err)}`)
    return { ok: false, reason: 'fs-error' }
  }
  invalidatePlugins()
  await refreshPluginSlots()
  logger.info('System', `[plugin] 已卸载 ${id}`)
  return { ok: true }
}

/** 供 UI 的「导出示例插件模板」用（让作者拿到可编辑的模板） */
export function builtinManifestForExport(id: string): PluginManifest | null {
  return sampleManifestForExport(id)
}
