/* ============================================================
 * v0.14.0 — reconcileToolCalls 行为单测
 *
 * 覆盖 400 "insufficient tool messages following tool_calls" 根因：
 * 历史脏数据中 assistant 带 tool_calls 却无配对 tool 响应
 * （旧 ask_user / task_complete 分支直接 return 未补 observation）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/__tests__/reconcile-tool-calls.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reconcileToolCalls } from '../engine/index.js'
import type { LlmMessage } from '../../llm/adapter.js'

function assistant(id: string | undefined, content = 'think'): LlmMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: id
      ? [{ id, type: 'function', function: { name: 'shell', arguments: '{}' } }]
      : undefined,
  }
}
function tool(toolCallId: string, content = 'ok'): LlmMessage {
  return { role: 'tool', content, toolCallId }
}
function user(content = 'hi'): LlmMessage {
  return { role: 'user', content }
}

test('reconcileToolCalls: 完整配对的 tool_calls 原样保留', () => {
  const msgs: LlmMessage[] = [
    user(),
    assistant('call_1_0'),
    tool('call_1_0'),
    assistant(undefined),
  ]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 4)
  assert.ok(out[1].toolCalls && out[1].toolCalls.length === 1, 'assistant tool_calls 保留')
  assert.equal(out[2].role, 'tool')
})

test('reconcileToolCalls: 悬空 assistant tool_calls（ask_user 形态）被剥离', () => {
  // 复现 T-20260731-426u4j 脏数据形态：最后一条 assistant 带 tool_calls 无 tool 响应
  const msgs: LlmMessage[] = [
    assistant('call_1_0'),
    tool('call_1_0'),
    assistant('call_3_0'), // ask_user → 无 observation
  ]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 3, '正常配对保留，悬空 assistant 仅剥离 toolCalls')
  assert.ok(out[0]!.toolCalls && out[0]!.toolCalls.length === 1, '第 1 条配对正常保留')
  assert.equal(out[1]!.role, 'tool')
  assert.equal(out[2]!.toolCalls, undefined, '悬空 assistant 无 toolCalls')
})

test('reconcileToolCalls: 部分配对的 tool_calls 剥离并丢弃孤立 tool', () => {
  // assistant 请求 2 个 tool，只有 1 条 tool 响应 → 剥离整段
  const msgs: LlmMessage[] = [
    {
      role: 'assistant',
      content: 'multi',
      toolCalls: [
        { id: 'call_0', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'call_1', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    tool('call_0'),
    user('继续'),
  ]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 2, '剥离 assistant tool_calls 并丢弃其后的孤立 tool 消息')
  assert.equal(out[0]!.toolCalls, undefined)
  assert.equal(out[1]!.role, 'user')
})

test('reconcileToolCalls: 多 tool 全部配对保留', () => {
  const msgs: LlmMessage[] = [
    {
      role: 'assistant',
      content: 'multi',
      toolCalls: [
        { id: 'c0', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: 'c1', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    tool('c0'),
    tool('c1'),
  ]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 3)
  assert.ok(out[0]!.toolCalls && out[0]!.toolCalls.length === 2)
})

test('reconcileToolCalls: 无 toolCalls 的普通消息流不受影响', () => {
  const msgs: LlmMessage[] = [user(), assistant(undefined), user()]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 3)
  assert.deepEqual(out, msgs)
})

test('reconcileToolCalls: 孤立 tool 消息（压缩切片遗留）被丢弃', () => {
  // 复现 auto-compress 后 400 "must be a response to a preceding message with tool_calls"：
  // compact sliceRecentContext 把前置 assistant tool_calls 归档，保留了 tool 响应
  const msgs: LlmMessage[] = [
    user('开始'),
    tool('call_9_0', 'shell 输出'), // 前面没有配对的 assistant toolCalls
    user('继续'),
  ]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 2, '孤立 tool 消息被丢弃')
  assert.equal(out[0]!.role, 'user')
  assert.equal(out[1]!.role, 'user')
})

test('reconcileToolCalls: 开头的孤立 tool 消息被丢弃', () => {
  // 压缩切片可能从 tool 响应开始（前置 assistant 被归档）
  const msgs: LlmMessage[] = [tool('call_5_0'), user('继续')]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 1, '开头孤立 tool 消息被丢弃')
  assert.equal(out[0]!.role, 'user')
})

test('reconcileToolCalls: 配对 tool 段不受影响（孤立 tool 丢弃不误伤）', () => {
  const msgs: LlmMessage[] = [
    user(),
    assistant('call_1_0'),
    tool('call_1_0'),
    tool('call_1_0'), // 同一 assistant 的第二个 tool 响应（并行）
    assistant(undefined),
    tool('orphan'), // 游离 tool → 丢弃
  ]
  const out = reconcileToolCalls(msgs)
  assert.equal(out.length, 5)
  assert.ok(out[1]!.toolCalls && out[1]!.toolCalls.length === 1, 'assistant tool_calls 保留')
  assert.equal(out[2]!.role, 'tool')
  assert.equal(out[3]!.role, 'tool')
  assert.equal(out[4]!.role, 'assistant')
  assert.ok(!out.some((m) => m.role === 'tool' && m.toolCallId === 'orphan'), '孤立 tool 已丢弃')
})
