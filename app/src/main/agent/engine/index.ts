/**
 * v0.27.0 R2（§3.1 引擎拆分）：engine 公共出口。
 * 原 engine.ts 拆分为本目录各职责模块；外部一律从这里导入公共 API。
 */
export type { RunOptions } from './loop.js'
export { runReActLoop } from './loop.js'
export { estimateTaskContext, getTaskContextBreakdown } from './context.js'
export { reconcileToolCalls } from './messages.js'
export type { ChatOrTask } from './dispatch.js'
// ★ v0.36.0（B9）：不再导出 `runTurnForTask` —— 它唯一的依赖 `engine/phase-runner.ts`
//   是 stub（`deriveSkillIdFromPlanItem` 硬编码返回 'file-reader'），已随死代码清理删除。
//   Turn 骨架类型保留在 `main/engine/types.ts`（`compaction-hook` 仍消费 `Turn`）。
export { runChatOnce, dispatchChatOrTask } from './dispatch.js'
