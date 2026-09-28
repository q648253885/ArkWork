/* ============================================================
 * ArkWork — 重试核心（v0.36.0 F1.4，设计文档 §3.3）
 *
 * 统一退避策略的**单一真源**（纯 Node，零 electron / i18n 依赖）：
 *   - DEFAULT_BACKOFF_MS = [500, 2000, 4000]，DEFAULT_MAX_ATTEMPTS = 3
 *   - sleep / retryCore 通用原语
 *
 * 两个消费方：
 *   - fault-tolerance/retry-with-backoff.ts（工具编排层：分类 + i18n 消息 +
 *     attempts 账本，默认值与 sleep 取自本模块）
 *   - agent/llm-call.ts callLlmWithRetry（LLM 层：保持零静态依赖，直接用
 *     retryCore —— 不能 import retry-with-backoff，否则会拖进 i18n 模块图）
 * ============================================================ */

/** 统一退避序列（ms）：首试失败后依次等待 500ms / 2s / 4s */
export const DEFAULT_BACKOFF_MS = [500, 2000, 4000] as const

/** 统一最大尝试次数（含首次） */
export const DEFAULT_MAX_ATTEMPTS = 3

/** backoff 等待；signal 中止时 reject（code=ABORT_ERR 的 Error('aborted')） */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      const e = new Error('aborted')
      ;(e as Error & { code: string }).code = 'ABORT_ERR'
      reject(e)
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export interface RetryCoreOptions {
  /** 总尝试次数（含首次），缺省 DEFAULT_MAX_ATTEMPTS */
  maxAttempts?: number
  /** 重试前等待序列（ms），第 n 次重试前取 backoffMs[n-1]，缺省 DEFAULT_BACKOFF_MS */
  backoffMs?: readonly number[]
  /** 外部中止信号 */
  signal?: AbortSignal
  /** 返回 false 的错误不重试（立即上抛最后一次错误）。缺省一律重试 */
  isRetryable?: (err: unknown) => boolean
  /** 每次决定重试前回调（attempt 从 1 计；delayMs 为本次等待） */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void
  /**
   * 中止时抛出的错误（调用前已中止 / 调用期间中止 / backoff 期间中止）。
   * 入参 lastErr 为此前捕获的错误（可能 undefined）。缺省抛 Error('aborted')。
   */
  onAborted?: (lastErr: unknown) => unknown
}

/**
 * 通用重试核心：最多 maxAttempts 次尝试，失败按 backoffMs 递增等待；
 * 不可重试错误或次数耗尽 → 上抛最后一次错误；signal 中止 → onAborted 定制错误。
 */
export async function retryCore<T>(fn: () => Promise<T>, opts: RetryCoreOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const isRetryable = opts.isRetryable ?? (() => true)
  const throwAborted = (lastErr: unknown): unknown =>
    opts.onAborted ? opts.onAborted(lastErr) : new Error('aborted')

  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 调用前短路：signal 已中止 → 立即按中止语义抛出，不再尝试
    if (opts.signal?.aborted) throw throwAborted(lastErr)
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // 调用期间用户中止 → 不重试
      if (opts.signal?.aborted) throw throwAborted(lastErr)
      if (!isRetryable(err) || attempt === maxAttempts - 1) break
      const delay = backoffMs[attempt] ?? 0
      opts.onRetry?.(attempt + 1, delay, err)
      try {
        await sleep(delay, opts.signal)
      } catch {
        // 中止打断 backoff 等待：与「调用前已中止」同语义
        throw throwAborted(lastErr)
      }
    }
  }
  throw lastErr
}
