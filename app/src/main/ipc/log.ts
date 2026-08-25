/* ============================================================
 * ArkWork — IPC: Logs
 * 设计文档 §5.5
 * ============================================================ */
import { ipcMain } from 'electron'
import { listLogs } from '../system/logger.js'

export function registerLogHandlers(): void {
  ipcMain.handle('log:list', async (_e, taskId?: string) => {
    return listLogs(taskId)
  })
}
