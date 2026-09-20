/* ============================================================
 * ArkWork — 插件注册表（v0.33.0 引入；v0.34.0 去内置通道；v0.35.0 三级作用域）
 * 设计文档：docs/versions/v0.34.0/04-system-design.md §5
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §3（M4）/ §4.4 / §6.3
 *
 * 职责：
 *  ① **三级作用域扫描**（bundled < global < workspace，同 id 整份覆盖）→ `InstalledPlugin[]`
 *  ② 磁盘级校验 **VP7/VP8/VP10**（入口存在性 / engines 兼容 / realpath 不逃逸）
 *  ③ 启停 / 卸载（`bundled` 来源不可卸载）
 *  ④ 把**启用的**插件的贡献点转成插槽条目（`pluginContributions()`）
 *  ⑤ `refreshPluginSlots()`：**按 effect 账本精确撤销**后重注册（免重启插拔）
 *
 * ★ v0.35.0 变更（用户指令「插件代码要独立于 agent、可通过导入的形式」）：
 *  · 新增 `tool` 类贡献（插件给模型加工具）与 `views` 类贡献（插件自带 iframe 界面）；
 *  · 卸载不再依赖「清 `plugin` 来源再重注册」这一条粗粒度路径 —— 先 `revokeAll(pluginId)`
 *    按账本逆序撤销（纪律⑬），`resetProfileSlots('plugin')` 退居兜底；
 *  · 启动对账 `reconcileKnownIds()` 清死条目（D76）。
 *
 * 三条纪律（对齐 v0.33.0 §12）：
 *  ① **逐插件隔离** —— 一个坏插件不得影响其他插件，也不得阻断启动；
 *  ② **绝不半注册** —— 校验有 error 即整插件不产出任何条目；
 *  ③ **不越权接管** —— `renderer` 插件命中已被内置占用的扩展名且未 `override`
 *     时**不产出条目**（正本 04 §5：接管文件类型是高影响动作，必须显式）。
 * ============================================================ */
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isSamplePlugin, sampleManifestForExport } from './sample-plugins.js'
import { ensureSamplePlugins } from './seed.js'
// ★ v0.35.0（D75 / A12）：落盘清单的外科式迁移（摘除废弃面板及其引用）
import { migratePluginManifestsOnDisk } from './migrate.js'
import {
  getEnabledMap,
  getOrderMap,
  invalidatePluginCache,
  markStaleOrderRef,
  pluginsDir,
  reconcileKnownIds,
  resolveEnabled,
  scanPluginsIn,
  setEnabled,
  type PluginScope,
  type ScannedPlugin,
} from './store.js'
import { pluginEffects } from './effects.js'
import { parsePluginManifest, contributionLabelOf, satisfiesEngineRange } from '@shared/utils/plugin-manifest'
import { BUILTIN_EXTENSIONS } from '@shared/utils/renderer-ext'
import {
  PLUGIN_SOURCE_ORDER,
  type InstalledPlugin,
  type PluginIssue,
  type PluginManifest,
  type PluginSource,
  type PluginSummary,
} from '@shared/types/plugin'
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

/** 宿主版本（VP8 的 engines 判定用；由 registry 注入，避免 shared 层依赖 app 元信息） */
let hostVersion = '0.0.0'

/** 由主进程启动时序注入真实版本（`app.getVersion()`） */
export function setHostVersion(v: string): void {
  hostVersion = v || '0.0.0'
}

export function getHostVersion(): string {
  return hostVersion
}

let cache: InstalledPlugin[] | null = null

/**
 * 插件「停机」钩子（由 `runtime/host-service` 在初始化时注入）。
 *
 * 为什么用注入而不是直接 import：`host-service` **需要** registry
 * （`listInstalledPlugins` / `refreshPluginSlots`），registry 若再反向 import
 * 就成环。钩子把「停掉运行态的 Host 半 + 撤掉它的运行期注册」这一步交出去，
 * 同时让本文件保持「只知道自己这层」的纯粹。
 *
 * 为什么不放在 IPC 层调用：**所有**改启用态的入口（IPC、模型控制工具、将来的
 * CLI）都必然经过本文件，钩子挂在这里才不会被某条新入口漏掉。
 */
let teardownHook: ((id: string) => Promise<void>) | null = null

export function setPluginTeardownHook(fn: ((id: string) => Promise<void>) | null): void {
  teardownHook = fn
}

/* ============================================================
 * 磁盘级校验（VP7 / VP8 / VP10）—— 纯函数校验器做不了的这三件事
 * ============================================================ */

/** realpath 后是否仍在插件目录内（挡 `..` 与 symlink 逃逸，沿用 fs/guard.ts 的手法） */
function staysInside(dir: string, rel: string): boolean {
  try {
    const base = realpathSync(dir)
    const target = resolve(base, rel)
    // 目标可能还不存在（例如作者写错文件名）→ 用 parent 判断归属
    const probe = existsSync(target) ? realpathSync(target) : realpathSync(resolve(target, '..'))
    const r = relative(base, probe)
    return r === '' || (!r.startsWith('..') && !isAbsolute(r))
  } catch {
    return false
  }
}

/**
 * 需要真实磁盘与宿主版本的校验：VP7（入口存在）/ VP8（engines 兼容）/ VP10（realpath 不逃逸）。
 *
 * 为什么与 `parsePluginManifest` 分开：后者是 shared 层的**零依赖纯函数**
 * （同时被渲染层 import），不能碰 fs；而这三项必须摸磁盘。
 * **规则编号沿用同一套**，作者看到的诊断不会出现「有两套 VP 编号」。
 *
 * @returns 追加的问题（可为空数组）
 */
export function verifyPluginEntries(m: PluginManifest, dir: string): PluginIssue[] {
  const issues: PluginIssue[] = []

  // VP8：engines 兼容
  const range = m.engines?.arkwork
  if (range && !satisfiesEngineRange(range, hostVersion)) {
    issues.push({
      rule: 'VP8',
      level: 'error',
      path: '$.engines.arkwork',
      message: `插件要求 ArkWork ${range}，当前版本 ${hostVersion} 不满足`,
      fix: '升级 ArkWork，或把 engines.arkwork 改为当前版本可满足的范围',
    })
  }

  // VP10 + VP7：入口不逃逸、且真的存在
  const entries: Array<{ path: string; rel: string }> = []
  if (m.main) entries.push({ path: '$.main', rel: m.main })
  if (m.renderer) entries.push({ path: '$.renderer', rel: m.renderer })
  for (const [i, v] of (m.provides.views ?? []).entries()) {
    const rel = v.renderer ?? m.renderer
    if (rel) entries.push({ path: `$.provides.views[${i}].renderer`, rel })
  }

  for (const e of entries) {
    if (!staysInside(dir, e.rel)) {
      issues.push({
        rule: 'VP10',
        level: 'error',
        path: e.path,
        message: `入口「${e.rel}」解析后不在插件目录内（疑似 ../ 或 symlink 逃逸）`,
        fix: '入口必须是插件目录内的相对路径',
      })
      continue
    }
    const abs = join(dir, e.rel)
    if (!existsSync(abs)) {
      issues.push({
        rule: 'VP7',
        level: 'error',
        path: e.path,
        message: `入口文件不存在：${e.rel}`,
        fix: '检查文件名大小写与扩展名；插件目录内应能看到该文件',
      })
    }
  }

  return issues
}

/** 来源优先级（唯一真源在 @shared/types/plugin 的 PLUGIN_SOURCE_ORDER） */
function rankOf(source: PluginSource): number {
  const i = PLUGIN_SOURCE_ORDER.indexOf(source)
  return i < 0 ? 0 : i
}

/* ============================================================
 * 扫描与汇总
 * ============================================================ */

/**
 * 扫描全部作用域并做覆盖解析（带缓存）。`invalidatePlugins()` 后重扫。
 *
 * @returns 每个 id **只有一条**（最高优先级那份）；被覆盖者记 `shadowedBy`
 */
export async function listPlugins(): Promise<InstalledPlugin[]> {
  if (cache) return cache
  // 随包示例落盘到**全局**插件目录（工作区级不落随包内容：工作区应当自包含且干净）
  ensureSamplePlugins(pluginsDir('global'))
  // ★ v0.35.0（D75 / A12）：外科式迁移 —— 摘掉被废弃的面板及其引用。
  //   两步分工必须都做，缺一不可：
  //     · `ensureSamplePlugins` 只覆盖**未被用户改动过**的副本（D57 指纹判定）；
  //     · 用户改过的那份它一字不动 → 那两个废弃面板会永远留在用户磁盘上。
  //   本步对**每一份**落盘清单做结构级摘除，且只摘废弃项（用户其它编辑不动）。
  migratePluginManifestsOnDisk(pluginsDir('global'))
  migratePluginManifestsOnDisk(pluginsDir('workspace'))

  const raw: ScannedPlugin[] = [...scanPluginsIn('global'), ...scanPluginsIn('workspace')]
  const built: Array<{ entry: InstalledPlugin; rank: number; invalid?: string }> = []

  for (const s of raw) {
    const b = buildScanEntry(s)
    if (b.entry) built.push({ entry: b.entry, rank: rankOf(b.entry.source) })
    else if (b.invalid) logger.warn('System', `[plugin] 跳过非法插件 ${s.dirName}（${s.scope}）：${b.invalid}`)
  }

  // 同 id 覆盖：高优先级**整份覆盖**低优先级（不做字段级 merge，对齐 dsh patch 的 last-write-wins）
  const byId = new Map<string, { entry: InstalledPlugin; rank: number }>()
  for (const b of built) {
    const cur = byId.get(b.entry.manifest.id)
    if (!cur) {
      byId.set(b.entry.manifest.id, b)
    } else if (b.rank > cur.rank) {
      b.entry.shadowedBy = cur.entry.source
      byId.set(b.entry.manifest.id, b)
    } else {
      // 低优先级那份被覆盖：在胜出者上留痕，便于诊断「为什么改全局没生效」
      cur.entry.shadowedBy = cur.entry.shadowedBy ?? b.entry.source
    }
  }

  const out = Array.from(byId.values())
    .map((x) => x.entry)
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))

  // D76：启动对账 —— 清掉既不认识也不是随包的死条目
  const known = new Set(out.map((p) => p.manifest.id))
  await reconcileKnownIds(known, 'global')
  await reconcileKnownIds(known, 'workspace')

  cache = out
  return out
}

/** 单个磁盘插件的构建（永不抛错） */
function buildScanEntry(s: ScannedPlugin): { entry?: InstalledPlugin; invalid?: string } {
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
    return {
      invalid:
        parsed.issues
          .filter((i) => i.level === 'error')
          .map((i) => `${i.rule} ${i.path}: ${i.message}`)
          .join('；') || '清单非法',
    }
  }
  const m = parsed.manifest

  // 来源：disk(global) 上的随包示例 → 'bundled'；其余按目录归属
  const source: PluginSource =
    s.scope === 'workspace' ? 'workspace' : isSamplePlugin(m.id) ? 'bundled' : 'global'

  // 磁盘级校验（VP7/VP8/VP10）；有 error → 整插件不产出（纪律②）
  const diskIssues = verifyPluginEntries(m, s.dir)
  const diskErrors = diskIssues.filter((i) => i.level === 'error')
  if (diskErrors.length > 0) {
    for (const i of diskIssues) {
      logger.warn('System', `[plugin] ${m.id} ${i.rule} ${i.path}: ${i.message}`)
    }
    return { invalid: diskErrors.map((i) => `${i.rule} ${i.path}: ${i.message}`).join('；') }
  }

  const dirMismatch = s.dirName !== m.id
  if (dirMismatch) markStaleOrderRef(`${s.scope}:${s.dirName}`)

  return {
    entry: {
      manifest: m,
      source,
      dir: s.dir,
      enabled: false, // 下面用 resolveEnabled 统一决定（工作区覆盖全局）
      ...(dirMismatch ? { invalidReason: `目录名（${s.dirName}）与插件 id 不一致，以 id 为准` } : {}),
    },
  }
}

/** 把 `enabled` 依「工作区 → 全局 → 清单缺省」三级解析后写回（与 listPlugins 分开便于测试） */
async function applyEnabled(entries: InstalledPlugin[]): Promise<InstalledPlugin[]> {
  const out: InstalledPlugin[] = []
  for (const p of entries) {
    const r = await resolveEnabled(p.manifest.id, p.manifest.enabledByDefault !== false)
    out.push({ ...p, enabled: r.enabled })
  }
  return out
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
    const homeModules =
      usable && p.manifest.kind === 'homeModule' && p.manifest.provides.homeModule
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
      uninstallable: p.source !== 'bundled',
      /* ★ v0.35.0 */
      viewRefs: usable ? (p.manifest.provides.views ?? []).map((v) => v.viewRef) : [],
      toolNames: usable ? (p.manifest.provides.tools ?? []).map((t) => t.name) : [],
      hasHostCode: !!p.manifest.main,
      hasClientCode: !!p.manifest.renderer || (p.manifest.provides.views ?? []).some((v) => !!v.renderer),
      shadowedBy: p.shadowedBy,
    }
  })
}

/** `listPlugins()` + enabled 三级解析（对外统一入口，避免调用方忘记解析） */
export async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
  return applyEnabled(await listPlugins())
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
          // ★ v0.35.0：代码视图也进插槽（`ui.panel` 的一个变体：载荷带 viewRef）
          for (const v of m.provides.views ?? []) {
            out.push({
              id: v.viewRef,
              kind: 'ui.panel',
              label: v.title,
              source: 'plugin',
              payload: {
                panelRef: v.viewRef,
                title: v.title,
                icon: v.icon,
                // 代码视图没有白名单组件：用 view 标记让渲染层走 iframe 容器
                component: 'PluginView',
                data: { kind: 'static', rows: [] },
                pluginId: m.id,
                view: {
                  viewRef: v.viewRef,
                  placement: v.placement,
                  renderer: v.renderer ?? m.renderer,
                  initialSize: v.initialSize,
                },
              } as unknown as PanelSlotPayload,
            })
          }
          break
        }
        case 'tool': {
          // ★ v0.35.0：kind='tool' 的插件把工具交给模型；工具本身由运行时在激活时注册，
          // 这里只产出一个**可见性登记**条目，让「能力 → 插件」能看到它贡献了什么。
          for (const t of m.provides.tools ?? []) {
            out.push({
              id: `plugin-tool:${m.id}:${t.name}`,
              kind: 'ui.action',
              label: t.name,
              source: 'plugin',
              payload: { actionId: t.name, label: t.description, origin: `plugin:${m.id}` },
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
 * 撤销插件来源的全部插槽条目。
 *
 * ★ v0.35.0 顺序（纪律⑬）：
 *  ① **按 effect 账本精确撤销**（每个插件的每个条目都有自己的 disposer）——
 *     这是主路径，能连定时器 / watcher / 视图会话一起收干净；
 *  ② `resetProfileSlots('plugin')` 作**兜底**：防御「账本之外登记进来的条目」
 *     （例如装配器直接注册的 profile 条目或历史遗留路径）。
 *     只做①会让兜底失效；只做②就是 v0.34.x 的老毛病（靠枚举而非记账）。
 */
async function revokePluginEffects(): Promise<void> {
  const ids = pluginEffects.pluginIds()
  let revoked = 0
  for (const id of ids) {
    // ★ 只撤 `slot`：`tool` / `view` / `panel` 由 Host 半的 effect 账与
    //   `host-service` 持有（见 effects.revokeAll 的 kinds 说明）。一起撤会导致
    //   「插件进程以为注册着、宿主侧已经忘了」的状态分叉。
    const r = await pluginEffects.revokeAll(id, { kinds: ['slot'] })
    revoked += r.revoked
    for (const f of r.failed) {
      // 纪律⑦：静默退化必须留诊断人话
      logger.warn('System', `[plugin] 撤销 ${id} 的副作用失败：${f}`)
    }
  }
  if (revoked > 0) logger.info('System', `[plugin] 按账本撤销 ${revoked} 项插槽副作用`)
  resetProfileSlots('plugin')
}

/**
 * 清 `plugin` 来源 → 重注册当前启用插件的贡献。
 * **不动** `profile` 与 `builtin` 来源（缺陷 D42 的修复语义）。
 */
export async function refreshPluginSlots(): Promise<{ registered: number; plugins: InstalledPlugin[] }> {
  await revokePluginEffects()
  const plugins = await listInstalledPlugins()
  const entries = pluginContributions(plugins)
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
      const pluginId = pluginIdOfEntry(e)
      const disp = registerSlot(e.kind, e, 'plugin')
      // ★ 记账（纪律⑬）：撤销靠账本，不靠枚举数量。
      //   注意 `Disposable` 在本仓是**函数**而不是 `{dispose()}` 对象（types/profile.ts）。
      pluginEffects.register(pluginId, 'slot', `${e.kind} ${e.id}`, () => disp())
      registered += 1
    } catch (err) {
      logger.warn('System', `[plugin] 插槽注册失败（${e.kind} ${e.id}）：${String(err)}`)
    }
  }
  logger.info('System', `[plugin] 刷新插槽：plugin 来源 ${registered} 条（共 ${plugins.length} 个插件）`)
  return { registered, plugins }
}

/** 从插槽条目反查归属插件（payload.pluginId 优先；工具条目从 id 解析） */
function pluginIdOfEntry(e: SlotEntry): string {
  const p = e.payload as { pluginId?: string; origin?: string } | undefined
  if (p?.pluginId) return p.pluginId
  if (p?.origin?.startsWith('plugin:')) return p.origin.slice('plugin:'.length)
  const m = /^plugin-tool:([^:]+):/.exec(e.id)
  if (m) return m[1]!
  return 'unknown'
}

/* ============================================================
 * 可用面板 / 模块（V2 引用闭合的事实源）
 * ============================================================ */

/** 可用面板 ref：内置六面板（裸名 + `panel:` 前缀双写法）+ 启用插件贡献的面板与视图 */
export async function availablePanelRefs(): Promise<string[]> {
  const plugins = await listInstalledPlugins()
  const out = new Set<string>(BUILTIN_PANEL_REFS)
  for (const r of BUILTIN_PANEL_REFS) out.add(r.slice('panel:'.length))
  for (const p of plugins) {
    if (!p.enabled || p.invalidReason) continue
    if (p.manifest.kind !== 'panel') continue
    for (const pd of [p.manifest.provides.panel, ...(p.manifest.provides.panels ?? [])]) {
      if (pd?.panelRef) out.add(pd.panelRef)
    }
    // ★ v0.35.0：代码视图也是可被引用的面板（同一竖排栏）
    for (const v of p.manifest.provides.views ?? []) out.add(v.viewRef)
  }
  return Array.from(out)
}

/** 可用首页模块：六个内置模块名 + 启用插件贡献的 `module:` */
export async function availableHomeModules(): Promise<string[]> {
  const plugins = await listInstalledPlugins()
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
  const plugins = await listInstalledPlugins()
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

/** ★ v0.35.0：启用插件的代码视图（viewRef → 展示信息）；渲染层据此建 Tab */
export async function pluginViews(): Promise<
  Array<{ pluginId: string; source: PluginSource; viewRef: string; title: string; icon?: string; placement: 'dock' | 'float'; order: number }>
> {
  const plugins = await listInstalledPlugins()
  const order = { ...(await getOrderMap('global')), ...(await getOrderMap('workspace')) }
  const out: Array<{
    pluginId: string
    source: PluginSource
    viewRef: string
    title: string
    icon?: string
    placement: 'dock' | 'float'
    order: number
  }> = []
  let seq = 0
  for (const p of plugins) {
    if (!p.enabled || p.invalidReason) continue
    for (const v of p.manifest.provides.views ?? []) {
      out.push({
        pluginId: p.manifest.id,
        source: p.source,
        viewRef: v.viewRef,
        title: v.title,
        icon: v.icon,
        placement: v.placement,
        order: order[v.viewRef] ?? 1000 + seq,
      })
      seq += 1
    }
  }
  return out.sort((a, b) => a.order - b.order || a.viewRef.localeCompare(b.viewRef))
}

/** ★ v0.35.0：全部启用插件声明的模型工具（声明部分；实现由运行时激活时挂上） */
export async function declaredPluginTools(): Promise<
  Array<{ pluginId: string; tool: { name: string; description: string; inputSchema: Record<string, unknown> } }>
> {
  const plugins = await listInstalledPlugins()
  const out: Array<{
    pluginId: string
    tool: { name: string; description: string; inputSchema: Record<string, unknown> }
  }> = []
  for (const p of plugins) {
    if (!p.enabled || p.invalidReason) continue
    for (const t of p.manifest.provides.tools ?? []) out.push({ pluginId: p.manifest.id, tool: t })
  }
  return out
}

/* ============================================================
 * 启停 / 卸载
 * ============================================================ */

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  scope: PluginScope = 'global',
): Promise<{ ok: boolean; reason?: string }> {
  const plugins = await listPlugins()
  const target = plugins.find((p) => p.manifest.id === id)
  if (!target) return { ok: false, reason: 'not-found' }
  // ★ 先停运行态（Host 半进程 + 运行期注册 + 视图会话），再改偏好并重注册插槽。
  //   顺序反了会出现「进程还活着、插槽已经没了」——插件继续跑却看不见入口。
  if (!enabled) await teardownHook?.(id)
  // 随包示例与本地插件都可禁用 —— 显式记录用户选择
  await setEnabled(id, enabled, scope)
  invalidatePlugins()
  await refreshPluginSlots()
  logger.info('System', `[plugin] ${id} → ${enabled ? '启用' : '禁用'}（${scope}）`)
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
    // 先撤销运行期与插槽副作用（纪律⑬），再删目录 —— 顺序反了会留下指向已删目录的挂点
    await teardownHook?.(id)
    await pluginEffects.revokeAll(id)
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
