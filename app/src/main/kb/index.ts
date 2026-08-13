/* ============================================================
 * ArkWork — Knowledge Base Index (v0.8.0 F811)
 * 切块策略：字符窗口 ~1,800（≈500 tokens）+ 重叠 150，优先段落边界断开。
 * 索引：MiniSearch（复用 search-engine.ts 抽象），text 权重 2 / kbName 权重 1。
 * 设计文档：versions/v0.8.0/02-knowledge-base.md §4
 * ============================================================ */
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getWorkspaceDir } from '../store/db.js'
import { genId } from '@shared/utils/id'
import { logger } from '../system/logger.js'
import { MiniSearchEngine } from '../memory/search-engine.js'
import type { SearchHit, SearchDoc } from '../memory/search-engine.js'
import { listKb, readAllChunks, readChunksByKbIds } from './store.js'
import type { KbChunk, KnowledgeBase } from '@shared/types/conversation'

/** 切块字符窗口 */
const CHUNK_WINDOW = 1800
/** 切块重叠字符 */
const CHUNK_OVERLAP = 150

function indexPath(): string {
  return join(getWorkspaceDir(), '.arkwork', 'kb', 'index.json')
}

/* ============================================================
 * 切块
 * ============================================================ */

/**
 * 将纯文本切分为块。
 * 策略：按 `\n\n`（段落边界）优先断开，累积到 ~1800 字符切一块；
 * 块间重叠 150 字符，避免截断句子导致上下文丢失。
 */
export function chunkText(text: string, kbId: string): KbChunk[] {
  if (!text.trim()) return []

  const chunks: KbChunk[] = []
  let seq = 0
  let pos = 0

  // 按段落边界切分，再聚合到窗口大小
  const paragraphs = text.split(/\n\n+/)
  let buffer = ''
  let bufferStart = 0

  for (const para of paragraphs) {
    // 计算当前段落在原文中的起始位置
    const paraStart = text.indexOf(para, pos)
    pos = paraStart + para.length

    if (buffer.length + para.length > CHUNK_WINDOW && buffer) {
      // 当前 buffer 已接近窗口，先落块
      chunks.push(makeChunk(kbId, seq, buffer, bufferStart, bufferStart + buffer.length))
      seq++
      // 保留 overlap：从 buffer 末尾取 150 字符作为下一块开头
      const overlap = buffer.slice(-CHUNK_OVERLAP)
      buffer = overlap + para
      bufferStart = bufferStart + buffer.length - overlap.length - para.length + overlap.length
      // 简化：overlap 模式下 bufferStart 近似正确（切块检索不依赖精确 startChar）
      bufferStart = text.indexOf(buffer, paraStart - buffer.length) | 0
      if (bufferStart < 0) bufferStart = 0
    } else {
      if (!buffer) {
        bufferStart = paraStart >= 0 ? paraStart : 0
      }
      buffer = buffer ? buffer + '\n\n' + para : para
    }
  }
  // 最后一块
  if (buffer.trim()) {
    chunks.push(makeChunk(kbId, seq, buffer, bufferStart, bufferStart + buffer.length))
  }

  // 若段落切分后单块仍超窗口（超长段落），硬切
  const finalChunks: KbChunk[] = []
  for (const c of chunks) {
    if (c.text.length <= CHUNK_WINDOW * 1.5) {
      finalChunks.push(c)
    } else {
      let s = 0
      let subSeq = 0
      while (s < c.text.length) {
        const end = Math.min(s + CHUNK_WINDOW, c.text.length)
        finalChunks.push({
          id: genId('ck'),
          kbId,
          seq: c.seq + subSeq,
          text: c.text.slice(s, end),
          startChar: c.startChar + s,
          endChar: c.startChar + end,
        })
        s = end - CHUNK_OVERLAP
        subSeq++
        if (s >= c.text.length) break
      }
    }
  }
  return finalChunks
}

function makeChunk(kbId: string, seq: number, text: string, startChar: number, endChar: number): KbChunk {
  return {
    id: genId('ck'),
    kbId,
    seq,
    text,
    startChar,
    endChar,
  }
}

/* ============================================================
 * 索引（MiniSearch，复用 search-engine 抽象）
 * ============================================================ */

/** KB 检索文档（扩展切块 + kbName 供检索与展示） */
interface KbSearchDoc {
  id: string
  text: string
  kbId: string
  kbName: string
  seq: number
}

let engine: MiniSearchEngine | null = null
let indexed = false

function getEngine(): MiniSearchEngine {
  if (!engine) {
    engine = new MiniSearchEngine({
      fields: ['text', 'kbName'],
      storeFields: ['text', 'kbId', 'kbName', 'seq'],
      weights: { text: 2, kbName: 1 },
    })
  }
  return engine
}

/** 从全部切块重建索引（启动时或重导入后调用） */
export async function rebuildKbIndex(): Promise<void> {
  const chunks = await readAllChunks()
  const kbList = await listKb()
  const kbMap = new Map(kbList.map((k) => [k.id, k]))
  const docs: SearchDoc[] = chunks.map((c) => {
    const kb = kbMap.get(c.kbId)
    return {
      id: c.id,
      text: c.text,
      kbId: c.kbId,
      kbName: kb?.name ?? c.kbId,
      seq: c.seq,
    }
  })
  // 重建需用全新引擎避免 id 冲突
  engine = new MiniSearchEngine({
    fields: ['text', 'kbName'],
    storeFields: ['text', 'kbId', 'kbName', 'seq'],
    weights: { text: 2, kbName: 1 },
  })
  engine.addMany(docs as unknown as SearchDoc[])
  indexed = true
  logger.info('System', `KB index rebuilt: ${docs.length} chunks from ${kbList.length} docs`)
}

/** 增量添加切块到索引（单次导入后调用） */
export function addToIndex(kbId: string, kbName: string, chunks: KbChunk[]): void {
  const eng = getEngine()
  const docs: SearchDoc[] = chunks.map((c) => ({
    id: c.id,
    text: c.text,
    kbId,
    kbName,
    seq: c.seq,
  }))
  eng.addMany(docs as unknown as SearchDoc[])
  void schedulePersist()
}

/** 从索引中移除某 kbId 的全部文档（重导入/删除前调用） */
export function removeFromIndex(kbId: string): void {
  if (!engine || !indexed) return
  // MiniSearch 不支持按字段过滤删除，只能重建
  void rebuildKbIndex()
}

/** 索引快照防抖落盘 */
let persistTimer: ReturnType<typeof setTimeout> | null = null
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(async () => {
    if (!engine) return
    try {
      const snapshot = engine.toJSON()
      await mkdir(join(getWorkspaceDir(), '.arkwork', 'kb'), { recursive: true })
      await writeFile(indexPath(), JSON.stringify(snapshot), 'utf-8')
    } catch (err) {
      logger.warn('System', `KB index persist failed: ${(err as Error).message}`)
    }
  }, 2000)
}

/** 启动时从快照加载索引，失败则重建 */
export async function initKbIndex(): Promise<void> {
  if (indexed) return
  try {
    if (existsSync(indexPath())) {
      const raw = await readFile(indexPath(), 'utf-8')
      getEngine().loadJSON(raw)
      indexed = true
      logger.info('System', 'KB index loaded from snapshot')
      return
    }
  } catch (err) {
    logger.warn('System', `KB index load failed, rebuilding: ${(err as Error).message}`)
  }
  await rebuildKbIndex()
}

/* ============================================================
 * 检索
 * ============================================================ */

export interface KbSearchHit {
  chunkId: string
  kbId: string
  kbName: string
  seq: number
  text: string
  score: number
}

/**
 * 检索知识库切块。
 * @param query 查询文本
 * @param kbIds 限定检索的知识库 id 集合（空则搜全部）
 * @param limit 返回上限（默认 5）
 */
export async function searchKb(
  query: string,
  kbIds: string[] | null,
  limit = 5,
): Promise<KbSearchHit[]> {
  if (!indexed) await initKbIndex()
  const eng = getEngine()
  const hits = eng.search(query, limit * 3) // 多取再过滤
  const idSet = kbIds && kbIds.length > 0 ? new Set(kbIds) : null

  const filtered = hits.filter((h) => {
    const kbId = h.fields.kbId as string
    return !idSet || idSet.has(kbId)
  })

  return filtered.slice(0, limit).map((h: SearchHit) => ({
    chunkId: h.id,
    kbId: h.fields.kbId as string,
    kbName: h.fields.kbName as string,
    seq: h.fields.seq as number,
    text: (h.fields.text as string).slice(0, 600),
    score: h.score,
  }))
}

/** 获取某知识库的切块数（从索引或文件读取） */
export async function getKbChunkCount(kbId: string): Promise<number> {
  const chunks = await readAllChunks()
  return chunks.filter((c) => c.kbId === kbId).length
}
