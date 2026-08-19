/* ============================================================
 * ArkWork — Context Compaction v0.15.0
 * 对齐 Claude Code/OpenCode：四级阈值 + 两阶段压缩（prune + summarize）
 * + keep.tokens + 熔断 + 结构化摘要入 L3b + 蒸馏触发。
 * ============================================================ */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { getTaskMemoryDir, getWorkspaceDir } from '../store/db.js'
import { appendL1, archiveMany } from './l1-working.js'
import { countTokens, countL1Tokens } from './token-counter.js'
import { estimateTokens } from '@shared/utils/id'
import { logger } from '../system/logger.js'
import { broadcast } from '../window.js'
import { getAdapter } from '../llm/registry.js'
import {
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_SUMMARY_TEMPLATE,
  buildCompactionUserPrompt,
} from './templates/compact-prompt.js'

// v0.15.0：模板对外只读暴露，供测试与 UI 校验六段式结构
export { COMPACTION_SUMMARY_TEMPLATE, COMPACTION_SYSTEM_PROMPT }
import { archiveCompactionSummary } from './l3-archive.js'
import type { L1Snapshot, MemoryItem } from '@shared/types/memory'
import type { LlmAdapter } from '../llm/adapter.js'

/* ============================================================
 * 公共常量
 * ============================================================ */

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_BUFFER_TOKENS = 20_000
export const BLOCKING_BUFFER_TOKENS = 3_000
export const MAX_SUMMARY_OUTPUT_TOKENS = 20_000
export const MAX_CONSECUTIVE_FAILURES = 3
export const KEEP_TOKENS = 15_000
export const PRUNE_PROTECT = 40_000
export const PRUNE_MINIMUM = 20_000
export const MAX_SUMMARY_TOKENS = 4_000

const SUMMARY_MAX_CHARS = 1500

/* ============================================================
 * 阈值计算（Claude Code 公式）
 * ============================================================ */

export function getMaxOutputTokens(modelMaxTokens: number): number {
  if (modelMaxTokens >= 200_000) return 20_000
  if (modelMaxTokens >= 128_000) return 16_384
  if (modelMaxTokens >= 32_000) return 8_192
  return 4_096
}

export function getEffectiveContextWindow(modelMaxTokens: number): number {
  const reserved = Math.min(getMaxOutputTokens(modelMaxTokens), MAX_SUMMARY_OUTPUT_TOKENS)
  return modelMaxTokens - reserved
}

export function getAutoCompactThreshold(modelMaxTokens: number): number {
  return getEffectiveContextWindow(modelMaxTokens) - AUTOCOMPACT_BUFFER_TOKENS
}

export function getWarningThreshold(modelMaxTokens: number): number {
  return getEffectiveContextWindow(modelMaxTokens) - WARNING_BUFFER_TOKENS
}

export function getBlockingThreshold(modelMaxTokens: number): number {
  return getEffectiveContextWindow(modelMaxTokens) - BLOCKING_BUFFER_TOKENS
}

export type CompactionLevel = 'normal' | 'warning' | 'autoCompact' | 'blocking'

/** v0.15.0：依据当前 token 数与模型上限判定阈值级别 */
export function classifyTokenUsage(
  currentTokens: number,
  modelMaxTokens: number,
): CompactionLevel {
  if (currentTokens >= getBlockingThreshold(modelMaxTokens)) return 'blocking'
  if (currentTokens >= getAutoCompactThreshold(modelMaxTokens)) return 'autoCompact'
  if (currentTokens >= getWarningThreshold(modelMaxTokens)) return 'warning'
  return 'normal'
}

/** v0.15.0：构造 summarize 阶段的 LLM user prompt（含六段式模板与自定义保留指令） */
export function buildSummarizePrompt(
  items: MemoryItem[],
  instructions?: string,
): string {
  const transcript = itemsToTranscript(items)
  return buildCompactionUserPrompt(transcript, instructions)
}

/* ============================================================
 * 熔断状态
 * ============================================================ */

export interface FuseState {
  consecutiveFailures: number
  autoCompactDisabled: boolean
}

let fuseState: FuseState = { consecutiveFailures: 0, autoCompactDisabled: false }

export function getFuseState(): Readonly<FuseState> {
  return fuseState
}

export function resetFuseState(): void {
  fuseState = { consecutiveFailures: 0, autoCompactDisabled: false }
}

export function recordCompactionSuccess(): void {
  fuseState.consecutiveFailures = 0
  fuseState.autoCompactDisabled = false
}

export function recordCompactionFailure(): boolean {
  fuseState.consecutiveFailures += 1
  if (fuseState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    fuseState.autoCompactDisabled = true
    return true
  }
  return false
}

export function isAutoCompactDisabled(): boolean {
  return fuseState.autoCompactDisabled
}

/* ============================================================
 * 手动压缩命令入口
 * ============================================================ */

export interface ManualCompactOptions {
  /** 用户通过 /compact 传入的额外保留要求 */
  instructions?: string
  /** 覆盖默认模型最大 token 数 */
  modelMaxTokens?: number
  /** 用于摘要的模型 ID（留空则使用本地 fallback 摘要） */
  modelId?: string
  /** 测试注入用 adapter（优先于 modelId） */
  summarizeAdapter?: LlmAdapter
  /** 任务标题，用于 L3b 归档 */
  taskTitle?: string
}

/** 读取 `.arkwork/memory/MEMORY.md` 的 `# Compact instructions` 段落 */
export async function loadCompactInstructions(): Promise<string> {
  const path = join(getWorkspaceDir(), '.arkwork', 'memory', 'MEMORY.md')
  if (!existsSync(path)) return ''
  try {
    const raw = await readFile(path, 'utf-8')
    const match = raw.match(/#\s*Compact instructions\s*\n([\s\S]*?)(?=\n#\s|$)/i)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/* ============================================================
 * 旧接口兼容类型（签名保留，内部复用新实现）
 * ============================================================ */

export interface CompactionPolicy {
  /** 已废弃：v0.15.0 后摘要上限固定为 4000 tokens，保留字段避免调用方报错 */
  targetTokenRatio: number
  /** 已废弃：v0.15.0 后按 keep.tokens 保留，保留字段避免调用方报错 */
  keepRecentRounds: number
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  targetTokenRatio: 0.3,
  keepRecentRounds: 3,
}

export interface CompactionResult {
  tokenBefore: number
  tokenAfter: number
  keptRounds: number
  summary: string
  entities: string[]
  stats: {
    durationMs: number
    droppedMessageCount: number
    prunedCount: number
    summaryTokens: number
  }
}

export interface CompactionPlan {
  kept: MemoryItem[]
  dropped: MemoryItem[]
  summary: string
  entities: string[]
  keptRounds: number
  tokenAfter: number
}

const ROLE_LABEL: Record<string, string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
}

const STOPWORDS_EN = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'you', 'are',
  'was', 'were', 'not', 'but', 'all', 'can', 'has', 'had', 'its', 'our',
  'your', 'their', 'will', 'would', 'should', 'could', 'about', 'into',
  'than', 'then', 'them', 'they', 'these', 'those', 'when', 'where', 'which',
  'while', 'also', 'been', 'being', 'after', 'before', 'during', 'over',
  'under', 'again', 'further', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'so', 'too', 'very', 'just', 'because', 'does',
  'doing', 'done', 'each', 'few', 'how', 'if', 'may', 'might', 'must',
  'shall', 'what', 'why', 'get', 'got', 'make', 'made', 'use', 'used',
  'using', 'one', 'two', 'new', 'now', 'not', 'here', 'there', 'out', 'off',
  'via', 'per', 'etc', 'e.g', 'i.e', 'vs', 'de', 'la', 'le', 'en',
])

export function extractKeyEntities(texts: string[], limit = 12): string[] {
  const freq = new Map<string, number>()
  for (const text of texts) {
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
      const w = m[0].toLowerCase()
      if (STOPWORDS_EN.has(w)) continue
      freq.set(w, (freq.get(w) ?? 0) + 1)
    }
    for (const m of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const seg = m[0]
      const maxLen = Math.min(6, seg.length)
      for (let len = 2; len <= maxLen; len++) {
        for (let i = 0; i + len <= seg.length; i++) {
          const w = seg.slice(i, i + len)
          freq.set(w, (freq.get(w) ?? 0) + 1)
        }
      }
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w)
}

export function buildSummary(dropped: MemoryItem[], maxChars = SUMMARY_MAX_CHARS): string {
  const parts: string[] = []
  let length = 0
  for (const m of dropped) {
    const text = m.content.trim()
    if (!text) continue
    const label = ROLE_LABEL[m.role] ?? m.role
    const line = `【${label}】${text}`
    if (length + line.length > maxChars) {
      if (length === 0) parts.push(line.slice(0, maxChars))
      break
    }
    parts.push(line)
    length += line.length
  }
  if (parts.length === 0) return ''
  return parts.join('\n')
}

/* ============================================================
 * 阶段 1：prune（零成本裁剪旧工具输出）
 * ============================================================ */

export interface PruneResult {
  items: MemoryItem[]
  savedTokens: number
  prunedIds: string[]
}

function isToolOutput(item: MemoryItem): boolean {
  return item.role === 'tool' || (item.role === 'assistant' && item.kind === 'observation')
}

export function pruneStage(inputItems: MemoryItem[]): PruneResult {
  const sorted = [...inputItems].sort((a, b) => a.createdAt - b.createdAt || a.iteration - b.iteration)
  const PLACEHOLDER = '[output compacted]'
  const placeholderTokens = estimateTokens(PLACEHOLDER)

  let userSeen = 0
  let protectedToolTokens = 0
  const candidates: MemoryItem[] = []

  for (let i = sorted.length - 1; i >= 0; i--) {
    const item = sorted[i]
    if (item.role === 'user') {
      userSeen += 1
      continue
    }
    if (userSeen < 2) continue
    if (!isToolOutput(item)) continue

    const itemTokens = item.tokens || estimateTokens(item.content)
    if (protectedToolTokens + itemTokens <= PRUNE_PROTECT) {
      protectedToolTokens += itemTokens
      continue
    }
    candidates.push(item)
  }

  const savedTokens = candidates.reduce((sum, item) => sum + (item.tokens || estimateTokens(item.content)) - placeholderTokens, 0)
  if (savedTokens <= PRUNE_MINIMUM || candidates.length === 0) {
    return { items: sorted, savedTokens: 0, prunedIds: [] }
  }

  const prunedIds = candidates.map((item) => item.id)
  const idSet = new Set(prunedIds)
  const nextItems = sorted.map((item) =>
    idSet.has(item.id)
      ? { ...item, content: PLACEHOLDER, tokens: placeholderTokens }
      : item,
  )
  return { items: nextItems, savedTokens, prunedIds }
}

/* ============================================================
 * 阶段 2：summarize（结构化摘要）
 * ============================================================ */

export interface SummarizeInput {
  dropped: MemoryItem[]
  instructions?: string
  adapter?: LlmAdapter | null
}

function itemsToTranscript(items: MemoryItem[]): string {
  return items
    .filter((m) => m.content.trim())
    .map((m) => `[${m.role}/${m.kind}] ${m.content.slice(0, 600)}`)
    .join('\n')
    .slice(0, 80_000)
}

function trimSummary(summary: string, maxTokens: number): string {
  // 兜底截断：先按字符粗略限制，再逐步缩减
  let text = summary
  while (estimateTokens(text) > maxTokens && text.length > 100) {
    text = text.slice(0, Math.floor(text.length * 0.9))
  }
  return text
}

export async function summarizeStage(input: SummarizeInput): Promise<string> {
  const { dropped, instructions, adapter } = input
  const transcript = itemsToTranscript(dropped)
  if (!transcript.trim()) return ''

  if (!adapter) {
    return buildSummary(dropped)
  }

  const prompt = buildCompactionUserPrompt(transcript, instructions)
  try {
    const resp = await adapter.complete({
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: MAX_SUMMARY_TOKENS,
    })
    return trimSummary(resp.content.trim(), MAX_SUMMARY_TOKENS)
  } catch (err) {
    logger.warn('Memory', `summarizeStage LLM failed: ${(err as Error).message}`)
    return buildSummary(dropped)
  }
}

/* ============================================================
 * keep.tokens：保留最近原始上下文
 * ============================================================ */

export function sliceRecentContext(items: MemoryItem[], keepTokens = KEEP_TOKENS): {
  recentContext: MemoryItem[]
  dropped: MemoryItem[]
} {
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt || a.iteration - b.iteration)
  let acc = 0
  let splitIdx = sorted.length
  for (let i = sorted.length - 1; i >= 0; i--) {
    const tokens = sorted[i].tokens || estimateTokens(sorted[i].content)
    if (acc + tokens > keepTokens) {
      splitIdx = i + 1
      break
    }
    acc += tokens
    if (i === 0) splitIdx = 0
  }
  // v0.19.x fix：切片边界必须落在「轮次」边界（assistant reasoning + 其后连续 tool 响应）。
  // 否则会把 assistant tool_calls 归档而保留其 tool 响应，产生孤立 tool 消息，
  // 每次 assembleMessages 都触发 reconcileToolCalls "dropped orphan tool message"。
  while (splitIdx > 0 && splitIdx < sorted.length && sorted[splitIdx].role === 'tool') {
    splitIdx -= 1
  }
  // v0.23.2 fix「用户输入被吞」：user_message 永不归档——交互区的用户气泡由
  // memory 派生，归档即从 UI 消失；且用户消息通常很小，全部保留对预算影响可忽略。
  const isPinned = (m: MemoryItem, i: number) => i >= splitIdx || m.kind === 'user_message'
  return {
    recentContext: sorted.filter((m, i) => isPinned(m, i)),
    dropped: sorted.filter((m, i) => !isPinned(m, i)),
  }
}

/* ============================================================
 * 两阶段压缩计划（纯计算）
 * ============================================================ */

export interface TwoStageCompactionPlan {
  tokenBefore: number
  tokenAfter: number
  pruned: MemoryItem[]
  dropped: MemoryItem[]
  recentContext: MemoryItem[]
  summary: string
  summaryTokens: number
  entities: string[]
  keptRounds: number
  prunedCount: number
}

export function computeTwoStageCompactionPlan(
  l1: L1Snapshot,
  keepTokens = KEEP_TOKENS,
  tokenBefore = countL1Tokens(l1.items),
): TwoStageCompactionPlan {
  const prune = pruneStage(l1.items)
  const { recentContext, dropped } = sliceRecentContext(prune.items, keepTokens)
  const summary = buildSummary(dropped)
  const summaryTokens = summary ? countTokens([{ role: 'system', content: summary }]) : 0
  const tokenAfter = countL1Tokens(recentContext) + summaryTokens
  const keptIters = new Set(recentContext.filter((m) => m.iteration >= 0).map((m) => m.iteration))
  return {
    tokenBefore,
    tokenAfter,
    pruned: prune.items,
    dropped,
    recentContext,
    summary,
    summaryTokens,
    entities: dropped.length > 0 ? extractKeyEntities(dropped.map((m) => m.content)) : [],
    keptRounds: keptIters.size,
    prunedCount: prune.prunedIds.length,
  }
}

/* ============================================================
 * 旧 computeCompaction 兼容入口
 * ============================================================ */

export function computeCompaction(
  l1: L1Snapshot,
  _policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
  tokenBefore = countL1Tokens(l1.items),
): CompactionPlan {
  const plan = computeTwoStageCompactionPlan(l1, KEEP_TOKENS, tokenBefore)
  return {
    kept: [...plan.recentContext],
    dropped: plan.dropped,
    summary: plan.summary,
    entities: plan.entities,
    keptRounds: plan.keptRounds,
    tokenAfter: plan.tokenAfter,
  }
}

/* ============================================================
 * 执行压缩
 * ============================================================ */

export async function compact(
  l1: L1Snapshot,
  opts: Partial<CompactionPolicy> & ManualCompactOptions = {},
): Promise<CompactionResult> {
  const startedAt = Date.now()
  const instructions = opts.instructions ?? (await loadCompactInstructions())
  const tokenBefore = countL1Tokens(l1.items)

  let plan: TwoStageCompactionPlan
  try {
    plan = computeTwoStageCompactionPlan(l1, KEEP_TOKENS, tokenBefore)
  } catch (err) {
    recordCompactionFailure()
    throw err
  }

  if (plan.dropped.length === 0) {
    recordCompactionSuccess()
    return {
      tokenBefore,
      tokenAfter: tokenBefore,
      keptRounds: plan.keptRounds,
      summary: '',
      entities: plan.entities,
      stats: { durationMs: Date.now() - startedAt, droppedMessageCount: 0, prunedCount: 0, summaryTokens: 0 },
    }
  }

  let adapter: LlmAdapter | null = opts.summarizeAdapter ?? null
  if (!adapter && opts.modelId) {
    try {
      adapter = await getAdapter(opts.modelId)
    } catch (err) {
      logger.warn('Memory', `failed to get summarize adapter: ${(err as Error).message}`, l1.taskId)
    }
  }

  let summary: string
  try {
    summary = await summarizeStage({ dropped: plan.dropped, instructions, adapter })
  } catch (err) {
    recordCompactionFailure()
    throw err
  }

  const summaryTokens = summary ? countTokens([{ role: 'system', content: summary }]) : 0
  const tokenAfter = countL1Tokens(plan.recentContext) + summaryTokens

  if (l1.taskId && summary) {
    try {
      await archiveMany(l1.taskId, plan.dropped.map((m) => m.id))
      await appendL1({
        taskId: l1.taskId,
        role: 'system',
        kind: 'compressed_summary',
        content: summary,
        iteration: -1,
        meta: JSON.stringify({
          entities: plan.entities,
          keptRounds: plan.keptRounds,
          tokenBefore,
          tokenAfter,
          prunedCount: plan.prunedCount,
        }),
      })
      await archiveCompactionSummary(opts.taskTitle ?? l1.taskId, summary, l1.taskId)
    } catch (err) {
      logger.warn('Memory', `compaction: L1 write-back failed: ${(err as Error).message}`, l1.taskId)
    }
  }

  recordCompactionSuccess()

  const durationMs = Date.now() - startedAt
  const result: CompactionResult = {
    tokenBefore,
    tokenAfter,
    keptRounds: plan.keptRounds,
    summary,
    entities: plan.entities,
    stats: {
      durationMs,
      droppedMessageCount: plan.dropped.length,
      prunedCount: plan.prunedCount,
      summaryTokens,
    },
  }

  await writeCompactionLog(l1.taskId, {
    taskId: l1.taskId,
    tokenBefore,
    tokenAfter,
    keptRounds: plan.keptRounds,
    durationMs,
    droppedMessageCount: plan.dropped.length,
    prunedCount: plan.prunedCount,
    summaryTokens,
    entities: plan.entities,
    summaryPreview: summary.slice(0, 120),
    instructions,
  })

  try {
    // v0.25.0 F3：压缩后不再自动评估蒸馏（避免空 transcript 蒸技能；详见设计文档 §5.1）。
    // 技能创建严格走 skill-forge 管线，由 task-done 时机触发。
  } catch (err) {
    logger.warn('Memory', `compaction distill evaluation failed: ${(err as Error).message}`, l1.taskId)
  }

  return result
}

/* ============================================================
 * 手动 /compact 便利入口
 * ============================================================ */

export async function compactTask(
  taskId: string,
  opts: ManualCompactOptions = {},
): Promise<CompactionResult> {
  const { listEnabledL1 } = await import('./l1-working.js')
  const items = await listEnabledL1(taskId)
  const snapshot: L1Snapshot = {
    taskId,
    items,
    budgetTokens: opts.modelMaxTokens ? getEffectiveContextWindow(opts.modelMaxTokens) : 180_000,
    createdAt: Date.now(),
  }
  return compact(snapshot, opts)
}

async function writeCompactionLog(taskId: string, record: Record<string, unknown>): Promise<void> {
  try {
    const file = join(getTaskMemoryDir(taskId), 'compaction.log')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify({ ...record, ts: Date.now() }) + '\n', 'utf-8')
  } catch (err) {
    logger.warn('Memory', `compaction: failed to write compaction.log: ${(err as Error).message}`, taskId)
  }
}
