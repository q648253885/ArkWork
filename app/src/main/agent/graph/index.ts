/**
 * ArkWork — TaskGraph 内核对外 barrel
 *
 * v0.30.0 新增。engine / ipc / tools 一律从此处导入，不深入子模块路径
 * —— 这样后续重构模块边界时不会波及调用方。
 */
export {
  ACTIVE_WINDOW_BUDGET,
  AFTER_TOOL_BUDGET,
  ANCHOR_BUDGET,
  TOTAL_INJECTION_BUDGET,
  buildThreeSegInjection,
  formatWaiting,
  renderActiveWindow,
  renderAfterTool,
  renderAnchors,
  type Projection,
  type ThreeSegInjection,
} from './project.js'

export {
  DRIFT_HARD_STREAK,
  DRIFT_NORMAL,
  DRIFT_SOFT,
  computeDrift,
  renderDriftHardBlock,
  renderDriftHint,
  type DriftAction,
  type DriftInput,
  type DriftResult,
  type DriftSignal,
  type DriftSignals,
} from './drift.js'

export {
  DOWNGRADE_INVARIANTS,
  WARN_ONLY_INVARIANTS,
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  formatGraphError,
  renderGraphErrorForModel,
  transitionDenied,
  validateGraph,
  validateWrite,
  type WriteChange,
  type WriteKind,
} from './invariants.js'

export {
  applyStatusChange,
  clearGateHooks,
  notifyStatusChange,
  registerGateHook,
  runGate,
  type GateHookName,
  type GateOutcome,
  type GateObserveHook,
  type GateRejectHook,
} from './gate.js'

export {
  addEvidence,
  applyModelClaim,
  getNode,
  hasSufficientEvidence,
  patchNode,
  renderAcceptance,
  syncAfterAct,
  updateNodeFields,
  type ActSyncInput,
  type ModelClaimInput,
  type WriteOutcome,
} from './write.js'

export {
  clearConvergeCounter,
  evaluateEvents,
  getLastConvergeCompleted,
  isInFlight,
  markConverged,
  pickPrimaryAction,
  type EventDecision,
  type EventInput,
} from './events.js'

export {
  APPROVAL_LEVEL_LABEL,
  applyPatch,
  buildPatch,
  computeImpact,
  decideApprovalLevel,
  renderPatchSummary,
  type ApplyResult,
  type BuildPatchInput,
} from './replan.js'

export {
  hasConvergeFindings,
  isTaskNodeLike,
  looksZombie,
  renderConvergeNoticeText,
  runConverge,
  shouldConverge,
  type ConvergeInput,
} from './converge.js'

export {
  dropGraphCache,
  getGraph,
  getGraphById,
  hasInFlight,
  persist,
  putGraphCache,
  summarizeGraph,
  syncConverge,
  syncModelClaim,
  syncPostAct,
  syncProject,
  waitingLabel,
  type ConvergeOutcome,
  type PersistOptions,
  type PostActInput,
  type ProjectOutcome,
  type SyncCtx,
  type SyncOutcome,
} from './sync.js'

export {
  MIGRATION_SOURCE,
  migrateToGraph,
  mapPlanItemStatusToNodeStatus,
  mapSourceToRevisionFields,
  needsGraphMigration,
  sealGraphAtTurnEnd,
  type MigrateInput,
} from './migrate.js'

export { buildSnapshot } from './store.js'

export {
  dropGraphPending,
  getPendingPatch,
  listPendingPatches,
  markPatchDecided,
  registerPendingPatch,
  resetPendingPatches,
} from './pending.js'

export {
  deleteGraph,
  findGraphIdByTaskId,
  getEvidenceDir,
  getGraphDir,
  getGraphJsonPath,
  getGraphMdPath,
  getSnapshotsDir,
  getSpecsDir,
  listSnapshots,
  loadGraph,
  loadGraphChecked,
  mapNodeStatusToPlanItemStatus,
  mapRevisionToPlanItemSource,
  mirrorPlanItems,
  readIndex,
  removeIndexEntry,
  renderGraphMd,
  resetGraphDocs,
  restoreSnapshot,
  saveGraph,
  snapshotGraph,
  upsertIndex,
  validateGraphShape,
  type GraphIndexEntry,
  type GraphLoadResult,
} from './store.js'

export {
  getMetricsSnapshot,
  recordMetric,
  renderMetricsLine,
  resetMetrics,
  type MetricName,
  type MetricsSnapshot,
} from './metrics.js'
