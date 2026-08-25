/* ============================================================
 * v0.19.0 M3 — inbox / turn-stopping 单测
 *
 * 验收断言：注入 steering 后同轮继续执行（continuation 进入收件箱，
 * 引擎可在停止候选处 drain 后继续同一 turn）。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/turn-stopping.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  onTurnStopping,
  clearTurnStoppingListeners,
  emitTurnStopping,
} from '../turn-stopping.js'
import { inbox, drainMessages, drainContinuations, hasPendingContinuation } from '../inbox.js'
import type { Task } from '@shared/types/task'

function makeTask(id = 'T-1'): Task {
  return { id, input: { text: 'hello' } } as Task
}

test.beforeEach(() => {
  clearTurnStoppingListeners()
  // 清空收件箱（避免跨测试残留）
  drainMessages('T-1')
  drainContinuations('T-1')
})

/* ---------- Inbox 基本行为 ---------- */

test('inbox.send → drainMessages 领取一条新消息并清空', () => {
  inbox.send('T-1', '第一条')
  inbox.send('T-1', '第二条')
  assert.deepEqual(drainMessages('T-1'), ['第一条', '第二条'])
  assert.deepEqual(drainMessages('T-1'), [])
})

test('inbox.inject → drainContinuations 领取 continuation 并清空', () => {
  inbox.inject('T-1', '继续执行')
  assert.equal(hasPendingContinuation('T-1'), true)
  assert.deepEqual(drainContinuations('T-1'), ['继续执行'])
  assert.equal(hasPendingContinuation('T-1'), false)
})

/* ---------- emitTurnStopping：注入 continuation ---------- */

test('emitTurnStopping: 无监听器不产生 continuation', () => {
  emitTurnStopping('T-1', { task: makeTask() })
  assert.equal(hasPendingContinuation('T-1'), false)
})

test('emitTurnStopping: 监听器返回非空字符串 → 注入 continuation', () => {
  onTurnStopping(() => '继续当前 turn')
  emitTurnStopping('T-1', { task: makeTask() })
  assert.equal(hasPendingContinuation('T-1'), true)
  assert.deepEqual(drainContinuations('T-1'), ['继续当前 turn'])
})

test('emitTurnStopping: 多个监听器注入多条 continuation', () => {
  onTurnStopping(() => '第一条')
  onTurnStopping(() => '第二条')
  emitTurnStopping('T-1', { task: makeTask() })
  assert.deepEqual(drainContinuations('T-1'), ['第一条', '第二条'])
})

test('emitTurnStopping: 监听器返回空/void 不注入', () => {
  onTurnStopping(() => '')
  onTurnStopping(() => undefined)
  onTurnStopping(() => '   ')
  emitTurnStopping('T-1', { task: makeTask() })
  assert.equal(hasPendingContinuation('T-1'), false)
})

test('emitTurnStopping: 监听器抛错不中断后续监听器', () => {
  const calls: string[] = []
  onTurnStopping(() => {
    throw new Error('boom')
  })
  onTurnStopping(() => {
    calls.push('second')
    return '存活'
  })
  emitTurnStopping('T-1', { task: makeTask() })
  assert.deepEqual(calls, ['second'])
  assert.deepEqual(drainContinuations('T-1'), ['存活'])
})

test('clearTurnStoppingListeners: 清空后不再触发', () => {
  onTurnStopping(() => '不应注入')
  clearTurnStoppingListeners()
  emitTurnStopping('T-1', { task: makeTask() })
  assert.equal(hasPendingContinuation('T-1'), false)
})
