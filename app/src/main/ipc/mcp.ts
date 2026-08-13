/* ============================================================
 * ArkWork — IPC: MCP
 * 设计文档 §4.3（F8）
 *
 * 通道：mcp:list / add / update / remove / connect / disconnect / call-tool / toggle
 * 持久化由 store/mcp-servers.ts 负责；运行时连接由 mcp/client.ts 管理。
 * ============================================================ */
import { ipcMain } from 'electron'
import {
  addMcpServer,
  updateMcpConfig,
  removeMcpConfig,
} from '../store/mcp-servers.js'
import {
  listMcpServers,
  connectMcp,
  disconnectMcp,
  callMcpTool,
} from '../mcp/client.js'
import type { McpAddInput } from '@shared/types/ipc'
import { logger } from '../system/logger.js'

export function registerMcpHandlers(): void {
  /** 列出全部 MCP server（含运行时状态） */
  ipcMain.handle('mcp:list', async () => listMcpServers())

  /** 新建 MCP server 配置 */
  ipcMain.handle('mcp:add', async (_e, input: McpAddInput) => {
    return addMcpServer(input)
  })

  /** 更新 MCP server 配置（更新后若已连接需手动重连） */
  ipcMain.handle(
    'mcp:update',
    async (_e, payload: { id: string; patch: Partial<McpAddInput> }) => {
      return updateMcpConfig(payload.id, payload.patch)
    },
  )

  /**
   * 删除 MCP server 配置。
   * 若已连接，先断开运行时连接。
   */
  ipcMain.handle('mcp:remove', async (_e, payload: { id: string }) => {
    await disconnectMcp(payload.id)
    await removeMcpConfig(payload.id)
    logger.info('System', `mcp removed via IPC: ${payload.id}`)
  })

  /**
   * 连接 MCP server：spawn 子进程 + initialize + tools/list。
   * @returns 发现的 McpTool[]
   */
  ipcMain.handle('mcp:connect', async (_e, payload: { id: string }) => {
    return connectMcp(payload.id)
  })

  /** 断开 MCP server 连接 */
  ipcMain.handle('mcp:disconnect', async (_e, payload: { id: string }) => {
    await disconnectMcp(payload.id)
  })

  /**
   * 调用 MCP 工具。
   * @param payload - { serverId, toolName, args }
   * @returns 工具返回结果
   */
  ipcMain.handle(
    'mcp:call-tool',
    async (
      _e,
      payload: { serverId: string; toolName: string; args: Record<string, unknown> },
    ) => {
      return callMcpTool(payload.serverId, payload.toolName, payload.args)
    },
  )

  /** 兼容旧版 toggle（等价于 update enabled） */
  ipcMain.handle(
    'mcp:toggle',
    async (_e, payload: { id: string; enabled: boolean }) => {
      await updateMcpConfig(payload.id, { enabled: payload.enabled })
    },
  )
}
