/* ============================================================
 * ArkWork — 终局短语谓词真值表（v0.41.0 / TC-FP-001…006 · D207）
 * 上游：docs/versions/v0.41.0/testcases/00-cumulative-matrix.md 模块 M
 * 运行（cwd=app）：node scripts/run-tests.mjs finish-phrase
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FINISH_HERE_PHRASES, isFinishHerePhrase, resolveFinishHereAction } from '../finish-phrase.js'

test('TC-FP-001 四语言终局短语全部命中（suggest.finishHere.label 四 locale 值）', () => {
  for (const phrase of FINISH_HERE_PHRASES) {
    assert.equal(isFinishHerePhrase(phrase), true, `「${phrase}」必须命中`)
  }
})

test('TC-FP-002 大小写与首尾空白归一', () => {
  assert.equal(isFinishHerePhrase('  Finish HERE  '), true)
  assert.equal(isFinishHerePhrase('finish here'), true)
})

test('TC-FP-003 ★ 宁缺毋滥：精确匹配、不子串 —— 自然语句一律不命中', () => {
  assert.equal(isFinishHerePhrase('就此结束。'), false, '带句号不是精确匹配')
  assert.equal(isFinishHerePhrase('好，就此结束'), false)
  assert.equal(isFinishHerePhrase('不要就此结束'), false, '子串不得命中')
  assert.equal(isFinishHerePhrase('继续吧就此结束之后'), false)
  assert.equal(isFinishHerePhrase('就此结'), false)
  assert.equal(isFinishHerePhrase('就此结束了'), false)
})

test('TC-FP-004 空串 / null / undefined / 纯空白 → false', () => {
  assert.equal(isFinishHerePhrase(''), false)
  assert.equal(isFinishHerePhrase(null), false)
  assert.equal(isFinishHerePhrase(undefined), false)
  assert.equal(isFinishHerePhrase('   '), false)
})

test('TC-FP-005 清单为 as const 只读常量且恰为四语言值（长度固定 4）', () => {
  assert.equal(FINISH_HERE_PHRASES.length, 4)
  assert.ok(FINISH_HERE_PHRASES.includes('就此结束'))
  assert.ok((FINISH_HERE_PHRASES as readonly string[]).every((p) => p.length > 0))
})

test('TC-FP-006 非 string 类型输入按 false 处理不抛', () => {
  assert.equal(isFinishHerePhrase(42 as unknown as string), false)
  assert.equal(isFinishHerePhrase({} as unknown as string), false)
})

test('TC-FP-007 resolveFinishHereAction 真值表（cancel / ack-only / null）', () => {
  assert.equal(resolveFinishHereAction('就此结束', 'running'), 'cancel')
  assert.equal(resolveFinishHereAction('就此结束', 'paused'), 'cancel')
  assert.equal(resolveFinishHereAction('就此结束', 'pending'), 'cancel')
  assert.equal(resolveFinishHereAction('就此结束', 'done'), 'ack-only')
  assert.equal(resolveFinishHereAction('就此结束', 'failed'), 'ack-only')
  assert.equal(resolveFinishHereAction('就此结束', 'cancelled'), 'ack-only')
  assert.equal(resolveFinishHereAction('就此结束', undefined), 'cancel', '无状态按未终态处理')
  assert.equal(resolveFinishHereAction('分析一下这个项目', 'paused'), null, '非短语 → null')
  assert.equal(resolveFinishHereAction('就此结束。', 'paused'), null, '带标点不命中')
})
