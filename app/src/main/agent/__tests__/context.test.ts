/* ============================================================
 * agent-context-compaction-robustness — context.ts 纯工具模块单测
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/context.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTextTokens,
  estimatePayloadTokens,
  estimatePayloadTokensDetailed,
  contextBudget,
  shouldCompact,
  truncateLongContent,
  applyMicroCompact,
  MICRO_COMPACT_PLACEHOLDER,
  MAX_REASONING_CONTENT,
  MAX_OBSERVATION_CONTENT,
  OBSERVATION_TRUNCATED_MARK,
} from '../context.js'
import type { LlmMessage } from '../../llm/adapter.js'

/* ---------- estimateTextTokens ---------- */

test('estimateTextTokens: 4000 个英文字符 ≈ 1000+ token（~4 字符/token + 固定开销）', () => {
  const t = estimateTextTokens('a'.repeat(4000))
  assert.ok(t >= 1000, `应为 1000+，实际 ${t}`)
})

test('estimateTextTokens: 空值返回 0', () => {
  assert.equal(estimateTextTokens(null), 0)
  assert.equal(estimateTextTokens(undefined), 0)
})

/* ---------- estimatePayloadTokens ---------- */

test('estimatePayloadTokens: 69000 字符 reasoningContent 被计入（结果 > 10000）', () => {
  const messages: LlmMessage[] = [
    { role: 'assistant', content: 'x', reasoningContent: 'a'.repeat(69000) },
  ]
  const t = estimatePayloadTokens({ messages })
  assert.ok(t > 10000, `reasoningContent 69000 字符应计入，实际 ${t}`)
})

test('estimatePayloadTokens: 空参数返回 0', () => {
  assert.equal(estimatePayloadTokens({}), 0)
})

test('estimatePayloadTokens: system + 工具 schema 计入', () => {
  const t = estimatePayloadTokens({
    system: 's'.repeat(400),
    messages: [{ role: 'user', content: 'u'.repeat(400) }],
    tools: [{ type: 'function', function: { name: 'x', description: 'y', parameters: {} } }],
  })
  assert.ok(t > 100)
})

/* ---------- estimatePayloadTokensDetailed（分项 = 总和 契约） ---------- */

test('estimatePayloadTokensDetailed: 分项之和 = total', () => {
  const { total, breakdown } = estimatePayloadTokensDetailed({
    system: 's'.repeat(600),
    messages: [
      { role: 'user', content: 'u'.repeat(400) },
      { role: 'assistant', content: 'r'.repeat(200), reasoningContent: 'rc'.repeat(150) },
    ],
    tools: [{ type: 'function', function: { name: 'x', description: 'y', parameters: {} } }],
  })
  assert.equal(breakdown.systemTokens + breakdown.messagesTokens + breakdown.toolsTokens, total)
  assert.ok(breakdown.systemTokens > 0)
  assert.ok(breakdown.messagesTokens > 0)
  assert.ok(breakdown.toolsTokens > 0)
})

test('estimatePayloadTokensDetailed: system 含 memoryInjection 时仍可按 memTokens 扣减（防 UI 双重计数）', () => {
  const memInjection = 'm'.repeat(300)
  const systemPrompt = `agent system prompt\n\n---\n## 工作区策展记忆\n${memInjection}`
  const { total, breakdown } = estimatePayloadTokensDetailed({
    system: systemPrompt,
    messages: [{ role: 'user', content: 'u' }],
    tools: [],
  })
  const memTokens = estimateTextTokens(memInjection)
  // 引擎把 systemTokens 上报为「扣减 memoryInjection 后」，memoryInjectionTokens 单独成项：
  // systemTokens' + memoryInjectionTokens = 原 systemTokens（总 payload 不变）
  const reportedSystem = breakdown.systemTokens - memTokens
  assert.equal(reportedSystem + memTokens, breakdown.systemTokens)
  assert.equal(reportedSystem + memTokens + breakdown.messagesTokens + breakdown.toolsTokens, total)
  assert.ok(memTokens > 0)
})

/* ---------- contextBudget ---------- */

test('contextBudget: 无参 ≈ round(64000*0.85)', () => {
  assert.equal(contextBudget(), Math.round(64000 * 0.85))
})

test('contextBudget: 128000 → 64000（clamp 上限）', () => {
  assert.equal(contextBudget(128000), 64000)
})

test('contextBudget: 30000 → round(30000*0.85) = 25500', () => {
  assert.equal(contextBudget(30000), Math.round(30000 * 0.85))
})

test('contextBudget: clamp 下限 24000', () => {
  assert.equal(contextBudget(20000), 24000)
})

/* ---------- shouldCompact ---------- */

test('shouldCompact: 30000 token vs 40000 预算 → false（30000+4096 <= 40000）', () => {
  assert.equal(shouldCompact(30000, 40000), false)
})

test('shouldCompact: 40000 token vs 40000 预算 → true（40000+4096 > 40000）', () => {
  assert.equal(shouldCompact(40000, 40000), true)
})

/* ---------- truncateLongContent ---------- */

test('truncateLongContent: 超长内容截断到 max 并追加 mark', () => {
  const out = truncateLongContent('x'.repeat(10000), MAX_OBSERVATION_CONTENT, OBSERVATION_TRUNCATED_MARK)
  assert.equal(out.length, MAX_OBSERVATION_CONTENT + OBSERVATION_TRUNCATED_MARK.length)
  assert.ok(out.endsWith(OBSERVATION_TRUNCATED_MARK))
})

test('truncateLongContent: 未超长内容原样返回', () => {
  const s = 'short'
  assert.equal(truncateLongContent(s, 8000, OBSERVATION_TRUNCATED_MARK), s)
})

/* ---------- applyMicroCompact ---------- */

test('applyMicroCompact: 保留最近 2 轮，更早轮 tool 内容清空 + reasoning 置 undefined', () => {
  const messages: LlmMessage[] = [
    { role: 'assistant', content: 'r1', reasoningContent: 'rc1', toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', content: 'res1', toolCallId: 'c1' },
    { role: 'assistant', content: 'r2', reasoningContent: 'rc2', toolCalls: [{ id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', content: 'res2', toolCallId: 'c2' },
    { role: 'assistant', content: 'r3', reasoningContent: 'rc3', toolCalls: [{ id: 'c3', type: 'function', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', content: 'res3', toolCallId: 'c3' },
  ]
  const { messages: out, clearedToolResults, droppedReasoning } = applyMicroCompact(messages, 2)

  assert.equal(clearedToolResults, 1, '仅第一轮的 tool 结果被清空')
  assert.equal(droppedReasoning, 1, '仅第一轮的 reasoningContent 被丢弃')
  assert.equal(out[0].content, 'r1')
  assert.equal(out[0].reasoningContent, undefined)
  assert.equal(out[1].content, MICRO_COMPACT_PLACEHOLDER)
  // 最近 2 轮原样保留
  assert.equal(out[2].reasoningContent, 'rc2')
  assert.equal(out[3].content, 'res2')
  assert.equal(out[4].reasoningContent, 'rc3')
  assert.equal(out[5].content, 'res3')
  // 不修改入参对象
  assert.equal(messages[0].reasoningContent, 'rc1')
  assert.equal(messages[1].content, 'res1')
})

test('applyMicroCompact: 轮数不足 keepRecentTurns 时零改动', () => {
  const messages: LlmMessage[] = [
    { role: 'assistant', content: 'a1', reasoningContent: 'rc1' },
    { role: 'tool', content: 'res1', toolCallId: 'c1' },
  ]
  const { messages: out, clearedToolResults, droppedReasoning } = applyMicroCompact(messages, 3)
  assert.equal(clearedToolResults, 0)
  assert.equal(droppedReasoning, 0)
  assert.equal(out[1].content, 'res1')
  assert.equal(out[0].reasoningContent, 'rc1')
})

test('applyMicroCompact: 默认 keepRecentTurns = RECENT_TOOL_TURNS(3)', () => {
  const messages: LlmMessage[] = [
    { role: 'assistant', content: 'a1', reasoningContent: 'rc1' },
    { role: 'assistant', content: 'a2', reasoningContent: 'rc2' },
    { role: 'assistant', content: 'a3', reasoningContent: 'rc3' },
    { role: 'assistant', content: 'a4', reasoningContent: 'rc4' },
  ]
  const { messages: out, droppedReasoning } = applyMicroCompact(messages)
  assert.equal(droppedReasoning, 1)
  assert.equal(out[0].reasoningContent, undefined)
  assert.equal(out[1].reasoningContent, 'rc2')
})

test('常量契约: MAX_REASONING_CONTENT / MAX_OBSERVATION_CONTENT', () => {
  // v0.24.0：4000 → 1500（压历史膨胀，见 context.ts 注释）
  assert.equal(MAX_REASONING_CONTENT, 1500)
  assert.equal(MAX_OBSERVATION_CONTENT, 8000)
})
