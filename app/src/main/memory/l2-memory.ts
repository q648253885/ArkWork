/* ============================================================
 * ArkWork — L2 压缩记忆（v0.16 Task 7）
 * 设计文档 §9.3 — 任务工作目录的产物经去重 + 摘要后的紧凑形态。
 *  - 写入时去重：基于实体重叠度（Jaccard）检测相似记忆，命中则合并
 *  - 摘要压缩：提取关键实体与意图，生成 compressedContent（上下文注入用）
 *  - 原始内容保留在 rawContent / references（详情查看用，不注入上下文）
 *  - 分片加载：loadRelevantL2Memories 仅返回与当前任务关键词相关的片段
 *  - 管理：list / detail / delete / merge / export
 * 存储：{taskDir}/.arkwork/l2-memory.json（单文件数组，任务级）
 * ============================================================ */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getTaskDir } from '../store/db.js'
import { genId, estimateTokens } from '@shared/utils/id'
import { extractKeyEntities } from './compaction.js'
import { listRawL2, readRawL2 } from './l2-file.js'
import { logger } from '../system/logger.js'
import { broadcast } from '../window.js'
import type { L2Memory } from '@shared/types/memory'

const STORE_FILENAME = 'l2-memory.json'
/** 实体 Jaccard 相似度阈值，超过则视为语义相似并合并 */
const SIMILARITY_THRESHOLD = 0.3
/** 同步原始产物时读取内容的大小上限（字节），超过则仅用文件名摘要 */
const SYNC_READ_MAX_BYTES = 64 * 1024
/** 同步时单条原始内容参与摘要的字符上限 */
const SUMMARY_CHAR_LIMIT = 2000

function storePath(taskId: string): string {
  return join(getTaskDir(taskId), '.arkwork', STORE_FILENAME)
}

async function readStore(taskId: string): Promise<L2Memory[]> {
  const path = storePath(taskId)
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as L2Memory[]) : []
  } catch {
    return []
  }
}

async function writeStore(taskId: string, items: L2Memory[]): Promise<void> {
  const path = storePath(taskId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(items, null, 2), 'utf-8')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

/** 基于关键词的意图分类（本地、确定性，避免 LLM 依赖） */
function detectIntent(text: string): string {
  const lower = text.toLowerCase()
  if (/error|fail|exception|报错|失败|异常|traceback|stack/.test(lower)) return 'error-recovery'
  if (/config|设置|配置|\.env|settings|json|yaml|toml/.test(lower)) return 'config'
  if (/test|spec|测试|coverage/.test(lower)) return 'test'
  if (/refactor|重构|cleanup|清理|rename/.test(lower)) return 'refactor'
  if (/api|endpoint|route|http|request/.test(lower)) return 'api'
  if (/doc|文档|readme|md/.test(lower)) return 'doc'
  if (/data|table|query|sql|schema/.test(lower)) return 'data'
  return 'general'
}

/** 生成本地压缩内容（抽取式摘要：意图标签 + 首段 + 实体清单） */
function buildCompressedContent(raw: string, entities: string[], intent: string): string {
  const head = raw.slice(0, 200).replace(/\s+/g, ' ').trim()
  const ent = entities.slice(0, 6).join(', ')
  return `[${intent}] ${head}${ent ? ` | 实体: ${ent}` : ''}`
}

/** 一行摘要（紧凑列表展示用） */
function deriveSummary(raw: string): string {
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return '(空记忆)'
  const cut = clean.slice(0, 80)
  return cut.length < clean.length ? cut + '…' : cut
}

/** 两个实体集合的 Jaccard 相似度 */
function entitySimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a.map((x) => x.toLowerCase()))
  const setB = new Set(b.map((x) => x.toLowerCase()))
  let inter = 0
  for (const x of setA) if (setB.has(x)) inter++
  const union = setA.size + setB.size - inter
  return union === 0 ? 0 : inter / union
}

function mergeRaw(a: string | undefined, b: string): string {
  if (!a) return b
  return a + '\n\n---\n\n' + b
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/* ============================================================
 * 写入：去重 + 摘要
 * ============================================================ */

/**
 * 写入一条 L2 记忆（去重 + 摘要）。
 * - 提取关键实体与意图，生成 compressedContent
 * - 检测语义相似记忆（实体重叠度 > 阈值），命中则合并为一条（保留最新信息）
 * - 原始内容保留在 rawContent，上下文注入使用 compressedContent
 * @param taskId - 任务 id
 * @param rawContent - 原始内容
 * @param opts.intent - 显式意图（覆盖自动检测）
 * @param opts.referenceId - 来源条目 id（如步骤 id）
 * @returns 写入或合并后的 L2 记忆
 */
export async function appendL2Memory(
  taskId: string,
  rawContent: string,
  opts: { intent?: string; referenceId?: string } = {},
): Promise<L2Memory> {
  const items = await readStore(taskId)
  const entities = extractKeyEntities([rawContent], 12)
  const intent = opts.intent ?? detectIntent(rawContent)
  const summary = deriveSummary(rawContent)
  const compressedContent = buildCompressedContent(rawContent, entities, intent)
  const now = Date.now()
  const referenceId = opts.referenceId ?? genId('ref')

  // 查找最相似的已有记忆
  let best: { item: L2Memory; score: number } | null = null
  for (const item of items) {
    const score = entitySimilarity(item.entities, entities)
    if (score > SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { item, score }
    }
  }

  if (best) {
    const target = best.item
    target.entities = Array.from(new Set([...target.entities, ...entities]))
    target.intent = intent
    target.summary = summary
    target.rawContent = mergeRaw(target.rawContent, rawContent)
    target.compressedContent = buildCompressedContent(target.rawContent, target.entities, target.intent)
    target.compressedTokens = estimateTokens(target.compressedContent)
    target.updatedAt = now
    if (!target.references.includes(referenceId)) target.references.push(referenceId)
    await writeStore(taskId, items)
    broadcast('memory:changed', taskId)
    logger.info('Memory', `L2 memory merged into ${target.id} (similarity=${best.score.toFixed(2)})`, taskId)
    return target
  }

  const entry: L2Memory = {
    id: genId('l2'),
    summary,
    entities,
    intent,
    compressedContent,
    compressedTokens: estimateTokens(compressedContent),
    createdAt: now,
    updatedAt: now,
    references: [referenceId],
    rawContent,
  }
  items.push(entry)
  await writeStore(taskId, items)
  broadcast('memory:changed', taskId)
  return entry
}

/* ============================================================
 * 列表 + 原始产物同步（首次/新增产物自动派生压缩条目）
 * ============================================================ */

/**
 * 列出全部 L2 压缩记忆（按 updatedAt 降序）。
 * 同步：为未引用的原始产物（steps/*.json）派生压缩条目，使产物自动进入紧凑视图。
 * 列表结果不含 rawContent（保持轻量），详情用 getL2Detail 按需加载。
 */
export async function listL2Memories(taskId: string): Promise<L2Memory[]> {
  let items = await readStore(taskId)
  try {
    const artifacts = await listRawL2(taskId)
    const referenced = new Set(items.flatMap((m) => m.references))
    let changed = false
    for (const art of artifacts) {
      if (referenced.has(art.stepId)) continue
      // 派生压缩条目：小产物读取内容摘要，大产物仅用文件名（避免读取开销）
      let rawText = art.stepId
      if (art.size <= SYNC_READ_MAX_BYTES) {
        const raw = await readRawL2(art.path)
        if (raw != null) rawText = safeStringify(raw).slice(0, SUMMARY_CHAR_LIMIT)
      }
      const entities = extractKeyEntities([rawText], 8)
      const intent = art.size <= SYNC_READ_MAX_BYTES ? detectIntent(rawText) : 'artifact'
      const summary = `${art.stepId} · ${formatBytes(art.size)}`
      const compressedContent = `[${intent}] 产物 ${summary}${entities.length ? ` | 实体: ${entities.slice(0, 4).join(', ')}` : ''}`
      const now = Date.now()
      items.push({
        id: genId('l2'),
        summary,
        entities,
        intent,
        compressedContent,
        compressedTokens: estimateTokens(compressedContent),
        createdAt: art.createdAt,
        updatedAt: now,
        references: [art.stepId],
        // rawContent 不持久化，详情按需从产物文件读取
      })
      changed = true
    }
    if (changed) await writeStore(taskId, items)
  } catch (err) {
    logger.warn('Memory', `L2 sync from raw artifacts failed: ${(err as Error).message}`, taskId)
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

/* ============================================================
 * 详情 / 删除 / 合并 / 导出
 * ============================================================ */

/**
 * 查看单条记忆完整详情。若 rawContent 缺失但有 references 指向产物文件，
 * 按需从产物文件读取并回填（不写盘，仅本次返回）。
 */
export async function getL2Detail(taskId: string, id: string): Promise<L2Memory | null> {
  const items = await readStore(taskId)
  const item = items.find((m) => m.id === id)
  if (!item) return null
  if (!item.rawContent && item.references.length > 0) {
    try {
      const artifacts = await listRawL2(taskId)
      const parts: string[] = []
      for (const ref of item.references) {
        const art = artifacts.find((a) => a.stepId === ref)
        if (art) {
          const raw = await readRawL2(art.path)
          if (raw != null) parts.push(safeStringify(raw).slice(0, 8000))
        }
      }
      if (parts.length > 0) item.rawContent = parts.join('\n\n---\n\n')
    } catch (err) {
      logger.warn('Memory', `L2 detail raw load failed: ${(err as Error).message}`, taskId)
    }
  }
  return item
}

/** 删除单条 L2 记忆（仅删除压缩条目，不删除底层产物文件） */
export async function deleteL2Memory(taskId: string, id: string): Promise<L2Memory[]> {
  const items = await readStore(taskId)
  const next = items.filter((m) => m.id !== id)
  await writeStore(taskId, next)
  broadcast('memory:changed', taskId)
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 合并多条 L2 记忆为一条。
 * - 实体取并集，意图取首条，summary 由各 summary 拼接摘要
 * - rawContent 拼接，compressedContent 重新生成
 * - references 取并集，createdAt 取最小，updatedAt 取当前
 * @returns 合并后的新条目（原条目已删除）；ids 不足 2 条时返回 null
 */
export async function mergeL2Memories(taskId: string, ids: string[]): Promise<L2Memory | null> {
  if (ids.length < 2) return null
  const items = await readStore(taskId)
  const toMerge = items.filter((m) => ids.includes(m.id))
  if (toMerge.length < 2) return null

  const entities = Array.from(new Set(toMerge.flatMap((m) => m.entities)))
  const intent = toMerge[0].intent
  const raws = toMerge.map((m) => m.rawContent).filter((v): v is string => Boolean(v))
  const rawContent = raws.length > 0 ? raws.join('\n\n---\n\n') : undefined
  const summary = deriveSummary(toMerge.map((m) => m.summary).join(' '))
  const compressedContent = buildCompressedContent(rawContent ?? summary, entities, intent)
  const now = Date.now()
  const merged: L2Memory = {
    id: genId('l2'),
    summary,
    entities,
    intent,
    compressedContent,
    compressedTokens: estimateTokens(compressedContent),
    createdAt: Math.min(...toMerge.map((m) => m.createdAt)),
    updatedAt: now,
    references: Array.from(new Set(toMerge.flatMap((m) => m.references))),
    rawContent,
  }
  const next = items.filter((m) => !ids.includes(m.id))
  next.push(merged)
  await writeStore(taskId, next)
  broadcast('memory:changed', taskId)
  logger.info('Memory', `L2 merged ${toMerge.length} entries into ${merged.id}`, taskId)
  return merged
}

/**
 * 导出 L2 记忆为 JSON 字符串。
 * @param ids - 指定导出的条目 id；空则导出全部
 */
export async function exportL2Memories(
  taskId: string,
  ids?: string[],
): Promise<{ json: string; count: number }> {
  const items = await readStore(taskId)
  const selected = ids && ids.length > 0 ? items.filter((m) => ids.includes(m.id)) : items
  return { json: JSON.stringify(selected, null, 2), count: selected.length }
}

/* ============================================================
 * 分片加载：仅返回与当前任务关键词相关的记忆片段
 * ============================================================ */

/**
 * 按需分片加载——仅返回与当前任务关键词/实体相关的 L2 记忆片段，避免全量注入上下文。
 * 评分规则：实体命中 +2，summary 命中 +1，intent 命中 +1；得分 > 0 才返回。
 * 无关键词时返回最近 limit 条。
 * @param taskId - 任务 id
 * @param taskKeywords - 当前任务关键词/实体
 * @param limit - 返回上限，默认 10
 */
export async function loadRelevantL2Memories(
  taskId: string,
  taskKeywords: string[],
  limit = 10,
): Promise<L2Memory[]> {
  const items = await listL2Memories(taskId)
  const kws = taskKeywords.map((k) => k.toLowerCase()).filter(Boolean)
  if (kws.length === 0) return items.slice(0, limit)
  const scored = items.map((m) => {
    const entSet = new Set(m.entities.map((e) => e.toLowerCase()))
    const summaryLower = m.summary.toLowerCase()
    const intentLower = m.intent.toLowerCase()
    let score = 0
    for (const kw of kws) {
      if (entSet.has(kw)) score += 2
      if (summaryLower.includes(kw)) score += 1
      if (intentLower.includes(kw)) score += 1
    }
    return { m, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
    .slice(0, limit)
    .map((s) => s.m)
}
