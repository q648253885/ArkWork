/* ============================================================
 * ArkWork — 竖排栏高度自适应折叠（TC-OVF 组）
 * 规格来源：docs/versions/v0.34.2/04-system-design.md §2
 *
 * ⚠️ 口径取代登记（不是静默改动）：
 *   D54（v0.34.0）的 TC-OVF-001..008 断言的是「**插件面板** ≤3、内置全留」，
 *   而该口径经用户实测复报后被判定为**需求读错**——竖排栏实测仍渲染
 *   6 内置 + 3 插件 = 9 个名称。用户 v0.34.2 复报原文：
 *     ① 「显示的侧边栏名称超过三个会挤压溢出」
 *     ② 「右侧侧边栏栏目如果超过侧边栏容纳范围高度，需要有折叠机制」
 *   新规则：**可见条数 = min(名称上限 3, 可用高度能容纳的条数)**，
 *   被折叠项（内置与插件一视同仁）全部进「更多」弹层。
 *   故本组整体重写为 TC-OVF-001..013；D54 的「插件专属上限」语义已退役，
 *   退役记录见 docs/versions/v0.34.2/00-release-goal.md §3。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs inspector-overflow
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_VISIBLE_NAMES,
  RAIL_COLLAPSE_BTN_H,
  RAIL_HIDDEN_BLOCK_BASE_H,
  RAIL_ITEM_GAP,
  RAIL_ITEM_H,
  RAIL_OVERFLOW_TRIGGER_H,
  RAIL_PADDING_Y,
  computeRailLayout,
  hiddenBlockHeight,
  itemsHeight,
  pickVisibleTabs,
} from '../rail-tab-overflow.js'

/** 造 n 个条目（builtin 只为可读性，新规则不再区分来源） */
const tabsOf = (n: number, prefix = 'panel:t') =>
  Array.from({ length: n }, (_, i) => ({ ref: `${prefix}${i}`, builtin: i % 2 === 0 }))

/** 让「可见上限 3 条」刚好放得下的最小高度 */
const H_FULL_3 = RAIL_PADDING_Y + RAIL_COLLAPSE_BTN_H + itemsHeight(3)

/* ---------- 常量契约 ---------- */

test('TC-OVF-001 ★ 名称上限 = 3（用户定调「超过三个会挤压溢出」；改动必须回到用户确认）', () => {
  assert.equal(MAX_VISIBLE_NAMES, 3)
})

test('TC-OVF-002 尺寸常量与 Inspector 样式同源（改样式不改这里 = 折叠算错）', () => {
  assert.equal(RAIL_ITEM_H, 64, '.inspector-toolbar__item height: 64px')
  assert.equal(RAIL_ITEM_GAP, 2, '.inspector-toolbar gap: 2px')
  assert.equal(RAIL_PADDING_Y, 12, '.inspector-toolbar padding: 6px 0')
  assert.equal(RAIL_COLLAPSE_BTN_H, 36, '底部折叠按钮 h-9')
  assert.equal(RAIL_OVERFLOW_TRIGGER_H, 48, '「更多」区块 mt-1(4) + pt-2(8) + h-9(36)')
  assert.equal(RAIL_HIDDEN_BLOCK_BASE_H, 48, '「已隐藏区」首项同构')
})

test('TC-OVF-003 itemsHeight / hiddenBlockHeight：n≤0 → 0，含条目间 gap', () => {
  assert.equal(itemsHeight(0), 0)
  assert.equal(itemsHeight(-3), 0)
  assert.equal(itemsHeight(1), 64)
  assert.equal(itemsHeight(2), 130)
  assert.equal(itemsHeight(3), 196)
  assert.equal(hiddenBlockHeight(0), 0)
  assert.equal(hiddenBlockHeight(1), 48)
  assert.equal(hiddenBlockHeight(2), 88)
})

/* ---------- computeRailLayout ---------- */

test('TC-OVF-004 total = 0 → 三字段零值（不产生「空折叠」）', () => {
  assert.deepEqual(computeRailLayout({ total: 0, availableHeight: 800 }), {
    visibleCount: 0,
    overflowCount: 0,
    collapsed: false,
  })
})

test('TC-OVF-005 ★ 条数 ≤3 且高度足够 → 全可见、不折叠（够用时绝不提前收纳）', () => {
  for (const n of [1, 2, 3]) {
    const r = computeRailLayout({ total: n, availableHeight: 800 })
    assert.equal(r.visibleCount, n, `total=${n} 应全可见`)
    assert.equal(r.overflowCount, 0)
    assert.equal(r.collapsed, false)
  }
  // 恰好卡在临界高度：H_FULL_3 放得下 3 条
  assert.equal(computeRailLayout({ total: 3, availableHeight: H_FULL_3 }).collapsed, false)
})

test('TC-OVF-006 ★ 用户复报场景回归：9 个名称 + 充裕高度 → 仍只显示 3（不得按高度放开）', () => {
  const r = computeRailLayout({ total: 9, availableHeight: 1200 })
  assert.equal(r.visibleCount, 3, '≥4 个名称就是「挤压溢出」——高度再宽也不放开')
  assert.equal(r.overflowCount, 6)
  assert.equal(r.collapsed, true)
  // 高度翻倍也不改变结论（防「按测量值全放开」的回归）
  assert.equal(computeRailLayout({ total: 9, availableHeight: 4000 }).visibleCount, 3)
})

test('TC-OVF-007 ★ 诉求②：高度不够时继续减（折叠而不是撑出滚动条）', () => {
  // 刚好差 1px 放不下 3 条 → 退到 2 条
  const r = computeRailLayout({ total: 3, availableHeight: H_FULL_3 - 1 })
  assert.equal(r.visibleCount, 2)
  assert.equal(r.overflowCount, 1)
  // 极矮：连 2 条都放不下 → 1 条
  const tiny = computeRailLayout({ total: 9, availableHeight: 200 })
  assert.equal(tiny.visibleCount, 1)
  assert.equal(tiny.overflowCount, 8)
})

test('TC-OVF-008 极矮窗口仍给 1 条（绝不出现「只剩一个更多按钮」的竖排栏）', () => {
  for (const h of [1, 40, 60, 100]) {
    const r = computeRailLayout({ total: 5, availableHeight: h })
    assert.equal(r.visibleCount, 1, `H=${h} 时应保留 1 条`)
    assert.ok(r.overflowCount >= 0)
  }
})

test('TC-OVF-009 未测量（null / NaN / 0 / 负）→ 退化为「只按上限 3」', () => {
  for (const h of [null, Number.NaN, 0, -100]) {
    const r = computeRailLayout({ total: 7, availableHeight: h })
    assert.equal(r.visibleCount, 3, `availableHeight=${String(h)} 应退化为条数上限`)
    assert.equal(r.overflowCount, 4)
  }
  // 未测量且条数本来就 ≤3 → 不折叠（首帧不该闪出一个假的「更多」）
  assert.equal(computeRailLayout({ total: 2, availableHeight: null }).collapsed, false)
})

test('TC-OVF-010 预留高度（已隐藏区）参与预算：同样高度、有隐藏区时更早折叠', () => {
  const H = 260
  const noReserve = computeRailLayout({ total: 3, availableHeight: H, reservedHeight: 0 })
  const withReserve = computeRailLayout({ total: 3, availableHeight: H, reservedHeight: hiddenBlockHeight(1) })
  assert.equal(noReserve.visibleCount, 3, '无隐藏区时 3 条放得下')
  assert.equal(withReserve.visibleCount, 1, '隐藏区吃掉高度后应更早折叠')
})

test('TC-OVF-011 maxVisible 可配置（为后续「用户自定义上限」留口），非法值夹到 ≥1', () => {
  assert.equal(computeRailLayout({ total: 3, availableHeight: 800, maxVisible: 1 }).visibleCount, 1)
  assert.equal(computeRailLayout({ total: 9, availableHeight: 800, maxVisible: 5 }).visibleCount, 5)
  assert.equal(computeRailLayout({ total: 9, availableHeight: 800, maxVisible: 0 }).visibleCount, 1)
  assert.equal(computeRailLayout({ total: 9, availableHeight: 800, maxVisible: -2 }).visibleCount, 1)
})

test('TC-OVF-012 输出自洽：visible + hidden = total 恒成立（不丢项、不重复）', () => {
  for (const total of [0, 1, 3, 4, 9, 20]) {
    for (const h of [null, 120, 240, 400, 900]) {
      const r = computeRailLayout({ total, availableHeight: h })
      assert.equal(r.visibleCount + r.overflowCount, total, `total=${total} h=${String(h)}`)
      assert.ok(r.visibleCount >= 0)
      assert.equal(r.collapsed, r.overflowCount > 0)
    }
  }
})

/* ---------- pickVisibleTabs ---------- */

test('TC-OVF-013 可见/折叠两段保持输入顺序，且引用透传（UI 需要同一 ref）', () => {
  const tabs = tabsOf(6)
  const { visible, hidden } = pickVisibleTabs(tabs, 3)
  assert.deepEqual(visible.map((t) => t.ref), ['panel:t0', 'panel:t1', 'panel:t2'])
  assert.deepEqual(hidden.map((t) => t.ref), ['panel:t3', 'panel:t4', 'panel:t5'])
  assert.equal(visible[0], tabs[0], '不得克隆元素')
  assert.equal(hidden[0], tabs[3])
  assert.equal(visible.length + hidden.length, tabs.length)
})

test('TC-OVF-014 visibleCount = 0 → 全部进折叠段（弹层仍可用，不丢项）', () => {
  const tabs = tabsOf(4)
  const { visible, hidden } = pickVisibleTabs(tabs, 0)
  assert.deepEqual(visible, [])
  assert.deepEqual(hidden, tabs)
  // 负数同义；超长（> length）→ 全部可见
  assert.deepEqual(pickVisibleTabs(tabs, -1).visible, [])
  assert.equal(pickVisibleTabs(tabs, 99).hidden.length, 0)
})

test('TC-OVF-015 ★ 激活项落在折叠段 → 换入可见段（可见段最后一位被换出）', () => {
  const tabs = tabsOf(6)
  const { visible, hidden } = pickVisibleTabs(tabs, 3, 'panel:t4')
  assert.deepEqual(visible.map((t) => t.ref), ['panel:t0', 'panel:t1', 'panel:t4'], '输入顺序不变，只换人')
  assert.deepEqual(hidden.map((t) => t.ref), ['panel:t2', 'panel:t3', 'panel:t5'])
  assert.equal(visible.length + hidden.length, tabs.length, '不丢项')
  assert.equal(new Set([...visible, ...hidden].map((t) => t.ref)).size, tabs.length, '不重复')
})

test('TC-OVF-016 激活项本就在可见段 / ref 不存在 / 未传 → 一律不动', () => {
  const tabs = tabsOf(6)
  assert.deepEqual(pickVisibleTabs(tabs, 3, 'panel:t1').visible.map((t) => t.ref), ['panel:t0', 'panel:t1', 'panel:t2'])
  assert.deepEqual(pickVisibleTabs(tabs, 3, 'panel:ghost').hidden.map((t) => t.ref), ['panel:t3', 'panel:t4', 'panel:t5'])
  assert.deepEqual(pickVisibleTabs(tabs, 3, null).visible.map((t) => t.ref), ['panel:t0', 'panel:t1', 'panel:t2'])
  assert.deepEqual(pickVisibleTabs(tabs, 3).visible.map((t) => t.ref), ['panel:t0', 'panel:t1', 'panel:t2'])
})

test('TC-OVF-017 泛型保形：额外字段（title/icon）随元素原样透传（弹层要渲染它们）', () => {
  interface RichTab {
    ref: string
    builtin: boolean
    title: string
    icon: string
  }
  const tabs: RichTab[] = Array.from({ length: 5 }, (_, i) => ({
    ref: `panel:p${i}`,
    builtin: false,
    title: `面板 ${i}`,
    icon: 'Plug',
  }))
  const r = computeRailLayout({ total: tabs.length, availableHeight: 200 })
  assert.equal(r.visibleCount, 1, 'H=200 只放得下 1 条（本用例顺带锁住高度口径）')
  const { visible, hidden } = pickVisibleTabs(tabs, r.visibleCount, 'panel:p4')
  assert.equal(visible.length, 1)
  assert.equal(visible[0]!.title, '面板 4', '激活项换入后仍带着自己的标题')
  assert.equal(visible[0]!.icon, 'Plug')
  assert.equal(hidden[0]!.title, '面板 0', '被换出的那一位落进折叠段（不丢项）')
  assert.equal(hidden.length, tabs.length - 1)
})
