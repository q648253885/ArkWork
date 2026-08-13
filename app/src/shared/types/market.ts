/* ============================================================
 * ArkWork — Shared Types: Skill Marketplace
 * v0.15.0：市场相关辅助类型（与 ipc.ts 的 SkillMetadata / SkillReview / MarketplaceSource / MarketLocalState 同义）
 * ============================================================ */

export interface SkillContextCost {
  baseline: number
  active: number
  perRound: number
}

export interface MarketInstalledEntry {
  version: string
  installedAt: number
  source: string
  enabled: boolean
  lastUsedAt?: number
  useCount: number
}

// 兼容导出：实际定义在 ipc.ts，这里 re-export 不重复定义以确保全工程类型一致
export type { SkillMetadata, SkillReview, MarketplaceSource, MarketLocalState, SkillCategory } from './ipc'
