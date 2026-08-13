/* ============================================================
 * ArkWork — v0.14.0 Task 9 · 暂停/恢复 Manager（US10）
 * 设计文档 §8.4 / spec.md Task 9
 *
 * 职责：
 *   - pauseTask：广播 task:interrupt → 终止当前推理/工具调用（AbortSignal，
 *     1s 宽限等待工具优雅退出）→ 写 pause checkpoint（L1 快照 + iteration +
 *     PlanItem 六态 + 工具历史）→ 任务状态置 paused
 *   - resumeTask：加载 checkpoint → 跳过已 done 项（running 重置为 pending）
 *     → 写恢复事件到审计 task.log → 复用既有 runTask 主体续跑（runReActLoop
 *     从 L1 最大 iteration 继续）
 *   - pauseAll：批量暂停全部运行中任务（应用退出前调用）
 *
 * 约束：不动 engine/phase-runner.ts；如需执行层感知暂停，见 ./hooks.ts。
 * ============================================================ */
import { mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getTask, updateTask } from '../store/tasks.js'
import { listEnabledL1 } from '../memory/l1-working.js'
import { listSteps, broadcastTaskStatus } from '../agent/events.js'
import {
  writeCheckpoint,
  getPauseCheckpoint,
  getLatestCheckpoint,
  checkpointId,
} from '../checkpoint/store.js'
import { broadcast } from '../window.js'
import { getArkworkDir } from '../store/db.js'
import { logger } from '../system/logger.js'
import type { PlanItem, Task } from '@shared/types/task'

/** 终止当前工具调用后等待其优雅退出的宽限时长（ms） */
const INTERRUPT_GRACE_MS = 1000

/* ============================================================
 * pauseTask — 暂停单个运行中任务
 * ============================================================ */
export async function pauseTask(taskId: string): Promise<boolean> {
  const task = await getTask(taskId)
  if (!task) return false
  // 仅 running 可暂停；引擎的 handleAbort 也已把状态落盘为 paused，重复调用幂等
  if (task.status !== 'running') return false

  // 1. 事件总线广播 task:interrupt（renderer 可订阅展示"正在中断…"）
  broadcast('task:interrupt', { taskId })

  // 2. 终止当前推理/工具调用——复用 runner 的 AbortController（engine 的
  //    AbortSignal），runner.pauseTask 会 abort 并摘除 controller。
  const { pauseTask: abortEngineRun, isTaskRunning } = await import('../agent/runner.js')
  if (isTaskRunning(taskId)) {
    await abortEngineRun(taskId)
    // 3. 1s 宽限：等待当前工具优雅退出 + engine handleAbort 完成（落盘 paused）
    await delay(INTERRUPT_GRACE_MS)
  }

  // 4. 保存 pause checkpoint（含 PlanItem 六态 + 工具历史 + L1 快照）
  await savePauseCheckpoint(task)

  // 5. 状态置 paused（handleAbort 可能已置；此处兜底幂等，避免竞态漏写）
  const current = await getTask(taskId)
  if (current && current.status !== 'paused') {
    const updated = await updateTask(taskId, { status: 'paused', completedAt: null })
    if (updated) broadcastTaskStatus(updated)
  } else if (current) {
    broadcastTaskStatus(current)
  }

  await logTaskAudit({ type: 'pause', taskId, title: task.title })
  logger.info('Agent', `task paused (checkpoint saved): ${taskId}`, taskId)
  return true
}

/* ============================================================
 * resumeTask — 恢复已暂停任务
 * 加载 checkpoint → 跳过已 done 项（running → pending 从中断处继续）
 * → 审计 task.log → 复用既有 runTask 主体续跑
 * ============================================================ */
export async function resumeTask(taskId: string): Promise<boolean> {
  const task = await getTask(taskId)
  if (!task) return false
  if (task.status !== 'paused') return false

  // 1. 加载 checkpoint（优先 pause 快照，旧数据回退最近一次）
  const cp = await getPauseCheckpoint(taskId)
  if (!cp) {
    logger.warn('Agent', `resume without checkpoint, continuing from L1 tail: ${taskId}`, taskId)
  }

  // 2. 跳过已 done 项：done/failed/cancelled/skipped 原样保留；
  //    暂停瞬间 running 的项重置为 pending（恢复后从该步继续执行）。
  if (cp?.planItems && cp.planItems.length > 0) {
    const restored: PlanItem[] = cp.planItems.map((it) =>
      it.status === 'running'
        ? { ...it, status: 'pending' as const, updatedAt: Date.now() }
        : it,
    )
    // 保持暂停前清单视图（done 不重跑，running 从该步继续）
    await updateTask(taskId, { planItems: restored })
  }

  // 3. 恢复事件写入审计日志 audit/task.log
  await logTaskAudit({
    type: 'resume',
    taskId,
    title: task.title,
    checkpointId: cp?.id ?? null,
    iteration: cp?.iteration ?? 0,
    planItems: cp?.planItems?.length ?? 0,
  })

  // 4. 继续执行（既有 runTask 主体——runReActLoop 从 L1 最大 iteration 续跑，
  //    已 done 的步骤不会重复执行）
  const { runTask } = await import('../agent/runner.js')
  await runTask(taskId)
  logger.info('Agent', `task resumed from checkpoint: ${taskId}`, taskId)
  return true
}

/* ============================================================
 * pauseAll — 批量暂停全部运行中任务（应用退出前调用）
 * 返回被暂停的任务 id 列表
 * ============================================================ */
export async function pauseAll(): Promise<string[]> {
  const { listRunningTaskIds } = await import('../agent/runner.js')
  const running = listRunningTaskIds()
  if (running.length === 0) return running
  await Promise.allSettled(running.map((id) => pauseTask(id)))
  return running
}

/* ============================================================
 * 内部工具
 * ============================================================ */

/** 构造并落盘 pause checkpoint（await 保证退出前落盘完成） */
async function savePauseCheckpoint(task: Task): Promise<void> {
  try {
    const latest = await getLatestCheckpoint(task.id)
    const iteration = latest?.iteration ?? 0
    const [l1, steps] = await Promise.all([
      listEnabledL1(task.id),
      listSteps(task.id),
    ])
    await writeCheckpoint({
      id: checkpointId(task.id, iteration),
      taskId: task.id,
      iteration,
      agentId: task.agentId,
      memorySnapshot: '',
      taskStatus: 'paused',
      timestamp: Date.now(),
      parentCheckpointId: task.parentTaskId ?? undefined,
      // v0.14.0 Task 9 扩展字段
      kind: 'pause',
      l1Snapshot: JSON.stringify(l1),
      planItems: task.planItems ?? [],
      toolHistory: steps,
    })
  } catch (err) {
    // checkpoint 失败不阻断暂停流程（状态仍置 paused，L1 本身已落盘）
    logger.warn('Agent', `pause checkpoint save failed: ${(err as Error).message}`, task.id)
  }
}

/** 审计：暂停/恢复事件写入 {arkworkDir}/audit/task.log（与 fault.log / router.log 同源） */
async function logTaskAudit(record: Record<string, unknown>): Promise<void> {
  try {
    const file = join(getArkworkDir(), 'audit', 'task.log')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(
      file,
      JSON.stringify({ ...record, ts: Date.now() }) + '\n',
      'utf8',
    )
  } catch (err) {
    logger.warn('System', `pause: failed to write task.log: ${(err as Error).message}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
