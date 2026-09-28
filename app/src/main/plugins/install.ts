/* ============================================================
 * ArkWork — 插件 zip 安装器（v0.36.0 · B2 / F3.2）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.4
 *
 * 语义对齐 VS Code 的「从 VSIX 安装」：
 *   选包 → 预览（needsConfirm）→ 确认 → 落盘（默认禁用）→ 刷新插槽。
 *
 * 错误码（设计文档 §3.4 五枚举 + 两个前置枚举）：
 *   NO_FILE          未提供 zip 路径（IPC 层负责弹文件选择框）
 *   EXTRACT_FAILED   zip 打不开 / 条目非法 / 超限
 *   MANIFEST_INVALID plugin.json 缺失或校验不通过
 *   ENGINES_MISMATCH engines.arkwork 与当前宿主版本不兼容
 *   ENTRY_MISSING    main / renderer 入口文件不存在
 *   ALREADY_EXISTS   同 id 已装且未传 overwrite
 *   IO_ERROR         落盘失败
 *
 * 边界（F3.7 插件边界纪律）：
 *  · 条目名穿越拒绝（`..` / 绝对路径 / 盘符 / 反斜杠归一后仍逃逸）
 *  · 条目数 ≤ 2000、解压总量 ≤ 64 MB（zip 炸弹防护）
 *  · 安装**默认禁用** —— 用户在面板里审过权限再手动启用
 * ============================================================ */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { parsePluginManifest, satisfiesEngineRange } from '@shared/utils/plugin-manifest'
import type { PluginManifest } from '@shared/types/plugin'
import type { PluginInstallZipResult } from '@shared/types/ipc'
import { getHostVersion, invalidatePlugins, refreshPluginSlots } from './registry.js'
import { ensureDirPackageType, pluginsDir, setEnabled } from './store.js'
import { logger } from '../system/logger.js'

/** 解压防护阈值 */
const MAX_ENTRIES = 2000
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** 安装完成后的插槽重建 + 变更广播（由 ipc 层注入，避免反向依赖） */
let broadcaster: ((channel: string, payload: unknown) => void) | null = null

export function setPluginInstallBroadcaster(fn: ((channel: string, payload: unknown) => void) | null): void {
  broadcaster = fn
}

function fail(error: string, message: string): PluginInstallZipResult {
  return { ok: false, error, message }
}

/** 条目名是否安全（不含穿越/绝对路径成分；统一按分隔符切分判断） */
function entryNameSafe(entryName: string): boolean {
  if (!entryName || entryName.startsWith('/') || /^[a-zA-Z]:/.test(entryName)) return false
  const parts = entryName.split(/[/\\]/)
  return parts.length > 0 && parts.every((p) => p !== '..' && p.length > 0 && p !== '.')
}

/** 条目是否是「应该解出来的」（跳过目录、macOS 元数据、非安全名） */
function entryKeep(name: string): boolean {
  if (name === '__MACOSX' || name.startsWith('__MACOSX/')) return false
  if (/(^|\/)\.DS_Store$/.test(name)) return false
  return entryNameSafe(name)
}

/** 解包 zip → 临时目录；返回插件根（处理单顶层目录包裹）与根下文件相对路径集合 */
function extractZip(zipPath: string): { root: string; cleanup: () => void } {
  let zip: AdmZip
  try {
    zip = new AdmZip(zipPath)
  } catch (err) {
    throw Object.assign(new Error(`无法读取 zip：${String(err)}`), { code: 'EXTRACT_FAILED' })
  }
  const entries = zip.getEntries()
  if (entries.length === 0) {
    throw Object.assign(new Error('zip 包为空'), { code: 'EXTRACT_FAILED' })
  }
  const keep = entries.filter((e) => !e.isDirectory && entryKeep(e.entryName))
  if (keep.length === 0) {
    throw Object.assign(new Error('zip 包内没有可解压的文件'), { code: 'EXTRACT_FAILED' })
  }
  if (keep.length > MAX_ENTRIES) {
    throw Object.assign(new Error(`zip 条目数 ${keep.length} 超过上限 ${MAX_ENTRIES}`), { code: 'EXTRACT_FAILED' })
  }
  let total = 0
  for (const e of keep) {
    total += e.header.size
    if (total > MAX_TOTAL_BYTES) {
      throw Object.assign(new Error(`zip 解压总量超过上限 ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB`), { code: 'EXTRACT_FAILED' })
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'arkwork-plugin-'))
  try {
    // 逐条目解压（只解 keep 集合）——extractAllTo 会把 __MACOSX / .DS_Store
    // 这类已被过滤的元数据一并写进临时目录并随 cpSync 落盘。条目名已逐个过闸。
    for (const e of keep) {
      zip.extractEntryTo(e, tmp, /* maintainEntryPath */ true, /* overwrite */ true)
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    throw Object.assign(new Error(`解压失败：${String(err)}`), { code: 'EXTRACT_FAILED' })
  }

  // 单顶层目录包裹（VS Code 的 VSIX / 常见压缩习惯）→ 剥掉
  let root = tmp
  try {
    const tops = readdirSync(tmp).filter((n) => !n.startsWith('.'))
    if (tops.length === 1 && statSync(join(tmp, tops[0]!)).isDirectory()) root = join(tmp, tops[0]!)
  } catch {
    /* 保持 tmp */
  }
  return { root, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

/** 校验清单 + 引擎 + 入口（返回清单；失败时抛带 code 的错误） */
function validatePackage(root: string): PluginManifest {
  const manifestPath = join(root, 'plugin.json')
  if (!existsSync(manifestPath)) {
    throw Object.assign(new Error('插件根目录缺少 plugin.json'), { code: 'MANIFEST_INVALID' })
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown
  } catch (err) {
    throw Object.assign(new Error(`plugin.json 解析失败：${String(err)}`), { code: 'MANIFEST_INVALID' })
  }
  const parsed = parsePluginManifest(raw)
  if (!parsed.manifest) {
    const detail = parsed.issues
      .filter((i) => i.level === 'error')
      .map((i) => `${i.rule} ${i.path}: ${i.message}`)
      .join('；')
    throw Object.assign(new Error(detail || '清单非法'), { code: 'MANIFEST_INVALID' })
  }
  const m = parsed.manifest

  // engines 兼容性（磁盘级 VP8 的安装路径版本）
  const range = m.engines?.arkwork
  if (range && !satisfiesEngineRange(range, getHostVersion())) {
    throw Object.assign(
      new Error(`插件要求 ArkWork ${range}，当前宿主 ${getHostVersion()}`),
      { code: 'ENGINES_MISMATCH' },
    )
  }

  // 入口存在性
  const entries: Array<[string, string | undefined]> = [
    ['main', m.main],
    ['renderer', m.renderer],
    ...(m.provides.views ?? []).map((v) => [`views[${v.viewRef}].renderer`, v.renderer ?? m.renderer] as [string, string | undefined]),
  ]
  for (const [label, entry] of entries) {
    if (entry && !existsSync(join(root, entry))) {
      throw Object.assign(new Error(`入口文件不存在：${label} → ${entry}`), { code: 'ENTRY_MISSING' })
    }
  }
  return m
}

/**
 * 安装插件包（zip）。
 *
 * 两段式：`confirmed` 缺省时只做预览（needsConfirm:true），不落盘；
 * 确认后带 `confirmed:true` 再进来才真正写目录。
 */
export async function installPluginFromZip(opts: {
  zipPath?: string
  confirmed?: boolean
  overwrite?: boolean
}): Promise<PluginInstallZipResult> {
  const zipPath = opts.zipPath?.trim()
  if (!zipPath) return fail('NO_FILE', '未提供插件包路径')
  if (!existsSync(zipPath)) return fail('NO_FILE', `插件包不存在：${zipPath}`)

  // ---- ① 解包 + 校验（不落盘，失败即清理临时目录） ----
  let extracted: { root: string; cleanup: () => void }
  let manifest: PluginManifest
  try {
    extracted = extractZip(zipPath)
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'EXTRACT_FAILED'
    return fail(code, (err as Error).message)
  }
  try {
    try {
      manifest = validatePackage(extracted.root)
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'MANIFEST_INVALID'
      return fail(code, (err as Error).message)
    }

    const target = join(pluginsDir('global'), manifest.id)
    const already = existsSync(target)
    if (already && !opts.overwrite) {
      return {
        ok: false,
        error: 'ALREADY_EXISTS',
        message: `插件 ${manifest.id} 已安装（版本 ${manifest.version}）。覆盖安装请勾选「覆盖已有」。`,
        alreadyExists: true,
        manifest: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          ...(manifest.author ? { author: manifest.author } : {}),
          ...(manifest.description ? { description: manifest.description } : {}),
        },
      }
    }

    // ---- ② 预览（两段式安装的第一段） ----
    if (!opts.confirmed) {
      const caps: string[] = []
      if (manifest.provides.views?.length) caps.push(`视图 ×${manifest.provides.views.length}`)
      if (manifest.provides.tools?.length) caps.push(`模型工具 ×${manifest.provides.tools.length}`)
      if (manifest.provides.commands?.length) caps.push(`命令 ×${manifest.provides.commands.length}`)
      if (manifest.provides.panel || manifest.provides.panels?.length) caps.push('面板')
      if (manifest.provides.renderer) caps.push(`渲染器（.${manifest.provides.renderer.extensions.join(' / .')}）`)
      if (manifest.provides.homeModule) caps.push('首页模块')
      if (manifest.provides.theme) caps.push('主题覆盖')
      return {
        ok: false,
        needsConfirm: true,
        alreadyExists: already,
        manifest: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          ...(manifest.author ? { author: manifest.author } : {}),
          ...(manifest.description ? { description: manifest.description } : {}),
        },
        capabilities: caps,
        permissions: [...(manifest.permissions ?? [])],
      }
    }

    // ---- ③ 落盘（覆盖 = 先删后拷） ----
    try {
      if (already) rmSync(target, { recursive: true, force: true })
      cpSync(extracted.root, target, { recursive: true })
      ensureDirPackageType(target)
    } catch (err) {
      logger.warn('System', `[plugin] 安装 ${manifest.id} 落盘失败：${String(err)}`)
      return fail('IO_ERROR', `写入插件目录失败：${String(err)}`)
    }

    // ---- ④ 默认禁用 + 刷新 + 广播 ----
    await setEnabled(manifest.id, false, 'global')
    invalidatePlugins()
    await refreshPluginSlots()
    broadcaster?.('plugin:changed', { pluginId: manifest.id })
    logger.info('System', `[plugin] 已安装 ${manifest.id}@${manifest.version}（global，默认禁用）`)
    return { ok: true, id: manifest.id }
  } finally {
    extracted.cleanup()
  }
}
