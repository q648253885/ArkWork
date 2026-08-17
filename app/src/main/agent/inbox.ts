/* ============================================================
 * ArkWork — 轮次/步骤收件箱（v0.19.0 M3）
 *
 * 职责：
 *  - `send`：派发一条新用户消息（开启新 turn）。
 *  - `inject`：向当前 turn 注入一条 continuation（推进 next-step）。
 * 副作用：进程内存内维护每任务队列（非持久化）。
 *
 * 说明：本版为最小语义层——`send` 仅入队镜像，真实用户消息仍由
 * runner / appendUserMessage 写入 L1；`inject` 由 turn-stopping 监听器
 * 或引擎在停止候选处注入，供同轮继续执行。队列通过 drain* 消费。
 * ============================================================ */

export interface Inbox {
  /** 派发一条新用户消息（开启新 turn） */
  send(taskId: string, message: string): void
  /** 向当前 turn 注入一条 continuation（推进 next-step） */
  inject(taskId: string, continuation: string): void
}

const pendingMessages = new Map<string, string[]>()
const pendingContinuations = new Map<string, string[]>()

/** 进程级单例收件箱 */
export const inbox: Inbox = {
  send(taskId: string, message: string): void {
    const q = pendingMessages.get(taskId) ?? []
    q.push(message)
    pendingMessages.set(taskId, q)
  },
  inject(taskId: string, continuation: string): void {
    const q = pendingContinuations.get(taskId) ?? []
    q.push(continuation)
    pendingContinuations.set(taskId, q)
  },
}

/** 消费并清空某任务的待处理新消息（供引擎外层 turn 循环领取） */
export function drainMessages(taskId: string): string[] {
  const q = pendingMessages.get(taskId) ?? []
  pendingMessages.delete(taskId)
  return q
}

/** 消费并清空某任务的待处理 continuation（供停止候选处继续同轮） */
export function drainContinuations(taskId: string): string[] {
  const q = pendingContinuations.get(taskId) ?? []
  pendingContinuations.delete(taskId)
  return q
}

/** 是否存在待处理 continuation（供停止候选处判断是否继续同轮） */
export function hasPendingContinuation(taskId: string): boolean {
  return (pendingContinuations.get(taskId)?.length ?? 0) > 0
}
