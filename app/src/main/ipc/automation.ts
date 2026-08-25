/* ============================================================
 * ArkWork — IPC: Automation
 * 通道：automation:list / create / update / remove / run
 * 持久化由 store/automations.ts 负责；run 复用 tasks.createTask 创建新任务。
 * ============================================================ */
import { ipcMain } from 'electron'
import {
  listAutomations,
  addAutomation,
  updateAutomation,
  removeAutomation,
  runAutomation,
} from '../store/automations.js'
import type { AutomationCreateInput } from '@shared/types/ipc'
import type { Automation } from '@shared/types/conversation'
import { logger } from '../system/logger.js'

export function registerAutomationHandlers(): void {
  /** 列出所有自动化规则 */
  ipcMain.handle('automation:list', async () => listAutomations())

  /**
   * 新建自动化规则。
   * @param input - Automation 字段（不含 id / createdAt / lastRun）
   * @returns 创建的 Automation
   * 错误：name / agentId / prompt 为空；trigger='cron' 缺 cronExpr
   */
  ipcMain.handle('automation:create', async (_e, input: AutomationCreateInput) => {
    return addAutomation(input)
  })

  /**
   * 更新自动化规则字段。
   * @param payload - { id, patch }
   * 错误：不存在；trigger='cron' 缺 cronExpr
   */
  ipcMain.handle(
    'automation:update',
    async (_e, payload: { id: string; patch: Partial<Automation> }) => {
      return updateAutomation(payload.id, payload.patch)
    },
  )

  /**
   * 删除自动化规则。
   * @param payload - { id }
   */
  ipcMain.handle('automation:remove', async (_e, payload: { id: string }) => {
    await removeAutomation(payload.id)
    logger.info('System', `automation removed via IPC: ${payload.id}`)
  })

  /**
   * 触发运行：基于 automation 的 agentId / prompt 创建一个新任务，
   * 并记录 lastRun。不直接调用 runTask——任务创建后由用户在任务列表中运行。
   * @param id - Automation id
   * @returns { taskId } 创建的 task id
   * 错误：automation 不存在 / 已暂停
   */
  ipcMain.handle('automation:run', async (_e, id: string) => {
    return runAutomation(id)
  })
}
