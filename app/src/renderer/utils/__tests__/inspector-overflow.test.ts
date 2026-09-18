/* ============================================================
 * ArkWork — 竖排栏插件 Tab 溢出收纳（v0.34.0 · D54 · TC-OVF-001..008）
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §6.3
 *
 * 用户诉求原文：「右侧显示的名称，不应该超过三个，否则会 UI 问题」。
 * 注意措辞 —— 是「不超过三个」**名称/插件面板**，不是「把内置 Tab 也砍掉」：
 * 内置六项（清单/上下文/文件/日志/浏览器/终端）有稳定语义与快捷键，
 * 按位置收纳会摧毁肌肉记忆。因此规则是「内置全留 + 插件只留前 3」。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs inspector-overflow
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_VISIBLE_PLUGIN_TABS, splitPluginTabs, type TabLike } from '../plugin-tab-overflow.js'

const builtin = (ref: string): TabLike => ({ ref, builtin: true })
const plugin = (ref: string): TabLike => ({ ref, builtin: false })

test('TC-OVF-001 上限常量 = 3（用户定调，改动即需重新确认需求）', () => {
  assert.equal(MAX_VISIBLE_PLUGIN_TABS, 3)
})

test('TC-OVF-002 无插件 → visible 即原序列，hidden 为空（内置行为零变化）', () => {
  const tabs = [builtin('panel:todos'), builtin('panel:files'), builtin('panel:logs')]
  const { visible, hidden } = splitPluginTabs(tabs)
  assert.deepEqual(visible, tabs, '必须逐元素相等（引用同一份，不克隆）')
  assert.deepEqual(hidden, [])
})

test('TC-OVF-003 插件数 ≤ 3 → 全部可见（不该在够用时提前收纳）', () => {
  for (const n of [0, 1, 2, 3]) {
    const tabs = [
      builtin('panel:todos'),
      ...Array.from({ length: n }, (_, i) => plugin(`panel:p${i}`)),
      builtin('panel:logs'),
    ]
    const { visible, hidden } = splitPluginTabs(tabs)
    assert.equal(hidden.length, 0, `插件 ${n} 个时不应有隐藏项`)
    assert.equal(visible.length, tabs.length)
  }
})

test('TC-OVF-004 ★ 8 个插件 → 可见 3 + 隐藏 5，且**内置 6 项一个不少**', () => {
  const builtins = ['todos', 'context', 'files', 'logs', 'browser', 'terminal'].map((k) => builtin(`panel:${k}`))
  const plugins = Array.from({ length: 8 }, (_, i) => plugin(`panel:plugin-${i}`))
  // 交错排布（模拟 manifest position 混排）
  const tabs = [builtins[0]!, plugins[0]!, builtins[1]!, plugins[1]!, builtins[2]!, ...plugins.slice(2), ...builtins.slice(3)]
  const { visible, hidden } = splitPluginTabs(tabs)

  assert.equal(visible.filter((t) => t.builtin).length, 6, '内置六项必须全部可见')
  assert.equal(visible.filter((t) => !t.builtin).length, 3, '插件可见上限 3')
  assert.equal(hidden.length, 5, '其余 5 个进「更多」')
  assert.equal(hidden.every((t) => !t.builtin), true, '只有插件会被收纳')
  assert.equal(visible.length + hidden.length, tabs.length, '两段合起来必须等于输入（不丢项）')
})

test('TC-OVF-005 输出保持输入原顺序（既不重排内置，也不重排插件）', () => {
  const tabs = [plugin('panel:a'), builtin('panel:todos'), plugin('panel:b'), plugin('panel:c'), plugin('panel:d'), plugin('panel:e')]
  const { visible, hidden } = splitPluginTabs(tabs)
  assert.deepEqual(visible.map((t) => t.ref), ['panel:a', 'panel:todos', 'panel:b', 'panel:c'])
  assert.deepEqual(hidden.map((t) => t.ref), ['panel:d', 'panel:e'])
  // 隐藏段在输入里的相对顺序也必须保持
  const inputPluginOrder = tabs.filter((t) => !t.builtin).map((t) => t.ref)
  const outputPluginOrder = [...visible, ...hidden].filter((t) => !t.builtin).map((t) => t.ref)
  assert.deepEqual(outputPluginOrder, inputPluginOrder)
})

test('TC-OVF-006 边界：max ≤ 0 → 插件全部进 hidden（内置仍全留）', () => {
  const tabs = [builtin('panel:todos'), plugin('panel:a'), plugin('panel:b')]
  const zero = splitPluginTabs(tabs, 0)
  assert.deepEqual(zero.visible.map((t) => t.ref), ['panel:todos'])
  assert.deepEqual(zero.hidden.map((t) => t.ref), ['panel:a', 'panel:b'])
  const neg = splitPluginTabs(tabs, -1)
  assert.deepEqual(neg.visible.map((t) => t.ref), ['panel:todos'], '负数与 0 同义（不产生「负上限可见」）')
  assert.equal(neg.hidden.length, 2)
})

test('TC-OVF-007 空输入 / 全插件 / 全内置 三种极端形态不抛错', () => {
  assert.deepEqual(splitPluginTabs([]), { visible: [], hidden: [] })
  const allPlugins = Array.from({ length: 10 }, (_, i) => plugin(`p${i}`))
  const a = splitPluginTabs(allPlugins)
  assert.equal(a.visible.length, 3)
  assert.equal(a.hidden.length, 7)
  const allBuiltin = Array.from({ length: 6 }, (_, i) => builtin(`b${i}`))
  const b = splitPluginTabs(allBuiltin)
  assert.equal(b.visible.length, 6)
  assert.equal(b.hidden.length, 0)
})

test('TC-OVF-008 泛型保形：额外字段（title/icon）随元素原样透传（UI 需要它们渲染弹层）', () => {
  interface RichTab extends TabLike {
    title: string
    icon: string
  }
  const tabs: RichTab[] = Array.from({ length: 5 }, (_, i) => ({
    ref: `panel:p${i}`,
    builtin: false,
    title: `面板 ${i}`,
    icon: 'Plug',
  }))
  const { visible, hidden } = splitPluginTabs(tabs)
  assert.equal(visible[0]!.title, '面板 0')
  assert.equal(hidden[0]!.title, '面板 3', '弹层要能拿到被收纳项的标题')
  assert.equal(hidden[1]!.icon, 'Plug')
  // 引用同一份对象（调用方后续 setInspectorTab 需要同一 ref）
  assert.equal(visible[0], tabs[0])
})
