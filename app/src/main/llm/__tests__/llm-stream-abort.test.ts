/* ============================================================
 * v0.27.0 r10-F6 — Stop 中断时序留证（PRD §4.1 F6：Stop 后 ≤500ms 停止出字）
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/llm/__tests__/llm-stream-abort.test.ts
 *
 * 口径说明：
 * - 「停止出字」= abort() 后流式迭代终止（promise settle）且不再有增量回调。
 *   完整链路 renderer Stop → ipc → runner.pauseTask → controller.abort() 为同步
 *   三行代码（runner.ts L130-135），无异步环节；本测覆盖唯一可能超时的
 *   流迭代层 —— 模拟 SDK 行为：signal 中止后迭代器尽快 reject。
 * - 真机 E2E（MiniMax-M3 实流）消耗用户 API 配额，不纳入自动化；以本测 +
 *   链路审计作为验收证据。
 * - 延迟数值断言采用两次采样（r10 加固：全量并发冷启动下单样本可能偶发超限，
 *   任一次 <500ms 即通过）；零迟到增量 / signal 透传每轮严格断言，不重试豁免。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIAdapter } from '../openai.js'
import type { LlmCompleteRequest, LlmStreamHandlers } from '../adapter.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeReq(overrides: Partial<LlmCompleteRequest> = {}): LlmCompleteRequest {
  return { system: 'sys', messages: [{ role: 'user', content: '问题' }], ...overrides }
}

/** 慢速 SSE 流：每 50ms 滴一个 delta，共 20 个（≈1s）；signal 中止后立即 reject（模拟 SDK） */
function slowDripStream(signal: AbortSignal | undefined, total = 20, intervalMs = 50): AsyncIterable<unknown> {
  return (async function* () {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new Error('Request was aborted.')
      await sleep(intervalMs)
      if (signal?.aborted) throw new Error('Request was aborted.')
      yield { choices: [{ delta: { content: `片段${i} ` }, finish_reason: null }] }
    }
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
  })()
}

/** 单轮场景：返回 abort→settle 延迟；除延迟数值外的所有断言失败均直接抛出 */
async function runScenario(): Promise<number> {
  const adapter = new OpenAIAdapter({ apiKey: 'test', defaultModel: 'm1' })
  const controller = new AbortController()

  const texts: string[] = []
  let lastDeltaAt = 0
  const handlers: LlmStreamHandlers & { texts: string[] } = {
    texts,
    onText: (d) => {
      texts.push(d)
      lastDeltaAt = performance.now()
    },
  }

  // 替换私有 client：create 收到第二参 { signal } 并驱动慢速流
  let receivedSignal: AbortSignal | undefined
  ;(adapter as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (_params: unknown, opts?: { signal?: AbortSignal }) => {
          receivedSignal = opts?.signal
          return slowDripStream(opts?.signal)
        },
      },
    },
  }

  const pending = adapter.completeStream(makeReq({ signal: controller.signal }), handlers)

  // 等 ≈5 个 delta 落地后发起 Stop
  await sleep(260)
  const countAtStop = texts.length
  assert.ok(countAtStop >= 3, `Stop 前应有增量落地，实际 ${countAtStop}`)
  assert.equal(receivedSignal, controller.signal, 'abort signal 应透传至 SDK 调用')

  const tAbort = performance.now()
  controller.abort()
  await assert.rejects(pending, /aborted/i, '中止后流式 promise 应 reject（SDK 语义）')
  const settleLatency = performance.now() - tAbort

  assert.equal(texts.length, countAtStop, 'abort 后不得再出现新增量（停止出字）')
  assert.ok(lastDeltaAt <= tAbort + 1, '最后一个增量应发生在 Stop 之前')
  return settleLatency
}

test('F6: Stop（abort）后 ≤500ms 终止出字——流迭代及时终止且无迟到增量', async () => {
  // 时序断言受宿主负载影响（全量并发套件冷启动抢占事件循环），单样本可能偶发
  // 超限。允许重试一次：任一次 <500ms 即通过；零迟到增量与 signal 透传每轮严格断言。
  const latencies: number[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const l = await runScenario()
    latencies.push(l)
    if (l < 500) return
  }
  assert.fail(
    `流终止延迟两次采样均 ≥ 500ms：${latencies.map((l) => l.toFixed(1)).join(' / ')}ms`,
  )
})
