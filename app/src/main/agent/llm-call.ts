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
 *
 * ⚠️ v0.32.1（缺陷 D35）：**超时后「成功 resolve」也必须认定为超时**。
 *
 * 原实现只把超时判定写在 `catch` 分支里。但中止一个流式请求时，SDK 并不保证抛错 ——
 * 它完全可能**正常结束迭代**（把流当作读完），于是 `fn` 顺利 resolve：
 *   · 实测形态（ModelScope/GLM-5.3-Flash）：耗时恰好 120.1s、usage 0+0、
 *     只留下 reasoning 没有 content；
 *   · 而调用方看到的是一个「正常返回的空回合」→ 思考突然中断却没有任何错误，
 *     引擎随后把它当成终答收尾（任务被静默判 done、任务清单纹丝不动）。
 *
 * 修法：用独立的 `timedOut` 标志（而非 `ctrl.signal.aborted`，避免与用户主动中止混淆）
 * 记住「这次超时是我们自己造成的」，并在 `fn` resolve 之后补判一次：
 *   · 结果**完整**（`isIncomplete` 返回 false）→ 照常返回 ——
 *     超时前一瞬间已完整收到的回答不该被丢掉（避免误杀）；
 *   · 结果**不完整**（`isIncomplete` 返回 true）→ 抛 LlmTimeoutError，
 *     让上层的重试 / 失败收尾链路接管。
 *
 * `isIncomplete` 缺省时退回原行为（不判），保证既有调用点语义不变。
 */
export async function withLlmTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  userSignal?: AbortSignal,
  isIncomplete?: (result: T) => boolean,
): Promise<T> {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, ms)
  const onUserAbort = () => ctrl.abort()
  if (userSignal) {
    if (userSignal.aborted) ctrl.abort()
    else userSignal.addEventListener('abort', onUserAbort)
  }
  try {
    const result = await fn(ctrl.signal)
    if (timedOut && !userSignal?.aborted && (isIncomplete?.(result) ?? false)) {
      throw new LlmTimeoutError(`LLM 调用超时 (timeout ${ms / 1000}s)：已中止，且上游只返回了不完整结果`)
    }
    return result
  } catch (err) {
    if (userSignal?.aborted) throw err // 用户中止：保持原错误（不转超时、不重试）
    if (timedOut) throw new LlmTimeoutError(`LLM 调用超时 (timeout ${ms / 1000}s)`)
    throw err
  } finally {
    clearTimeout(timer)
    userSignal?.removeEventListener('abort', onUserAbort)
  }
}

/**
 * v0.32.1（缺陷 D35）：一次响应是否**不完整** —— 既无正文、又无思考正文、还无任何动作。
 *
 * 这是「流被截断 / 模型只吐了思考就断了」的可判别特征：调用已经返回，但里面
 * 没有任何可推进任务的东西。用于 `withLlmTimeout` 的 `isIncomplete` 判定，
 * 以及测试里的同口径断言（单一真源，避免两处各写一份）。
 *
 * 注意**刻意不看** `reasoningContent`：只有思考、没有正文与动作的回合对 ReAct
 * 而言是空转 —— 模型想了一堆但什么也没做，必须重试或失败，不能算完成。
 */
export function isIncompleteLlmResponse(r: {
  content?: string
  thought?: string
  actions?: unknown[]
  action?: unknown
}): boolean {
  if (r.content?.trim()) return false
  if (r.thought?.trim()) return false
  if (r.actions && r.actions.length > 0) return false
  if (r.action) return false
  return true
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
