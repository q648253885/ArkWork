/**
 * v0.27.0 R2/F7：中断与停止候选收尾（由 loop.ts 纯移动，行为不变）。
 * - persistAbortedReason：用户中断时把本轮已流出文本落盘（R1 流式管道配套）
 * - handleAbort：统一处理用户中断（stale 静默 / cancelled 保留 / paused 兜底）
 * - continueTurnIfInjected：停止候选处注入 continuation 则同轮继续（M3）
 */

import type { Task } from '@shared/types/task'
import { appendL1 } from '../../memory/l1-working.js'
import { updateTask, getTask } from '../../store/tasks.js'
import { broadcastStep, broadcastTaskStatus } from '../events.js'
import { logger } from '../../system/logger.js'
import { genId } from '@shared/utils/id'
import { drainContinuations } from '../inbox.js'
import { emitTurnStopping } from '../turn-stopping.js'
import { emitEvent } from './broadcast.js'
import { discardIncompletePlanItems } from './gates.js'

/**
 * v0.27.0 R1：用户中断时，把本轮已流出的部分文本落盘。
 * - append-only 真源不变：只写停止时刻 pump.accumulated 已确认收到的内容
 * - 写一条 L1 reasoning + 一条 status='cancelled' 的 reason step（UI 呈现「已停止」态）
 * - 内部失败静默：不掩盖原始 AbortError 向上抛出
 *
 * v0.31.0 B1（C-9 / 正本 G13）：**双通道留存**。
 * @param channels.thought   叙述通道（`kind='text'`）已累计文本；语义 = content 剥离 SAY 后的剩余物
 * @param channels.reasoning 思考通道（`kind='reasoning'`）已累计文本；模型无原生思考通道时为空串
 *
 * 两通道各自写入 step 的 `thought` / `reasoning`，互不覆盖 —— 此前只落 text 通道，
 * 而真思考走 reasoning 通道，导致中断场景「连部分思考都没有」（RC-12）。
 * 两路都为空时直接返回，不产生空 step。
 */
export async function persistAbortedReason(
  taskId: string,
  iteration: number,
  startedAt: number,
  channels: { thought: string; reasoning: string },
): Promise<void> {
  const trimmed = channels.thought.trim()
  const trimmedReasoning = channels.reasoning.trim()
  if (!trimmed && !trimmedReasoning) return
  try {
    await appendL1({
      taskId,
      role: 'assistant',
      kind: 'reasoning',
      content: trimmed,
      iteration,
      raw: trimmedReasoning ? { reasoningContent: trimmedReasoning } : undefined,
    })
    broadcastStep({
      id: genId('step'),
      taskId,
      iteration,
      type: 'reason',
      thought: trimmed,
      reasoning: trimmedReasoning || undefined,
      startedAt,
      durationMs: Date.now() - startedAt,
      status: 'cancelled',
      errorMessage: '用户中断——保留中断前已生成的内容',
    })
  } catch (err) {
    logger.warn('Agent', `persistAbortedReason failed (silent): ${(err as Error).message}`, taskId)
  }
}

/**
 * v0.8.1：统一处理用户中断（Esc/停止/暂停/取消）。
 * - 若运行已被新一次 runTask 接管（stale 返回 true）：静默退出，不动任务状态。
 * - 若当前 DB 状态已是 cancelled：保留 cancelled（cancelTask 已写）。
 * - 否则按 paused 处理（Esc/暂停场景）。
 */
export async function handleAbort(
  task: Task,
  iteration: number,
  stale?: () => boolean,
): Promise<void> {
  if (stale?.()) return
  const current = await getTask(task.id)
  if (current?.status === 'cancelled') {
    await emitEvent(task.id, { type: 'task_paused', iteration })
    await discardIncompletePlanItems(current ?? task, '任务已取消，未完成清单项丢弃')
    return
  }
  await emitEvent(task.id, { type: 'task_paused', iteration })
  await updateTask(task.id, { status: 'paused' })
  await discardIncompletePlanItems(current ?? task, '任务已暂停，未完成清单项丢弃')
  broadcastTaskStatus({ ...task, status: 'paused' })
}

/**
 * v0.19.0 M3：停止候选处判断是否注入 continuation 让同轮继续。
 * 触发 stop-hook 监听器 → 若注入 continuation，则写为 L1 user 消息并返回 true
 * （调用方 `continue` 进入下一 step）；否则返回 false（调用方按原路径暂停/结束）。
 * 副作用：可能写 L1；清空收件箱 pending continuation。
 */
export async function continueTurnIfInjected(task: Task, iteration: number): Promise<boolean> {
  emitTurnStopping(task.id, { task })
  const continuations = drainContinuations(task.id)
  if (continuations.length === 0) return false
  for (const c of continuations) {
    await appendL1({
      taskId: task.id,
      role: 'user',
      kind: 'user_message',
      content: c,
      iteration,
    })
  }
  return true
}
