/* ============================================================
 * v0.27.0 R1 — 流式 adapter 单测（completeStream / complete 同源解析）
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/llm/__tests__/llm-stream.test.ts
 *
 * Mock 策略：替换私有 client（(adapter as any).client），不触网。
 * - OpenAI：create 返回 async generator，逐个 yield ChatCompletionChunk 形状的对象；
 * - Anthropic：messages.stream 返回链式 .on() 的假流，finalMessage() 先回放
 *   排队的 text/streamEvent 再返回 Message 固件。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIAdapter } from '../openai.js'
import { AnthropicAdapter } from '../anthropic.js'
import type { LlmCompleteRequest, LlmStreamHandlers } from '../adapter.js'

/* ---------- 公共夹具 ---------- */

function makeReq(overrides: Partial<LlmCompleteRequest> = {}): LlmCompleteRequest {
  return { system: 'sys', messages: [{ role: 'user', content: '问题' }], ...overrides }
}

function collectHandlers(): LlmStreamHandlers & { texts: string[]; reasonings: string[] } {
  const texts: string[] = []
  const reasonings: string[] = []
  return {
    texts,
    reasonings,
    onText: (d) => texts.push(d),
    onReasoning: (d) => reasonings.push(d),
  }
}

function asyncGen(items: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const it of items) yield it
  })()
}

type CreateSpy = { calls: Array<Record<string, unknown>> }

function installOpenAIClient(
  adapter: OpenAIAdapter,
  respond: (params: Record<string, unknown>) => Promise<AsyncIterable<unknown>>,
): CreateSpy {
  const spy: CreateSpy = { calls: [] }
  ;(adapter as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          spy.calls.push(params)
          return respond(params)
        },
      },
    },
  }
  return spy
}

/** Anthropic 假流：on 可链式注册；finalMessage 时按脚本回放事件再返回固件 */
function installAnthropicClient(
  adapter: AnthropicAdapter,
  message: unknown,
  script: Array<{ event: string; arg: unknown }>,
): void {
  const ons: Array<{ event: string; cb: (arg: unknown) => void }> = []
  const fakeStream = {
    on(event: string, cb: (arg: never) => void) {
      ons.push({ event, cb: cb as (arg: unknown) => void })
      return fakeStream
    },
    async finalMessage() {
      for (const { event, cb } of ons) {
        for (const s of script) if (s.event === event) cb(s.arg)
      }
      return message
    },
  }
  ;(adapter as unknown as { client: unknown }).client = {
    messages: { stream: () => fakeStream },
  }
}

/* ---------- OpenAI completeStream ---------- */

test('openai completeStream: 文本增量聚合 + 尾部 usage-only chunk（choices 空）', async () => {
  const adapter = new OpenAIAdapter({ apiKey: 'test', defaultModel: 'm1' })
  installOpenAIClient(adapter, async () =>
    asyncGen([
      { choices: [{ delta: { content: '你好' }, finish_reason: null }] },
      { choices: [{ delta: { content: '，世界' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
    ]),
  )
  const h = collectHandlers()
  const res = await adapter.completeStream(makeReq(), h)

  assert.deepEqual(h.texts, ['你好', '，世界'])
  assert.equal(res.content, '你好，世界')
  assert.equal(res.thought, '你好，世界')
  assert.equal(res.say, undefined)
  assert.equal(res.action, null)
  assert.equal(res.tokensIn, 120)
  assert.equal(res.tokensOut, 30)
  assert.equal(res.finishReason, 'stop')
  assert.equal(res.reasoningContent, undefined)
})

test('openai completeStream: SAY 标记跨块剥离 + tool_call 分片按 index 聚合', async () => {
  const adapter = new OpenAIAdapter({ apiKey: 'test', defaultModel: 'm1' })
  installOpenAIClient(adapter, async () =>
    asyncGen([
      { choices: [{ delta: { content: '分析中\n<<<SAY' }, finish_reason: null }] },
      { choices: [{ delta: { content: '>>>\n正在读取文件\n<<<END' }, finish_reason: null }] },
      { choices: [{ delta: { content: '>>>\n完毕' }, finish_reason: null }] },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]),
  )
  const h = collectHandlers()
  const res = await adapter.completeStream(makeReq(), h)

  // SAY 剥离：say 提取、thought 不含标记块
  assert.equal(res.say, '正在读取文件')
  assert.equal(res.thought, '分析中\n\n完毕')
  // 分片 tool_call 聚合
  assert.deepEqual(res.action, { tool: 'read', args: { path: 'a.ts' } })
  assert.deepEqual(res.actions, [{ tool: 'read', args: { path: 'a.ts' } }])
  assert.deepEqual(res.toolCallIds, ['call_1'])
  assert.equal(res.toolCallId, 'call_1')
  assert.equal(res.finishReason, 'tool_calls')
})

test('openai completeStream: reasoning_content 增量回调 + reasoningContent 字段', async () => {
  const adapter = new OpenAIAdapter({ apiKey: 'test', defaultModel: 'deepseek-r' })
  installOpenAIClient(adapter, async () =>
    asyncGen([
      { choices: [{ delta: { reasoning_content: '先想' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: '后答' }, finish_reason: null }] },
      { choices: [{ delta: { content: '答案' }, finish_reason: 'stop' }] },
    ]),
  )
  const h = collectHandlers()
  const res = await adapter.completeStream(makeReq(), h)

  assert.deepEqual(h.reasonings, ['先想', '后答'])
  assert.equal(res.reasoningContent, '先想后答')
  assert.equal(res.content, '答案')
})

test('openai completeStream: 并行双 tool_calls 按 index 交错聚合', async () => {
  const adapter = new OpenAIAdapter({ apiKey: 'test', defaultModel: 'm1' })
  installOpenAIClient(adapter, async () =>
    asyncGen([
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'read', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 1, id: 'c1', type: 'function', function: { name: 'write', arguments: '' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] }, finish_reason: null }],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"b","content":"x"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]),
  )
  const res = await adapter.completeStream(makeReq(), collectHandlers())

  assert.deepEqual(res.actions, [
    { tool: 'read', args: { path: 'a' } },
    { tool: 'write', args: { path: 'b', content: 'x' } },
  ])
  assert.deepEqual(res.toolCallIds, ['c0', 'c1'])
  assert.equal(res.action?.tool, 'read')
})

test('openai completeStream: 端点不认 stream_options（报错含关键词）→ 去参重试成功且 tokens=0', async () => {
  const adapter = new OpenAIAdapter({ apiKey: 'test', defaultModel: 'legacy' })
  const spy = installOpenAIClient(adapter, async (params) => {
    if (params.stream_options) throw new Error("Unrecognized request argument supplied: stream_options")
    return asyncGen([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
  })

  const res = await adapter.completeStream(makeReq(), collectHandlers())

  assert.equal(spy.calls.length, 2)
  assert.ok(spy.calls[0].stream_options)
  assert.equal(spy.calls[1].stream_options, undefined)
  assert.equal(res.content, 'ok')
  assert.equal(res.tokensIn, 0)
  assert.equal(res.tokensOut, 0)
})

/* ---------- OpenAI complete（重构保全：与 completeStream 共用解析单源） ---------- */

test('openai complete: 行为保全——say 提取 + tool_calls 解析 + 缓存统计', async () => {
  const adapter = new OpenAIAdapter({ apiKey: 'test', defaultModel: 'm1' })
  ;(adapter as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: {
                content: '读完了\n<<<SAY>>>\n已读取 main.ts\n<<<END>>>',
                tool_calls: [
                  { id: 't9', type: 'function', function: { name: 'read', arguments: '{"path":"z.ts"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 50, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 },
        }),
      },
    },
  }
  const res = await adapter.complete(makeReq())

  assert.equal(res.say, '已读取 main.ts')
  assert.equal(res.thought, '读完了')
  assert.deepEqual(res.action, { tool: 'read', args: { path: 'z.ts' } })
  assert.deepEqual(res.toolCallIds, ['t9'])
  assert.deepEqual(res.cache, { hitTokens: 150, missTokens: 50 })
  assert.equal(res.tokensIn, 200)
  assert.equal(res.tokensOut, 50)
  assert.equal(res.finishReason, 'tool_calls')
})

/* ---------- Anthropic completeStream ---------- */

test('anthropic completeStream: text/thinking 增量回调 + finalMessage 聚合解析', async () => {
  const adapter = new AnthropicAdapter({ apiKey: 'test', defaultModel: 'claude-x' })
  installAnthropicClient(
    adapter,
    {
      content: [{ type: 'text', text: '你好世界' }],
      usage: { input_tokens: 11, output_tokens: 7 },
      stop_reason: 'end_turn',
    },
    [
      { event: 'text', arg: '你好' },
      { event: 'text', arg: '世界' },
      { event: 'streamEvent', arg: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } } },
      { event: 'streamEvent', arg: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '考' } } },
      { event: 'streamEvent', arg: { type: 'content_block_start', index: 0 } },
    ],
  )
  const h = collectHandlers()
  const res = await adapter.completeStream(makeReq(), h)

  assert.deepEqual(h.texts, ['你好', '世界'])
  assert.deepEqual(h.reasonings, ['想', '考'])
  assert.equal(res.content, '你好世界')
  assert.equal(res.thought, '你好世界')
  assert.equal(res.tokensIn, 11)
  assert.equal(res.tokensOut, 7)
  assert.equal(res.finishReason, 'stop')
  assert.equal(res.action, null)
})

test('anthropic completeStream: tool_use block 解析（thinking block 不污染正文）', async () => {
  const adapter = new AnthropicAdapter({ apiKey: 'test', defaultModel: 'claude-x' })
  installAnthropicClient(
    adapter,
    {
      content: [
        { type: 'thinking', thinking: '内部推理' },
        { type: 'text', text: '需要写入文件' },
        { type: 'tool_use', id: 'tu_1', name: 'write', input: { path: 'x.ts', content: 'hi' } },
      ],
      usage: { input_tokens: 20, output_tokens: 40 },
      stop_reason: 'tool_use',
    },
    [],
  )
  const res = await adapter.completeStream(makeReq(), collectHandlers())

  assert.equal(res.finishReason, 'tool_calls')
  assert.deepEqual(res.action, { tool: 'write', args: { path: 'x.ts', content: 'hi' } })
  assert.deepEqual(res.actions, [{ tool: 'write', args: { path: 'x.ts', content: 'hi' } }])
  assert.deepEqual(res.toolCallIds, ['tu_1'])
  assert.equal(res.toolCallId, 'tu_1')
  // thinking block 既不进 content 也不进 thought（与非流式同源解析）
  assert.equal(res.content, '需要写入文件')
  assert.equal(res.thought, '需要写入文件')
})

/* ---------- Anthropic complete（重构保全） ---------- */

test('anthropic complete: 行为保全——非数组 content 防御 + usage 映射', async () => {
  const adapter = new AnthropicAdapter({ apiKey: 'test', defaultModel: 'claude-x' })
  ;(adapter as unknown as { client: unknown }).client = {
    messages: {
      create: async () => ({
        content: '裸字符串响应',
        usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 5 },
        stop_reason: 'end_turn',
      }),
    },
  }
  const res = await adapter.complete(makeReq())

  assert.equal(res.content, '裸字符串响应')
  assert.equal(res.action, null)
  assert.deepEqual(res.cache, { hitTokens: 5, missTokens: 3, writeTokens: undefined })
  assert.equal(res.tokensIn, 8)
  assert.equal(res.tokensOut, 3)
  assert.equal(res.finishReason, 'stop')
})
