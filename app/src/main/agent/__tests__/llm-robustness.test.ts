/* ============================================================
 * agent-context-compaction-robustness — llm-call.ts 纯工具模块单测
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/llm-robustness.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  retryableError,
  callLlmWithRetry,
  withLlmTimeout,
  LlmTimeoutError,
  RETRY_BACKOFF_MS,
  isContextOverflowError,
} from '../llm-call.js'
import type { LlmCompleteResponse } from '../../llm/adapter.js'

function okResponse(over: Partial<LlmCompleteResponse> = {}): LlmCompleteResponse {
  return {
    content: 'ok',
    thought: 'ok',
    action: null,
    tokensIn: 0,
    tokensOut: 0,
    finishReason: 'stop',
    ...over,
  }
}

/* ---------- retryableError ---------- */

test('retryableError: LlmTimeoutError message 含 timeout → 可重试', () => {
  assert.equal(retryableError(new LlmTimeoutError('LLM 调用超时 (timeout 120s)')), true)
})

test('retryableError: 用户中止（aborted）不再被误判为可重试', () => {
  assert.equal(retryableError(new Error('The user aborted a request.')), false)
})

test('retryableError: 其余 retryable 关键词仍匹配', () => {
  assert.equal(retryableError(new Error('rate limit exceeded')), true)
  assert.equal(retryableError(new Error('429 Too Many Requests')), true)
  assert.equal(retryableError(new Error('request timeout exceeded')), true)
  assert.equal(retryableError(new Error('network error')), true)
  assert.equal(retryableError(new Error('fetch failed')), true)
  assert.equal(retryableError(new Error('getaddrinfo ENOTFOUND api.openai.com')), true)
  assert.equal(retryableError(new Error('ETIMEDOUT')), true)
  assert.equal(retryableError(new Error('finish_reason: length')), true)
  assert.equal(retryableError(new Error('empty response from model')), true)
})

test('retryableError: 非 retryable 错误（工具缺失/解析错误）不可重试', () => {
  assert.equal(retryableError(new Error('Tool not found: file-reader')), false)
  assert.equal(retryableError(new Error('JSON parse failed')), false)
})

/* ---------- isContextOverflowError (Layer 3 Reactive Fallback) ---------- */

test('isContextOverflowError: context 超限类错误 → true', () => {
  assert.equal(isContextOverflowError(new Error('prompt is too long: maximum context length is 200000')), true)
  assert.equal(isContextOverflowError(new Error('Request failed: 400 invalid_request_error, context_length_exceeded')), true)
  assert.equal(isContextOverflowError(new Error('This model maximum context length is 128000 tokens')), true)
  assert.equal(isContextOverflowError(new Error('context window exceeded, reduce your prompt')), true)
  assert.equal(isContextOverflowError(new Error('maximum context exceeded token limit')), true)
  assert.equal(isContextOverflowError(new Error('too many tokens for this model')), true)
})

test('isContextOverflowError: LlmTimeoutError → true（thinking 模型膨胀常以超时报错）', () => {
  assert.equal(isContextOverflowError(new LlmTimeoutError('LLM 调用超时 (timeout 120s)')), true)
})

test('isContextOverflowError: 普通错误 → false', () => {
  assert.equal(isContextOverflowError(new Error('Tool not found: file-reader')), false)
  assert.equal(isContextOverflowError(new Error('rate limit exceeded')), false)
  assert.equal(isContextOverflowError(new Error('JSON parse failed')), false)
  assert.equal(isContextOverflowError('not an error object'), false)
})

/* ---------- callLlmWithRetry ---------- */

test('callLlmWithRetry: 调用前 signal 已中止 → 立即抛中止错误，fn 不执行', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  let calls = 0
  await assert.rejects(
    callLlmWithRetry(async () => {
      calls++
      return okResponse()
    }, ctrl.signal),
    /The user aborted a request\./,
  )
  assert.equal(calls, 0)
})

test('callLlmWithRetry: 重试等待期间用户中止 → fn 仅调用 1 次（不重试）', async () => {
  const ctrl = new AbortController()
  let calls = 0
  const p = callLlmWithRetry(async () => {
    calls++
    throw new Error('rate limit exceeded')
  }, ctrl.signal, [100, 100])
  await new Promise((r) => setTimeout(r, 0)) // 让第一次调用进入 backoff 等待
  ctrl.abort()
  await assert.rejects(p, /rate limit/)
  assert.equal(calls, 1)
})

test('callLlmWithRetry: 非 retryable 错误不重试（fn 仅调用 1 次）', async () => {
  let calls = 0
  await assert.rejects(
    callLlmWithRetry(async () => {
      calls++
      throw new Error('Tool not found: xyz')
    }, undefined, [1]),
    /Tool not found/,
  )
  assert.equal(calls, 1)
})

test('callLlmWithRetry: retryable 错误触发重试（backoff 注入加速，耗尽重试次数后成功）', async () => {
  const backoff = [1, 1]
  let calls = 0
  const resp = await callLlmWithRetry(async () => {
    calls++
    if (calls <= backoff.length) throw new Error('429 rate limit')
    return okResponse()
  }, undefined, backoff)
  assert.equal(resp.content, 'ok')
  assert.equal(calls, backoff.length + 1)
})

test('callLlmWithRetry: retryable 错误耗尽重试次数后仍失败 → 上抛最后错误', async () => {
  const backoff = [1, 1]
  let calls = 0
  await assert.rejects(
    callLlmWithRetry(async () => {
      calls++
      throw new Error('fetch failed')
    }, undefined, backoff),
    /fetch failed/,
  )
  assert.equal(calls, backoff.length + 1)
})

test('callLlmWithRetry: 不传 backoffMs 时默认使用 RETRY_BACKOFF_MS', async () => {
  assert.deepEqual(RETRY_BACKOFF_MS, [500, 2000])
  let calls = 0
  const resp = await callLlmWithRetry(async () => {
    calls++
    if (calls === 1) throw new Error('rate limit')
    return okResponse()
  })
  assert.equal(resp.content, 'ok')
  assert.equal(calls, 2)
})

/* ---------- withLlmTimeout ---------- */

test('withLlmTimeout: fn 未完成且响应 abort → ms 到期抛 LlmTimeoutError（message 含 timeout）', async () => {
  const err = await withLlmTimeout<string>(
    (sig) =>
      new Promise<string>((_, reject) => {
        // 模拟 SDK：监听 signal，abort 时抛错（openai/anthropic SDK 行为）
        sig.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    200,
  ).then(
    () => null,
    (e) => e,
  )
  assert.ok(err instanceof LlmTimeoutError)
  assert.match((err as Error).message, /timeout/)
})

test('withLlmTimeout: userSignal 已中止 → fn 立即抛原中止错误（不转 LlmTimeoutError）', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  let called = false
  await assert.rejects(
    withLlmTimeout(
      (sig) => {
        called = true
        if (sig.aborted) throw new Error('The user aborted a request.')
        return Promise.resolve('x')
      },
      1000,
      ctrl.signal,
    ),
    /The user aborted a request\./,
  )
  assert.equal(called, true)
})

test('withLlmTimeout: 运行中 userSignal abort → 原错误透出（不转超时错误）', async () => {
  const ctrl = new AbortController()
  const p = withLlmTimeout(
    (sig) =>
      new Promise<string>((_, reject) => {
        sig.addEventListener('abort', () => reject(new Error('The user aborted a request.')))
      }),
    5000,
    ctrl.signal,
  )
  ctrl.abort()
  await assert.rejects(p, /The user aborted a request\./)
})

test('withLlmTimeout: 正常完成 → 返回值透出，不触发超时', async () => {
  const result = await withLlmTimeout(async (sig) => {
    assert.equal(sig.aborted, false)
    return 'ok'
  }, 1000)
  assert.equal(result, 'ok')
})
