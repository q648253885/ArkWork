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
import type { Task } from '@shared/types/task'

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
