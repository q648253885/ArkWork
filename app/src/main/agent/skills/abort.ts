/* ============================================================
 * ArkWork — abortAfterAny 工具（v0.16.x 新增）
 *
 * 参考 opencode 的 abort.ts 设计（anomalyco/opencode）：
 *  - 把「超时」与「用户中止」合并到一个 AbortSignal，任一触发即 abort
 *  - 返回 cleanup 函数，避免事件监听器泄漏
 *
 * 使用场景：web-search / fetch-url / shell 这类外部 I/O 工具
 * 必须既能响应用户点停止（ctx.abort），又能在指定时间后自动终止。
 * 简单 AbortSignal.timeout() 只解决超时，丢了用户中止；
 * Promise.race(setTimeout-based) 又会泄漏 setTimeout 句柄。
 *
 * 调用：
 *   const { signal, clear } = abortAfterAny(timeoutMs, ctx.signal)
 *   try {
 *     const res = await fetch(url, { signal })
 *     ...
 *   } finally {
 *     clear()
 *   }
 * ============================================================ */

export interface AbortAfterAnyHandle {
  /** 合并后的 AbortSignal — 任一触发源（超时 / 用户中止）都会触发 */
  signal: AbortSignal
  /** 清理定时器与事件监听器，避免泄漏；调用方必须在 finally 里执行 */
  clear: () => void
  /** 已触发的根因（仅在 signal.aborted=true 时有值），便于日志区分超时 vs 用户中止 */
  reason?: 'timeout' | 'user-abort'
}

/**
 * 合并「超时」与「用户中止」到一个 AbortSignal。
 *
 * @param timeoutMs 超时毫秒；<=0 视为不设超时
 * @param userSignal 用户中止 signal（可选，常见为 ctx.abort / ctx.signal）
 */
export function abortAfterAny(timeoutMs: number, userSignal?: AbortSignal): AbortAfterAnyHandle {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let reason: 'timeout' | 'user-abort' | undefined

  const onUserAbort = () => {
    if (ctrl.signal.aborted) return
    reason = 'user-abort'
    ctrl.abort()
  }

  // 1. 用户中止 signal
  if (userSignal) {
    if (userSignal.aborted) {
      reason = 'user-abort'
      ctrl.abort()
    } else {
      userSignal.addEventListener('abort', onUserAbort, { once: true })
    }
  }

  // 2. 超时（仅在 timeoutMs > 0 时启动）
  if (timeoutMs > 0 && !ctrl.signal.aborted) {
    timer = setTimeout(() => {
      if (ctrl.signal.aborted) return
      reason = 'timeout'
      ctrl.abort()
    }, timeoutMs)
  }

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (userSignal) {
      userSignal.removeEventListener('abort', onUserAbort)
    }
  }

  return {
    signal: ctrl.signal,
    clear,
    get reason() {
      return reason
    },
  }
}

/**
 * 包装 fetch 调用，统一处理超时 + 用户中止 + 响应大小硬限制。
 * 借鉴 opencode WebFetch：5 MiB 默认上限，防止内存爆掉。
 *
 * 注：当前实现只做 Content-Length 预检（chunked 流式响应未做实时累计）；
 * 真实线上场景里 Baidu/Bing/GitHub 等均会带 Content-Length，5 MiB 已能挡
 * 住绝大多数恶意/挂掉的大响应。后续可升级为流式 TransformStream 包装。
 *
 * @param url 请求 URL
 * @param init fetch 选项，会被本函数附加 signal / headers
 * @param opts.timeoutMs 超时（默认 15000）
 * @param opts.maxBytes 响应体字节上限（默认 5 MiB）
 * @param opts.userSignal 用户中止 signal
 */
export async function fetchWithLimits(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; maxBytes?: number; userSignal?: AbortSignal; defaultHeaders?: Record<string, string> } = {},
): Promise<{ response: Response; handle: AbortAfterAnyHandle }> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const handle = abortAfterAny(timeoutMs, opts.userSignal)
  const merged: RequestInit = {
    ...init,
    signal: handle.signal,
    headers: { ...(opts.defaultHeaders ?? {}), ...(init.headers ?? {}) },
  }
  const response = await fetch(url, merged)
  // Content-Length 预检：避免下载大文件时内存爆
  const clHeader = response.headers.get('content-length')
  if (clHeader) {
    const cl = parseInt(clHeader, 10)
    if (Number.isFinite(cl) && cl > maxBytes) {
      handle.clear()
      // 抛错前必须关闭 body，否则连接无法释放
      try { await response.body?.cancel() } catch { /* ignore */ }
      throw new Error(`响应体过大（${cl} bytes > 上限 ${maxBytes} bytes）`)
    }
  }
  return { response, handle }
}

/**
 * 超时常错误（含 reason）— 让上层 catch 能区分"用户中止"与"超时"。
 */
export class TimeoutError extends Error {
  readonly isTimeout = true
  constructor(msMs: number) {
    super(`Operation timed out after ${msMs}ms`)
    this.name = 'TimeoutError'
  }
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true
  if (err instanceof Error && /timeout|timed out|abort/i.test(err.message)) return true
  return false
}