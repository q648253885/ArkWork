/* ============================================================
 * ArkWork — Knowledge Base Store (v0.8.0 F810/F811)
 * 持久化结构：
 *   {workspace}/.arkwork/kb/kb.json      — 知识库清单（元数据）
 *   {workspace}/.arkwork/kb/chunks.jsonl  — 切块全量（检索数据源）
 *   {workspace}/.arkwork/kb/files/{id}.{ext} — 原文集中存储
 *
 * 迁移：首次启动若检测到旧 {arkworkDir}/knowledge.json，自动改名 .bak
 *       并把条目迁移到新 kb.json（chunks 字段留空，等用户重导入解析）。
 * 设计文档：versions/v0.8.0/02-knowledge-base.md §3.2
 * ============================================================ */
import { join } from 'node:path'
import { readFile, writeFile, mkdir, appendFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getWorkspaceDir, getArkworkDir } from '../store/db.js'
import { genId } from '@shared/utils/id'
import { logger } from '../system/logger.js'
import { tFor, getUiLocale } from '../i18n/messages.js'
import type { KnowledgeBase, KbChunk } from '@shared/types/conversation'

/** KB 目录根 */
export function kbDir(): string {
  return join(getWorkspaceDir(), '.arkwork', 'kb')
}
function kbJsonPath(): string {
  return join(kbDir(), 'kb.json')
}
function chunksPath(): string {
  return join(kbDir(), 'chunks.jsonl')
}
function filesDir(): string {
  return join(kbDir(), 'files')
}
function legacyKnowledgePath(): string {
  return join(getArkworkDir(), 'knowledge.json')
}

let migrated = false

/** 首次调用时迁移旧 knowledge.json → kb.json（幂等） */
async function ensureMigrated(): Promise<void> {
  if (migrated) return
  migrated = true
  const legacy = legacyKnowledgePath()
  const target = kbJsonPath()
  if (!existsSync(legacy) || existsSync(target)) return

  try {
    await mkdir(kbDir(), { recursive: true })
    const raw = await readFile(legacy, 'utf-8')
    const oldItems = JSON.parse(raw) as Array<{
      id: string
      name: string
      path: string
      type?: string
      size?: number
      addedAt: string
    }>
    // 旧条目迁移：保留元数据，chunks=0、enabled=true、parseError 提示需重导入
    const migratedItems: KnowledgeBase[] = oldItems.map((o) => ({
      id: o.id || genId('kb'),
      name: o.name,
      path: o.path, // 旧 path 是源路径，非集中存储路径
      type: o.type ?? 'file',
      size: o.size ?? 0,
      addedAt: o.addedAt,
      chunks: 0,
      enabled: true,
      parseError: tFor(getUiLocale(), 'kb.legacyEntryError'),
    }))
    await writeFile(target, JSON.stringify(migratedItems, null, 2), 'utf-8')
    // 旧文件改名 .bak（不直接删，留回滚余地）
    await rename(legacy, `${legacy}.bak`)
    logger.info('System', `kb migrated ${migratedItems.length} entries from legacy knowledge.json`)
  } catch (err) {
    logger.warn('System', `kb migration failed (silent): ${(err as Error).message}`)
  }
}

/** 读取知识库清单（自动迁移） */
async function readKbJson(): Promise<KnowledgeBase[]> {
  await ensureMigrated()
  const path = kbJsonPath()
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    const data = JSON.parse(raw) as KnowledgeBase[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

async function writeKbJson(items: KnowledgeBase[]): Promise<void> {
  await mkdir(kbDir(), { recursive: true })
  await writeFile(kbJsonPath(), JSON.stringify(items, null, 2), 'utf-8')
}

/** 列出所有知识库条目（按添加时间倒序） */
export async function listKb(): Promise<KnowledgeBase[]> {
  const items = await readKbJson()
  return items.sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0))
}

/** 按 id 查找 */
export async function getKb(id: string): Promise<KnowledgeBase | null> {
  const items = await readKbJson()
  return items.find((k) => k.id === id) ?? null
}

/** 查询启用的知识库条目（面板 enabled=true） */
export async function listEnabledKb(): Promise<KnowledgeBase[]> {
  const items = await listKb()
  return items.filter((k) => k.enabled !== false && !k.parseError)
}

export interface AddKbInput {
  name: string
  /** 源文件扩展名（决定集中存储路径） */
  ext: string
  size: number
}

/** 新增知识库条目元数据（不写入切块） */
export async function addKbEntry(input: AddKbInput): Promise<KnowledgeBase> {
  const id = genId('kb')
  const entry: KnowledgeBase = {
    id,
    name: input.name,
    path: join('.arkwork', 'kb', 'files', `${id}.${input.ext}`),
    type: input.ext,
    size: input.size,
    addedAt: new Date().toISOString(),
    chunks: 0,
    enabled: true,
    parseError: '',
  }
  const items = await readKbJson()
  items.push(entry)
  await writeKbJson(items)
  return entry
}

/** 集中存储原文路径（绝对） */
export function kbFilePath(id: string, ext: string): string {
  return join(filesDir(), `${id}.${ext}`)
}

/** 批量写入切块并回写 kb.json 的 chunks 计数 */
export async function saveChunks(kbId: string, chunks: KbChunk[]): Promise<number> {
  await mkdir(kbDir(), { recursive: true })
  if (chunks.length > 0) {
    const block = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n'
    await appendFile(chunksPath(), block, 'utf-8')
  }
  // 更新 kb.json 的 chunks 字段
  const items = await readKbJson()
  const idx = items.findIndex((k) => k.id === kbId)
  if (idx >= 0) {
    items[idx] = { ...items[idx], chunks: chunks.length, parseError: '' }
    await writeKbJson(items)
  }
  return chunks.length
}

/** 标记解析失败 */
export async function markParseError(kbId: string, error: string): Promise<void> {
  const items = await readKbJson()
  const idx = items.findIndex((k) => k.id === kbId)
  if (idx >= 0) {
    items[idx] = { ...items[idx], parseError: error, chunks: 0 }
    await writeKbJson(items)
  }
}

/** 删除知识库条目 + 对应切块 + 原文文件 */
export async function removeKb(id: string): Promise<void> {
  const items = await readKbJson()
  const next = items.filter((k) => k.id !== id)
  await writeKbJson(next)
  // 删除原文文件
  const entry = items.find((k) => k.id === id)
  if (entry) {
    const absPath = join(getWorkspaceDir(), entry.path)
    const { rm } = await import('node:fs/promises')
    await rm(absPath, { force: true }).catch(() => {})
  }
  // 删除该 kbId 的切块（重写 chunks.jsonl，过滤掉该 kbId）
  await deleteChunksByKbId(id)
}

/** 重命名知识库条目 */
export async function renameKb(id: string, newName: string): Promise<void> {
  const items = await readKbJson()
  const idx = items.findIndex((k) => k.id === id)
  if (idx >= 0) {
    items[idx] = { ...items[idx], name: newName }
    await writeKbJson(items)
  }
}

/** 切换 enabled 开关 */
export async function setKbEnabled(id: string, enabled: boolean): Promise<void> {
  const items = await readKbJson()
  const idx = items.findIndex((k) => k.id === id)
  if (idx >= 0) {
    items[idx] = { ...items[idx], enabled }
    await writeKbJson(items)
  }
}

/** 删除某 kbId 的全部切块（重写 chunks.jsonl） */
async function deleteChunksByKbId(kbId: string): Promise<void> {
  if (!existsSync(chunksPath())) return
  try {
    const raw = await readFile(chunksPath(), 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const kept = lines.filter((line) => {
      try {
        const chunk = JSON.parse(line) as KbChunk
        return chunk.kbId !== kbId
      } catch {
        return false
      }
    })
    await writeFile(chunksPath(), kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8')
  } catch (err) {
    logger.warn('System', `deleteChunksByKbId failed: ${(err as Error).message}`)
  }
}

/** 清空某 kbId 的切块（重导入前调用，先清后写） */
export async function clearChunksByKbId(kbId: string): Promise<void> {
  return deleteChunksByKbId(kbId)
}

/** 读取全部切块（用于索引重建） */
export async function readAllChunks(): Promise<KbChunk[]> {
  if (!existsSync(chunksPath())) return []
  try {
    const raw = await readFile(chunksPath(), 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as KbChunk
        } catch {
          return null
        }
      })
      .filter((c): c is KbChunk => c !== null)
  } catch {
    return []
  }
}

/** 按 kbId 集合读取切块（检索时用） */
export async function readChunksByKbIds(kbIds: string[]): Promise<KbChunk[]> {
  if (kbIds.length === 0) return []
  const all = await readAllChunks()
  const set = new Set(kbIds)
  return all.filter((c) => set.has(c.kbId))
}

/** 集中存储目录绝对路径（导入时复制原文用） */
export function filesDirAbs(): string {
  return filesDir()
}
