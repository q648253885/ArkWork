/* ============================================================
 * ArkWork — 交互区轮次折叠（v0.34.0 · D52 · TC-FOLDT-001..008）
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §2.4
 *
 * 用户实测现象：「模型一直在 loop，但是没有内容，且交互区一直在变化增加距离」。
 * 前半句是引擎空转（见 stall.test.ts），后半句是**渲染层对轮数没有上限** ——
 * 每轮都追加步骤卡，页面高度无限增长。本组把守折叠区间计算。
 *
 * 为什么折叠而不是虚拟滚动：贴底跟随 / scroll-to-tool / scroll-to-plan-step
 * 都依赖真实 DOM 存在（见 turn-fold.ts 头注释），折叠是零破坏的解法。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs turn-fold
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TURN_FOLD_THRESHOLD, foldTurnRange } from '../turn-fold.js'

test('TC-FOLDT-001 阈值常量 = 30（设计 §2.4 定稿值）', () => {
  assert.equal(TURN_FOLD_THRESHOLD, 30)
})

test('TC-FOLDT-002 未达阈值 → 不折叠（startIndex 必须是 0，不能是 total）', () => {
  for (const total of [0, 1, 5, 29, 30]) {
    const r = foldTurnRange(total, false)
    assert.equal(r.hiddenCount, 0, `total=${total} 不应折叠`)
    assert.equal(r.startIndex, 0, `total=${total} 的起切下标必须是 0`)
  }
})

test('TC-FOLDT-003 ★ 超过阈值 → 只保留最近 30 轮，其余计入 hiddenCount', () => {
  const r = foldTurnRange(45, false)
  assert.equal(r.hiddenCount, 15, '45 - 30 = 15')
  assert.equal(r.startIndex, 15, '切片起点 = hiddenCount（两值必须自洽）')
  assert.equal(45 - r.startIndex, 30, '可见轮数恰为阈值')
})

test('TC-FOLDT-004 展开态永不折叠（用户点过展开就尊重其选择）', () => {
  for (const total of [31, 100, 5000]) {
    const r = foldTurnRange(total, true)
    assert.equal(r.hiddenCount, 0)
    assert.equal(r.startIndex, 0)
  }
})

test('TC-FOLDT-005 边界：threshold ≤ 0 → 全部折叠（startIndex = total，由调用方渲染折叠条）', () => {
  const r = foldTurnRange(10, false, 0)
  assert.equal(r.hiddenCount, 10)
  assert.equal(r.startIndex, 10, '切片起点等于总数 → 可见段为空，但折叠条必须仍渲染（turn-fold.ts 已注明）')
  const neg = foldTurnRange(10, false, -5)
  assert.deepEqual(neg, { hiddenCount: 10, startIndex: 10 }, '负数按 0 处理')
})

test('TC-FOLDT-006 threshold 可注入且优先于缺省值（便于未来按窗口高度自适应）', () => {
  assert.deepEqual(foldTurnRange(10, false, 4), { hiddenCount: 6, startIndex: 6 })
  assert.deepEqual(foldTurnRange(10, false, 10), { hiddenCount: 0, startIndex: 0 })
  assert.deepEqual(foldTurnRange(10, false, 11), { hiddenCount: 0, startIndex: 0 })
})

test('TC-FOLDT-007 脏输入「失败开放」：非有限输入不得把内容藏起来，也不得产生 NaN', () => {
  const frac = foldTurnRange(10, false, 4.9)
  assert.equal(frac.startIndex, 6, '小数阈值向下取整（4.9 → 4）')

  // NaN / Infinity 阈值：正常输入里不该出现，出现即视为「没有阈值」→ 全显示
  const nan = foldTurnRange(10, false, Number.NaN)
  assert.deepEqual(nan, { hiddenCount: 0, startIndex: 0 }, 'NaN 阈值必须失败开放（藏内容比多显示更糟）')
  const inf = foldTurnRange(10, false, Number.POSITIVE_INFINITY)
  assert.deepEqual(inf, { hiddenCount: 0, startIndex: 0 }, 'Infinity 阈值 = 永不折叠')

  // 关键回归：hiddenCount / startIndex 绝不能是 NaN ——
  // NaN 会一路传到 i18n 插值，界面上出现「已折叠 NaN 轮」这种可见缺陷。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    for (const total of [Number.NaN, Number.POSITIVE_INFINITY, -1, 10]) {
      const r = foldTurnRange(total, false, bad)
      assert.equal(Number.isNaN(r.hiddenCount), false, `total=${total} threshold=${bad} 的 hiddenCount 不得为 NaN`)
      assert.equal(Number.isNaN(r.startIndex), false, `total=${total} threshold=${bad} 的 startIndex 不得为 NaN`)
      assert.ok(r.startIndex >= 0, '起点不得为负')
    }
  }
  assert.deepEqual(foldTurnRange(Number.NaN, false), { hiddenCount: 0, startIndex: 0 }, 'NaN 总轮数 → 不折叠')
})

test('TC-FOLDT-008 不变量：hiddenCount === startIndex（切片自洽），故不会出现空洞或重叠', () => {
  for (const total of [0, 1, 30, 31, 60, 137]) {
    for (const expanded of [false, true]) {
      const r = foldTurnRange(total, expanded)
      assert.equal(r.hiddenCount, r.startIndex, `total=${total} expanded=${expanded} 两值必须相等`)
      assert.ok(r.startIndex >= 0 && r.startIndex <= total, '起点必须在 [0, total] 内')
    }
  }
})
