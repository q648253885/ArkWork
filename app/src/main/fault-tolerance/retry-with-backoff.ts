/* ============================================================
 * v0.14.0 Task 5.2 — 重试编排器（retryWithBackoff）
 *
 * 行为：
 *  - 任意一次成功立即返回 { value, attempts }
 *  - 全部失败抛 FaultError('retries-exhausted', ...)
 *  - 默认 backoffMs = [1000, 2000, 4000]，最多 3 次
 *  - 不可重试错误（non-retryable-tool / llm-fatal）直接抛，不消耗重试次数
 *  - 基于 AbortSignal 的外部中断支持
 * ============================================================ */

import type { FaultError, RetryAttemptRecord, RetryOptions, RetryResult } from './types.js'
import { classifyError, isFaultError, RETRIES_EXHAUSTED_CODE } from './classify.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000] as const
export const DEFAULT_MAX_ATTEMPTS = 3

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/**
 * 工具调用包装器（与编排器配合使用）：
 *  - 接收原始 toolCall 函数
 *  - 单次执行失败 → classifyError 归一化
 *  - 不可重试 / llm-fatal 错误直接抛（不消耗重试）
 *  - 可重试错误 → 通过 opts.onAttempt 回调后抛 FaultError('retries-exhausted')
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const backoffMs = (opts.backoffMs ?? Array.from(DEFAULT_BACKOFF_MS)).slice(0, Math.max(1, maxAttempts - 1))
  const signal = opts.signal
  // v0.29.0 F6：FaultError.message 会经异常卡片/toast 展示给用户，随 UI 语言切换
  const locale = getUiLocale()

  const attempts: RetryAttemptRecord[] = []
  let lastError: FaultError | undefined

  for (let n = 1; n <= maxAttempts; n++) {
    if (signal?.aborted) {
      throw new Error('aborted')
    }
    try {
      const value = await fn()
      attempts.push({ n, ok: true, ts: Date.now() })
      return { value, attempts }
    } catch (raw) {
      const fault: FaultError = isFaultError(raw) ? raw : classifyError(raw)
      // 不可重试 / llm-fatal → 立即抛，不消耗重试
      if (fault.originalKind === 'non-retryable-tool' || fault.originalKind === 'llm-fatal') {
        attempts.push({ n, ok: false, error: fault, ts: Date.now() })
        if (opts.onAttempt) opts.onAttempt(n, fault)
        // 抛带 attempts 的 FaultError
        const exhausted: FaultError = {
          ...fault,
          code: fault.originalKind === 'llm-fatal' ? fault.code : 'non-retryable-thrown',
          message:
            fault.originalKind === 'llm-fatal'
              ? tFor(locale, 'retry.llmFatal', { message: fault.message })
              : tFor(locale, 'retry.nonRetryable', { message: fault.message }),
        }
        throw exhausted
      }
      attempts.push({ n, ok: false, error: fault, ts: Date.now() })
      lastError = fault
      if (opts.onAttempt) opts.onAttempt(n, fault)
      if (n >= maxAttempts) break
      // 等待 backoff（前 n-1 次等待）
      const delay = backoffMs[n - 1] ?? 0
      try {
        await sleep(delay, signal)
      } catch {
        throw new Error('aborted')
      }
    }
  }

  // 全部失败
  const exhausted: FaultError = {
    code: RETRIES_EXHAUSTED_CODE,
    message: tFor(locale, 'retry.exhaustedWithReason', {
      attempts: maxAttempts,
      reason: lastError?.message ?? tFor(locale, 'retry.unknownReason'),
    }),
    originalKind: lastError?.originalKind ?? 'unknown',
    toolName: lastError?.toolName,
    httpStatus: lastError?.httpStatus,
    cause: lastError?.cause ?? lastError,
  }
  throw exhausted
}
