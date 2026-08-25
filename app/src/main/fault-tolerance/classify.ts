/* ============================================================
 * v0.14.0 Task 5.1 / 5.8 — 错误归类（classifyError）
 *
 * 错误归类规则（按 spec）：
 *  - HTTP 5xx / 429 / 空响应 / 模型自我报告失败 → llm-fatal
 *  - 参数非法 / 权限拒绝 → non-retryable-tool
 *  - 网络抖动 / MCP 超时 → retryable-tool
 *  - 其余 → unknown（默认走重试）
 *
 * 实现说明：
 *  - 错误识别基于「错误码 / 状态码 / 错误文案」三路启发式
 *  - 同时支持 Node Error（code / status / statusCode）与 thrown string / thrown plain object
 *  - ctx 字段（toolName / provider / httpStatus）用于补充信息，
 *    调用方一般已经知道这些；不强制依赖
 *  - 错误文案不面向用户精修，仅用于日志与审计
 * ============================================================ */

import type { FaultError, FaultKind } from './types.js'

export interface ClassifyCtx {
  toolName?: string
  provider?: string
  httpStatus?: number
}

export const RETRIES_EXHAUSTED_CODE = 'retries-exhausted'

/**
 * 归一化 unknown → 结构化字段（status / code / message 三方面）
 * - 兼容 Error / object / string
 * - 仅做最小识别，不引入外部依赖
 */
interface NormalizedErr {
  status?: number
  statusCode?: number
  code?: string
  message: string
  raw: unknown
}

const HTTP_STATUS_FIELDS = ['status', 'statusCode', 'httpStatus', 'response.status', 'response.statusCode'] as const

function pickNumber(obj: Record<string, unknown>, path: string): number | undefined {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return typeof cur === 'number' ? cur : undefined
}

function normalize(err: unknown): NormalizedErr {
  if (err == null) {
    return { message: String(err), raw: err }
  }
  if (typeof err === 'string') {
    return { message: err, raw: err }
  }
  if (typeof err === 'object') {
    const obj = err as Record<string, unknown>
    const status = HTTP_STATUS_FIELDS.map((p) => pickNumber(obj, p)).find((v): v is number => typeof v === 'number')
    const code = typeof obj['code'] === 'string' ? (obj['code'] as string) : undefined
    const messageRaw = obj['message'] ?? obj['error'] ?? obj['msg']
    const message = typeof messageRaw === 'string' ? messageRaw : (() => { try { return JSON.stringify(err) } catch { return String(err) } })()
    return { status, code, message, raw: err }
  }
  return { message: String(err), raw: err }
}

/**
 * 启发式：当前错误是不是「LLM 致命异常」
 *  - HTTP 5xx
 *  - HTTP 429
 *  - 空响应 / 响应未到达
 *  - 模型自我报告失败（如 finish_reason=error、API 报错 "model overloaded"）
 */
function isLlmFatal(n: NormalizedErr): { fatal: boolean; code: string } {
  // HTTP 5xx / 429
  if (n.status === 429) return { fatal: true, code: 'llm-429' }
  if (typeof n.status === 'number' && n.status >= 500 && n.status < 600) return { fatal: true, code: `llm-${n.status}` }
  // 错误码含 LLM 致命信号
  if (n.code) {
    const c = n.code.toLowerCase()
    if (c === 'econnreset' || c === 'econnaborted' || c === 'eai_again' || c === 'etimedout' || c === 'network') {
      // 纯网络错通常是 retryable；只有 LLM 通道的 network 失效才 fatal
      // 因为 LLM 通道一般在 network 错也是可重试的，下方归 retryable。
      // 留空：仅靠 status 即可判 fatal
    }
  }
  // 文案兜底
  const m = n.message.toLowerCase()
  if (
    m.includes('model overloaded') ||
    m.includes('model_not_found') ||
    m.includes('服务异常') ||
    m.includes('上游不可用') ||
    m.includes('empty response') ||
    m.includes('empty assistant')
  ) {
    return { fatal: true, code: 'llm-self-reported' }
  }
  return { fatal: false, code: '' }
}

/** 启发式：是不是「不可重试」工具错误（参数非法 / 权限拒绝） */
function isNonRetryableTool(n: NormalizedErr): boolean {
  if (n.status === 400 || n.status === 401 || n.status === 403 || n.status === 404 || n.status === 422) {
    return true
  }
  if (n.code) {
    const c = n.code.toLowerCase()
    if (c === 'permission_denied' || c === 'permission-denied' || c === 'unauthorized' || c === 'forbidden' || c === 'err_invalid_argument' || c === 'invalid_argument') {
      return true
    }
  }
  const m = n.message.toLowerCase()
  if (
    m.includes('permission denied') ||
    m.includes('用户拒绝') ||
    m.includes('确认超时') ||
    m.includes('确认已取消') ||
    m.includes('命令确认') ||
    m.includes('invalid argument') ||
    m.includes('参数非法') ||
    m.includes('参数错误') ||
    m.includes('schema') ||
    m.includes('validation failed') ||
    m.includes('not found') ||
    m.includes('missing required')
  ) {
    return true
  }
  return false
}

/** 启发式：是不是「可重试」工具/网络错误（瞬时故障） */
function isRetryableTool(n: NormalizedErr): boolean {
  if (n.status === 408 || n.status === 425 || n.status === 502 || n.status === 503 || n.status === 504) {
    return true
  }
  if (n.code) {
    const c = n.code.toLowerCase()
    if (c === 'econnreset' || c === 'etimedout' || c === 'eai_again' || c === 'mcp_timeout' || c === 'aborted' || c === 'fetch_error') {
      return true
    }
  }
  const m = n.message.toLowerCase()
  if (
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('超时') ||
    m.includes('network') ||
    m.includes('econnreset') ||
    m.includes('socket hang up') ||
    m.includes('try again') ||
    m.includes('网络抖动') ||
    m.includes('mcp 工具调用超时')
  ) {
    return true
  }
  return false
}

/**
 * 归类入口。
 * - err: 原始异常
 * - ctx: 上下文（toolName / provider / httpStatus）
 *
 * 返回 FaultError，但不在此处抛出（编排器决定是直接抛还是可以走到下一档）。
 */
export function classifyError(err: unknown, ctx: ClassifyCtx = {}): FaultError {
  const n = normalize(err)
  // HTTP 状态合并：调用方显式 ctx.httpStatus > err 自身 .status
  const httpStatus = ctx.httpStatus ?? n.status
  const toolName = ctx.toolName
  const provider = ctx.provider

  // 1. LLM 致命（HTTP 5xx / 429 / 空响应 / 模型自我报告）
  //  - 仅在调用方未提供 toolName（说明错误来自 LLM 通道本身）时归 llm-fatal
  //  - 若 ctx.toolName 存在，则 5xx/429 视为工具层面的瞬时故障 → 走 retryable-tool
  const isFromLlmChannel = !toolName
  const fatal = (() => {
    if (isFromLlmChannel) {
      if (httpStatus === 429) return { fatal: true, code: 'llm-429' }
      if (typeof httpStatus === 'number' && httpStatus >= 500 && httpStatus < 600) return { fatal: true, code: `llm-${httpStatus}` }
    }
    const r = isLlmFatal(n)
    return r.fatal && isFromLlmChannel ? { fatal: true, code: r.code } : { fatal: false, code: '' }
  })()
  if (fatal.fatal) {
    return {
      code: fatal.code,
      message: n.message || `LLM 致命异常（${fatal.code}）`,
      originalKind: 'llm-fatal',
      llmProvider: provider,
      httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
      cause: err,
    }
  }

  // 2. 不可重试工具错误（参数非法 / 权限拒绝）
  if (isNonRetryableTool({ ...n, status: httpStatus ?? n.status })) {
    return {
      code: typeof httpStatus === 'number' ? `tool-${httpStatus}` : (n.code ?? 'tool-invalid'),
      message: n.message || '工具参数非法或权限被拒绝',
      originalKind: 'non-retryable-tool',
      toolName,
      httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
      cause: err,
    }
  }

  // 3. 可重试工具错误（网络抖动 / MCP 超时 / 5xx 类瞬时故障）
  // 502/503/504 是 web 通用 transient 信号；当 ctx.toolName 存在时归 retryable-tool
  if (isRetryableTool({ ...n, status: httpStatus ?? n.status })) {
    return {
      code: typeof httpStatus === 'number' ? `tool-${httpStatus}` : (n.code ?? 'tool-retryable'),
      message: n.message || '工具调用失败，可重试',
      originalKind: 'retryable-tool',
      toolName,
      httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
      cause: err,
    }
  }

  // 4. 兜底 → 5xx/429 在带 toolName 时也归 retryable-tool（避免把瞬时网络故障误判为 llm-fatal）
  if (toolName && typeof httpStatus === 'number') {
    if (httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600) || httpStatus === 408 || httpStatus === 425) {
      return {
        code: `tool-${httpStatus}`,
        message: n.message || '工具上游瞬时故障，可重试',
        originalKind: 'retryable-tool',
        toolName,
        httpStatus,
        cause: err,
      }
    }
  }

  // 4. 兜底 → unknown（默认走重试）
  return {
    code: n.code ?? 'unknown',
    message: n.message || '未知异常',
    originalKind: 'unknown',
    toolName,
    httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
    cause: err,
  }
}

/** 类型守卫：判断一个对象是否是 FaultError */
export function isFaultError(err: unknown): err is FaultError {
  if (!err || typeof err !== 'object') return false
  const obj = err as Record<string, unknown>
  return (
    typeof obj['code'] === 'string' &&
    typeof obj['message'] === 'string' &&
    typeof obj['originalKind'] === 'string' &&
    (['retryable-tool', 'non-retryable-tool', 'llm-fatal', 'unknown'] as FaultKind[]).includes(
      obj['originalKind'] as FaultKind,
    )
  )
}
