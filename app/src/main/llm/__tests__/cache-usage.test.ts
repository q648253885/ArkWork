/* ============================================================
 * v0.23.1 — 缓存命中统计单测
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/llm/__tests__/cache-usage.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCacheUsage as extractOpenAI } from '../openai.js'
import { extractCacheUsage as extractAnthropic, withCacheBreakpoints } from '../anthropic.js'
import type { LlmCompleteRequest } from '../adapter.js'

/* ---------- OpenAI 兼容端点 usage 提取 ---------- */

type OpenAIUsage = Parameters<typeof extractOpenAI>[0]

test('openai extractCacheUsage: DeepSeek prompt_cache_hit_tokens/miss', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 200,
  } as unknown as OpenAIUsage
  assert.deepEqual(extractOpenAI(usage), { hitTokens: 800, missTokens: 200 })
})

test('openai extractCacheUsage: Moonshot 顶层 cached_tokens（v0.23.1 补）', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    cached_tokens: 700,
  } as unknown as OpenAIUsage
  assert.deepEqual(extractOpenAI(usage), { hitTokens: 700, missTokens: 300 })
})

test('openai extractCacheUsage: OpenAI/MiniMax/智谱 prompt_tokens_details.cached_tokens', () => {
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 900 },
  } as unknown as OpenAIUsage
  assert.deepEqual(extractOpenAI(usage), { hitTokens: 900, missTokens: 100 })
})

test('openai extractCacheUsage: 无缓存字段 → undefined（端点未报告）', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 50 } as unknown as OpenAIUsage
  assert.equal(extractOpenAI(usage), undefined)
  assert.equal(extractOpenAI(null), undefined)
})

/* ---------- Anthropic usage 提取 ---------- */

test('anthropic extractCacheUsage: cache_read/creation_input_tokens', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 800,
  } as Parameters<typeof extractAnthropic>[0]
  assert.deepEqual(extractAnthropic(usage), {
    hitTokens: 5000,
    missTokens: 0,
    writeTokens: 800,
  })
})

test('anthropic extractCacheUsage: 无字段 → undefined', () => {
  const usage = { input_tokens: 100, output_tokens: 20 } as Parameters<typeof extractAnthropic>[0]
  assert.equal(extractAnthropic(usage), undefined)
})

/* ---------- Anthropic cache_control 断点构造 ---------- */

function makeReq(overrides: Partial<LlmCompleteRequest> = {}): LlmCompleteRequest {
  return {
    system: 'system prompt',
    messages: [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '回答', toolCalls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: '工具结果', toolCallId: 't1' },
    ],
    tools: [
      { type: 'function', function: { name: 'read', description: 'd1', parameters: {} } },
      { type: 'function', function: { name: 'write', description: 'd2', parameters: {} } },
    ],
    ...overrides,
  }
}

test('withCacheBreakpoints: system 尾块 / 最后一个 tool / 最后一条消息均带 ephemeral 断点', () => {
  const { system, tools, messages } = withCacheBreakpoints(makeReq())

  // system → text block + cache_control
  assert.ok(Array.isArray(system))
  const sysBlock = (system as unknown as Array<Record<string, unknown>>)[0]
  assert.equal(sysBlock.type, 'text')
  assert.deepEqual(sysBlock.cache_control, { type: 'ephemeral' })

  // tools：只有最后一个带断点
  assert.equal(tools?.length, 2)
  assert.equal((tools![0] as unknown as Record<string, unknown>).cache_control, undefined)
  assert.deepEqual((tools![1] as unknown as Record<string, unknown>).cache_control, { type: 'ephemeral' })

  // 最后一条消息（tool_result user 消息）：最后一个 block 带断点
  const last = messages[messages.length - 1]
  assert.equal(last.role, 'user')
  const blocks = last.content as unknown as Array<Record<string, unknown>>
  assert.equal(blocks[0].type, 'tool_result')
  assert.deepEqual(blocks[blocks.length - 1].cache_control, { type: 'ephemeral' })

  // 非最后一条消息不带断点
  const first = messages[0]
  assert.ok(typeof first.content === 'string')
})

test('withCacheBreakpoints: string content 的最后一条消息自动转 block 数组并打断点', () => {
  const { messages } = withCacheBreakpoints(
    makeReq({ messages: [{ role: 'user', content: '纯文本' }], tools: undefined }),
  )
  assert.equal(messages.length, 1)
  const blocks = messages[0].content as unknown as Array<Record<string, unknown>>
  assert.equal(blocks[0].type, 'text')
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' })
})

test('withCacheBreakpoints: 无 system / 无 tools 时不产生断点也不报错', () => {
  const { system, tools, messages } = withCacheBreakpoints(
    makeReq({ system: '', tools: undefined, messages: [{ role: 'user', content: 'hi' }] }),
  )
  assert.equal(system, undefined)
  assert.equal(tools, undefined)
  assert.equal(messages.length, 1)
})
