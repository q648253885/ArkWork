/* ============================================================
 * ArkWork — 插件持久化与目录扫描（v0.33.0 引入；v0.35.0 扩**两级作用域**）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §3.1 / §4.2
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §4.3 / §4.4
 *
 * 目录规范（两级）：
 *   global    ：{arkworkDir}/plugins/<plugin-dir>/plugin.json
 *   workspace ：{workspace}/.arkwork/plugins/<plugin-dir>/plugin.json   ← 优先级更高
 * 启停状态：同级 `plugins.json`（两级各自一份；工作区那份优先）
 *
 * ★ v0.35.0 变更：
 *  ① `scope` 维度贯穿全部 API（缺省 `'global'`，与 v0.34.x 行为一致）；
 *  ② `plugins.json` 增 `order`（视图排序提示），schemaVersion 1.0 → 1.1（旧值按 1.0 读入，无损）；
 *  ③ 新增 `reconcileKnownIds()`：启动对账清掉**已不存在且非随包**的死条目（D76）。
 *
 * 只记录**用户显式改过**的插件 —— 这样插件升级改了 `enabledByDefault` 之后，
 * 用户的显式选择仍然被尊重（与 VS Code 的 settings 覆盖同款语义）。
 *
 * 纪律：扫描**永不抛错**。读不了的目录/文件只是「这个插件不出现」，
 * 绝不因一个坏插件让注册表起不来。
 * ============================================================ */
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { getArkworkDir, getWorkspaceDir, JsonDoc } from '../store/db.js'
import { logger } from '../system/logger.js'
import { isSamplePlugin } from './sample-plugins.js'
import type { PluginSource } from '@shared/types/plugin'

/** 插件作用域（v0.35.0）：全局 / 本工作区 */
export type PluginScope = 'global' | 'workspace'

export interface PluginsDoc {
  schemaVersion: string
  /** 只含用户显式改过的项 */
  enabled: Record<string, boolean>
  /** ★ v0.35.0：视图在竖排栏内的排序提示（viewRef → 序号；缺省按注册顺序） */
  order: Record<string, number>
  updatedAt: number
}

/** 单个插件的原始扫描结果 */
export interface ScannedPlugin {
  /** ★ v0.35.0：来自哪一级作用域 */
  scope: PluginScope
  /** 插件目录的绝对路径 */
  dir: string
  /** 目录名（与 manifest.id 不一致时给 warning） */
  dirName: string
  /** plugin.json 的原始内容（解析失败时为 undefined） */
  raw?: unknown
  /** 读取/解析失败原因（非空时 raw 必然为 undefined） */
  readError?: string
}

const FALLBACK: PluginsDoc = { schemaVersion: '1.1', enabled: {}, order: {}, updatedAt: 0 }

/** 每个 scope 一份文档句柄 + 缓存（两级独立，互不干扰） */
const docs = new Map<PluginScope, JsonDoc<PluginsDoc>>()
const cached = new Map<PluginScope, PluginsDoc>()

function docRef(scope: PluginScope): JsonDoc<PluginsDoc> {
  let d = docs.get(scope)
  if (!d) {
    d = new JsonDoc<PluginsDoc>(join(scopeRootDir(scope), 'plugins.json'), FALLBACK)
    docs.set(scope, d)
  }
  return d
}

/**
 * 某作用域的**内容根目录**。
 * global → `{userData}/arkwork-data`；workspace → `<workspace>/.arkwork`
 * （与任务记忆目录同级，符合工作区自包含原则）。
 */
function scopeRootDir(scope: PluginScope): string {
  return scope === 'workspace' ? join(getWorkspaceDir(), '.arkwork') : getArkworkDir()
}

/** 插件目录根（不存在也返回路径，供 UI 「打开目录」用） */
export function pluginsDir(scope: PluginScope = 'global'): string {
  return join(scopeRootDir(scope), 'plugins')
}

/**
 * 就绪化插件目录（幂等；失败只 warn —— 目录建不出来不该阻断启动）。
 *
 * ★ v0.35.0：`pluginsDir(scope)` 也挪进 try。原先它在 try 之外，而
 *   `scopeRootDir` 要走 `getArkworkDir()`（`app.getPath('userData')`）——
 *   在 `app.whenReady()` 之前调用会**抛穿**本函数，直接违反本模块头声明的
 *   「纪律：扫描永不抛错」。现在无论路径解析在哪一步失败，都退化成
 *   「返回空路径 + 一行 warn」，由调用方（`scanPluginsIn`）的逐项 try 兜住。
 */
export function ensurePluginsDir(scope: PluginScope = 'global'): string {
  let dir = ''
  try {
    dir = pluginsDir(scope)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    ensureDirPackageType(dir)
  } catch (err) {
    logger.warn('System', `[plugin] 插件目录创建失败（${scope}）：${String(err)}`)
  }
  return dir
}

/**
 * ★ v0.35.0：给插件根目录补一份 `{"type":"commonjs"}` 的 package.json。
 *
 * 为什么**必须**有它：Host 半入口若叫 `main.js`，Node 按「最近的 package.json
 * 的 type」决定它是 CJS 还是 ESM。插件目录在 `{userData}` 下，上层没有
 * package.json —— 于是解析结果取决于上层文件系统的偶然情况，**不可预测**。
 * 我们在插件根目录钉死一份，`.js` 就确定是 CJS（与 VS Code 同款抉择），
 * 想在 `.js` 里写 `export` 的作者改用 `.mjs` 或在**自己插件目录内**放
 * `{"type":"module"}`（更近的同名文件优先，作者仍有完全控制权）。
 *
 * 只补空缺、绝不覆盖作者自己写的 package.json。
 */
export function ensureDirPackageType(dir: string): void {
  const file = join(dir, 'package.json')
  if (existsSync(file)) return
  try {
    writeFileSync(file, `${JSON.stringify({ type: 'commonjs', private: true }, null, 2)}\n`, 'utf-8')
  } catch (err) {
    logger.warn('System', `[plugin] 写入 ${file} 失败：${String(err)}`)
  }
}

/** 扫描某作用域的插件目录（永不抛错；每个失败项进 `readError`） */
export function scanPluginsIn(scope: PluginScope): ScannedPlugin[] {
  const dir = ensurePluginsDir(scope)
  const out: ScannedPlugin[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    logger.warn('System', `[plugin] 目录读取失败（${scope}）：${String(err)}`)
    return out
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const sub = join(dir, name)
    try {
      if (!statSync(sub).isDirectory()) continue
    } catch {
      continue
    }
    const file = join(sub, 'plugin.json')
    if (!existsSync(file)) {
      out.push({ scope, dir: sub, dirName: name, readError: '目录内缺少 plugin.json' })
      continue
    }
    try {
      const text = readFileSync(file, 'utf-8')
      out.push({ scope, dir: sub, dirName: name, raw: JSON.parse(text) as unknown })
    } catch (err) {
      out.push({ scope, dir: sub, dirName: name, readError: `plugin.json 解析失败：${String(err)}` })
    }
  }
  return out
}

/**
 * v0.34.x 兼容别名：扫描**全局**插件目录。
 * 保留它的原因是既有用例与调用点都按「只有一个作用域」写的；
 * 新代码请直接用 `scanPluginsIn(scope)`。
 */
export function scanUserPlugins(): ScannedPlugin[] {
  return scanPluginsIn('global')
}

/** 读启停状态（带内存缓存；默认全局） */
export async function getEnabledMap(scope: PluginScope = 'global'): Promise<Record<string, boolean>> {
  return (await loadDoc(scope)).enabled
}

/** 读排序提示（viewRef → 序号） */
export async function getOrderMap(scope: PluginScope = 'global'): Promise<Record<string, number>> {
  return (await loadDoc(scope)).order
}

async function loadDoc(scope: PluginScope): Promise<PluginsDoc> {
  const hit = cached.get(scope)
  if (hit) return hit
  const raw = await docRef(scope).read()
  const enabled: Record<string, boolean> = {}
  if (raw.enabled && typeof raw.enabled === 'object' && !Array.isArray(raw.enabled)) {
    for (const [k, v] of Object.entries(raw.enabled)) {
      if (typeof v === 'boolean') enabled[k] = v
    }
  }
  const order: Record<string, number> = {}
  if (raw.order && typeof raw.order === 'object' && !Array.isArray(raw.order)) {
    for (const [k, v] of Object.entries(raw.order)) {
      if (typeof v === 'number' && Number.isFinite(v)) order[k] = v
    }
  }
  const doc: PluginsDoc = {
    schemaVersion: '1.1',
    enabled,
    order,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
  cached.set(scope, doc)
  return doc
}

/** 写启停状态（覆盖写；失败只 warn —— 启停失败由调用方回读实际值） */
export async function setEnabled(
  id: string,
  enabled: boolean,
  scope: PluginScope = 'global',
): Promise<void> {
  const cur = await loadDoc(scope)
  const next: PluginsDoc = {
    schemaVersion: '1.1',
    enabled: { ...cur.enabled, [id]: enabled },
    order: cur.order,
    updatedAt: Date.now(),
  }
  cached.set(scope, next)
  try {
    await docRef(scope).write(next)
  } catch (err) {
    logger.warn('System', `[plugin] 启停状态写入失败（${scope} ${id}=${enabled}）：${String(err)}`)
  }
}

/**
 * ★ v0.35.0（D76）：清掉 `plugins.json` 里**已失效的死条目**。
 *
 * 为什么要有它：`enabled` 只增不减 —— 插件被删除后，它的开关记录会永远留在文件里。
 * 本机实测就有一条 `ark.plugin.kchart-renderer: false`（v0.34.1 已删除该示例）。
 * 死条目本身无害，但它会污染诊断信息，也让「这个 id 到底是什么」无法回答。
 *
 * 语义（保守）：
 *  · 只清「**既不在磁盘上，也不是随包示例**」的项；
 *  · 随包示例的开关**永远保留**（用户禁用示例插件是合法选择，且示例可能被重新落盘）；
 *  · 清理后写回；写回失败只 warn（清理是加分项，不阻断启动）。
 *
 * @param knownIds 当前磁盘上真实存在的插件 id 集合（由 registry 汇总）
 */
export async function reconcileKnownIds(
  knownIds: ReadonlySet<string>,
  scope: PluginScope = 'global',
): Promise<{ cleaned: string[] }> {
  const cur = await loadDoc(scope)
  const cleaned: string[] = []
  const nextEnabled: Record<string, boolean> = {}
  for (const [id, v] of Object.entries(cur.enabled)) {
    if (knownIds.has(id) || isSamplePlugin(id)) nextEnabled[id] = v
    else cleaned.push(id)
  }
  const nextOrder: Record<string, number> = {}
  for (const [ref, v] of Object.entries(cur.order)) {
    // order 的 key 是 viewRef/panelRef；这里只能按前缀粗筛，交由装配期再收敛
    if (pendingOrderRefs.has(ref)) continue
    nextOrder[ref] = v
  }
  if (cleaned.length === 0 && Object.keys(nextOrder).length === Object.keys(cur.order).length) {
    return { cleaned }
  }
  const next: PluginsDoc = { schemaVersion: '1.1', enabled: nextEnabled, order: nextOrder, updatedAt: Date.now() }
  cached.set(scope, next)
  try {
    await docRef(scope).write(next)
  } catch (err) {
    logger.warn('System', `[plugin] 死条目清理写回失败（${scope}）：${String(err)}`)
  }
  if (cleaned.length > 0) {
    logger.info('System', `[plugin] 已清理 ${cleaned.length} 条失效插件记录（${scope}）：${cleaned.join(', ')}`)
  }
  return { cleaned }
}

/** 被登记的「待清理 order 引用」（由 registry 在校验失败/覆盖时填） */
const pendingOrderRefs = new Set<string>()

/** 登记一个应当被对账清掉的 order 引用 */
export function markStaleOrderRef(ref: string): void {
  pendingOrderRefs.add(ref)
}

/** 测试与「重新扫描」用：清内存缓存（下次读盘） */
export function invalidatePluginCache(): void {
  cached.clear()
  docs.clear()
}

/** 测试收尾：清对账登记表 */
export function clearStaleOrderRefs(): void {
  pendingOrderRefs.clear()
}

/** 诊断：某 id 的开关最终值（工作区覆盖全局；都没有则用插件自己的 enabledByDefault） */
export async function resolveEnabled(
  id: string,
  enabledByDefault: boolean,
): Promise<{ enabled: boolean; decidedBy: PluginScope | 'manifest' }> {
  const ws = await getEnabledMap('workspace')
  if (typeof ws[id] === 'boolean') return { enabled: ws[id]!, decidedBy: 'workspace' }
  const gl = await getEnabledMap('global')
  if (typeof gl[id] === 'boolean') return { enabled: gl[id]!, decidedBy: 'global' }
  return { enabled: enabledByDefault, decidedBy: 'manifest' }
}

/** 供测试构造：把某 scope 的文档直接置为给定值（绕过磁盘） */
export function __setDocForTest(scope: PluginScope, doc: PluginsDoc): void {
  cached.set(scope, doc)
}

/** 来源 → 作用域 的反查（UI 与诊断共用；bundled 视为 global 侧） */
export function scopeOfSource(source: PluginSource): PluginScope {
  return source === 'workspace' ? 'workspace' : 'global'
}
