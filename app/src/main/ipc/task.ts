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
import { delegateAgent, cancelDelegateChild } from '../agent/skills/delegate.js'
import { getAgent } from '../store/agents.js'
import { getWorkspaceDir } from '../store/db.js'
import type { TaskUpdatePatch, SubagentActionResult } from '@shared/types/ipc'
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

  /* ============================================================
   * v0.36.0（F4.2）：并行子 agent 单卡操作（P5 卡）
   * ============================================================ */

  /**
   * 取消单个并行子 agent。
   * 职责：中断指定子任务的 AbortController（父任务与同批其它子任务不受影响）。
   * 入参：childTaskId（子任务 id）。
   * 出参：{ok:true} 已中断；{ok:false, message} 子任务已终结或不存在（不静默）。
   */
  ipcMain.handle('task:cancel-subagent', async (_e, childTaskId: string): Promise<SubagentActionResult> => {
    const cancelled = cancelDelegateChild(childTaskId)
    if (!cancelled) return { ok: false, message: '子任务已结束或不在运行中，无需取消' }
    logger.info('Tool', `task:cancel-subagent 已中断子任务 ${childTaskId}`)
    return { ok: true }
  })

  /**
   * 重试失败的并行子 agent。
   * 职责：以父任务的 agent/modelId 为上下文，对原 target 重新单发一次委派
   *       （产生新的 childTaskId，进度事件照常回到 parentTaskId）。
   * 入参：{parentTaskId, agentId, objective}。
   * 出参：{ok:true} 已派发；{ok:false, message} 父任务不存在 / 父任务无 modelId / 派发异常。
   */
  ipcMain.handle('task:retry-subagent', async (_e, payload: {
    parentTaskId: string
    agentId: string
    objective: string
  }): Promise<SubagentActionResult> => {
    const parent = await getTask(payload.parentTaskId)
    if (!parent) return { ok: false, message: '父任务不存在，无法重试子任务' }
    if (!parent.modelId) return { ok: false, message: '父任务没有可用的模型配置，无法重试子任务' }
    const parentAgent = await getAgent(parent.agentId)
    const ctrl = new AbortController()
    try {
      await delegateAgent(
        { targets: [{ agentId: payload.agentId, objective: payload.objective }] },
        {
          taskId: parent.id,
          signal: ctrl.signal,
          workspaceDir: getWorkspaceDir(),
          agent: parentAgent ?? undefined,
          task: parent,
        },
      )
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('Tool', `task:retry-subagent 失败：${message}`, parent.id)
      return { ok: false, message }
    }
  })
}
