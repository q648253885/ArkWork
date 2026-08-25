/* ============================================================
 * ArkWork — L1 Token Counter（v0.14.0 Task 12）
 * 复用 llm/token-counter.ts 的字符估算实现（@shared/utils/id#estimateTokens）：
 *   英文 ~4 字符/token，中日韩 ~1.5 字符/token（中英文混合场景足够准确）。
 * 由 Turn Phase 0 入口（memoryPhase0 钩子）每次调用进行 token 计量。
 * ============================================================ */
import { estimateTextTokens } from '../llm/token-counter.js'
import type { MemoryItem, MemoryRole, MemoryKind } from '@shared/types/memory'

/** L1 消息视图 — countTokens 的输入（与 MemoryItem 解耦，便于测试构造） */
export interface L1Message {
  role: MemoryRole
  content: string
  kind?: MemoryKind
}

/** 按内容统计一组 L1 消息的估算 token 数（不依赖已缓存的 tokens 字段） */
export function countTokens(messages: L1Message[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTextTokens(m.content)
  }
  return total
}

/** 便捷函数：直接统计 MemoryItem 列表 */
export function countL1Tokens(items: MemoryItem[]): number {
  return countTokens(
    items.map((m) => ({ role: m.role, content: m.content, kind: m.kind })),
  )
}
