/* ============================================================
 * ArkWork — IPC: Context
 * 上下文面板/输入框按需获取真实 payload token 估算
 * （非运行态也能如实展示 system + messages + tools + memoryInjection）
 *
 * Task 6：新增占比可视化与下钻接口
 *  - context:get-breakdown：返回当前任务的 ContextBreakdownResult
 *  - context:remove-item：移除指定分类的指定项（如移除某个文件 / 关闭某技能）
 *  - context:clear-category：清空某类上下文（如清空所有文件引用）
 * ============================================================ */
import { ipcMain } from 'electron'
import { estimateTaskContext, getTaskContextBreakdown } from '../agent/engine/index.js'
import {
  archiveL1,
  archiveMany,
  listEnabledL1,
} from '../memory/l1-working.js'
import { toggleSkill } from '../store/skills.js'
import { getTask, updateTask } from '../store/tasks.js'
import { logger } from '../system/logger.js'
import {
  CONVERSATION_KINDS,
  type ContextCategory,
} from '../agent/context-breakdown.js'

export function registerContextHandlers(): void {
  ipcMain.handle('context:estimate', async (_e, taskId: string) => {
    try {
      return await estimateTaskContext(taskId)
    } catch (err) {
      logger.warn('Agent', `context:estimate failed: ${(err as Error).message}`, taskId)
      return null
    }
  })

  /** Task 6：获取上下文占比明细（7 分类 + 可下钻 detail） */
  ipcMain.handle('context:get-breakdown', async (_e, taskId: string) => {
    try {
      return await getTaskContextBreakdown(taskId)
    } catch (err) {
      logger.warn('Agent', `context:get-breakdown failed: ${(err as Error).message}`, taskId)
      return null
    }
  })

  /**
   * Task 6：移除指定分类的指定项。
   * - files / messages：归档对应 L1 条目
   * - tools / mcp / skills：从 task.skillIds 移除（会话级），若不在会话级则全局禁用该技能
   */
  ipcMain.handle(
    'context:remove-item',
    async (
      _e,
      payload: { taskId: string; category: ContextCategory; detailId: string },
    ) => {
      try {
        const { taskId, category, detailId } = payload
        if (category === 'files' || category === 'messages') {
          await archiveL1(taskId, detailId)
        } else if (category === 'tools' || category === 'mcp' || category === 'skills') {
          const task = await getTask(taskId)
          if (task) {
            const current = task.skillIds || []
            if (current.includes(detailId)) {
              await updateTask(taskId, { skillIds: current.filter((x) => x !== detailId) })
            } else {
              // 不在会话级 skillIds 中（可能是 agent 默认或全局启用）→ 全局禁用
              await toggleSkill(detailId, false)
            }
          }
        }
        return true
      } catch (err) {
        logger.warn('Agent', `context:remove-item failed: ${(err as Error).message}`, payload?.taskId)
        return false
      }
    },
  )

  /**
   * Task 6：清空某类上下文。
   * - files：归档全部 file_ref L1 条目
   * - messages：归档全部对话类 L1 条目（不动 system_prompt / file_ref）
   * - tools / mcp / skills：清空会话级 skillIds（Agent 默认能力不可清空）
   */
  ipcMain.handle(
    'context:clear-category',
    async (_e, payload: { taskId: string; category: ContextCategory }) => {
      try {
        const { taskId, category } = payload
        if (category === 'files') {
          const items = (await listEnabledL1(taskId)).filter((m) => m.kind === 'file_ref')
          await archiveMany(taskId, items.map((m) => m.id))
        } else if (category === 'messages') {
          const items = (await listEnabledL1(taskId)).filter((m) =>
            CONVERSATION_KINDS.has(m.kind),
          )
          await archiveMany(taskId, items.map((m) => m.id))
        } else if (category === 'tools' || category === 'mcp' || category === 'skills') {
          const task = await getTask(taskId)
          if (task && (task.skillIds || []).length > 0) {
            await updateTask(taskId, { skillIds: [] })
          }
        }
        return true
      } catch (err) {
        logger.warn('Agent', `context:clear-category failed: ${(err as Error).message}`, payload?.taskId)
        return false
      }
    },
  )
}
