/* ============================================================
 * ArkWork — 模型级调用限流器用例（v0.48.0 · TC-RL，对应设计文档 §二）
 *
 * 背景：公司内网端点多通道并发（主循环 / 规划通道 / PlanOps / 标题生成…）
 * 同时打到同一模型时收到 429 频率过快异常。三层防线之一：客户端主动节流。
 *
 * 覆盖：effectiveRateLimit 判据真值表、间隔闸、并发闸、FIFO 顺序、
 * maxConcurrent>1 不串行化（run() 修复的回归）、中止语义、wrap 直通与包装契约。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs rate-limit.test
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { effectiveRateLimit, ModelRateLimiter, wrapWithRateLimit } from '../rate-limit.js'
import type { LlmAdapter, LlmCompleteRequest, LlmCompleteResponse } from '../adapter.js'
import type { LlmModel } from '@shared/types/agent'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 最小合法 LlmCompleteResponse（限流测试不关心响应内容） */
const OK = { content: 'ok', thought: '', action: null, tokensIn: 0, tokensOut: 0, finishReason: 'stop' } as unknown as LlmCompleteResponse

/** 请求打点 mock adapter：记录 complete / completeStream 的真实派发时刻 */
function makeAdapter(withStream = false): { adapter: LlmAdapter; state: { calls: number; streams: number; times: number[] } } {
  const state = { calls: 0, streams: 0, times: [] as number[] }
  const adapter: LlmAdapter = {
    name: 'mock',
    provider: 'openai',
    async complete(_req: LlmCompleteRequest) {
      state.calls += 1
      state.times.push(Date.now())
      return OK
    },
    ...(withStream
      ? {
          async completeStream(_req: LlmCompleteRequest, _h: unknown) {
            state.streams += 1
            state.times.push(Date.now())
            return OK
          },
        }
      : {}),
  }
  return { adapter, state }
}

/* ---------------- 一、effectiveRateLimit 判据真值表 ---------------- */

test('TC-RL-001 ★ effectiveRateLimit 真值表：未配置/非法值 → null（直通）；有效值 → 归一化', () => {
  const m = (rateLimit?: LlmModel['rateLimit']): LlmModel => ({ id: 'm', name: 'm', kind: 'openai', enabled: true, rateLimit }) as LlmModel
  // —— 不限制（null = 直通）——
  assert.equal(effectiveRateLimit(m()), null, 'rateLimit 缺省 → 不限制')
  assert.equal(effectiveRateLimit(m(undefined)), null, 'undefined → 不限制')
  assert.equal(effectiveRateLimit(m({})), null, '空对象 → 不限制')
  assert.equal(effectiveRateLimit(m({ minIntervalMs: 0, maxConcurrent: 0 })), null, '全 0 → 不限制')
  assert.equal(effectiveRateLimit(m({ minIntervalMs: -5 })), null, '负数视为未配置')
  assert.equal(effectiveRateLimit(m({ maxConcurrent: Number.NaN })), null, 'NaN 视为未配置')
  // —— 有效（归一化：并发向下取整）——
  assert.deepEqual(effectiveRateLimit(m({ minIntervalMs: 1500 })), { minIntervalMs: 1500, maxConcurrent: 0 })
  assert.deepEqual(effectiveRateLimit(m({ maxConcurrent: 2.9 })), { minIntervalMs: 0, maxConcurrent: 2 }, '并发取整')
  assert.deepEqual(effectiveRateLimit(m({ minIntervalMs: 500, maxConcurrent: 3 })), { minIntervalMs: 500, maxConcurrent: 3 })
})

/* ---------------- 二、ModelRateLimiter 行为 ---------------- */

test('TC-RL-002 ★ 间隔闸：同模型两次请求的真实起步间隔 ≥ minIntervalMs', () => {
  const lim = new ModelRateLimiter({ minIntervalMs: 80, maxConcurrent: 4 })
  const times: number[] = []
  const t0 = Date.now()
  return (async () => {
    await lim.run(async () => { times.push(Date.now()) })
    await lim.run(async () => { times.push(Date.now()) })
    assert.ok(times[1] - times[0] >= 75, `第二次起步距第一次应 ≥75ms（实际 ${times[1] - times[0]}）`)
    assert.ok(Date.now() - t0 >= 80, '总耗时至少一个间隔')
  })()
})

test('TC-RL-003 ★ 并发闸：maxConcurrent=1 时在途峰值恒为 1', () => {
  const lim = new ModelRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 })
  let inFlight = 0
  let peak = 0
  const job = (): Promise<void> =>
    lim.run(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(30)
      inFlight -= 1
    })
  return Promise.all([job(), job(), job()]).then(() => {
    assert.equal(peak, 1, `在途峰值必须为 1（实际 ${peak}）`)
  })
})

test('TC-RL-004 ★ FIFO：并发 1 时三个请求按提交顺序入场', async () => {
  const lim = new ModelRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 })
  const order: number[] = []
  await Promise.all([1, 2, 3].map((i) => lim.run(async () => { order.push(i) })))
  assert.deepEqual(order, [1, 2, 3])
})

test('TC-RL-005 ★ maxConcurrent=2 不得被隐性串行化（run() 修复回归：链条只约束入场资格）', async () => {
  const lim = new ModelRateLimiter({ minIntervalMs: 0, maxConcurrent: 2 })
  let entered = 0
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const p1 = lim.run(async () => { entered += 1; await gate }) // 第一个卡住不放
  const p2 = lim.run(async () => { entered += 1 })             // 第二个应立刻入场
  await sleep(50)
  assert.equal(entered, 2, `并发 2 时第二个请求不得等第一个执行完（实际入场 ${entered}）`)
  release()
  await Promise.all([p1, p2])
})

test('TC-RL-006 ★ 中止语义：排队等待期间中止 → 立即拒绝，fn 不执行', async () => {
  // 预先已中止
  const pre = new AbortController()
  pre.abort()
  let ran = false
  await assert.rejects(
    new ModelRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 }).run(async () => { ran = true }, pre.signal),
  )
  assert.equal(ran, false, '已中止的调用不得进入执行')

  // 排队中中止：第一个占位，第二个排队后被中止
  const lim = new ModelRateLimiter({ minIntervalMs: 0, maxConcurrent: 1 })
  let release1!: () => void
  const gate = new Promise<void>((r) => { release1 = r })
  const p1 = lim.run(async () => { await gate })
  const ctl = new AbortController()
  const p2 = lim.run(async () => { ran = true }, ctl.signal)
  await sleep(20)
  ctl.abort()
  await assert.rejects(p2, undefined, '排队等待被中止 → 拒绝')
  release1()
  await p1
  assert.equal(ran, false, '被中止的请求不得执行 fn')
})

/* ---------------- 三、wrapWithRateLimit 包装契约 ---------------- */

test('TC-RL-007 ★ 未配置 → 原样返回同一引用（零包装零开销，既有模型逐字节不变）', () => {
  const { adapter } = makeAdapter(true)
  assert.equal(wrapWithRateLimit(adapter, { id: 'm1' }), adapter, '无 rateLimit → 同一对象')
  assert.equal(wrapWithRateLimit(adapter, { id: 'm1', rateLimit: {} }), adapter, '空配置 → 同一对象')
  assert.equal(wrapWithRateLimit(adapter, { id: 'm1', rateLimit: { minIntervalMs: 0, maxConcurrent: 0 } }), adapter, '全 0 → 同一对象')
})

test('TC-RL-008 ★ 配置后：complete/completeStream 均经限流，name/provider 直通，间隔闸真实生效', async () => {
  const { adapter, state } = makeAdapter(true)
  const logs: string[] = []
  const wrapped = wrapWithRateLimit(adapter, { id: 'qwen-27b', rateLimit: { minIntervalMs: 60, maxConcurrent: 2 } }, (msg) => logs.push(msg))
  assert.notEqual(wrapped, adapter, '配置后必须返回新包装对象')
  assert.equal(wrapped.name, 'mock', 'name 直通')
  assert.equal(wrapped.provider, 'openai', 'provider 直通')
  assert.match(logs.join('\n'), /rate limit enabled: model=qwen-27b/, '启用日志必须可诊断（纪律⑨）')
  // complete：两次顺序调用，底层派发间隔 ≥ minIntervalMs
  const req = {} as LlmCompleteRequest
  await wrapped.complete(req)
  await wrapped.complete(req)
  assert.equal(state.calls, 2)
  assert.ok(state.times[1] - state.times[0] >= 55, `底层两次派发间隔应 ≥55ms（实际 ${state.times[1] - state.times[0]}）`)
  // completeStream：同样经限流（第二个流请求被间隔闸延后）
  const t0 = Date.now()
  await wrapped.completeStream!(req, { onText: () => {} })
  assert.ok(state.times[state.times.length - 1] - t0 >= 50, '流式请求同样受间隔闸约束')
  assert.equal(state.streams, 1)
})
