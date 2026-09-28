/* ============================================================
 * ArkWork — 任务树陈旧提醒判定（v0.36.5 · D126，对齐 ZCode todo_reminder）
 *
 * 背景（用户导出会话实测，java-coder agent）：LLM 执行完一段任务后既不
 * todo_update 标记、也不检查清单是否与现实脱节 —— ZCode turn-loop 有
 * shouldBuildTodoReminder（距上次 TodoWrite ≥10 轮 → 注入 todo_reminder
 * 含内联清单快照 + "clean up the todo list if has become stale"），
 * ArkWork 引擎此前没有任何对应机制（D126）。
 *
 * 纯函数、零依赖：真值表可穷尽单测（TC-TREESYNC 组）。
 * 计数器本体与注入走 loop.ts 的 pendingSystemHint 瞬时通道；
 * 触发后归零 = ZCode 双阈值防刷屏的等价实现。
 * ============================================================ */

/** 陈旧提醒阈值（对齐 ZCode runtime-reminders 的 10 轮） */
export const TREE_SYNC_REMIND_INTERVAL = 10

export interface TreeSyncState {
  /** 距上次写树动作（todo_update / replan / task_create）已过的迭代轮数 */
  itersSinceTreeTouch: number
  /** 触发阈值（生产传 TREE_SYNC_REMIND_INTERVAL；测试可传小值） */
  threshold: number
}

/**
 * 是否应注入「任务树陈旧」段末提醒。
 * v0.36.6（缺陷 D127）：去掉「清单有未收口项」前置 —— ZCode runtime-reminders 的
 * shouldBuildTodoReminder 是**纯轮数判定**，「全终态但已过时」的树同样需要提醒
 * （D127 自设前置导致长 run 里树被抹平后引擎失明）。
 * 真值表：
 *   iters <  threshold → false（未达阈值）
 *   iters >= threshold → true
 */
export function shouldRemindTreeSync(state: TreeSyncState): boolean {
  return state.itersSinceTreeTouch >= state.threshold
}

/**
 * 写树判定（命中任一即视为本轮触碰过任务树，计数归零）。
 *
 * v0.38.0（D154）：清单控制面收敛为 `task_plan` 单入口后，本处**不再**自建白名单，
 * 而是调 `work-class.ts` 的 `isPlanWriteTool()` 守卫（纪律⑧：白名单只许一个事实源、
 * 全仓只调守卫 —— 连集合字面量都不留）。
 *
 * ⚠️ 必须用「唯一写入口」而不是「清单族」：历史工具名（`RETIRED_PLAN_TOOLS`）调用后
 * 由 `act.ts` 在 `invokeSkill` 之前兜底 return，**清单根本没被写过**。若把它们算作
 * 触碰过树，`treeTouchedThisRun` 会被置真 → 完成门禁在"有实质工作 + 清单陈旧"时
 * **静默放行**（设计文档 04-system-design §4.2 明确要求收敛为 `{'task_plan'}`）。
 */
import { isPlanWriteTool } from './work-class.js'

/** 本轮 actions 是否触碰了任务树（纯函数，供 loop 每轮调用） */
export function touchesPlanTree(tools: string[]): boolean {
  return tools.some((t) => isPlanWriteTool(t))
}
