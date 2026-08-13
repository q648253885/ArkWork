/* ============================================================
 * ArkWork — IPC: Tool 执行确认（v0.8.1）
 * renderer 浮层回传确认结果 → 兑现 registry 中挂起的 confirm Promise
 * ============================================================ */
import { ipcMain } from 'electron'
import { respondToolConfirm } from '../agent/registry.js'
import type { ConfirmRespondReason } from '@shared/types/ipc'

export function registerToolHandlers(): void {
  ipcMain.handle(
    'tool:confirm:respond',
    (
      _e,
      payload: { requestId: string; allowed: boolean; session?: boolean; reason?: ConfirmRespondReason },
    ) => {
      respondToolConfirm(
        payload.requestId,
        payload.allowed,
        payload.session ?? false,
        payload.reason ?? 'denied',
      )
    },
  )
}
