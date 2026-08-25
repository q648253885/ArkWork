/* ============================================================
 * ArkWork — 上下文预算与分层压缩（纯工具模块）
 * agent-context-compaction-robustness spec Task 1 / Task 2 / Task 3
 *
 * 只做纯计算（token 估算 / 预算 clamp / L1 本地微压缩），
 * 禁止 import electron 相关模块，便于 node:test 单元测试。
 * token 口径与 @shared/utils/id.estimateTokens 一致：
 *   CJK ~1.5 字符/token、其他 ~4 字符/token，另加固定开销 +4。
 * ============================================================ */
import { estimateTokens } from '../../shared/utils/id.js'
import type { LlmMessage } from '../llm/adapter.js'

/** 单条文本 token 估算：空值返回 0，否则按 CJK/其他字符规则 + 固定开销 4 */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0
  return estimateTokens(text) + 4
}

/**
 * 整包 payload token 估算：
 *  - system 文本
 *  - 每条消息 content + reasoningContent + meta（若存在，JSON.stringify 后估算）
 *  - 每条工具 schema（JSON.stringify 后估算，estimateTextTokens 自带固定开销）
 * LlmMessage 字段可能为 undefined（如 content/reasoningContent 缺失），须兼容。
 */
export function estimatePayloadTokens(opts: {
  system?: string
  messages?: LlmMessage[]
  tools?: unknown[]
}): number {
  let total = 0
  if (opts.system !== undefined) total += estimateTextTokens(opts.system)
  for (const m of opts.messages ?? []) {
    total += estimateTextTokens(m.content)
    total += estimateTextTokens(m.reasoningContent)
    const meta = (m as { meta?: unknown }).meta
    if (meta !== undefined) total += estimateTextTokens(JSON.stringify(meta))
  }
  for (const tool of opts.tools ?? []) {
    total += estimateTextTokens(JSON.stringify(tool))
  }
  return total
}

export interface PayloadTokenBreakdown {
  systemTokens: number
  messagesTokens: number
  toolsTokens: number
}

export function estimatePayloadTokensDetailed(opts: {
  system?: string
  messages?: LlmMessage[]
  tools?: unknown[]
}): { total: number; breakdown: PayloadTokenBreakdown } {
  const breakdown: PayloadTokenBreakdown = {
    systemTokens: estimateTextTokens(opts.system),
    messagesTokens: 0,
    toolsTokens: 0,
  }
  for (const m of opts.messages ?? []) {
    breakdown.messagesTokens += estimateTextTokens(m.content)
    breakdown.messagesTokens += estimateTextTokens(m.reasoningContent)
    const meta = (m as { meta?: unknown }).meta
    if (meta !== undefined) breakdown.messagesTokens += estimateTextTokens(JSON.stringify(meta))
  }
  for (const tool of opts.tools ?? []) {
    breakdown.toolsTokens += estimateTextTokens(JSON.stringify(tool))
  }
  return { total: breakdown.systemTokens + breakdown.messagesTokens + breakdown.toolsTokens, breakdown }
}

/**
 * 上下文预算：min(128000, contextWindow ?? 64000) × 0.85 取整，
 * clamp 到 [24000, 64000]。
 */
export function contextBudget(contextWindow?: number): number {
  const base = Math.min(128000, contextWindow ?? 64000)
  return Math.min(64000, Math.max(24000, Math.round(base * 0.85)))
}

/** 输出预留 token（保证模型有足够的回复预算，避免思考耗尽返回空内容） */
export function outputReserve(): number {
  return 4096
}

/** 是否需要压缩：payload + 输出预留 > 预算 */
export function shouldCompact(payloadTokens: number, budget: number): boolean {
  return payloadTokens + outputReserve() > budget
}

/**
 * 单条 reasoning_content 传回 LLM 的最大字符数。
 * v0.24.0：4000 → 1500。实测（T-20260817-106u4s，105 轮 / 1.56M tokens）
 * reasoning 每轮全量回传是历史膨胀主因；决策结论 1500 字符已足够，
 * 早期思考过程对后续轮次无增量价值。
 */
export const MAX_REASONING_CONTENT = 1500

/** 单条 tool observation 传回 LLM 的最大字符数 */
export const MAX_OBSERVATION_CONTENT = 8000

/** Layer 1 微压缩占位符：更早轮工具结果原文已被清空 */
export const MICRO_COMPACT_PLACEHOLDER = '[old tool result cleared · 详见 L2]'

/** 观察内容截断标记（完整内容见 L2） */
export const OBSERVATION_TRUNCATED_MARK = '\n\n…[已截断，完整内容见 L2]'

/** 微压缩保留的最近工具轮数 */
export const RECENT_TOOL_TURNS = 3

/** 按 UTF-16 编码单元截断，但避免在 Unicode 代理对中间切开，防止产生 lone surrogate 导致 JSON 序列化 400 */
function safeSlice(content: string, max: number): string {
  if (content.length <= max) return content
  let end = max
  const lead = content.charCodeAt(end - 1)
  if (lead >= 0xd800 && lead <= 0xdbff && content.charCodeAt(end) >= 0xdc00 && content.charCodeAt(end) <= 0xdfff) {
    end -= 1
  }
  return content.slice(0, end)
}

/** 超长内容截断：超过 max 截断并追加 mark */
export function truncateLongContent(content: string, max: number, mark: string): string {
  if (content.length <= max) return content
  return safeSlice(content, max) + mark
}

export interface MicroCompactResult {
  messages: LlmMessage[]
  clearedToolResults: number
  droppedReasoning: number
}

/**
 * Layer 1 本地微压缩（纯函数，不读文件、零 AI 调用）：
 * 按"轮"分组——一个 assistant 消息 + 其后连续的 tool 消息为一轮；
 * 从后往前保留最近 keepRecentTurns 轮，更早轮中：
 *   - role === 'tool' 的 content 替换为 MICRO_COMPACT_PLACEHOLDER
 *   - assistant 的 reasoningContent 置为 undefined（丢弃原文，content 保留）
 * 不修改入参对象，返回处理后的新数组与清空/丢弃计数。
 */
export function applyMicroCompact(
  messages: LlmMessage[],
  keepRecentTurns: number = RECENT_TOOL_TURNS,
): MicroCompactResult {
  // 1. 分轮：assistant 开启一轮，其后连续 tool 消息归入该轮
  const turns: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role === 'assistant') {
      const start = i
      i += 1
      while (i < messages.length && messages[i].role === 'tool') i += 1
      turns.push({ start, end: i })
    } else {
      i += 1
    }
  }

  const keepFrom = Math.max(0, turns.length - Math.max(0, keepRecentTurns))
  const next = messages.map((m) => ({ ...m }))
  let clearedToolResults = 0
  let droppedReasoning = 0

  for (let t = 0; t < keepFrom; t++) {
    const { start, end } = turns[t]
    for (let k = start; k < end; k++) {
      const msg = next[k]
      if (msg.role === 'tool') {
        if (msg.content !== MICRO_COMPACT_PLACEHOLDER) {
          msg.content = MICRO_COMPACT_PLACEHOLDER
          clearedToolResults += 1
        }
      } else if (msg.role === 'assistant') {
        if (msg.reasoningContent !== undefined) {
          msg.reasoningContent = undefined
          droppedReasoning += 1
        }
      }
    }
  }

  return { messages: next, clearedToolResults, droppedReasoning }
}
