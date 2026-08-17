/* ============================================================
 * v0.19.0 M2 — session-log.ts 纯函数单测（deriveMessages）
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/session-log.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMessages } from '../session-log.js'
import type { SessionEvent } from '@shared/types/conversation'
import type { ReActEvent } from '@shared/types/react'

function ev(seq: number, event: ReActEvent): SessionEvent {
  return { ...event, id: `ev-${seq}`, seq, ts: 0 }
}

test('deriveMessages: 空列表返回空数组', () => {
  assert.deepEqual(deriveMessages([]), [])
})

test('deriveMessages: reason_end 有 action → assistant 消息 + toolCalls', () => {
  const events: SessionEvent[] = [
    ev(1, {
      type: 'reason_end',
      iteration: 0,
      thought: '我要读取文件',
      action: { tool: 'file-reader', args: { path: 'a.txt' } },
      durationMs: 100,
    }),
  ]
  const msgs = deriveMessages(events)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0]!.role, 'assistant')
  assert.equal(msgs[0]!.content, '我要读取文件')
  assert.equal(msgs[0]!.toolCalls?.[0]?.function.name, 'file-reader')
  assert.equal(msgs[0]!.toolCalls?.[0]?.function.arguments, JSON.stringify({ path: 'a.txt' }))
})

test('deriveMessages: reason_end 无 action → assistant 纯文本消息', () => {
  const events: SessionEvent[] = [
    ev(1, { type: 'reason_end', iteration: 0, thought: '任务完成', action: null, durationMs: 100 }),
  ]
  const msgs = deriveMessages(events)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0]!.role, 'assistant')
  assert.equal(msgs[0]!.toolCalls, undefined)
})

test('deriveMessages: act_start + act_end → tool 结果消息（name/toolCallId 配对）', () => {
  const events: SessionEvent[] = [
    ev(1, {
      type: 'reason_end',
      iteration: 0,
      thought: '读',
      action: { tool: 'file-reader', args: {} },
      durationMs: 100,
    }),
    ev(2, { type: 'act_start', iteration: 0, tool: 'file-reader', args: {} }),
    ev(3, { type: 'act_end', iteration: 0, result: '内容', resultSummary: '内容摘要', durationMs: 10, ok: true }),
  ]
  const msgs = deriveMessages(events)
  assert.equal(msgs.length, 2)
  const toolMsg = msgs[1]!
  assert.equal(toolMsg.role, 'tool')
  assert.equal(toolMsg.name, 'file-reader')
  assert.equal(toolMsg.toolCallId, 'call-0')
  assert.equal(toolMsg.content, '内容摘要')
})

test('deriveMessages: 多轮 reason/act 按顺序投影', () => {
  const events: SessionEvent[] = [
    ev(1, { type: 'reason_end', iteration: 0, thought: '第一步', action: { tool: 'a', args: {} }, durationMs: 1 }),
    ev(2, { type: 'act_end', iteration: 0, result: 'r1', resultSummary: 'r1', durationMs: 1, ok: true }),
    ev(3, { type: 'reason_end', iteration: 1, thought: '第二步', action: { tool: 'b', args: {} }, durationMs: 1 }),
    ev(4, { type: 'act_end', iteration: 1, result: 'r2', resultSummary: 'r2', durationMs: 1, ok: true }),
  ]
  const msgs = deriveMessages(events)
  assert.equal(msgs.length, 4)
  assert.deepEqual(msgs.map((m) => m.role), ['assistant', 'tool', 'assistant', 'tool'])
})
