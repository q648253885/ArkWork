/* ============================================================
 * ArkWork — LLM 错误分类单一真源（v0.36.0 F1.4，设计文档 §3.3）
 *
 * 此前 retryableError / isContextOverflowError 正则在 agent/llm-call.ts 与
 * fault-tolerance/classify.ts 各写一份、口径漂移。本模块收敛为唯一实现：
 * agent/llm-call.ts 再导出保持既有 import 路径不破坏。
 *
 * 纯 Node 模块（零依赖），可独立单测。
 * ============================================================ */

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
 * v0.48.0：从 429 / rate limit 错误中提取服务端建议的等待时长（毫秒）。
 *
 * 提取顺序（优先级从高到低）：
 *   ① `retry-after-ms` 头（毫秒，OpenAI / Anthropic SDK 的 APIError 均挂在 err.headers）
 *   ② `retry-after` 头（秒数或 HTTP-date 两种格式，HTTP 规范）
 *   ③ 错误消息文本（部分端点把 "retry after 5s" 写进 message）
 *
 * 一律封顶 60s：服务端给的等待若过长（如 HTTP-date 在几分钟后），
 * 客户端不该傻等 —— 超出部分交给 retryCore 退避兜底。
 * 无任何线索返回 null（调用方回落既有固定退避）。
 */
export function extractRetryAfterMs(err: unknown): number | null {
  const MAX_MS = 60_000
  // —— ①② 结构化 headers（OpenAI / Anthropic SDK APIError 均带）——
  const headers = (err as { headers?: Record<string, unknown> | null } | null)?.headers
  if (headers && typeof headers === 'object') {
    const header = (name: string): string | undefined => {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === name && v != null) return String(v).trim()
      }
      return undefined
    }
    // ① retry-after-ms（毫秒，优先 —— 粒度最细）
    const msRaw = header('retry-after-ms')
    if (msRaw) {
      const ms = Number(msRaw)
      if (Number.isFinite(ms) && ms > 0) return Math.min(Math.ceil(ms), MAX_MS)
    }
    // ② retry-after：先按秒数解析，失败再按 HTTP-date
    const raRaw = header('retry-after')
    if (raRaw) {
      const sec = Number(raRaw)
      if (Number.isFinite(sec) && sec > 0) return Math.min(Math.ceil(sec * 1000), MAX_MS)
      const at = Date.parse(raRaw)
      if (!Number.isNaN(at)) return Math.min(Math.max(0, at - Date.now()), MAX_MS)
    }
  }
  // —— ③ 错误消息文本（如 "rate limit exceeded, retry after 5s"）——
  const msg = err instanceof Error ? err.message : String(err)
  const m = /retry[ -_]?after[ :=]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)?/i.exec(msg)
  if (m) {
    const v = Number(m[1])
    const unit = (m[2] ?? 's').toLowerCase()
    const ms = unit.startsWith('ms') || unit.startsWith('milli') ? v : unit.startsWith('m') ? v * 60_000 : v * 1000
    if (Number.isFinite(ms) && ms > 0) return Math.min(Math.ceil(ms), MAX_MS)
  }
  return null
}

/**
 * LLM 调用超时错误。
 * message 含 "timeout" 子串（retryableError 按 timeout 匹配 → 可重试）。
 * v0.36.0：类定义移入本模块（error-classify 单一真源），llm-call.ts 再导出 ——
 * instanceof 判定全仓共享同一类对象。
 */
export class LlmTimeoutError extends Error {
  name = 'LlmTimeoutError'
}
