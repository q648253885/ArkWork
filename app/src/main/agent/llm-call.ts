/* ============================================================
 * agent-context-compaction-robustness — LLM 调用健壮性纯工具模块
 *
 * 从 engine.ts 抽取 retryableError / callLlmWithRetry / RETRY_BACKOFF_MS，
 * 并新增 withLlmTimeout（120s 超时包装）。纯模块便于单元测试：
 *   npx tsx --test src/main/agent/__tests__/llm-robustness.test.ts
 * ============================================================ */
import type { LogEntry } from '@shared/types/ipc'
import type { LlmCompleteResponse } from '../llm/adapter.js'

type LogSource = LogEntry['source']

/** polish4 §D1.3：retry backoff 序列（单位 ms，最多重试 RETRY_BACKOFF_MS.length 次） */
export const RETRY_BACKOFF_MS = [500, 2000]

/**
 * 惰性加载 logger：llm-call.ts 必须保持零静态依赖（logger → store/db → electron
 * 只能在主进程加载，纯 Node 单测环境不可用）。动态 import 在非主进程环境失败时
 * 静默降级；生产环境首次调用后模块缓存，行为与 logger.warn 一致。
 */
function warnLog(source: LogSource, message: string, taskId?: string): void {
  void import('../system/logger.js')
    .then((m) => m.logger.warn(source, message, taskId))
    .catch(() => {
      // 非主进程环境（如纯 Node 单测）无 logger：静默降级
    })
}

/**
 * polish4 §D1.3：识别可重试错误（rate limit / network / length / empty）。
 * 注意：`aborted` 不在其中——用户中止（SDK 抛 "The user aborted a request."）
 * 必须立即上抛，绝不无效重试。
 */
export function retryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /rate.?limit|429|timeout|network|fetch failed|ENOTFOUND|ETIMEDOUT|length|empty response/i.test(
    msg,
  )
}

/**
 * v0.15.0 Task 2 SubTask 2.5 — Layer 3 Reactive Fallback 触发判定。
 * context 超限类错误：上下文超过模型窗口上限（如 Anthropic context_length_exceeded、
 * OpenAI maximum context length / token limit），需要激进压缩后重试一次。
 */
export function isContextOverflowError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // thinking 模型（如 deepseek-v4-flash）上下文膨胀常以「超时」而非 context_length 报错，
  // 需一并纳入 Reactive Fallback 触发判定，否则会按原 payload 重试 → 同样超时 → 任务卡死。
  if (err instanceof LlmTimeoutError) return true
  return /context\s*length|context_length|context\s*window|token\s*limit|maximum\s*context|too\s*many\s*tokens/i.test(msg)
}

/**
 * LLM 调用超时错误。
 * message 含 "timeout" 子串（retryableError 按 timeout 匹配 → 可重试）。
 */
export class LlmTimeoutError extends Error {
  name = 'LlmTimeoutError'
}

/**
 * 120s 超时包装：
 * - 用户中止（userSignal aborted）→ 原错误原样抛出（上层按 AbortError 处理为 paused/cancelled，不重试）；
 * - 内部超时（ms 到期）→ 抛 LlmTimeoutError（message 含 "timeout"，retryableError 匹配后可重试）；
 * - 其他错误 → 原样透出。
 */
export async function withLlmTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  userSignal?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  const onUserAbort = () => ctrl.abort()
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort()
    else userSignal.addEventListener('abort', onUserAbort)
  }
  try {
    return await fn(ctrl.signal)
  } catch (err) {
    if (userSignal?.aborted) throw err // 用户中止：保持原错误（不转超时、不重试）
    if (ctrl.signal.aborted) throw new LlmTimeoutError(`LLM 调用超时 (timeout ${ms / 1000}s)`)
    throw err
  } finally {
    clearTimeout(timer)
    userSignal?.removeEventListener('abort', onUserAbort)
  }
}

/**
 * polish4 §D1.3：retryable 错误自动重试，backoff 序列逐次递增，最多重试 backoffMs.length 次。
 * signal 中止短路：循环顶部检查 + catch 内检查——用户中止绝不进入下一次重试。
 * @param backoffMs 可注入的自定义 backoff 序列（测试可传 [1] 加速），默认 RETRY_BACKOFF_MS
 */
export async function callLlmWithRetry(
  fn: () => Promise<LlmCompleteResponse>,
  signal?: AbortSignal,
  backoffMs: number[] = RETRY_BACKOFF_MS,
): Promise<LlmCompleteResponse> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    // 调用前短路：signal 已中止（如调用期间用户 Esc/停止）→ 立即上抛，不再重试
    if (signal?.aborted) throw lastErr ?? new Error('The user aborted a request.')
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // 调用期间用户中止（SDK 同步触发 signal）→ 不重试
      if (signal?.aborted) break
      if (!retryableError(err) || attempt === backoffMs.length) break
      const delay = backoffMs[attempt]
      warnLog('Agent', `LLM call failed (retry ${attempt + 1}/${backoffMs.length} in ${delay}ms): ${(err as Error).message}`)
      await new Promise<void>((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
