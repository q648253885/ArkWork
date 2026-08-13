/* ============================================================
 * ArkWork — IPC: Task
 * ============================================================ */
import { ipcMain } from 'electron'
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  appendUserMessage,
  type CreateTaskInput,
} from '../store/tasks.js'
import { runTask, cancelTask } from '../agent/runner.js'
// v0.14.0 Task 9：暂停/恢复走 pause manager（checkpoint 持久化 + 审计）
import { pauseTask, resumeTask } from '../pause/manager.js'
import { listSteps } from '../agent/events.js'
import type { TaskUpdatePatch } from '@shared/types/ipc'
import { logger } from '../system/logger.js'

export function registerTaskHandlers(): void {
  ipcMain.handle('task:list', async () => {
    return listTasks()
  })

  ipcMain.handle('task:get', async (_e, id: string) => {
    return getTask(id)
  })

  ipcMain.handle('task:create', async (_e, input: CreateTaskInput) => {
    return createTask(input)
  })

  ipcMain.handle('task:update', async (_e, patch: TaskUpdatePatch) => {
    return updateTask(patch.id, patch)
  })

  ipcMain.handle('task:append-message', async (_e, payload: { taskId: string; text: string }) => {
    return appendUserMessage(payload.taskId, payload.text)
  })

  ipcMain.handle('task:delete', async (_e, id: string) => {
    await deleteTask(id)
    return null
  })

  ipcMain.handle('task:run', async (_e, id: string) => {
    try {
      await runTask(id)
    } catch (err) {
      logger.error('Agent', `runTask error: ${(err as Error).message}`, id)
      throw err
    }
  })

  ipcMain.handle('task:pause', async (_e, id: string) => {
    await pauseTask(id)
  })

  ipcMain.handle('task:resume', async (_e, id: string) => {
    await resumeTask(id)
  })

  ipcMain.handle('task:cancel', async (_e, id: string) => {
    await cancelTask(id)
  })

  ipcMain.handle('task:steps', async (_e, id: string) => {
    return listSteps(id)
  })
}
