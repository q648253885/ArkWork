/* ============================================================
 * ArkWork — L3a 策展记忆（v0.8.0 F802）
 * frozen snapshot 机制：run 启动读一次，写入进 pending 区，下次 run 合并生效。
 * 文件：
 *   {workspace}/.arkwork/memory.md           — 工作区策展快照（≤2,200 字符）
 *   {workspace}/.arkwork/user.md              — 用户画像笔记快照（≤1,375 字符）
 *   {workspace}/.arkwork/memory.pending.jsonl — 待生效条目（暂存区）
 * 预算：画像 + 策展合计注入 ≤2,000 tokens（engine 装配时硬顶）。
 * 设计文档：versions/v0.8.0/01-memory.md §4
 * ============================================================ */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getWorkspaceDir } from '../store/db.js'
import { genId } from '@shared/utils/id'
import { getAdapter } from '../llm/registry.js'
import { logger } from '../system/logger.js'
import { broadcast } from '../window.js'
import type { PendingEntry } from '@shared/types/memory'

const MEMORY_FILE = 'memory.md'
const USER_FILE = 'user.md'
const PENDING_FILE = 'memory.pending.jsonl'

/** 字符预算（v0.7.0 蓝图约定） */
export const BUDGET = {
  memory: 2200,
  user: 1375,
}

function curatedPath(file: string): string {
  return join(getWorkspaceDir(), '.arkwork', file)
}

async function readText(path: string): Promise<string> {
  if (!existsSync(path)) return ''
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

/** 策展快照（当前生效内容 + 字符用量 + 预算） */
export interface CuratedSnapshot {
  memoryMd: string
  userMd: string
  memoryChars: number
  userChars: number
  memoryBudget: number
  userBudget: number
}

/**
 * 读取当前策展快照（run 启动注入与面板展示共用）。
 * @returns memory.md / user.md 全文 + 字符用量
 */
export async function getCuratedSnapshot(): Promise<CuratedSnapshot> {
  const memoryMd = await readText(curatedPath(MEMORY_FILE))
  const userMd = await readText(curatedPath(USER_FILE))
  return {
    memoryMd,
    userMd,
    memoryChars: memoryMd.length,
    userChars: userMd.length,
    memoryBudget: BUDGET.memory,
    userBudget: BUDGET.user,
  }
}

/**
 * 手动编辑策展快照——立即生效（用户显式动作视为即时意图，绕过 pending）。
 * @param file - 'memory.md' | 'user.md'
 * @param content - 新全文
 */
export async function updateCuratedFile(
  file: 'memory.md' | 'user.md',
  content: string,
): Promise<void> {
  await writeText(curatedPath(file), content)
  logger.info('Memory', `L3a curated ${file} updated (${content.length} chars)`)
  broadcast('memory:changed', '')
}

/** 列出全部待生效条目 */
export async function listPending(): Promise<PendingEntry[]> {
  const path = curatedPath(PENDING_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = await readFile(path, 'utf-8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PendingEntry)
      .sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

/**
 * 追加一条待生效条目（「记住：…」指令或蒸馏建议落 pending）。
 * @param targetFile - 'memory.md' | 'user.md'
 * @param line - 待加入的一行内容
 * @param sourceTaskId - 来源任务
 * @returns 创建的 PendingEntry
 */
export async function addPendingLine(
  targetFile: 'memory.md' | 'user.md',
  line: string,
  sourceTaskId?: string,
): Promise<PendingEntry> {
  const entry: PendingEntry = {
    id: genId('pend'),
    targetFile,
    line,
    sourceTaskId,
    createdAt: Date.now(),
  }
  await mkdir(dirname(curatedPath(PENDING_FILE)), { recursive: true })
  await writeFile(curatedPath(PENDING_FILE), JSON.stringify(entry) + '\n', { flag: 'a' })
  logger.info('Memory', `L3a pending +1 → ${targetFile}: ${line.slice(0, 60)}`, sourceTaskId)
  broadcast('memory:changed', '')
  return entry
}

/**
 * 丢弃待生效条目（全部或指定 id）。
 */
export async function discardPending(ids?: string[]): Promise<void> {
  const all = await listPending()
  const next = ids ? all.filter((e) => !ids.includes(e.id)) : []
  await writeFile(
    curatedPath(PENDING_FILE),
    next.map((e) => JSON.stringify(e)).join('\n') + (next.length ? '\n' : ''),
    'utf-8',
  )
  broadcast('memory:changed', '')
}

export interface ApplyPendingResult {
  applied: number
  merged: boolean
  memoryMerged: boolean
  userMerged: boolean
}

/**
 * 合并待生效条目到快照——run 启动时调用。
 * 1. 按 targetFile 追加 pending 行；
 * 2. 超字符预算时 LLM 有损归并（失败降级为尾部截断）；
 * 3. 清空 pending。
 * @param modelId - 用于有损归并的模型；缺省则仅截断
 */
export async function applyPending(modelId?: string): Promise<ApplyPendingResult> {
  const pending = await listPending()
  if (pending.length === 0) {
    return { applied: 0, merged: false, memoryMerged: false, userMerged: false }
  }

  let memoryMd = await readText(curatedPath(MEMORY_FILE))
  let userMd = await readText(curatedPath(USER_FILE))

  for (const entry of pending) {
    const line = `\n- ${entry.line}`
    if (entry.targetFile === 'memory.md') memoryMd += line
    else userMd += line
  }

  let memoryMerged = false
  let userMerged = false

  if (memoryMd.length > BUDGET.memory) {
    memoryMd = await mergeWithLlm(memoryMd, BUDGET.memory, '工作区记忆', modelId)
    memoryMerged = true
  }
  if (userMd.length > BUDGET.user) {
    userMd = await mergeWithLlm(userMd, BUDGET.user, '用户画像笔记', modelId)
    userMerged = true
  }

  await writeText(curatedPath(MEMORY_FILE), memoryMd)
  await writeText(curatedPath(USER_FILE), userMd)
  await writeFile(curatedPath(PENDING_FILE), '', 'utf-8')

  logger.info('Memory', `L3a pending applied: ${pending.length} entries (merged: mem=${memoryMerged} user=${userMerged})`)
  broadcast('memory:changed', '')

  return {
    applied: pending.length,
    merged: memoryMerged || userMerged,
    memoryMerged,
    userMerged,
  }
}

/**
 * 有损归并：让 LLM 把超预算的快照压缩到 budgetChars 以内，保留关键事实。
 * 失败降级为尾部截断（保留开头，因为开头通常是更早确立的稳定事实）。
 */
async function mergeWithLlm(
  content: string,
  budgetChars: number,
  label: string,
  modelId?: string,
): Promise<string> {
  if (!modelId) {
    return content.slice(0, budgetChars)
  }
  try {
    const adapter = await getAdapter(modelId)
    const resp = await adapter.complete({
      system: `你是记忆策展助手。把以下${label}内容压缩到 ${budgetChars} 字符以内，保留所有关键事实与偏好，丢弃冗余与重复。直接输出压缩后内容，不要解释。`,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
      maxTokens: Math.ceil(budgetChars / 2),
    })
    const merged = resp.content.trim()
    return merged.length > 0 ? merged : content.slice(0, budgetChars)
  } catch (err) {
    logger.warn('Memory', `L3a merge LLM failed, naive truncate: ${(err as Error).message}`)
    return content.slice(0, budgetChars)
  }
}
