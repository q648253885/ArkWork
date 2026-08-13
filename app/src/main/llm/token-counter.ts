/* ============================================================
 * ArkWork — Token Counter
 * 设计文档 §7.3 — 简易估算，足够上下文用量条显示用
 * ============================================================ */
import { estimateTokens } from '@shared/utils/id'
import type { MemoryItem } from '@shared/types/memory'
import type { LlmMessage } from './adapter.js'

export function estimateTextTokens(text: string): number {
  return estimateTokens(text)
}

export function estimateMessagesTokens(messages: LlmMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.content)
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += estimateTokens(tc.function.arguments)
      }
    }
  }
  return total
}

export function estimateMemoryTokens(items: MemoryItem[]): number {
  return items.reduce((sum, m) => sum + m.tokens, 0)
}
