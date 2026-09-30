/**
 * 档位判定理由的**展示层净化**（v0.43.0 · 用户反馈②）
 *
 * 背景：迁移期的 `tierReason` 是机器语言，例如
 *   「迁移自 v0.29（无 tier 判定，按既有清单规模取 T2）」
 * 属实现细节（哪个版本迁来的、当时有无判定逻辑），不应外露到展示页面。
 * 存量图数据（`graph.json`）无法批量重写，故按 `main/agent/graph/drift.ts`
 * 处理 intent 机器前缀的同一手法：在**消费边界**剥离。
 *
 * 纯函数 · 无副作用：内部迁移语言 → `undefined`（调用方据此不渲染理由行）。
 */

/** 内部迁移语言前缀（中/英）—— 锚定行首，避免误伤正常理由 */
const INTERNAL_TIER_REASON = /^(迁移自|migrated from)/i

export function sanitizeTierReason(reason?: string): string | undefined {
  const text = reason?.trim()
  if (!text) return undefined
  if (INTERNAL_TIER_REASON.test(text)) return undefined
  return text
}