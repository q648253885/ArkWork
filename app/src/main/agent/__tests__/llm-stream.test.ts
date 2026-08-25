/* ============================================================
 * v0.27.0 R1 — llm-stream.ts 单元测试
 * 覆盖：createTextDeltaPump（首包立即 / 窗口攒批 / 稀疏短窗口 /
 *       flush / accumulated / sender 抛错静默）+
 *       completeWithStream（无流式回退 / unsupported 降级 /
 *       真错误上抛 / handlers 透传）
 * 纪律：纯函数级密闭测试——不 import electron/window，send 注入收集器。
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeWithStream,
  createTextDeltaPump,
} from '../llm-stream.js'
import type {
  LlmAdapter,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmStreamHandlers,
} from '../../llm/adapter.js'
import type { TaskTextDeltaPayload } from '@shared/types/ipc'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeResponse(overrides: Partial<LlmCompleteResponse> = {}): LlmCompleteResponse {
  return {
    content: 'C',
    thought: '',
    action: null,
    tokensIn: 1,
    tokensOut: 1,
    finishReason: 'stop',
    ...overrides,
  }
}

interface FakeAdapter {
  adapter: LlmAdapter
  calls: string[]
}

/** 构造可注入行为的假 adapter；withStream=false 时彻底没有 completeStream 方法 */
function makeAdapter(opts: {
  withStream?: boolean
  streamImpl?: (req: LlmCompleteRequest, h: LlmStreamHandlers) => Promise<LlmCompleteResponse>
  completeImpl?: (req: LlmCompleteRequest) => Promise<LlmCompleteResponse>
}): FakeAdapter {
  const calls: string[] = []
  const adapter: Record<string, unknown> = {
    name: 'fake',
    provider: 'openai',
    complete: async (req: LlmCompleteRequest) => {
      calls.push('complete')
      return opts.completeImpl
        ? opts.completeImpl(req)
        : fakeResponse()
    },
  }
  if (opts.withStream !== false) {
    adapter.completeStream = async (req: LlmCompleteRequest, h: LlmStreamHandlers) => {
      calls.push('stream')
      return opts.streamImpl
        ? opts.streamImpl(req, h)
        : fakeResponse()
    }
  }
  return { adapter: adapter as unknown as LlmAdapter, calls }
}

describe('createTextDeltaPump', () => {
  it('首包立即发出（seq=1，首字延迟优先）', () => {
    const sent: TaskTextDeltaPayload[] = []
    const pump = createTextDeltaPump('t1', 'turn', (p) => sent.push(p))
    pump.push('你')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].seq, 1)
    assert.equal(sent[0].taskId, 't1')
    assert.equal(sent[0].scope, 'turn')
    assert.equal(sent[0].text, '你')
  })

  it('空增量不触发发送', () => {
    const sent: TaskTextDeltaPayload[] = []
    const pump = createTextDeltaPump('t1', 'turn', (p) => sent.push(p))
    pump.push('')
    assert.equal(sent.length, 0)
  })

  it('到达密集 → 长窗口（80ms）攒批合并', async () => {
    const sent: TaskTextDeltaPayload[] = []
    const pump = createTextDeltaPump('t1', 'turn', (p) => sent.push(p))
    pump.push('a') // 立即
    await sleep(10)
    pump.push('b')
    pump.push('c')
    // 定时器最早也在 ~90ms（10ms gap + 80ms 窗口）后触发，此刻必然未发
    assert.equal(sent.length, 1)
    await sleep(150)
    assert.equal(sent.length, 2)
    assert.deepEqual([sent[1].seq, sent[1].text], [2, 'bc'])
  })

  it('稀疏到达 → 短窗口（40ms）快发', async () => {
    const sent: TaskTextDeltaPayload[] = []
    const pump = createTextDeltaPump('t1', 'turn', (p) => sent.push(p))
    pump.push('a')
    await sleep(200) // 拉开间隔 → gap ≥ 100ms
    pump.push('b')
    // 40ms 定时器不可能提前触发
    await sleep(5)
    assert.equal(sent.length, 1)
    await sleep(120)
    assert.equal(sent.length, 2)
    assert.equal(sent[1].text, 'b')
  })

  it('flush() 立即清空 pending 并发送', async () => {
    const sent: TaskTextDeltaPayload[] = []
    const pump = createTextDeltaPump('t1', 'chat', (p) => sent.push(p))
    pump.push('x')
    await sleep(10)
    pump.push('y')
    pump.flush()
    assert.equal(sent.length, 2)
    assert.equal(sent[1].text, 'y')
    assert.equal(sent[1].scope, 'chat')
  })

  it('accumulated 含未 flush 的 pending（中断部分落盘依据）', () => {
    const sent: TaskTextDeltaPayload[] = []
    const pump = createTextDeltaPump('t1', 'turn', (p) => sent.push(p))
    pump.push('先想')
    pump.push('后答')
    assert.equal(pump.accumulated, '先想后答')
    assert.ok(sent.length >= 1)
  })

  it('sender 抛错静默吞掉，不阻断 push/flush', () => {
    let boom = false
    const pump = createTextDeltaPump('t1', 'turn', () => {
      boom = true
      throw new Error('renderer gone')
    })
    assert.doesNotThrow(() => pump.push('a'))
    assert.ok(boom)
    assert.equal(pump.accumulated, 'a')
  })
})

describe('completeWithStream', () => {
  it('adapter 无 completeStream → 静默回退 complete', async () => {
    const { adapter, calls } = makeAdapter({ withStream: false })
    const res = await completeWithStream(adapter, {} as LlmCompleteRequest, { onText: () => {} })
    assert.equal(res.content, 'C')
    assert.deepEqual(calls, ['complete'])
  })

  it('completeStream 报「不支持」→ 降级 complete（R-stream-4）', async () => {
    const { adapter, calls } = makeAdapter({
      streamImpl: async () => {
        throw new Error('streaming is not implemented for this endpoint')
      },
    })
    const res = await completeWithStream(adapter, {} as LlmCompleteRequest, { onText: () => {} })
    assert.equal(res.content, 'C')
    assert.deepEqual(calls, ['stream', 'complete'])
  })

  it('completeStream 真错误（网络等）→ 向上抛出，不降级', async () => {
    const { adapter, calls } = makeAdapter({
      streamImpl: async () => {
        throw new Error('ECONNRESET')
      },
    })
    await assert.rejects(
      () => completeWithStream(adapter, {} as LlmCompleteRequest, { onText: () => {} }),
      /ECONNRESET/,
    )
    assert.deepEqual(calls, ['stream'])
  })

  it('成功路径透传 handlers 增量 + 返回聚合完整响应', async () => {
    const deltas: string[] = []
    const { adapter, calls } = makeAdapter({
      streamImpl: async (_req, h) => {
        h.onText('第一段')
        h.onText('第二段')
        return fakeResponse({ content: '第一段第二段' })
      },
    })
    const res = await completeWithStream(adapter, {} as LlmCompleteRequest, {
      onText: (d) => deltas.push(d),
    })
    assert.deepEqual(deltas, ['第一段', '第二段'])
    assert.equal(res.content, '第一段第二段')
    assert.deepEqual(calls, ['stream'])
  })
})
