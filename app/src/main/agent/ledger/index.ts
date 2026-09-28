/* ============================================================
 * ArkWork — TaskLedger 模块出口
 * 设计文档：docs/versions/v0.37.0/04-system-design.md
 *
 * 对外只暴露两条路：
 *   · 写 → `engine.mutate()`（唯一变更入口）
 *   · 读 → `engine.loadLedger()` + `project.*` 投影
 * ============================================================ */
export * from './types.js'
export * from './ops.js'
export { readLedgerFile, writeLedgerFile, invalidateLedgerCache, normalizeLedger, ledgerPathOf } from './file.js'
export {
  mutate,
  loadLedger,
  ensureLedger,
  setMode,
  parkLedger,
  discardLedger,
  resumeLedger,
  sweepStale,
  sealLedger,
  touchSync,
  getSnapshotView,
  ledgerFileOf,
  inferMode,
  type MutateResult,
} from './engine.js'
export { toPlanItems, toSnapshotView, renderSnapshot, openItems } from './project.js'
export { buildResumeHint, evaluateArtifact, hasResumePoint, type ArtifactVerdict } from './resume.js'
