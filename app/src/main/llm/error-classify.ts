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
 * LLM 调用超时错误。
 * message 含 "timeout" 子串（retryableError 按 timeout 匹配 → 可重试）。
 * v0.36.0：类定义移入本模块（error-classify 单一真源），llm-call.ts 再导出 ——
 * instanceof 判定全仓共享同一类对象。
 */
export class LlmTimeoutError extends Error {
  name = 'LlmTimeoutError'
}
