/* ============================================================
 * ArkWork — L1 Working Memory
 * 设计文档 §9.3 / 附录 B
 * 持久化：{workspaceDir}/.arkwork/memory/{taskId}/l1.jsonl
 * ============================================================ */
import { join } from 'node:path'
import { JsonlCollection } from '../store/db.js'
import { getTaskMemoryDir } from '../store/db.js'
import type { MemoryItem } from '@shared/types/memory'
import { genId, estimateTokens } from '@shared/utils/id'
import { broadcast } from '../window.js'
import { logger } from '../system/logger.js'

const collections = new Map<string, JsonlCollection<MemoryItem>>()

function collection(taskId: string): JsonlCollection<MemoryItem> {
  let col = collections.get(taskId)
  if (!col) {
    const path = join(getTaskMemoryDir(taskId), 'l1.jsonl')
    col = new JsonlCollection<MemoryItem>(path)
    collections.set(taskId, col)
  }
  return col
}

export interface AppendMemoryInput {
  taskId: string
  role: MemoryItem['role']
  kind: MemoryItem['kind']
  content: string
  iteration?: number
  enabled?: boolean
  meta?: string
  raw?: unknown
}

/**
 * L1 token 口径修正（agent-context-compaction-robustness Task 1 SubTask 1.3）：
 * 计入 content + raw + meta 三者合计，避免 reasoning_content / meta 的大字段
 * 在估算中被漏算（DeepSeek 思考模型单条 raw.reasoningContent 可达 6.9 万字符）。
 * raw/meta 为对象时 JSON 序列化后估算；空值（undefined）按空串处理。
 */
function estimateItemTokens(input: { content: string; raw?: unknown; meta?: unknown }): number {
  const rawStr = typeof input.raw === 'string' ? input.raw : (JSON.stringify(input.raw) ?? '')
  const metaStr = typeof input.meta === 'string' ? input.meta : (JSON.stringify(input.meta) ?? '')
  return estimateTokens(input.content) + estimateTokens(rawStr) + estimateTokens(metaStr)
}

export async function appendL1(input: AppendMemoryInput): Promise<MemoryItem> {
  const item: MemoryItem = {
    id: genId('mem'),
    taskId: input.taskId,
    layer: 'L1',
    role: input.role,
    kind: input.kind,
    content: input.content,
    enabled: input.enabled ?? true,
    iteration: input.iteration ?? -1,
    tokens: estimateItemTokens(input),
    meta: input.meta,
    raw: input.raw,
    createdAt: Date.now(),
    archivedAt: null,
  }

  const col = collection(input.taskId)
  await col.append(item)
  logger.debug('Memory', `L1 +1 ${item.kind} (${item.tokens} tokens)`, input.taskId)
  broadcast('memory:changed', input.taskId)
  return item
}

export async function listL1(taskId: string): Promise<MemoryItem[]> {
  const col = collection(taskId)
  const items = await col.list()
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function toggleL1(taskId: string, id: string, enabled: boolean): Promise<void> {
  const col = collection(taskId)
  // v0.30.2 修复①：list→算→write 收敛进互斥链（col.mutate），并发 append 不再被吞
  await col.mutate((items) => {
    const idx = items.findIndex((m) => m.id === id)
    if (idx < 0) return null
    const next = [...items]
    next[idx] = { ...next[idx], enabled }
    return next
  })
  broadcast('memory:changed', taskId)
}

export async function editL1(taskId: string, id: string, content: string): Promise<void> {
  const col = collection(taskId)
  await col.mutate((items) => {
    const idx = items.findIndex((m) => m.id === id)
    if (idx < 0) return null
    const next = [...items]
    next[idx] = { ...next[idx], content, tokens: estimateTokens(content) }
    return next
  })
  broadcast('memory:changed', taskId)
}

export async function archiveL1(taskId: string, id: string): Promise<void> {
  const col = collection(taskId)
  await col.mutate((items) => {
    const idx = items.findIndex((m) => m.id === id)
    if (idx < 0) return null
    const next = [...items]
    next[idx] = { ...next[idx], enabled: false, archivedAt: Date.now() }
    return next
  })
  broadcast('memory:changed', taskId)
}

export async function archiveMany(taskId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const col = collection(taskId)
  const idSet = new Set(ids)
  // v0.30.2 修复①：锁内读-改-写 —— 压缩归档（compaction 走这里）与并发 append
  // 交错时，快照之后新写入的条目按「保序映射」原样保留，不再丢失
  await col.mutate((items) =>
    items.map((m) =>
      idSet.has(m.id)
        ? { ...m, enabled: false, archivedAt: Date.now() }
        : m,
    ),
  )
  broadcast('memory:changed', taskId)
}

/**
 * 标记 L1 条目的蒸馏流向（v0.8.0 F805）。
 * 转化完成后写入 distilled 字段，MemoryPanel 显示流向徽标（📄→事实 / 🛠→技能 / 📚→知识库）。
 * @param taskId - 条目所属任务
 * @param id - L1 条目 id
 * @param target - 转化目标
 * @param targetId - 转化产物的 id（skill id / kb id 等）
 */
export async function markL1Distilled(
  taskId: string,
  id: string,
  target: 'l3_fact' | 'skill' | 'profile' | 'kb',
  targetId: string,
): Promise<void> {
  const col = collection(taskId)
  await col.mutate((items) => {
    const idx = items.findIndex((m) => m.id === id)
    if (idx < 0) return null
    const next = [...items]
    next[idx] = { ...next[idx], distilled: { target, targetId } }
    return next
  })
  broadcast('memory:changed', taskId)
}

/**
 * 归档指定 iteration 之后的所有 L1 条目（用于 checkpoint 恢复）。
 * 保留 iteration <= targetIteration 的条目，其余置 enabled=false + archivedAt。
 * system_prompt 条目（iteration=-1）始终保留。
 * @param taskId - 任务 id
 * @param targetIteration - 保留到此 iteration（含）
 */
export async function archiveL1AfterIteration(
  taskId: string,
  targetIteration: number,
): Promise<void> {
  const col = collection(taskId)
  await col.mutate((items) =>
    items.map((m) => {
      // system_prompt 与 user_message（iteration=-1 或 0 之前）始终保留
      if (m.kind === 'system_prompt') return m
      if (m.iteration <= targetIteration) return m
      return { ...m, enabled: false, archivedAt: Date.now() }
    }),
  )
  broadcast('memory:changed', taskId)
}

/** 用于上下文组装：按规则筛出 enabled 且未归档的 L1 条目 */
export async function listEnabledL1(taskId: string): Promise<MemoryItem[]> {
  const items = await listL1(taskId)
  return items.filter((m) => m.enabled && !m.archivedAt)
}

export async function removeL1Items(taskId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const col = collection(taskId)
  const idSet = new Set(ids)
  await col.mutate((items) => items.filter((m) => !idSet.has(m.id)))
  broadcast('memory:changed', taskId)
}

export async function clearL1(taskId: string): Promise<void> {
  const col = collection(taskId)
  await col.mutate(() => [])
  collections.delete(taskId)
  broadcast('memory:changed', taskId)
}

export function totalTokens(items: MemoryItem[]): number {
  return items.reduce((sum, m) => sum + m.tokens, 0)
}
