/* ============================================================
 * ArkWork — MCP Client (stdio JSON-RPC 2.0)
 * 设计文档 §4.3（F8）
 *
 * 最小化实现，不依赖 @modelcontextprotocol/sdk：
 *  - spawn 子进程，通过 stdin/stdout 收发 JSON-RPC 2.0 消息
 *  - 支持 initialize 握手 / tools/list / tools/call / ping
 *  - 单进程多 server 并发管理（clientMap by serverId）
 *  - 心跳：每 30s 调 ping，失败标记 error 并尝试重连一次
 *  - 应用退出时 disconnectAll（在 app.before-quit 钩子调用）
 *
 * 协议参考：https://spec.modelcontextprotocol.io/specification/
 * ============================================================ */
import { spawn, type ChildProcess } from 'node:child_process'
import { getArkworkDir } from '../store/db.js'
import type { McpServer, McpTool } from '@shared/types/agent'
import {
  listMcpConfigs,
  mergeRuntime,
  getMcpConfig,
} from '../store/mcp-servers.js'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface ClientEntry {
  proc: ChildProcess
  status: McpServer['status']
  tools: McpTool[]
  lastError?: string
  pending: Map<number | string, PendingRequest>
  nextId: number
  heartbeat?: NodeJS.Timeout
  initialized: boolean
  buffer: string  // stdout 行缓冲
}

const clientMap = new Map<string, ClientEntry>()
const HEARTBEAT_INTERVAL_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000
const INIT_TIMEOUT_MS = 15_000

/**
 * 连接到 MCP server（spawn 子进程 + initialize 握手 + tools/list）。
 * @param serverId - MCP server id
 * @returns 发现的 McpTool[]
 * 错误：配置不存在 / 子进程启动失败 / 握手超时 / tools/list 失败
 */
export async function connectMcp(serverId: string): Promise<McpTool[]> {
  // 已连接则先断开重连
  if (clientMap.has(serverId)) {
    await disconnectMcpInternal(serverId, false)
  }
  const config = await getMcpConfig(serverId)
  if (!config) {
    throw new Error(tFor(getUiLocale(), 'mcp.configNotFound', { id: serverId }))
  }
  if (config.transport !== 'stdio') {
    throw new Error(tFor(getUiLocale(), 'mcp.unsupportedTransport', { transport: config.transport }))
  }
  if (!config.command) {
    throw new Error(tFor(getUiLocale(), 'mcp.missingCommand', { id: serverId }))
  }

  logger.info('System', `mcp connecting: ${serverId} (${config.command} ${(config.args ?? []).join(' ')})`)

  // spawn 子进程
  const env = { ...process.env, ...resolveEnv(config.env) }
  let proc: ChildProcess
  try {
    proc = spawn(config.command, config.args ?? [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: getArkworkDir(),
    })
  } catch (err) {
    throw new Error(tFor(getUiLocale(), 'mcp.spawnFailed', { message: (err as Error).message }))
  }

  const entry: ClientEntry = {
    proc,
    status: 'connecting',
    tools: [],
    pending: new Map(),
    nextId: 1,
    initialized: false,
    buffer: '',
  }
  clientMap.set(serverId, entry)

  // 监听 stdout（JSON-RPC 按行分隔）
  proc.stdout?.on('data', (chunk: Buffer) => {
    entry.buffer += chunk.toString('utf-8')
    // 按行处理
    let nl: number
    while ((nl = entry.buffer.indexOf('\n')) >= 0) {
      const line = entry.buffer.slice(0, nl).trim()
      entry.buffer = entry.buffer.slice(nl + 1)
      if (line) {
        handleJsonRpc(serverId, line)
      }
    }
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString('utf-8').trim()
    if (msg) {
      logger.info('System', `[mcp:${serverId}] stderr: ${msg.slice(0, 200)}`)
    }
  })

  proc.on('error', (err) => {
    logger.error('System', `[mcp:${serverId}] proc error: ${err.message}`)
    entry.status = 'error'
    entry.lastError = err.message
    rejectAllPending(entry, err)
  })

  proc.on('exit', (code, signal) => {
    logger.info('System', `[mcp:${serverId}] proc exit code=${code} signal=${signal}`)
    if (clientMap.has(serverId)) {
      entry.status = 'disconnected'
      rejectAllPending(entry, new Error(tFor(getUiLocale(), 'mcp.processExited', { code: code ?? 'null', signal: signal ?? 'null' })))
    }
  })

  // initialize 握手
  try {
    await sendRequest(serverId, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ArkWork', version: '0.6.0' },
    }, INIT_TIMEOUT_MS)
    // 发送 initialized 通知（无 id）
    sendNotification(serverId, 'notifications/initialized', {})
    entry.initialized = true
    entry.status = 'connected'

    // tools/list
    const toolsResult = await sendRequest(serverId, 'tools/list', {}, REQUEST_TIMEOUT_MS) as
      | { tools?: McpTool[] }
      | McpTool[]
    const tools = Array.isArray(toolsResult) ? toolsResult : (toolsResult?.tools ?? [])
    entry.tools = tools
    logger.info('System', `[mcp:${serverId}] connected · ${tools.length} tools discovered`)

    // 启动心跳
    entry.heartbeat = setInterval(() => {
      void heartbeatOnce(serverId)
    }, HEARTBEAT_INTERVAL_MS)

    // v0.24.2.1：连接成功 → 失效 skill 缓存，下一次 listSkills 会重新注入 MCP tools
    try {
      const { invalidateSkillCache } = await import('../agent/registry.js')
      invalidateSkillCache()
    } catch { /* ignore — cache 失效失败不影响 MCP 连接 */ }

    return tools
  } catch (err) {
    entry.status = 'error'
    entry.lastError = (err as Error).message
    logger.error('System', `[mcp:${serverId}] connect failed: ${(err as Error).message}`)
    // 清理子进程
    try { proc.kill() } catch { /* ignore */ }
    throw err
  }
}

/**
 * 断开 MCP server 连接。
 * @param serverId - server id
 */
export async function disconnectMcp(serverId: string): Promise<void> {
  await disconnectMcpInternal(serverId, true)
}

async function disconnectMcpInternal(serverId: string, clearStatus: boolean): Promise<void> {
  const entry = clientMap.get(serverId)
  if (!entry) return
  if (entry.heartbeat) {
    clearInterval(entry.heartbeat)
    entry.heartbeat = undefined
  }
  rejectAllPending(entry, new Error(tFor(getUiLocale(), 'mcp.disconnected')))
  try {
    entry.proc.kill('SIGTERM')
    // 给 500ms 优雅退出，否则 SIGKILL
    setTimeout(() => {
      try {
        if (!entry.proc.killed) entry.proc.kill('SIGKILL')
      } catch { /* ignore */ }
    }, 500)
  } catch { /* ignore */ }
  clientMap.delete(serverId)
  if (clearStatus) {
    logger.info('System', `[mcp:${serverId}] disconnected`)
  }
  // v0.24.2.1：断开连接 → 失效 skill 缓存，让 listSkills 下次不再注入已断开的 MCP tool
  try {
    const { invalidateSkillCache } = await import('../agent/registry.js')
    invalidateSkillCache()
  } catch { /* ignore */ }
}

/** 断开全部连接（app 退出时调用） */
export async function disconnectAllMcp(): Promise<void> {
  const ids = Array.from(clientMap.keys())
  await Promise.all(ids.map((id) => disconnectMcp(id)))
}

/**
 * 调用 MCP 工具。
 * @param serverId - server id
 * @param toolName - 工具名
 * @param args - 工具参数
 * @param signal - 可选 AbortSignal
 * @returns 工具返回结果
 * 错误：未连接 / 工具不存在 / 执行超时
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const entry = clientMap.get(serverId)
  if (!entry || entry.status !== 'connected') {
    throw new Error(tFor(getUiLocale(), 'mcp.notConnected', { id: serverId, status: entry?.status ?? 'absent' }))
  }
  // 校验工具是否存在
  if (!entry.tools.find((t) => t.name === toolName)) {
    throw new Error(tFor(getUiLocale(), 'mcp.toolNotFound', { id: serverId, tool: toolName }))
  }
  const timeoutMs = REQUEST_TIMEOUT_MS * 2  // 工具调用允许更长
  return sendRequest(
    serverId,
    'tools/call',
    { name: toolName, arguments: args },
    timeoutMs,
    signal,
  )
}

/**
 * 列出全部 MCP server（合并持久化配置 + 运行时状态）。
 */
export async function listMcpServers(): Promise<McpServer[]> {
  const configs = await listMcpConfigs()
  const runtime = new Map<string, { status: McpServer['status']; tools: McpTool[]; lastError?: string }>()
  for (const [id, entry] of clientMap.entries()) {
    runtime.set(id, { status: entry.status, tools: entry.tools, lastError: entry.lastError })
  }
  return mergeRuntime(configs, runtime)
}

/** 获取单个 server 运行时状态（供 ipc 查询） */
export async function getMcpServerRuntime(id: string): Promise<McpServer | null> {
  const all = await listMcpServers()
  return all.find((m) => m.id === id) ?? null
}

/* ============================================================
 * JSON-RPC 内部实现
 * ============================================================ */

function sendNotification(serverId: string, method: string, params: unknown): void {
  const entry = clientMap.get(serverId)
  if (!entry) return
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
  writeLine(entry.proc, msg)
}

function sendRequest(
  serverId: string,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const entry = clientMap.get(serverId)
  if (!entry) {
    return Promise.reject(new Error(tFor(getUiLocale(), 'mcp.clientNotStarted', { id: serverId })))
  }
  const id = entry.nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id)
      reject(new Error(tFor(getUiLocale(), 'mcp.requestTimeout', { method, timeoutMs })))
    }, timeoutMs)

    const onAbort = () => {
      clearTimeout(timer)
      entry.pending.delete(id)
      reject(new Error(tFor(getUiLocale(), 'mcp.requestAborted')))
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    entry.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        entry.pending.delete(id)
        resolve(v)
      },
      reject: (err) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        entry.pending.delete(id)
        reject(err)
      },
      timer,
    })

    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    try {
      writeLine(entry.proc, msg)
    } catch (err) {
      clearTimeout(timer)
      entry.pending.delete(id)
      reject(new Error(tFor(getUiLocale(), 'mcp.writeFailed', { message: (err as Error).message })))
    }
  })
}

function writeLine(proc: ChildProcess, line: string): void {
  if (!proc.stdin || proc.stdin.destroyed) {
    throw new Error(tFor(getUiLocale(), 'mcp.stdinUnavailable'))
  }
  proc.stdin.write(line + '\n')
}

function handleJsonRpc(serverId: string, line: string): void {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    // 非 JSON 行忽略（某些 server 会打印日志到 stdout）
    return
  }
  const obj = msg as { jsonrpc?: string; id?: number | string; method?: string; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  // 响应（有 id + result/error）
  if (obj.id !== undefined && (obj.result !== undefined || obj.error)) {
    const entry = clientMap.get(serverId)
    if (!entry) return
    const pending = entry.pending.get(obj.id)
    if (!pending) return
    if (obj.error) {
      pending.reject(new Error(`${obj.error.message} (code=${obj.error.code})`))
    } else {
      pending.resolve(obj.result)
    }
    return
  }
  // 通知 / 请求（有 method 无 id）— 当前忽略服务端发起的方法
  // 未来可处理 notifications/tools/list_changed 以刷新工具列表
}

function rejectAllPending(entry: ClientEntry, err: Error): void {
  for (const [, p] of entry.pending) {
    clearTimeout(p.timer)
    p.reject(err)
  }
  entry.pending.clear()
}

async function heartbeatOnce(serverId: string): Promise<void> {
  const entry = clientMap.get(serverId)
  if (!entry || entry.status !== 'connected') return
  try {
    await sendRequest(serverId, 'ping', {}, 5000)
  } catch (err) {
    logger.warn('System', `[mcp:${serverId}] heartbeat failed: ${(err as Error).message}, 重连中…`)
    entry.status = 'error'
    entry.lastError = tFor(getUiLocale(), 'mcp.heartbeatFailed', { message: (err as Error).message })
    // 尝试重连一次
    try {
      await connectMcp(serverId)
    } catch (reconnectErr) {
      logger.error('System', `[mcp:${serverId}] 重连失败：${(reconnectErr as Error).message}`)
    }
  }
}

/**
 * 解析 env 中的 secret 引用（值以 "secret:" 开头时从 secrets.json 读取）。
 * 简化版：直接透传字符串值（密钥由用户在配置中填写）。
 * 后续可对接 settings 的 secret 存储。
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  if (!env) return {}
  const resolved: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v.startsWith('secret:')) {
      // 简化：保留原值前缀，由实际部署时替换
      // 真实实现应从 secrets.json 读取对应 key
      resolved[k] = v
    } else {
      resolved[k] = v
    }
  }
  return resolved
}
