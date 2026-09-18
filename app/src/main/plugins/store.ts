/* ============================================================
 * ArkWork — 能力插件持久化与目录扫描（v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §3.1 / §4.2
 *
 * 目录规范：
 *   {arkworkDir}/plugins/<plugin-dir>/plugin.json
 *   （getArkworkDir() = {userData}/arkwork-data，与 profiles.json 同级）
 *
 * 启停状态：`{arkworkDir}/plugins.json`（复用既有 `JsonDoc`，**不新建存储原语**）
 *   { "schemaVersion": "1.0", "enabled": { "<pluginId>": false }, "updatedAt": 0 }
 *
 * 只记录**用户显式改过**的插件 —— 这样插件升级改了 `enabledByDefault` 之后，
 * 用户的显式选择仍然被尊重（与 VS Code 的 settings 覆盖同款语义）。
 *
 * 纪律：扫描**永不抛错**。读不了的目录/文件只是「这个插件不出现」，
 * 绝不因一个坏插件让注册表起不来。
 * ============================================================ */
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { getArkworkDir, JsonDoc } from '../store/db.js'
import { logger } from '../system/logger.js'

export interface PluginsDoc {
  schemaVersion: string
  /** 只含用户显式改过的项 */
  enabled: Record<string, boolean>
  updatedAt: number
}

/** 单个用户插件的原始扫描结果 */
export interface ScannedPlugin {
  /** 插件目录的绝对路径 */
  dir: string
  /** 目录名（与 manifest.id 不一致时给 warning） */
  dirName: string
  /** plugin.json 的原始内容（解析失败时为 undefined） */
  raw?: unknown
  /** 读取/解析失败原因（非空时 raw 必然为 undefined） */
  readError?: string
}

const FALLBACK: PluginsDoc = { schemaVersion: '1.0', enabled: {}, updatedAt: 0 }

let doc: JsonDoc<PluginsDoc> | null = null
let cached: PluginsDoc | null = null

function docRef(): JsonDoc<PluginsDoc> {
  if (!doc) doc = new JsonDoc<PluginsDoc>(join(getArkworkDir(), 'plugins.json'), FALLBACK)
  return doc
}

/** 插件目录根（不存在也返回路径，供 UI 「打开目录」用） */
export function pluginsDir(): string {
  return join(getArkworkDir(), 'plugins')
}

/** 就绪化插件目录（幂等；失败只 warn —— 目录建不出来不该阻断启动） */
export function ensurePluginsDir(): string {
  const dir = pluginsDir()
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch (err) {
    logger.warn('System', `[plugin] 插件目录创建失败：${String(err)}`)
  }
  return dir
}

/** 扫描用户插件目录（永不抛错；每个失败项进 `readError`） */
export function scanUserPlugins(): ScannedPlugin[] {
  const dir = ensurePluginsDir()
  const out: ScannedPlugin[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch (err) {
    logger.warn('System', `[plugin] 目录读取失败：${String(err)}`)
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
      out.push({ dir: sub, dirName: name, readError: '目录内缺少 plugin.json' })
      continue
    }
    try {
      const text = readFileSync(file, 'utf-8')
      out.push({ dir: sub, dirName: name, raw: JSON.parse(text) as unknown })
    } catch (err) {
      out.push({ dir: sub, dirName: name, readError: `plugin.json 解析失败：${String(err)}` })
    }
  }
  return out
}

/** 读启停状态（带内存缓存） */
export async function getEnabledMap(): Promise<Record<string, boolean>> {
  if (cached) return cached.enabled
  const raw = await docRef().read()
  const enabled: Record<string, boolean> = {}
  if (raw.enabled && typeof raw.enabled === 'object' && !Array.isArray(raw.enabled)) {
    for (const [k, v] of Object.entries(raw.enabled)) {
      if (typeof v === 'boolean') enabled[k] = v
    }
  }
  cached = {
    schemaVersion: '1.0',
    enabled,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
  return cached.enabled
}

/** 写启停状态（覆盖写；失败只 warn —— 启停失败由调用方回读实际值） */
export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const cur = await getEnabledMap()
  const next: PluginsDoc = {
    schemaVersion: '1.0',
    enabled: { ...cur, [id]: enabled },
    updatedAt: Date.now(),
  }
  cached = next
  try {
    await docRef().write(next)
  } catch (err) {
    logger.warn('System', `[plugin] 启停状态写入失败（${id}=${enabled}）：${String(err)}`)
  }
}

/** 测试与「重新扫描」用：清内存缓存（下次读盘） */
export function invalidatePluginCache(): void {
  cached = null
  doc = null
}
