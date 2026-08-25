/* ============================================================
 * ArkWork — L3b 档案记忆（v0.8.0 F803）
 * 全量归档：任务 done 后把 L1 条目异步入库（ADD-only，保留历史）。
 * 全文检索：MiniSearch（content 权重 2、taskTitle 权重 3）。
 * 文件：
 *   {workspace}/.arkwork/archive/items.jsonl  — 全量条目
 *   {workspace}/.arkwork/archive/index.json   — MiniSearch 索引快照
 * 设计文档：versions/v0.8.0/01-memory.md §5
 * ============================================================ */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getWorkspaceDir } from '../store/db.js'
import { genId } from '@shared/utils/id'
import { logger } from '../system/logger.js'
import { MiniSearchEngine } from './search-engine.js'
import type { SearchDoc } from './search-engine.js'
import type { ArchiveHit } from '@shared/types/memory'
import type { MemoryItem, MemoryKind } from '@shared/types/memory'

/** 档案条目——入库后的不可变记录 */
export interface ArchiveItem {
  id: string
  taskId: string
  taskTitle: string
  content: string
  kind: MemoryKind
  iteration: number
  createdAt: number
}

const ITEMS_FILE = 'items.jsonl'
const INDEX_FILE = 'index.json'
/** 入库失败重试次数（静默，不阻塞 UI） */
const RETRY = 1
/** 索引落盘防抖（ms） */
const PERSIST_DEBOUNCE = 800

function archiveDir(): string {
  return join(getWorkspaceDir(), '.arkwork', 'archive')
}
function itemsPath(): string {
  return join(archiveDir(), ITEMS_FILE)
}
function indexPath(): string {
  return join(archiveDir(), INDEX_FILE)
}

/** 单例引擎：lazy init，启动时加载快照，变更后防抖落盘 */
let engine: MiniSearchEngine | null = null
let persistTimer: NodeJS.Timeout | null = null
let initialized = false

function getEngine(): MiniSearchEngine {
  if (!engine) {
    engine = new MiniSearchEngine({
      fields: ['content', 'taskTitle'],
      storeFields: ['content', 'taskTitle', 'taskId', 'kind', 'iteration', 'createdAt'],
      weights: { content: 2, taskTitle: 3 },
    })
  }
  return engine
}

/**
 * 初始化档案索引——启动时调用一次。
 * 优先加载 index.json 快照；缺失或损坏则从 items.jsonl 重建。
 *
 * v0.9.1 §Task 7：index.json 内容是 MiniSearch.toJSON() 的 JSON 字符串（原样写入），
 * 而不是 JSON.parse 后再 loadJSON 的对象——后者会触发 MiniSearch 抛出
 * "[object Object]" is not valid JSON（contract error）。
 */
export async function initArchiveIndex(): Promise<void> {
  if (initialized) return
  initialized = true
  const eng = getEngine()

  // 1. 尝试加载索引快照（按字符串契约：raw 文本就是 JSON 字符串）
  const idxPath = indexPath()
  if (existsSync(idxPath)) {
    try {
      const snapshot = await readFile(idxPath, 'utf-8')
      eng.loadJSON(snapshot)
      logger.info('Memory', `L3b archive index loaded from snapshot (${eng.size()} docs)`)
      return
    } catch (err) {
      logger.warn('Memory', `L3b index snapshot load failed, rebuilding: ${(err as Error).message}`)
    }
  }

  // 2. 从 items.jsonl 重建
  await rebuildIndexFromItems()
}

async function rebuildIndexFromItems(): Promise<void> {
  const items = await listAllArchiveItems()
  // 重建需用全新引擎避免 id 冲突
  engine = new MiniSearchEngine({
    fields: ['content', 'taskTitle'],
    storeFields: ['content', 'taskTitle', 'taskId', 'kind', 'iteration', 'createdAt'],
    weights: { content: 2, taskTitle: 3 },
  })
  engine.addMany(items as unknown as SearchDoc[])
  logger.info('Memory', `L3b archive index rebuilt from items.jsonl (${items.length} docs)`)
  void schedulePersist()
}

async function listAllArchiveItems(): Promise<ArchiveItem[]> {
  const path = itemsPath()
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArchiveItem)
  } catch {
    return []
  }
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void persistIndex()
  }, PERSIST_DEBOUNCE)
}

async function persistIndex(): Promise<void> {
  if (!engine) return
  try {
    await mkdir(archiveDir(), { recursive: true })
    // v0.9.1 §Task 7：MiniSearch.toJSON() 已经是 JSON 字符串，按字符串契约写盘
    // 不再 JSON.stringify 一遍（再 encode 一次会出现外层字符串包裹 + 双重转义）
    const snapshot = engine.toJSON()
    await writeFile(indexPath(), snapshot, 'utf-8')
  } catch (err) {
    logger.warn('Memory', `L3b index persist failed: ${(err as Error).message}`)
  }
}

/**
 * 归档一个任务的全部 L1 条目——任务 done 后异步调用。
 * - 跳过 system_prompt（无信息量）；
 * - ADD-only：重复 taskId 不去重（历史快照保留）；
 * - 失败静默重试 RETRY 次，永不阻塞 UI。
 * @param taskId
 * @param taskTitle
 * @param l1Items - 该任务的全部 L1 条目（含已归档）
 */
export async function archiveTaskL1(
  taskId: string,
  taskTitle: string,
  l1Items: MemoryItem[],
): Promise<void> {
  if (!initialized) await initArchiveIndex()

  const candidates = l1Items.filter((m) => m.kind !== 'system_prompt')
  if (candidates.length === 0) return

  const items: ArchiveItem[] = candidates.map((m) => ({
    id: genId('arc'),
    taskId,
    taskTitle,
    content: m.content,
    kind: m.kind,
    iteration: m.iteration,
    createdAt: m.createdAt,
  }))

  for (let attempt = 0; attempt <= RETRY; attempt++) {
    try {
      await mkdir(archiveDir(), { recursive: true })
      const block = items.map((i) => JSON.stringify(i)).join('\n') + '\n'
      await appendFile(itemsPath(), block, 'utf-8')
      getEngine().addMany(items as unknown as SearchDoc[])
      void schedulePersist()
      logger.info('Memory', `L3b archived ${items.length} items from ${taskId}`, taskId)
      return
    } catch (err) {
      if (attempt < RETRY) {
        logger.warn('Memory', `L3b archive attempt ${attempt + 1} failed, retrying: ${(err as Error).message}`)
        continue
      }
      logger.error('Memory', `L3b archive failed permanently for ${taskId}: ${(err as Error).message}`, taskId)
    }
  }
}

/**
 * 全文检索档案。
 * @param query - 自然语言查询
 * @param limit - 返回条数上限（默认 5）
 * @returns 命中片段（任务标题 + 时间 + 内容截断 500 字符）
 */
export async function searchArchive(query: string, limit = 5): Promise<ArchiveHit[]> {
  if (!initialized) await initArchiveIndex()
  const hits = getEngine().search(query, limit)
  return hits.map((h, idx) => {
    const content = String(h.fields.content ?? '')
    const taskTitle = String(h.fields.taskTitle ?? '')
    return {
      itemId: h.id,
      taskId: String(h.fields.taskId ?? ''),
      taskTitle,
      snippet: content.slice(0, 500),
      rank: idx + 1,
      createdAt: Number(h.fields.createdAt ?? 0),
    }
  })
}

/**
 * v0.15.0：归档压缩摘要到 L3b，便于 session-search 召回。
 */
export async function archiveCompactionSummary(
  taskTitle: string,
  summary: string,
  taskId: string,
): Promise<void> {
  if (!initialized) await initArchiveIndex()
  const item: ArchiveItem = {
    id: genId('comp'),
    taskId,
    taskTitle: taskTitle || taskId,
    content: summary,
    kind: 'compressed_summary' as MemoryKind,
    iteration: -1,
    createdAt: Date.now(),
  }
  try {
    await mkdir(archiveDir(), { recursive: true })
    await appendFile(itemsPath(), JSON.stringify(item) + '\n', 'utf-8')
    getEngine().add(item as unknown as SearchDoc)
    void schedulePersist()
    logger.info('Memory', `L3b compaction-summary archived: ${taskId}`)
  } catch (err) {
    logger.warn('Memory', `L3b compaction-summary archive failed: ${(err as Error).message}`)
  }
}
