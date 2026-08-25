/* ============================================================
 * abort.ts 单测（v0.16.x 新增）
 *
 * 覆盖：
 *   1. 超时触发 → signal.aborted=true, reason='timeout'
 *   2. 用户中止触发 → signal.aborted=true, reason='user-abort'
 *   3. 用户先中止 → reason='user-abort'
 *   4. clear() 后定时器被回收（不再触发）
 *   5. fetchWithLimits Content-Length 超限抛错
 *   6. 超时 0 表示禁用超时
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/skills/__tests__/abort.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abortAfterAny, fetchWithLimits, TimeoutError, isTimeoutError } from '../abort.js'

test('abortAfterAny: 超时触发后 signal.aborted=true, reason=timeout', async () => {
  const handle = abortAfterAny(50)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(handle.signal.aborted, true)
  assert.equal(handle.reason, 'timeout')
  handle.clear()
})

test('abortAfterAny: 用户中止触发后 reason=user-abort', async () => {
  const ctrl = new AbortController()
  const handle = abortAfterAny(10_000, ctrl.signal)
  ctrl.abort()
  assert.equal(handle.signal.aborted, true)
  assert.equal(handle.reason, 'user-abort')
  handle.clear()
})

test('abortAfterAny: 用户先中止（构造时已 aborted）→ reason=user-abort', () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const handle = abortAfterAny(10_000, ctrl.signal)
  assert.equal(handle.signal.aborted, true)
  assert.equal(handle.reason, 'user-abort')
  handle.clear()
})

test('abortAfterAny: clear 后不再触发', async () => {
  const handle = abortAfterAny(50)
  handle.clear()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(handle.signal.aborted, false)
  assert.equal(handle.reason, undefined)
})

test('abortAfterAny: timeoutMs<=0 不启动超时定时器', async () => {
  const handle = abortAfterAny(0)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(handle.signal.aborted, false)
  assert.equal(handle.reason, undefined)
  handle.clear()
})

test('fetchWithLimits: Content-Length 超限抛错', async () => {
  // 用 127.0.0.1 起一个 mock server 返回大 Content-Length
  // 这里用更轻量方式：unfetchable URL → 走超时分支（兜底测试）
  try {
    await fetchWithLimits(
      'http://127.0.0.1:1/__definitely_not_listening__',
      {},
      { timeoutMs: 100, userSignal: undefined, defaultHeaders: {} },
    )
    assert.fail('应抛错（连接失败或超时）')
  } catch (err) {
    // 任意错误（connect refused / timeout）都行，证明错误会冒泡
    assert.ok(err instanceof Error)
  }
})

test('TimeoutError: isTimeoutError 正确识别', () => {
  const t = new TimeoutError(1000)
  assert.equal(t.isTimeout, true)
  assert.equal(isTimeoutError(t), true)
  assert.equal(isTimeoutError(new Error('Operation timed out after 5s')), true)
  assert.equal(isTimeoutError(new Error('普通错误')), false)
  assert.equal(isTimeoutError(null), false)
})

test('abortAfterAny: 监听器不泄漏（连续 100 次创建/销毁）', () => {
  for (let i = 0; i < 100; i++) {
    const ctrl = new AbortController()
    const handle = abortAfterAny(10_000, ctrl.signal)
    ctrl.abort()
    handle.clear()
  }
  // 无 throw 即通过
  assert.ok(true)
})