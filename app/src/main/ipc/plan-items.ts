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
 *  2) 写状态：
 *     - **有图任务**（`task.graphId`）：写图 → 由图重算 `planItems` 镜像（v0.30.0 §4.7 唯一写入序列，
 *       镜像写入处统一补发 `task:plan-list-snapshot`）；
 *     - **无图任务**（tier 0/1）：保持 v0.29 直写 `planItems`。
 *  3) 广播
 *  4) 返回 { ok, version, effectiveStatus } 给 Renderer 做 optimistic reconcile
 * ============================================================ */
import { ipcMain } from 'electron'
import { getTask, updateTask } from '../store/tasks.js'
import {
  broadcastPlanItemStatus,
  getPlanListVersion,
} from '../agent/events.js'
// v0.37.0（缺陷 D132）：不再 import 桥的 `applyPlanItemStatus` —— 用户手动操作改走账本，
// 图只在账本落定后做派生镜像；保留旧 import 会让「还有第二个写入者」的假象留在代码里。
// v0.37.0：清单唯一真相源（TaskLedger）—— 用户手动操作也必须经 mutate
import { loadLedger, mutate, getSnapshotView, ensureLedger } from '../agent/ledger/engine.js'
import { toPlanItems } from '../agent/ledger/project.js'
import type { PlanItemActionResult, LedgerSnapshotView, LedgerHistoryView } from '@shared/types/ipc'
import { readAuditLog, readLedgerArchive } from '../agent/ledger/audit.js'
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
      // v0.37.0：优先读账本（唯一真相源）；无账本回退 tasks.json（旧任务兼容）
      try {
        const ledger = await loadLedger(taskId)
        if (ledger && ledger.items.length > 0) return toPlanItems(ledger)
      } catch {
        /* 账本不可用 → 回退 */
      }
      const task = await getTask(taskId)
      return task?.planItems ?? []
    },
  )

  // v0.39.0（D187）：清单变更历史 —— 永久审计日志 + 终态归档状态
  ipcMain.handle(
    'task:ledger-history',
    async (_e, taskId: string, limit?: number): Promise<LedgerHistoryView | null> => {
      try {
        const entries = readAuditLog(taskId, typeof limit === 'number' ? limit : 50)
        const arch = readLedgerArchive(taskId)
        return {
          taskId,
          entries,
          archived: Boolean(arch),
          ...(arch
            ? { archivedAt: arch.archivedAt, outcome: arch.outcome, reason: arch.reason }
            : {}),
        }
      } catch (err) {
        logger.warn('Agent', `task:ledger-history 读取失败：${(err as Error).message}`)
        return null
      }
    },
  )

  // v0.37.0：账本快照（UI 显示任务模式徽标 / 恢复点提示条 / 未收口计数）
  ipcMain.handle(
    'task:ledger-snapshot',
    async (_e, taskId: string): Promise<LedgerSnapshotView | null> => {
      try {
        return await getSnapshotView(taskId)
      } catch {
        return null
      }
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

  // ============================================================
  // v0.37.0（缺陷 D132）：**用户点击也走账本**（唯一写入口）。
  // 此前用户手动操作在无图任务上直写 `planItems`，与图/账本三条通道并存 ——
  // 这正是"真相源不唯一"的表现。现在统一经 ledger.mutate（force=true：
  // 用户显式指令优先，与 graph:set-status 的强制分支同语义）。
  // ============================================================
  try {
    let ledger = await loadLedger(taskId)
    if (!ledger) {
      // 首次操作时尚未建账 → 先建账再写，绝不退化成直写 planItems
      ledger = await ensureLedger(task, { seedFromPlanItems: true })
    }
    if (ledger) {
      const res = await mutate(
        taskId,
        {
          kind: 'set-status',
          itemId: planItemId,
          to: targetStatus as 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped',
          source,
          note: source === 'user-cancel' ? '用户在清单里取消' : undefined,
          force: true,
        },
        { actor: `ui:${source}` },
      )
      if (!res.ok) {
        return {
          ok: false,
          error: { code: 'E_INVALID_STATE', message: res.error?.message ?? '账本写入失败' },
        }
      }
      const rawEffective = res.effective?.find((e) => e.itemId === planItemId)?.status ?? targetStatus
      // 账本 9 态 → planItem 7 态：verifying/blocked 折叠到最接近的可展示态
      const effective: PlanItemStatus =
        rawEffective === 'verifying' ? 'running' : rawEffective === 'blocked' ? 'failed' : rawEffective
      logger.info(
        'Agent',
        `[plan-item-action] task=${taskId} id=${planItemId} ${item.status}->${effective} source=${source}（账本通道）`,
        taskId,
      )
      return { ok: true, version: getPlanListVersion(taskId), effectiveStatus: effective }
    }
  } catch (err) {
    logger.warn('Agent', `[plan-item-action] 账本通道失败：${(err as Error).message}`, taskId)
    return {
      ok: false,
      error: { code: 'E_INVALID_STATE', message: `任务清单引擎不可写：${(err as Error).message}` },
    }
  }
  // 账本不可用（建账失败）→ 明确报错，不静默回退成直写 planItems。
  // 理由：直写会制造第二个真相源，UI 与模型随后会读到不一致的清单（诊断 §2 L2）。
  return {
    ok: false,
    error: { code: 'E_INVALID_STATE', message: '任务清单账本不可用，无法修改清单项' },
  }
}
