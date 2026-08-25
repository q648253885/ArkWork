/* ============================================================
 * ArkWork — MCP Server Store
 * 设计文档 §3.3 / §4.3（F8）
 *
 * 持久化 MCP server 配置到 {arkworkDir}/mcp-servers.json
 * 运行时状态（status / toolCount / tools / lastError）不持久化，
 * 由 mcp/client.ts 维护并合并到 listMcpServers 返回值。
 * ============================================================ */
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir } from './db.js'
import type { McpServer, McpTool } from '@shared/types/agent'
import type { McpAddInput } from '@shared/types/ipc'
import { logger } from '../system/logger.js'
// v0.29.0 F6：用户可见校验错误四语言化
import { getUiLocale, tFor } from '../i18n/messages.js'

let cachedConfigs: Omit<McpServer, 'status' | 'toolCount' | 'tools' | 'lastError'>[] | null = null

type PersistedMcp = Omit<McpServer, 'status' | 'toolCount' | 'tools' | 'lastError'>

async function readPersisted(): Promise<PersistedMcp[]> {
  if (cachedConfigs) return cachedConfigs
  const path = join(getArkworkDir(), 'mcp-servers.json')
  if (!existsSync(path)) {
    cachedConfigs = []
    return cachedConfigs
  }
  try {
    const raw = await readFile(path, 'utf-8')
    cachedConfigs = JSON.parse(raw) as PersistedMcp[]
  } catch {
    cachedConfigs = []
  }
  return cachedConfigs
}

async function writePersisted(list: PersistedMcp[]): Promise<void> {
  const path = join(getArkworkDir(), 'mcp-servers.json')
  await writeFile(path, JSON.stringify(list, null, 2), 'utf-8')
  cachedConfigs = list
}

/** 失效缓存（外部修改后调用） */
export function invalidateMcpCache(): void {
  cachedConfigs = null
}

/**
 * 列出全部 MCP server 配置。
 * 运行时状态从 mcp/client.ts 拉取并合并。
 */
export async function listMcpConfigs(): Promise<PersistedMcp[]> {
  return readPersisted()
}

export async function getMcpConfig(id: string): Promise<PersistedMcp | null> {
  const list = await readPersisted()
  return list.find((m) => m.id === id) ?? null
}

/**
 * 新建 MCP server 配置。
 * @param input - 配置字段（不含 id/status/toolCount/tools）
 * @returns 创建的完整 McpServer（status='disconnected'）
 */
export async function addMcpServer(input: McpAddInput): Promise<McpServer> {
  if (!input.name?.trim()) {
    throw new Error(tFor(getUiLocale(), 'mcpcfg.nameRequired'))
  }
  if (input.transport !== 'stdio' && input.transport !== 'sse') {
    throw new Error(tFor(getUiLocale(), 'mcpcfg.transportInvalid'))
  }
  if (input.transport === 'stdio' && !input.command?.trim()) {
    throw new Error(tFor(getUiLocale(), 'mcpcfg.commandRequired'))
  }
  if (input.transport === 'sse' && !input.url?.trim()) {
    throw new Error(tFor(getUiLocale(), 'mcpcfg.urlRequired'))
  }
  const list = await readPersisted()
  const id = input.id?.trim() || generateMcpId(input.name, list)
  if (list.find((m) => m.id === id)) {
    throw new Error(tFor(getUiLocale(), 'mcpcfg.idExists', { id }))
  }
  if (list.find((m) => m.name === input.name)) {
    throw new Error(tFor(getUiLocale(), 'mcpcfg.nameExists', { name: input.name }))
  }
  const config: PersistedMcp = {
    id,
    name: input.name,
    namespace: input.namespace ?? id,
    transport: input.transport,
    command: input.command,
    args: input.args,
    env: input.env,
    url: input.url,
    enabled: input.enabled ?? true,
  }
  const next = [...list, config]
  await writePersisted(next)
  logger.info('System', `mcp server created: ${config.id} (${config.name})`)
  return {
    ...config,
    status: 'disconnected',
    toolCount: 0,
    tools: [],
  }
}

/**
 * 更新 MCP server 配置。
 * @param id - server id
 * @param patch - 要更新的字段
 * 错误：不存在
 */
export async function updateMcpConfig(
  id: string,
  patch: Partial<PersistedMcp>,
): Promise<PersistedMcp> {
  const list = await readPersisted()
  const idx = list.findIndex((m) => m.id === id)
  if (idx < 0) throw new Error(tFor(getUiLocale(), 'mcpcfg.notFound', { id }))
  const { id: _omitId, ...safePatch } = patch
  const updated: PersistedMcp = { ...list[idx], ...safePatch, id: list[idx].id }
  list[idx] = updated
  await writePersisted(list)
  logger.info('System', `mcp server updated: ${id}`)
  return updated
}

/**
 * 删除 MCP server 配置。
 * 调用方需先 disconnect 运行时连接。
 */
export async function removeMcpConfig(id: string): Promise<void> {
  const list = await readPersisted()
  if (!list.find((m) => m.id === id)) {
    throw new Error(tFor(getUiLocale(), 'mcpcfg.notFound', { id }))
  }
  const next = list.filter((m) => m.id !== id)
  await writePersisted(next)
  logger.info('System', `mcp server removed: ${id}`)
}

function generateMcpId(name: string, existing: PersistedMcp[]): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'mcp'
  let id = `M-${slug}`
  let n = 2
  while (existing.find((m) => m.id === id)) {
    id = `M-${slug}-${n}`
    n++
  }
  return id
}

/** 把运行时状态合并到持久化配置，返回完整 McpServer[] */
export function mergeRuntime(
  configs: PersistedMcp[],
  runtime: Map<string, { status: McpServer['status']; tools: McpTool[]; lastError?: string }>,
): McpServer[] {
  return configs.map((c) => {
    const rt = runtime.get(c.id)
    return {
      ...c,
      status: rt?.status ?? 'disconnected',
      toolCount: rt?.tools.length ?? 0,
      tools: rt?.tools ?? [],
      lastError: rt?.lastError,
    }
  })
}
