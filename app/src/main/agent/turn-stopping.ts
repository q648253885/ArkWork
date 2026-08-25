/* ============================================================
 * ArkWork — 停止候选钩子（v0.19.0 M3）
 *
 * 职责：
 *  - 到达停止候选（如 ask_user / 阶段门禁）时通知监听器。
 *  - 监听器可返回 continuation 字符串，经 Inbox.inject 注入，
 *    让同一 turn 继续执行（而非暂停/结束）。
 * 副作用：可能向 Inbox.inject 注入消息。
 * ============================================================ */
import type { Task } from '@shared/types/task'
import { inbox } from './inbox.js'

export interface TurnStoppingContext {
  task: Task
}

/** 返回非空字符串 = 注入 continuation 让同轮继续；返回空/void = 不干预 */
export type TurnStoppingListener = (
  taskId: string,
  context: TurnStoppingContext,
) => string | void

const listeners: TurnStoppingListener[] = []

/** 注册停止候选监听器 */
export function onTurnStopping(listener: TurnStoppingListener): void {
  listeners.push(listener)
}

/** 清空监听器（测试隔离用） */
export function clearTurnStoppingListeners(): void {
  listeners.length = 0
}

/**
 * 触发停止候选判断。监听器可通过注入 continuation 让同轮继续执行。
 * 副作用：可能向 Inbox.inject 注入消息。
 */
export function emitTurnStopping(taskId: string, context: TurnStoppingContext): void {
  for (const listener of listeners) {
    try {
      const continuation = listener(taskId, context)
      if (typeof continuation === 'string' && continuation.trim().length > 0) {
        inbox.inject(taskId, continuation)
      }
    } catch (err) {
      // 监听器异常不得打断引擎主流程
      void err
    }
  }
}
