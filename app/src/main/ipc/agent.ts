/* ============================================================
 * ArkWork — IPC: Agent
 * 设计文档 §4.1（F3 Agent CRUD）
 *
 * 通道：agent:list / get / add / update / remove
 * 持久化由 store/agents.ts 负责；CRUD 后失效内存缓存。
 * 内置 Agent 受保护：update 仅允许改非人格字段，remove 直接抛错。
 * ============================================================ */
import { ipcMain } from 'electron'
import {
  listAgents,
  getAgent,
  addAgent,
  updateAgent,
  removeAgent,
  getManualAgentOverride,
  setManualAgentOverride,
} from '../store/agents.js'
import type { AgentAddInput } from '@shared/types/ipc'
import { logger } from '../system/logger.js'

export function registerAgentHandlers(): void {
  /** 列出所有 Agent（内置 + 自定义） */
  ipcMain.handle('agent:list', async () => listAgents())

  /** 获取单个 Agent */
  ipcMain.handle('agent:get', async (_e, id: string) => getAgent(id))

  /**
   * 新建自定义 Agent。
   * @param input - Agent 字段（不含 id/isBuiltin/version）
   * @returns 创建的 Agent（含生成的 id）
   * 错误：name 为空 / id 或 name 重复
   */
  ipcMain.handle('agent:add', async (_e, input: AgentAddInput) => {
    return addAgent(input)
  })

  /**
   * 更新 Agent 字段。
   * @param payload - { id, patch }
   * 错误：不存在 / 内置 Agent 改人格字段
   */
  ipcMain.handle(
    'agent:update',
    async (_e, payload: { id: string; patch: Partial<AgentAddInput> }) => {
      return updateAgent(payload.id, payload.patch)
    },
  )

  /**
   * 删除 Agent。
   * @param payload - { id }
   * 错误：不存在 / 内置 Agent 不可删
   */
  ipcMain.handle('agent:remove', async (_e, payload: { id: string }) => {
    await removeAgent(payload.id)
    logger.info('System', `agent removed via IPC: ${payload.id}`)
  })

  ipcMain.handle('agent:manual-override', async (_e, value?: '@general' | '@coding' | 'auto') => {
    if (value === undefined) return getManualAgentOverride()
    return setManualAgentOverride(value)
  })
}
