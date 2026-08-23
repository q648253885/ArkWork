/* ============================================================
 * ArkWork — gate-nav 单测（v0.27.1 修三）
 * 覆盖：循环移动 / 空列表 / 数字映射边界
 * 运行：tsx --test（run-tests.mjs 自动发现）
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moveSelection, digitToIndex } from '../gate-nav.js'

/* ---------------- moveSelection ---------------- */

test('moveSelection · 向下移动', () => {
  assert.equal(moveSelection(0, 1, 4), 1)
  assert.equal(moveSelection(2, 1, 4), 3)
})

test('moveSelection · 向上移动', () => {
  assert.equal(moveSelection(2, -1, 4), 1)
  assert.equal(moveSelection(1, -1, 4), 0)
})

test('moveSelection · 尾部向下回绕到头', () => {
  assert.equal(moveSelection(3, 1, 4), 0)
})

test('moveSelection · 头部向上回绕到尾', () => {
  assert.equal(moveSelection(0, -1, 4), 3)
})

test('moveSelection · 空列表返回 -1', () => {
  assert.equal(moveSelection(0, 1, 0), -1)
  assert.equal(moveSelection(0, -1, 0), -1)
})

test('moveSelection · 单项循环不动', () => {
  assert.equal(moveSelection(0, 1, 1), 0)
  assert.equal(moveSelection(0, -1, 1), 0)
})

test('moveSelection · 大步长回绕仍落在界内', () => {
  assert.equal(moveSelection(0, 5, 4), 1)
})

/* ---------------- digitToIndex ---------------- */

test('digitToIndex · 1-9 映射 0-based', () => {
  assert.equal(digitToIndex(1), 0)
  assert.equal(digitToIndex(5), 4)
  assert.equal(digitToIndex(9), 8)
})

test('digitToIndex · 越界返回 -1', () => {
  assert.equal(digitToIndex(0), -1)
  assert.equal(digitToIndex(-3), -1)
  assert.equal(digitToIndex(10), -1)
})
