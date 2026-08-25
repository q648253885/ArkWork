/**
 * v0.27.0 R2（§3.1 引擎拆分）：engine 公共出口。
 * 原 engine.ts 拆分为本目录各职责模块；外部一律从这里导入公共 API。
 */
export type { RunOptions } from './loop.js'
export { runReActLoop } from './loop.js'
export { estimateTaskContext, getTaskContextBreakdown } from './context.js'
export { reconcileToolCalls } from './messages.js'
export type { ChatOrTask } from './dispatch.js'
export { runChatOnce, runTurnForTask, dispatchChatOrTask } from './dispatch.js'
