/* ============================================================
 * ArkWork — IPC: PlanItem 用户手动操作 + 快照兜底（v0.18.0）
 * 设计文档：docs/versions/v0.18.0/03-system-design.md §4 / §7.3
 *
 * 三类 Renderer → Main 入口：
 *  - task:plan-item-cancel    标记 planItem 为 cancelled
 *  - task:plan-item-retry     标记 planItem 为 running（重试）
 *  - task:plan-item-mark-done 标记 planItem 为 done
 *
 *  + 一类整对象兜底入口：
 *  - task:plan-list-snapshot  Renderer 主动拉取整 planItems（patch 落后 fallback 用）
 *
 * 所有变更都走：
 *  1) 校验（任务/项存在 + 终态规则）
 *  2) 写 planItem.status + source + updatedAt/completedAt
 *  3) updateTask 持久化
 *  4) broadcastPlanItemStatus 推单条 patch（F1 通道激活）
 *  5) 返回 { ok, version, effectiveStatus } 给 Renderer 做 optimistic reconcile
 * ============================================================ */
import { ipcMain } from 'electron'
import { getTask, updateTask } from '../store/tasks.js'
import {
  broadcastPlanItemStatus,
  getPlanListVersion,
} from '../agent/events.js'
import type { PlanItemActionResult } from '@shared/types/ipc'
import type { PlanItem, PlanItemStatus, PlanItemSource } from '@shared/types/task'
import { logger } from '../system/logger.js'

const TERMINAL_STATES: ReadonlySet<PlanItemStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'skipped',
])

export function registerPlanItemHandlers(): void {
  ipcMain.handle('task:plan-item-cancel', async (_e, payload): Promise<PlanItemActionResult> => {
    return setPlanItemStatus(payload, 'cancelled', 'user-cancel')
  })

  ipcMain.handle('task:plan-item-retry', async (_e, payload): Promise<PlanItemActionResult> => {
    return setPlanItemStatus(payload, 'running', 'user-retry')
  })

  ipcMain.handle('task:plan-item-mark-done', async (_e, payload): Promise<PlanItemActionResult> => {
    return setPlanItemStatus(payload, 'done', 'user-mark-done')
  })

  ipcMain.handle(
    'task:plan-list-snapshot',
    async (_e, taskId: string): Promise<PlanItem[]> => {
      const task = await getTask(taskId)
      return task?.planItems ?? []
    },
  )
}

/**
 * 设置单个 planItem 的状态（user-cancel / user-retry / user-mark-done 共享核心逻辑）。
 *
 * 校验顺序：
 *  1) 任务存在；
 *  2) planItem 存在；
 *  3) 目标态 !== 当前态（避免无意义广播）；
 *  4) 终态规则：终态只能 → running（重试），其余转换拒。
 *
 * @returns 成功 → { ok: true, version, effectiveStatus }；
 *          失败 → { ok: false, error: { code, message } }。
 */
async function setPlanItemStatus(
  payload: { taskId: string; planItemId: string } | undefined,
  targetStatus: PlanItemStatus,
  source: PlanItemSource,
): Promise<PlanItemActionResult> {
  if (!payload || typeof payload.taskId !== 'string' || typeof payload.planItemId !== 'string') {
    return {
      ok: false,
      error: { code: 'E_NOT_FOUND', message: 'task:plan-item-* 缺少 taskId 或 planItemId' },
    }
  }
  const { taskId, planItemId } = payload
  const task = await getTask(taskId)
  if (!task) {
    return {
      ok: false,
      error: { code: 'E_NOT_FOUND', message: `task ${taskId} not found` },
    }
  }
  const planItems = task.planItems ?? []
  const idx = planItems.findIndex((it) => it.id === planItemId)
  if (idx < 0) {
    return {
      ok: false,
      error: { code: 'E_NOT_FOUND', message: `planItem ${planItemId} not found` },
    }
  }
  const item = planItems[idx]!
  if (item.status === targetStatus) {
    return { ok: true, version: getPlanListVersion(taskId), effectiveStatus: item.status }
  }
  const isTerminal = TERMINAL_STATES.has(item.status)
  if (isTerminal && targetStatus !== 'running') {
    return {
      ok: false,
      error: {
        code: 'E_INVALID_STATE',
        message: `planItem ${planItemId} is in terminal state ${item.status}；仅允许 retry → running`,
      },
    }
  }
  const fromStatus = item.status
  item.status = targetStatus
  item.source = source
  item.updatedAt = Date.now()
  if (TERMINAL_STATES.has(targetStatus)) item.completedAt = Date.now()
  await updateTask(taskId, { planItems })
  const version = broadcastPlanItemStatus(taskId, [
    {
      planItemId: item.id,
      index: idx,
      fromStatus,
      status: targetStatus,
      source,
      reason: source === 'user-cancel' ? '用户在 TodoPanel 取消' : undefined,
    },
  ])
  logger.info('Agent', `[plan-item-action] task=${taskId} idx=${idx} ${fromStatus}->${targetStatus} source=${source}`, taskId)
  return { ok: true, version, effectiveStatus: targetStatus }
}
