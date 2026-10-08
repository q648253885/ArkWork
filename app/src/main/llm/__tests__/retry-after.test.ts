/* ============================================================
 * ArkWork — 429 Retry-After 尊重通道用例（v0.48.0 · TC-RA，W3）
 *
 * 三层防线的第二层：服务端（或网关）在 429 里给了建议等待时长时，
 * 客户端按它等待，而不是傻套固定退避。链路：
 *   extractRetryAfterMs（error-classify.ts）→ retryCore.delayFor（retry-core.ts）
 *   → callLlmWithRetry（agent/llm-call.ts）。
 *
 * 纪律：无 Retry-After 线索 → delayFor 返回 0 → 回落既有固定退避，零变化。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs retry-after.test
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { extractRetryAfterMs } from '../error-classify.js'
import { retryCore } from '../../fault-tolerance/retry-core.js'
import { callLlmWithRetry } from '../../agent/llm-call.js'
import type { LlmCompleteResponse } from '../adapter.js'
/** 注释剥离器唯一真源（纪律㉒） */
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const CALL = stripComments(read('../../agent/llm-call.ts'))

const OK = { content: 'ok', thought: '', action: null, tokensIn: 0, tokensOut: 0, finishReason: 'stop' } as unknown as LlmCompleteResponse

/** 构造带 headers 的错误（OpenAI / Anthropic SDK 的 APIError 形态） */
function errWithHeaders(message: string, headers: Record<string, string>): Error {
  const e = new Error(message)
  ;(e as Error & { headers: Record<string, string> }).headers = headers
  return e
}

/* ---------------- 一、extractRetryAfterMs 真值表 ---------------- */

test('TC-RA-001 ★ headers 三级解析真值表：retry-after-ms 优先 → 秒 → HTTP-date；消息文本兜底', () => {
  // ① retry-after-ms（毫秒，优先）
  assert.equal(extractRetryAfterMs(errWithHeaders('429', { 'retry-after-ms': '250' })), 250)
  // ② retry-after（秒）
  assert.equal(extractRetryAfterMs(errWithHeaders('429', { 'Retry-After': '3' })), 3000, '头名大小写不敏感，秒→ms')
  // 优先级：ms 头优先于秒头
  assert.equal(
    extractRetryAfterMs(errWithHeaders('429', { 'retry-after': '5', 'retry-after-ms': '250' })),
    250,
    'retry-after-ms 粒度最细，必须优先',
  )
  // ②' retry-after（HTTP-date，未来时刻）
  const future = new Date(Date.now() + 10_000).toUTCString()
  const fromDate = extractRetryAfterMs(errWithHeaders('429', { 'retry-after': future })) ?? -1
  assert.ok(fromDate > 5_000 && fromDate <= 60_000, `HTTP-date 应解析为剩余等待 ≈10s（实际 ${fromDate}ms）`)
  // 过去的 HTTP-date → 0（立即重试，回落语义交给 delayFor 的 >0 判定）
  const past = new Date(Date.now() - 10_000).toUTCString()
  assert.equal(extractRetryAfterMs(errWithHeaders('429', { 'retry-after': past })), 0, '过去的日期 → 0')
  // ③ 消息文本兜底（裸 fetch 通道无 headers）
  assert.equal(extractRetryAfterMs(new Error('rate limit exceeded, retry after 2s')), 2000)
  assert.equal(extractRetryAfterMs(new Error('too many requests, retry after 500ms')), 500)
  assert.equal(extractRetryAfterMs(new Error('429, retry after 1 minute')), 60_000, '分钟单位换算')
  // —— 无线索 → null ——
  assert.equal(extractRetryAfterMs(new Error('rate limit exceeded')), null, '无等待线索 → null')
  assert.equal(extractRetryAfterMs(errWithHeaders('boom', {})), null, '空 headers → 走消息路径 → null')
  assert.equal(extractRetryAfterMs(undefined), null, '非 Error 形态 → null')
  assert.equal(extractRetryAfterMs(errWithHeaders('x', { 'retry-after-ms': 'abc' })), null, '非法数值 → null（不臆测）')
})

test('TC-RA-002 ★ 封顶 60s：服务端异常大值不得卡死任务', () => {
  assert.equal(extractRetryAfterMs(errWithHeaders('429', { 'retry-after-ms': '999999' })), 60_000)
  assert.equal(extractRetryAfterMs(errWithHeaders('429', { 'Retry-After': '3600' })), 60_000, '小时级 HTTP-date 封顶 60s')
})

/* ---------------- 二、retryCore.delayFor 注入 ---------------- */

test('TC-RA-003 ★ delayFor 注入：服务端建议等待优先于固定退避', async () => {
  let attempts = 0
  const seen: number[] = []
  const t0 = Date.now()
  const res = await retryCore(
    async () => {
      attempts += 1
      if (attempts === 1) throw errWithHeaders('429', { 'retry-after-ms': '40' })
      return 'ok'
    },
    { backoffMs: [1500], delayFor: (_attempt, err) => extractRetryAfterMs(err) ?? 0, onRetry: (_attempt, delayMs) => seen.push(delayMs) },
  )
  assert.equal(res, 'ok')
  assert.equal(attempts, 2)
  assert.deepEqual(seen, [40], 'onRetry 上报的等待必须是 Retry-After 值而非 backoff')
  assert.ok(Date.now() - t0 < 1000, `总耗时应 ≈40ms 而非 1500ms（实际 ${Date.now() - t0}ms）`)
})

test('TC-RA-004 ★ delayFor 未提供 / 返回 0 → 回落固定退避（零变化契约）', async () => {
  const seen: number[] = []
  let attempts = 0
  await retryCore(
    async () => {
      attempts += 1
      if (attempts === 1) throw errWithHeaders('429', {}) // 无线索
      return 'ok'
    },
    { backoffMs: [60], onRetry: (_a, d) => seen.push(d) },
  )
  assert.deepEqual(seen, [60], '无线索 → 回落 backoffMs（既有行为）')

  // 显式传 delayFor 但错误无线索 → extractRetryAfterMs 为 null → 0 → 回落
  const seen2: number[] = []
  let n = 0
  await retryCore(
    async () => {
      n += 1
      if (n === 1) throw new Error('boom')
      return 'ok'
    },
    { backoffMs: [45], delayFor: (_a, err) => extractRetryAfterMs(err) ?? 0, onRetry: (_a, d) => seen2.push(d) },
  )
  assert.deepEqual(seen2, [45], 'delayFor 返回 0 必须回落固定退避')
})

/* ---------------- 三、callLlmWithRetry 全链 ---------------- */

test('TC-RA-005 ★ 全链：callLlmWithRetry 遇 Retry-After 按其等待，而非注入的长退避', async () => {
  let n = 0
  const t0 = Date.now()
  const resp = await callLlmWithRetry(
    async () => {
      n += 1
      if (n === 1) throw errWithHeaders('429 too many requests', { 'retry-after-ms': '50' })
      return OK
    },
    undefined,
    [2500], // 注入长退避：若 delayFor 未生效，本次调用将耗 ≥2500ms
  )
  assert.equal(n, 2)
  assert.equal(resp, OK)
  assert.ok(Date.now() - t0 < 1500, `必须按 retry-after(50ms) 等待而非 backoff(2500ms)（实际 ${Date.now() - t0}ms）`)
})

test('TC-RA-006 ★ llm-call.ts 接线契约：delayFor 通道 + extractRetryAfterMs 导入（有写必须有读）', () => {
  assert.match(
    CALL,
    /import \{ retryableError, isContextOverflowError, LlmTimeoutError, extractRetryAfterMs \} from '\.\.\/llm\/error-classify\.js'/,
    'extractRetryAfterMs 导入存在',
  )
  assert.match(CALL, /delayFor: \(_, err\) => extractRetryAfterMs\(err\) \?\? 0/, 'retryCore 必须接 delayFor 通道')
})
