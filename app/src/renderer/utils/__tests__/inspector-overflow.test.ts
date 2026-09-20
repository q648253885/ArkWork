/* ============================================================
 * ArkWork — 竖排栏「铺满才折叠」（TC-OVF 组）
 * 规格来源：docs/versions/v0.34.3/04-system-design.md §D58
 *
 * ⚠️ 口径取代登记（不是静默改动）：
 *   D56-c（v0.34.2）的 TC-OVF-001..017 断言的是
 *       **可见条数 = min(名称上限 3, 可用高度能容纳的条数)**
 *   —— 其中「≤3」被当成**用户的硬偏好**。用户 v0.34.3 实测复报给出真正的规则：
 *
 *       「整体验证，尤其是侧边栏，**在铺满的时候才有更多**，
 *         现在的更多我点不开」
 *
 *   即「超过三个会挤压溢出」是对**症状**的描述（她的窗口恰好只放得下 3 个），
 *   不是对数量的偏好。故本组整体重写为 TC-OVF-001..019，规则收敛为：
 *
 *       **只有放不下才折叠；放得下就一条都不收，数量不再是判据。**
 *
 *   退役记录见 docs/versions/v0.34.3/00-release-goal.md §三「口径纠正登记」。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs inspector-overflow
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_VISIBLE,
  MAX_VISIBLE_NAMES,
  RAIL_COLLAPSE_BTN_H,
  RAIL_HIDDEN_BLOCK_BASE_H,
  RAIL_HIDDEN_ITEM_H,
  RAIL_ITEM_GAP,
  RAIL_ITEM_H,
  RAIL_OVERFLOW_TRIGGER_H,
  RAIL_PADDING_Y,
  computeRailLayout,
  hiddenBlockHeight,
  itemsHeight,
  pickVisibleTabs,
} from '../rail-tab-overflow.js'

/** 造 n 个条目（builtin 只为可读性，折叠不区分来源） */
const tabsOf = (n: number, prefix = 'panel:t') =>
  Array.from({ length: n }, (_, i) => ({ ref: `${prefix}${i}`, builtin: i % 2 === 0 }))

/** 给定竖排栏高度 → 条目实际可用高度（扣内边距 + 底部折叠按钮 + 已隐藏区） */
const usableOf = (H: number, reserved = 0) => H - RAIL_PADDING_Y - RAIL_COLLAPSE_BTN_H - reserved

/* ---------- 常量契约 ---------- */

test('TC-OVF-001 尺寸常量与 Inspector 样式同源（改样式不改这里 = 折叠算错）', () => {
  assert.equal(RAIL_ITEM_H, 64, '.inspector-toolbar__item height: 64px')
  assert.equal(RAIL_ITEM_GAP, 2, '.inspector-toolbar gap: 2px')
  assert.equal(RAIL_PADDING_Y, 12, '.inspector-toolbar padding: 6px 0')
  assert.equal(RAIL_COLLAPSE_BTN_H, 36, '底部折叠按钮 h-9')
  assert.equal(RAIL_OVERFLOW_TRIGGER_H, 48, '「更多」区块 mt-1(4) + pt-2(8) + h-9(36)')
  assert.equal(RAIL_HIDDEN_BLOCK_BASE_H, 48, '「已隐藏区」首项同构')
  assert.equal(RAIL_HIDDEN_ITEM_H, 40, '「已隐藏区」每多一项 h-9 + gap-1')
})

test('TC-OVF-002 itemsHeight：n≤0 → 0，含条目间 gap', () => {
  assert.equal(itemsHeight(0), 0)
  assert.equal(itemsHeight(-3), 0)
  assert.equal(itemsHeight(1), 64)
  assert.equal(itemsHeight(2), 130)
  assert.equal(itemsHeight(3), 196)
  assert.equal(itemsHeight(9), 592)
})

test('TC-OVF-003 hiddenBlockHeight：0 项 → 0（该区块不渲染）', () => {
  assert.equal(hiddenBlockHeight(0), 0)
  assert.equal(hiddenBlockHeight(-1), 0)
  assert.equal(hiddenBlockHeight(1), 48)
  assert.equal(hiddenBlockHeight(3), 128)
})

test('TC-OVF-004 ★ 数量上限常量已退役：不再参与判定，仅在显式传入时生效', () => {
  // 常量仍导出（不破坏历史 import），但语义已改 —— 缺省判定完全由高度决定
  assert.equal(MAX_VISIBLE_NAMES, 3)
  assert.equal(DEFAULT_MAX_VISIBLE, Number.POSITIVE_INFINITY)
  // 6 项 + 高度充裕 → 不传 maxVisible 时 6 条全显（若 3 仍是硬上限就会只剩 3）
  const r = computeRailLayout({ total: 6, availableHeight: 800 })
  assert.equal(r.visibleCount, 6)
})

/* ---------- 核心：铺满才折叠 ---------- */

test('TC-OVF-005 空栏：total=0 → 全 0、不折叠（空栏连「更多」都不该有）', () => {
  for (const H of [null, 0, 100, 800]) {
    const r = computeRailLayout({ total: 0, availableHeight: H })
    assert.deepEqual(r, { visibleCount: 0, overflowCount: 0, collapsed: false })
  }
})

test('TC-OVF-006 ★ 没铺满 → 不出现「更多」：9 项 / 栏高 800 全显示', () => {
  const r = computeRailLayout({ total: 9, availableHeight: 800 })
  assert.equal(r.visibleCount, 9)
  assert.equal(r.overflowCount, 0)
  assert.equal(r.collapsed, false)
  // 前提校验：9 项确实放得下（放不下就不该走这条断言）
  assert.ok(itemsHeight(9) <= usableOf(800))
})

test('TC-OVF-007 ★ 名义「三个」不再是边界：3 项 + 高度充裕 / 4 项 + 高度充裕 都不折叠', () => {
  for (const total of [1, 2, 3, 4, 5]) {
    const r = computeRailLayout({ total, availableHeight: 800 })
    assert.equal(r.visibleCount, total, `${total} 项应全显`)
    assert.equal(r.overflowCount, 0, `${total} 项不应折叠`)
  }
})

test('TC-OVF-008 ★ 放不下才折叠：9 项 / 栏高 560 → 出现「更多」', () => {
  const H = 560
  const r = computeRailLayout({ total: 9, availableHeight: H })
  assert.ok(itemsHeight(9) > usableOf(H), '前提：9 项放不下')
  assert.ok(r.overflowCount > 0, '放不下必须折叠')
  assert.ok(r.visibleCount < 9)
  assert.equal(r.collapsed, true)
  // 具体数值：usable=512 → 462/66 → 7 条
  assert.equal(r.visibleCount, 7)
  assert.equal(r.overflowCount, 2)
})

test('TC-OVF-009 折叠时先给「更多」触发器留位（含它与上一项之间的 gap）', () => {
  for (const H of [200, 300, 400, 500, 560, 600]) {
    const r = computeRailLayout({ total: 9, availableHeight: H })
    if (r.overflowCount === 0) continue
    const used = itemsHeight(r.visibleCount) + RAIL_OVERFLOW_TRIGGER_H + RAIL_ITEM_GAP
    assert.ok(
      used <= usableOf(H),
      `H=${H}: 可见 ${r.visibleCount} 条 + 触发器 = ${used} 应 ≤ 可用 ${usableOf(H)}`,
    )
  }
})

test('TC-OVF-010 高度单调：栏越高，可见条数只增不减', () => {
  let prev = -1
  for (let H = 100; H <= 1000; H += 10) {
    const r = computeRailLayout({ total: 9, availableHeight: H })
    assert.ok(r.visibleCount >= prev, `H=${H} 时可见 ${r.visibleCount} < 上一档 ${prev}`)
    prev = r.visibleCount
  }
})

test('TC-OVF-011 保底 1 条：极矮时也不出现「只剩一个更多按钮」的空栏', () => {
  for (const H of [1, 40, 100, 120, 200]) {
    const r = computeRailLayout({ total: 9, availableHeight: H })
    assert.ok(r.visibleCount >= 1, `H=${H} 时应至少显示 1 条`)
  }
})

test('TC-OVF-012 ★ 「更多」只在铺满时出现（total≥2 时二者等价）', () => {
  for (let total = 2; total <= 12; total++) {
    for (let H = 60; H <= 1000; H += 37) {
      const r = computeRailLayout({ total, availableHeight: H })
      const full = itemsHeight(total) > usableOf(H)
      assert.equal(
        r.overflowCount > 0,
        full,
        `total=${total} H=${H}: 溢出 ${r.overflowCount} 与「放不下=${full}」不一致`,
      )
    }
  }
})

test('TC-OVF-013 不丢项：visible + overflow ≡ total（任意输入）', () => {
  for (let total = 0; total <= 15; total++) {
    for (const H of [null, 0, -5, 80, 300, 560, 900, Number.NaN]) {
      const r = computeRailLayout({ total, availableHeight: H })
      assert.equal(r.visibleCount + r.overflowCount, total, `total=${total} H=${String(H)}`)
    }
  }
})

test('TC-OVF-014 预留高度（已隐藏区）参与判定：预留越多，可见越少且可能触发折叠', () => {
  const base = computeRailLayout({ total: 9, availableHeight: 800 })
  assert.equal(base.overflowCount, 0, '前提：不预留时 9 项放得下')

  let prev = base.visibleCount
  for (const reserved of [100, 200, 300, 400]) {
    const r = computeRailLayout({ total: 9, availableHeight: 800, reservedHeight: reserved })
    assert.ok(r.visibleCount <= prev, `预留 ${reserved} 时可见 ${r.visibleCount} > ${prev}`)
    assert.ok(itemsHeight(r.visibleCount) <= usableOf(800, reserved), '不得超出预留后的空间')
    prev = r.visibleCount
  }
  const tight = computeRailLayout({ total: 9, availableHeight: 800, reservedHeight: 400 })
  assert.ok(tight.overflowCount > 0, '预留 400 后 9 项已放不下 → 必须折叠')
})

/* ---------- 未测量：绝不凭「没量到」冒「更多」 ---------- */

test('TC-OVF-015 ★ 未测量（null）→ 不折叠、全显示', () => {
  const r = computeRailLayout({ total: 9, availableHeight: null })
  assert.equal(r.visibleCount, 9)
  assert.equal(r.overflowCount, 0)
  assert.equal(r.collapsed, false)
})

test('TC-OVF-016 非法高度（NaN / 0 / 负数）→ 同「未测量」，一律不折叠', () => {
  for (const H of [Number.NaN, 0, -1, -100]) {
    const r = computeRailLayout({ total: 9, availableHeight: H })
    assert.equal(r.visibleCount, 9, `H=${String(H)} 不应折叠`)
    assert.equal(r.overflowCount, 0)
    assert.equal(r.collapsed, false)
  }
})

/* ---------- maxVisible：口径回退逃生口 ---------- */

test('TC-OVF-017 ★ 显式 maxVisible=3 可恢复 v0.34.2 的「≤3 硬上限」', () => {
  const r = computeRailLayout({ total: 9, availableHeight: 800, maxVisible: 3 })
  assert.equal(r.visibleCount, 3)
  assert.equal(r.overflowCount, 6)
  assert.equal(r.collapsed, true)
})

test('TC-OVF-018 maxVisible 边界：非法值按缺省（不限）处理，不出现 0 或负上限', () => {
  const t = (mv: unknown) =>
    computeRailLayout({ total: 9, availableHeight: 800, maxVisible: mv as number })
  assert.equal(t(Number.NaN).visibleCount, 9, 'NaN → 不限')
  assert.equal(t(Number.POSITIVE_INFINITY).visibleCount, 9, 'Infinity → 不限')
  assert.equal(t(0).visibleCount, 1, '0 → 夹到最小 1（不是 0 或负）')
  assert.equal(t(-5).visibleCount, 1, '负数 → 夹到最小 1')
  // 高度放不下时，maxVisible 只做「上限」，实际仍受高度约束
  const tight = computeRailLayout({ total: 9, availableHeight: 300, maxVisible: 99 })
  assert.ok(tight.visibleCount < 9, '高度才是硬约束')
})

/* ---------- 可见段选取（激活项恒可见） ---------- */

test('TC-OVF-019 pickVisibleTabs：顺序恒等于输入，且 visible + hidden ≡ tabs', () => {
  const tabs = tabsOf(9)
  for (const n of [0, 1, 3, 7, 9]) {
    const { visible, hidden } = pickVisibleTabs(tabs, n)
    assert.equal(visible.length + hidden.length, tabs.length)
    assert.deepEqual(
      [...visible, ...hidden].map((t) => t.ref),
      tabs.map((t) => t.ref),
      '两段拼接后必须还原输入顺序',
    )
  }
  // 引用透传（不克隆）
  const { visible } = pickVisibleTabs(tabs, 3)
  assert.equal(visible[0], tabs[0])
})

test('TC-OVF-020 ★ 激活项落在折叠段 → 换进可见段（对调末位，其余次序不变）', () => {
  const tabs = tabsOf(9)
  const { visible, hidden } = pickVisibleTabs(tabs, 3, 'panel:t8')
  assert.equal(visible.length, 3)
  assert.deepEqual(
    visible.map((t) => t.ref),
    ['panel:t0', 'panel:t1', 'panel:t8'],
    '保留前 n-1 个 + 激活项，按输入顺序排列',
  )
  assert.deepEqual(
    hidden.map((t) => t.ref),
    ['panel:t2', 'panel:t3', 'panel:t4', 'panel:t5', 'panel:t6', 'panel:t7'],
    '被换出的末位落入折叠段，其余次序不变',
  )
})

test('TC-OVF-021 激活项不在表内 / 为 null / visibleCount=0 → 不做对调', () => {
  const tabs = tabsOf(5)
  const a = pickVisibleTabs(tabs, 2, 'not-exist')
  assert.deepEqual(a.visible.map((t) => t.ref), ['panel:t0', 'panel:t1'])
  const b = pickVisibleTabs(tabs, 2, null)
  assert.deepEqual(b.visible.map((t) => t.ref), ['panel:t0', 'panel:t1'])
  const c = pickVisibleTabs(tabs, 0, 'panel:t3')
  assert.equal(c.visible.length, 0)
  assert.equal(c.hidden.length, 5, 'visibleCount=0 → 全部进折叠段（弹层仍可用）')
})
