/* ============================================================
 * ArkWork — 规划通道 barrel（v0.39.0 · F1）
 *
 * 对外只暴露「调用一次规划」所需的最小面：类型、策略、解析、失败摘要、执行器。
 * 内部实现（`prompt.ts` 的模板细节）不导出 —— 提示词是要跟着实测迭代的，
 * 暴露越多越难改。
 * ============================================================ */
export * from './types.js'
export * from './policy.js'
export * from './parse.js'
export * from './digest.js'
export {
  runPlannerPass,
  getPlannerModelId,
  type PlannerLlmInput,
  type PlannerLlmOutput,
  type RunPlannerPassArgs,
} from './runner.js'

/* v0.40.0：清单操作通道（PlanOps）—— 五类清单操作各自一次独立的窄请求 */
export {
  PLAN_OPS_KINDS,
  isPlanOpsKind,
  type PlanOpsKind,
  type PlanOpsRequest,
  type PlanOpsResult,
  type PlanOpsSkipReason,
  type PlanOpsState,
} from './ops/types.js'
export { initPlanOpsState, shouldRunPlanOps, notePlanOpsRun, pickPlanOpsKind } from './ops/policy.js'
export {
  runPlanOps,
  getPlanOpsModelId,
  type PlanOpsLlmInput,
  type PlanOpsLlmOutput,
  type RunPlanOpsArgs,
} from './ops/runner.js'
