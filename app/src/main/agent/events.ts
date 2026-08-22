/* ============================================================
 * ArkWork — ReAct Engine Events / Step Store
 * 设计文档 §8.4
 * ReAct 步骤持久化 + 推送给所有 Renderer
 * ============================================================ */
import { join } from 'node:path'
import { JsonlCollection } from '../store/db.js'
import { getTaskMemoryDir } from '../store/db.js'
import { broadcast } from '../window.js'
import { logger } from '../system/logger.js'
import type { ReActStep, ReActEvent } from '@shared/types/react'
import type { Task, PlanItem, PlanItemStatus, PlanItemSource } from '@shared/types/task'
import type { PlanItemStatusChanged, PlanItemListSnapshotPayload, TaskTextDeltaPayload } from '@shared/types/ipc'

const stepCollections = new Map<string, JsonlCollection<ReActStep>>()

function steps(taskId: string): JsonlCollection<ReActStep> {
  let col = stepCollections.get(taskId)
  if (!col) {
    col = new JsonlCollection<ReActStep>(join(getTaskMemoryDir(taskId), 'steps.jsonl'))
    stepCollections.set(taskId, col)
  }
  return col
}

export async function listSteps(taskId: string): Promise<ReActStep[]> {
  const items = await steps(taskId).list()
  return items.sort((a, b) => a.startedAt - b.startedAt)
}

export async function persistStep(step: ReActStep): Promise<void> {
  await steps(step.taskId).append(step)
}

export async function broadcastStep(step: ReActStep): Promise<void> {
  await persistStep(step)
  try {
    broadcast('task:step', step)
  } catch (err) {
    logger.warn('Agent', `broadcastStep failed (silent): ${(err as Error).message}`)
  }
}

export function broadcastTaskStatus(task: Task): void {
  try {
    broadcast('task:status', task)
  } catch (err) {
    logger.warn('Agent', `broadcastTaskStatus failed (silent): ${(err as Error).message}`)
  }
}

export function broadcastReActEvent(event: ReActEvent): void {
  try {
    broadcast('task:event', event)
  } catch (err) {
    logger.warn('Agent', `broadcastReActEvent failed (silent): ${(err as Error).message}`)
  }
  if (event.type === 'log') {
    logger.info('Agent', `[${event.level}] ${event.source}: ${event.message}`)
  }
}

/**
 * v0.27.0 R1：流式文本增量广播（Main → Renderer，`task:text-delta` 通道）。
 * 渲染加速通道、非数据源 —— session-log / steps.jsonl 仍只在拿到完整
 * LlmCompleteResponse 后写入权威内容（append-only 真源不变）。
 */
export function broadcastTextDelta(payload: TaskTextDeltaPayload): void {
  try {
    broadcast('task:text-delta', payload)
  } catch (err) {
    logger.warn('Agent', `broadcastTextDelta failed (silent): ${(err as Error).message}`)
  }
}

/* ============================================================
 * v0.14.0 Task 4：进度聚合（per-tool 维度）
 *
 * 背景：同一 ReAct 轮可能并行发起多个无依赖工具调用。
 * 渲染层要按"工具维度"展示进度（不互相覆盖、不抖动），必须
 * 在 Main 侧对每条 act 调用维护一个独立的 requestId 状态，
 * UI 订阅 `task:progress` 通道按 requestId / tool 维度渲染。
 * ============================================================ */
export type ToolProgressStatus = 'running' | 'success' | 'failed' | 'cancelled'

export interface ToolProgress {
  taskId: string
  /** 同一轮 Reason 共享一个 groupId，用于一次性清理 */
  groupId: string
  requestId: string
  tool: string
  status: ToolProgressStatus
  startedAt: number
  finishedAt?: number
  durationMs?: number
  errorMessage?: string
  resultSummary?: string
}

const progressByRequest = new Map<string, ToolProgress>()

/** 推送一条工具进度事件（Main → Renderer） */
export function broadcastToolProgress(progress: ToolProgress): void {
  progressByRequest.set(progress.requestId, progress)
  try {
    broadcast('task:progress', progress)
  } catch (err) {
    logger.warn('Agent', `broadcastToolProgress failed (silent): ${(err as Error).message}`)
  }
}

/** 取得某 task 的所有当前进度（用于 UI 一次性渲染） */
export function listToolProgress(taskId: string): ToolProgress[] {
  const out: ToolProgress[] = []
  for (const p of progressByRequest.values()) {
    if (p.taskId === taskId) out.push(p)
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/** 清理某 task 的进度（任务结束/重置时调用） */
export function clearToolProgress(taskId: string, groupId?: string): void {
  if (groupId) {
    for (const [k, v] of progressByRequest) {
      if (v.taskId === taskId && v.groupId === groupId) progressByRequest.delete(k)
    }
    try {
      broadcast('task:progress:clear', { taskId, groupId })
    } catch (err) {
      logger.warn('Agent', `clearToolProgress failed (silent): ${(err as Error).message}`)
    }
    return
  }
  for (const [k, v] of progressByRequest) {
    if (v.taskId === taskId) progressByRequest.delete(k)
  }
  try {
    broadcast('task:progress:clear', { taskId })
  } catch (err) {
    logger.warn('Agent', `clearToolProgress failed (silent): ${(err as Error).message}`)
  }
}

/* ============================================================
 * v0.18.0：PlanItem 状态变更 — 单条 patch 广播 + 整对象快照兜底
 *
 * 背景（B2 死通道）：v0.14.0 起就在 `task:plan-item-status-changed` 通道上订阅，
 * 但 Main 侧从未触发。整对象 `broadcastTaskStatus` 每次 planItems 变化都会
 * 重推整 Task（包含整 planItems 数组），payload 与渲染浪费严重。
 *
 * 新设计（详见 docs/versions/v0.18.0/03-system-design.md §4）：
 *  - 引擎改 planItem 状态 → 调用 broadcastPlanItemStatus 推单条 patch；
 *  - 同 task 维护 planListVersion 单调自增；Renderer 端做 reconcile；
 *  - 整对象 snapshot 走独立 `task:plan-list-snapshot` 通道，仅用于落后兜底，
 *    避免与 patch 队列交叉。两种 channel 不互相替代。
 * ============================================================ */

const planListVersionByTask = new Map<string, number>()

/** 取得某 task 的当前 planListVersion（从未推过则返回 0）。 */
export function getPlanListVersion(taskId: string): number {
  return planListVersionByTask.get(taskId) ?? 0
}

/**
 * v0.18.0：推送单条 / 多条 planItem 状态变更（Main → Renderer）。
 *
 * 职责：
 *  - 维护单 task 的 planListVersion +1；
 *  - 通过 `broadcast` 推 `task:plan-item-status-changed` 给所有 webContents；
 *  - **不**走整对象 `broadcastTaskStatus` 通道，避免重复 payload 与双通路不一致。
 *
 * @param taskId   任务 ID
 * @param items    变更项列表（每项含 planItemId / index / fromStatus / status / source / reason / ts_iteration）
 * @returns        推完的 planListVersion；items 为空数组则仅返回当前版本号，不广播
 *
 * 注意：调用方应在更新完 `task.planItems` + `updateTask` 持久化后再调用本函数；
 * 否则 patch 推过去而落盘失败会形成"内存有、磁盘无"的不一致。
 */
export function broadcastPlanItemStatus(
  taskId: string,
  items: Array<{
    planItemId: string
    index: number
    fromStatus: PlanItemStatus
    status: PlanItemStatus
    source: PlanItemSource
    reason?: string
    ts_iteration?: number
  }>,
): number {
  const version = (planListVersionByTask.get(taskId) ?? 0) + 1
  planListVersionByTask.set(taskId, version)
  if (items.length === 0) return version
  const payload: PlanItemStatusChanged = {
    taskId,
    planItemId: items[0]!.planItemId,
    index: items[0]!.index,
    fromStatus: items[0]!.fromStatus,
    status: items[0]!.status,
    source: items[0]!.source,
    reason: items[0]!.reason,
    version,
    ts: Date.now(),
    ts_iteration: items[0]!.ts_iteration,
  }
  try {
    // 注：v0.18.0 现阶段 payload 携带 items[0] 单条；批量多 decisions 通过
    // 循环 N 次 broadcastPlanItemStatus 串行推，避免 Renderer 端按 index 拆分的复杂度。
    broadcast('task:plan-item-status-changed', payload)
    // 引擎决策日志（开发/生产都可观测；F9 验证 grep 命中）
    if (items[0]!.source.startsWith('engine-')) {
      logger.info(
        'Agent',
        `[engine-decide-plan] task=${taskId} idx=${items[0]!.index} from=${items[0]!.fromStatus} to=${items[0]!.status} source=${items[0]!.source}`,
        taskId,
      )
    }
    if (items.length > 1) {
      // 多条决策：串行递归（version 单调 +1）
      const rest = items.slice(1)
      const nextVersion = broadcastPlanItemStatus(taskId, rest)
      // 递归后覆盖本次返回值（让最外层 caller 拿到的是最终 version）
      return nextVersion
    }
  } catch (err) {
    logger.warn('Agent', `broadcastPlanItemStatus failed (silent): ${(err as Error).message}`)
  }
  return version
}

/**
 * v0.18.0：推送 planItems 整对象快照（Main → Renderer）。
 *
 * 与 patch 通道分开，避免 patch 队列与 snapshot 队列交叉。
 * 触发场景：
 *  - plan-regen（plan 全量重新生成）：来源 = plan-regen；
 *  - Renderer 通过 fetchPlanItemList 主动拉取后由 IPC handler 内部调用此函数广播；
 *  - 未来 P1：Renderer 检测到 patch.version 落后差距 ≥ 5 时自动 fallback。
 *
 * @param taskId     任务 ID
 * @param planItems  完整 PlanItem 列表（已按 index 排序）
 * @param source     触发源（默认 'plan-regen'）
 * @returns          推完的 planListVersion
 */
export function broadcastPlanListSnapshot(
  taskId: string,
  planItems: PlanItem[],
  source: PlanItemSource = 'plan-regen',
): number {
  const version = (planListVersionByTask.get(taskId) ?? 0) + 1
  planListVersionByTask.set(taskId, version)
  const payload: PlanItemListSnapshotPayload = {
    taskId,
    planItems,
    version,
    ts: Date.now(),
  }
  try {
    broadcast('task:plan-list-snapshot', payload)
    logger.info(
      'Agent',
      `[plan-snapshot] task=${taskId} items=${planItems.length} version=${version} source=${source}`,
      taskId,
    )
  } catch (err) {
    logger.warn('Agent', `broadcastPlanListSnapshot failed (silent): ${(err as Error).message}`)
  }
  return version
}
