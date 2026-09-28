/* ============================================================
 * ArkWork — 协议归一化层单测（v0.36.0 F1.5 · TC-LN-001..024）
 *
 * 覆盖 llm/normalize.ts 四块能力：
 *   ① normalizeFinishReason：openai / anthropic 精确词表 + ollama/vllm 宽松
 *      词表 + 缺省 interrupted（D35 语义锁定）；
 *   ② normalizeToolCalls：malformed 标记 + _raw 保留 + 缺失 id 合成；
 *   ③ normalizeResponse：聚合 + empty 判定（reason-phase 补试链路接管口径）；
 *   ④ greeting-loop 守卫（同前缀 × 连续 N 轮）+ endpoint unhealthy 计数。
 * 另锁 adapter 薄包装（openai/anthropic mapFinishReason）与单源 error-classify。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs llm-normalize
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFinishReason,
  normalizeToolCalls,
  normalizeResponse,
  createGreetingLoopGuard,
  markEndpointUnhealthy,
  getEndpointUnhealthyCount,
  resetEndpointUnhealthy,
  __resetUnhealthyForTest,
} from '../normalize.js'
import { mapFinishReason as openaiMapFinishReason } from '../openai.js'
import { mapFinishReason as anthropicMapFinishReason } from '../anthropic.js'
import { retryableError, isContextOverflowError, LlmTimeoutError } from '../error-classify.js'

/** RawProtocolResponse.toolCalls 的元素类型（测试别名） */
type RawToolCall = Parameters<typeof normalizeToolCalls>[0][number]

/* ---------------- ① finish_reason 映射表 ---------------- */

test('TC-LN-001 openai 词表：stop/tool_calls/length/content_filter 精确映射', () => {
  assert.equal(normalizeFinishReason('openai', 'stop'), 'stop')
  assert.equal(normalizeFinishReason('openai', 'tool_calls'), 'tool_calls')
  assert.equal(normalizeFinishReason('openai', 'function_call'), 'tool_calls') // legacy 形态
  assert.equal(normalizeFinishReason('openai', 'length'), 'length')
  assert.equal(normalizeFinishReason('openai', 'content_filter'), 'content_filter')
})

test('TC-LN-002 anthropic 词表：end_turn/stop_sequence→stop、tool_use→tool_calls、max_tokens→length', () => {
  assert.equal(normalizeFinishReason('anthropic', 'end_turn'), 'stop')
  assert.equal(normalizeFinishReason('anthropic', 'stop_sequence'), 'stop')
  assert.equal(normalizeFinishReason('anthropic', 'tool_use'), 'tool_calls')
  assert.equal(normalizeFinishReason('anthropic', 'max_tokens'), 'length')
})

test('TC-LN-003 缺终止帧/未知值 → interrupted（D35：缺终止帧 ≠ 正常说完）', () => {
  for (const kind of ['openai', 'anthropic', 'ollama', 'vllm'] as const) {
    assert.equal(normalizeFinishReason(kind, null), 'interrupted')
    assert.equal(normalizeFinishReason(kind, undefined), 'interrupted')
    assert.equal(normalizeFinishReason(kind, ''), 'interrupted')
    assert.equal(normalizeFinishReason(kind, 'abort'), 'interrupted') // vLLM 实测形态
    assert.equal(normalizeFinishReason(kind, 'weird_value'), 'interrupted')
  }
})

test('TC-LN-004 ollama/vllm 宽松：同时接受 openai 与 anthropic 词表', () => {
  assert.equal(normalizeFinishReason('ollama', 'stop'), 'stop')
  assert.equal(normalizeFinishReason('ollama', 'end_turn'), 'stop')
  assert.equal(normalizeFinishReason('vllm', 'tool_use'), 'tool_calls')
  assert.equal(normalizeFinishReason('vllm', 'max_tokens'), 'length')
})

test('TC-LN-005 adapter 薄包装与单源映射等价（openai / anthropic）', () => {
  assert.equal(openaiMapFinishReason('stop'), 'stop')
  assert.equal(openaiMapFinishReason(undefined), 'interrupted')
  assert.equal(anthropicMapFinishReason('end_turn'), 'stop')
  assert.equal(anthropicMapFinishReason('tool_use'), 'tool_calls')
  assert.equal(anthropicMapFinishReason(null), 'interrupted')
})

/* ---------------- ② tool_calls 容错 ---------------- */

test('TC-LN-010 合法调用原样解析（id/name/args 保留）', () => {
  const [call] = normalizeToolCalls([
    { id: 'call_abc', name: 'shell', arguments: '{"command":"ls"}' },
  ])
  assert.equal(call.id, 'call_abc')
  assert.equal(call.name, 'shell')
  assert.deepEqual(call.args, { command: 'ls' })
  assert.equal(call.malformed, false)
})

test('TC-LN-011 arguments 非法 JSON → malformed=true + args 降级 {_raw: 原文}', () => {
  const [call] = normalizeToolCalls([
    { id: 'x', name: 'write_file', arguments: '{"path": "a.txt", ' },
  ])
  assert.equal(call.malformed, true)
  assert.deepEqual(call.args, { _raw: '{"path": "a.txt", ' })
  assert.equal(call.rawArguments, '{"path": "a.txt", ')
})

test('TC-LN-012 arguments 空串 → 按 {} 解析（端点省略 arguments 的形态）', () => {
  const [call] = normalizeToolCalls([{ id: 'x', name: 'shell', arguments: '' }])
  assert.equal(call.malformed, false)
  assert.deepEqual(call.args, {})
})

test('TC-LN-013 arguments 为非对象 JSON（数组/标量）→ malformed + _raw', () => {
  const [arr] = normalizeToolCalls([{ id: 'x', name: 't', arguments: '[1,2]' }])
  assert.equal(arr.malformed, true)
  assert.deepEqual(arr.args, { _raw: '[1,2]' })
  const [num] = normalizeToolCalls([{ id: 'y', name: 't', arguments: '42' }])
  assert.equal(num.malformed, true)
})

test('TC-LN-014 缺失/空串 id → 合成稳定 id（call_{index}_{hash8}）', () => {
  const calls = normalizeToolCalls([
    { name: 'a', arguments: '{"x":1}' },
    { id: '', name: 'b', arguments: '{"y":2}' },
    { id: 'real', name: 'c', arguments: '{}' },
  ])
  assert.match(calls[0].id, /^call_0_[0-9a-f]{8}$/)
  assert.match(calls[1].id, /^call_1_[0-9a-f]{8}$/)
  assert.equal(calls[2].id, 'real')
  // 同输入 → 同合成 id（对 name+arguments 稳定）
  const again = normalizeToolCalls([{ name: 'a', arguments: '{"x":1}' }])
  assert.equal(again[0].id, calls[0].id)
  // 不同输入 → 不同合成 id
  const other = normalizeToolCalls([{ name: 'a', arguments: '{"x":2}' }])
  assert.notEqual(other[0].id, calls[0].id)
})

test('TC-LN-015 name 缺失 → 空串（不抛错，容错优先）', () => {
  const [call] = normalizeToolCalls([{ id: 'x', arguments: '{}' }])
  assert.equal(call.name, '')
  assert.equal(call.malformed, false)
})

/* ---------------- ③ normalizeResponse 聚合 ---------------- */

test('TC-LN-020 聚合：text/reasoning/toolCalls/finishReason/usage 齐全', () => {
  const r = normalizeResponse(
    {
      content: '你好',
      reasoningContent: '想一想',
      toolCalls: [{ id: 't1', name: 'shell', arguments: '{}' }],
      finishReason: 'tool_calls',
      usage: { tokensIn: 10, tokensOut: 5 },
    },
    'openai',
  )
  assert.equal(r.text, '你好')
  assert.equal(r.reasoning, '想一想')
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.finishReason, 'tool_calls')
  assert.equal(r.tokensIn, 10)
  assert.equal(r.tokensOut, 5)
  assert.equal(r.empty, false)
  assert.equal(r.malformedToolCallCount, 0)
})

test('TC-LN-021 空文本 + 空 toolCalls → empty=true（reason-phase 补试链路接管口径）', () => {
  assert.equal(normalizeResponse({ content: '', finishReason: 'stop' }, 'openai').empty, true)
  assert.equal(normalizeResponse({ content: '   \n\t' }, 'anthropic').empty, true)
  assert.equal(normalizeResponse({}, 'ollama').empty, true)
})

test('TC-LN-022 有 toolCalls 即不 empty（即便文本为空）', () => {
  const r = normalizeResponse(
    { content: '', toolCalls: [{ id: 't', name: 'shell', arguments: '{}' }] },
    'openai',
  )
  assert.equal(r.empty, false)
})

test('TC-LN-023 toolCalls 非数组 / 字段类型异常 → 容错为空集，不抛错', () => {
  const r = normalizeResponse({ content: 'ok', toolCalls: 'garbage' as unknown as RawToolCall[] }, 'openai')
  assert.deepEqual(r.toolCalls, [])
  assert.equal(r.text, 'ok')
})

test('TC-LN-024 usage 缺失 → tokensIn/Out 为 0；malformed 计数正确', () => {
  const r = normalizeResponse(
    {
      content: '',
      toolCalls: [
        { id: 'a', name: 'x', arguments: 'bad json' },
        { id: 'b', name: 'y', arguments: '{}' },
      ],
    },
    'vllm',
  )
  assert.equal(r.tokensIn, 0)
  assert.equal(r.tokensOut, 0)
  assert.equal(r.malformedToolCallCount, 1)
})

/* ---------------- ④ greeting-loop 守卫 + unhealthy 计数 ---------------- */

test('TC-LN-030 守卫真值表：连续 3 轮同前缀才触发（maxRepeat=3）', () => {
  const guard = createGreetingLoopGuard({ reference: '帮我分析一下整个工作区的结构' })
  assert.deepEqual(guard.observe('帮我分析一下整个工作区的结构！很高兴见到你。'), { repeated: false, streak: 1 })
  assert.deepEqual(guard.observe('帮我分析一下整个工作区的结构！！'), { repeated: false, streak: 2 })
  const v = guard.observe('帮我分析一下整个工作区的结构。你好。')
  assert.equal(v.repeated, true)
  assert.equal(v.streak, 3)
  // 触发后 streak 归零重新累计
  assert.deepEqual(guard.observe('帮我分析一下整个工作区的结构。'), { repeated: false, streak: 1 })
})

test('TC-LN-031 中途正常回复 → streak 归零', () => {
  const guard = createGreetingLoopGuard({ reference: '修复登录页的 bug' })
  guard.observe('修复登录页的 bug 是我的专长。')
  guard.observe('修复登录页的 bug 需要两步。')
  assert.deepEqual(guard.observe('已完成修复。'), { repeated: false, streak: 0 })
})

test('TC-LN-032 空白差异不影响同前缀判定（whitespace 归一）', () => {
  const guard = createGreetingLoopGuard({ reference: '你好\n 世界\t 今天' })
  assert.deepEqual(guard.observe('你好 世界 今天 大家好'), { repeated: false, streak: 1 })
})

test('TC-LN-033 空响应不参与重复判定（prefix 为空 → 不累计）', () => {
  const guard = createGreetingLoopGuard({ reference: '你好世界' })
  assert.deepEqual(guard.observe(''), { repeated: false, streak: 0 })
  assert.deepEqual(guard.observe('   '), { repeated: false, streak: 0 })
})

test('TC-LN-034 基准为空 → 守卫不激活', () => {
  const guard = createGreetingLoopGuard({ reference: '' })
  assert.deepEqual(guard.observe('任何内容'), { repeated: false, streak: 0 })
})

test('TC-LN-035 prefixChars 截断比较（长文本按前缀判定）', () => {
  const long = 'A'.repeat(100)
  const guard = createGreetingLoopGuard({ reference: long, prefixChars: 80 })
  // 前 80 字符一致、后缀不同 → 仍判重复
  assert.deepEqual(guard.observe(long + 'B'), { repeated: false, streak: 1 })
})

test('TC-LN-036 unhealthy 计数：mark/get/reset 按 endpoint|modelId 维度聚合', () => {
  __resetUnhealthyForTest()
  assert.equal(markEndpointUnhealthy('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 1)
  assert.equal(markEndpointUnhealthy('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 2)
  assert.equal(getEndpointUnhealthyCount('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 2)
  // 不同 endpoint / 不同 modelId 互不干扰
  assert.equal(getEndpointUnhealthyCount('http://other:11434/v1', 'qwen3.5:9b'), 0)
  assert.equal(getEndpointUnhealthyCount('http://192.168.31.57:11434/v1', 'other:8b'), 0)
  resetEndpointUnhealthy('http://192.168.31.57:11434/v1', 'qwen3.5:9b')
  assert.equal(getEndpointUnhealthyCount('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 0)
  // endpoint 缺省退化为 modelId 维度
  assert.equal(markEndpointUnhealthy(undefined, 'qwen3.5:9b'), 1)
  assert.equal(getEndpointUnhealthyCount('', 'qwen3.5:9b'), 1)
  __resetUnhealthyForTest()
})

/* ---------------- 单源 error-classify（F1.4 回归锁定） ---------------- */

test('TC-LN-040 retryableError / isContextOverflowError / LlmTimeoutError 单源可用', () => {
  assert.equal(retryableError(new Error('429 Too Many Requests')), true)
  assert.equal(retryableError(new Error('fetch failed')), true)
  assert.equal(retryableError(new Error('The user aborted a request.')), false) // 用户中止不重试
  assert.equal(isContextOverflowError(new Error('maximum context length exceeded')), true)
  const t = new LlmTimeoutError('LLM 调用超时 (timeout 120s)')
  assert.equal(isContextOverflowError(t), true) // 超时按窗口膨胀处理
  assert.equal(t.name, 'LlmTimeoutError')
})
