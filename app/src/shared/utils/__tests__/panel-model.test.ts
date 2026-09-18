/* ============================================================
 * v0.33.0 — 面板模型纯函数契约（TC-PLM-001..014）
 * 规格见 testcases/00-cumulative-matrix.md §2；
 * 被测：shared/utils/panel-model.ts（插槽条目 → Inspector 面板 Tab）
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs panel-model
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOCK_TAB_TO_INSPECTOR,
  INSPECTOR_TAB_REFS,
  builtinTabsOf,
  isPanelTabRef,
  mergePanelOrder,
  panelRefToInspectorTab,
  panelTabsOf,
  type PanelTab,
} from '../panel-model.js'
import type { SlotEntry } from '@shared/types/profile'
import type { PanelData, PanelSlotPayload } from '@shared/types/vlib'

/** 合法插件面板条目（最小可用载荷） */
function pluginPanelEntry(over: Partial<SlotEntry> = {}): SlotEntry {
  const data: PanelData = { kind: 'static', rows: [{ symbol: '600519', px: 1 }] }
  const payload: PanelSlotPayload = {
    panelRef: 'panel:watchlist',
    title: '自选股',
    component: 'DataTable',
    data,
    pluginId: 'ark.plugin.watchlist',
  }
  return {
    id: 'panel:watchlist',
    kind: 'ui.panel',
    label: '自选股',
    source: 'plugin',
    position: 3,
    payload,
    ...over,
  }
}

/* ============================================================
 * panelRefToInspectorTab（归一）
 * ============================================================ */

test('TC-PLM-001 六个内置名原样返回；progress 归一为 logs；panel:x 原样返回', () => {
  for (const t of ['files', 'context', 'terminal', 'browser', 'todos']) {
    assert.equal(panelRefToInspectorTab(t), t)
    assert.equal(panelRefToInspectorTab(`panel:${t}`), t)
  }
  // progress 是 RightDock 时代遗留 → Inspector 里对应 logs
  assert.equal(panelRefToInspectorTab('progress'), 'logs')
  assert.equal(panelRefToInspectorTab('panel:progress'), 'logs')
  // 非内置的插件面板 ref 原样保留
  assert.equal(panelRefToInspectorTab('panel:watchlist'), 'panel:watchlist')
})

test('TC-PLM-002 非法输入（空串 / 大写 / 含空格 / 冒号后空）返回 null', () => {
  assert.equal(panelRefToInspectorTab(''), null)
  assert.equal(panelRefToInspectorTab('FILES'), null, '裸名必须精确小写')
  assert.equal(panelRefToInspectorTab('a b'), null)
  assert.equal(panelRefToInspectorTab('panel:'), null, '冒号后必须有名字')
  assert.equal(panelRefToInspectorTab('panel:Watchlist'), null, '插件面板名也必须小写起始')
  assert.equal(panelRefToInspectorTab(42), null)
  assert.equal(panelRefToInspectorTab(undefined), null)
})

/* ============================================================
 * panelTabsOf（过滤 + 守卫）
 * ============================================================ */

test('TC-PLM-003 只挑 kind 为 ui.panel 的条目，其余 kind 全部忽略', () => {
  const others: SlotEntry[] = [
    { id: 'renderer:kchart', kind: 'ui.renderer', label: 'x', payload: { rendererKind: 'table', extensions: ['kchart'], override: true, labelKey: 'x' } },
    { id: 'action:mark', kind: 'ui.action', label: 'y', payload: { actionId: 'mark', label: '标记', origin: 'test' } },
  ]
  const tabs = panelTabsOf([...others, pluginPanelEntry()])
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0]!.ref, 'panel:watchlist')
})

test('TC-PLM-004 payload 缺 component / data / title 的条目被跳过（不抛错）', () => {
  const entries: SlotEntry[] = [
    pluginPanelEntry({ payload: { panelRef: 'panel:a', title: 'A' } as unknown as PanelSlotPayload }), // 缺 component/data
    pluginPanelEntry({ payload: { panelRef: 'panel:b', component: 'DataTable', data: { kind: 'static', rows: [] } } as unknown as PanelSlotPayload }), // 缺 title
  ]
  assert.equal(panelTabsOf(entries).length, 0, '磁盘手改的残缺载荷必须被守卫拦下')
})

test('TC-PLM-005 component 不在 VLIB 白名单 → 跳过', () => {
  const bad = pluginPanelEntry({
    payload: {
      panelRef: 'panel:x',
      title: 'X',
      component: 'ArbitraryReactComponent' as never,
      data: { kind: 'static', rows: [] },
    },
  })
  assert.equal(panelTabsOf([bad]).length, 0, '插件不得注入白名单外的组件')
})

test('TC-PLM-006 内置名条目：builtin=true 且无 component', () => {
  const e: SlotEntry = {
    id: 'panel:files',
    kind: 'ui.panel',
    label: '文件',
    source: 'profile',
    payload: { panelRef: 'panel:files', title: '文件', builtin: true },
  }
  const tabs = panelTabsOf([e])
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0]!.ref, 'files')
  assert.equal(tabs[0]!.builtin, true)
  assert.equal(tabs[0]!.component, undefined, '内置 Tab 由 Inspector 既有分支渲染，不认 payload.component')
})

test('TC-PLM-007 pluginId 透传（供诊断归属）', () => {
  const [tab] = panelTabsOf([pluginPanelEntry()])
  assert.equal(tab?.pluginId, 'ark.plugin.watchlist')
})

/* ============================================================
 * mergePanelOrder（position 插入 / 去重 / 确定性）
 * ============================================================ */

const BASE = builtinTabsOf(['todos', 'context', 'files', 'logs'])
const panel = (ref: string, position?: number): PanelTab => ({
  ref,
  title: ref,
  builtin: false,
  position,
})

test('TC-PLM-008 无面板 → 返回 base 原样（逐元素相等）', () => {
  const out = mergePanelOrder(BASE, [])
  assert.deepEqual(out.map((t) => t.ref), BASE.map((t) => t.ref))
})

test('TC-PLM-009 position 缺省 → 追加到末尾，按 ref 字典序（确定性优先于输入顺序）', () => {
  // 设计语义：同缺省位次的面板与 TC-PLM-012 同规 —— 按 ref 字典序，
  // 两次调用（即使输入顺序不同）结果逐位相同。
  const out = mergePanelOrder(BASE, [panel('panel:b'), panel('panel:a')])
  assert.deepEqual(out.map((t) => t.ref), ['todos', 'context', 'files', 'logs', 'panel:a', 'panel:b'])
  const rev = mergePanelOrder(BASE, [panel('panel:a'), panel('panel:b')])
  assert.deepEqual(out.map((t) => t.ref), rev.map((t) => t.ref))
})

test('TC-PLM-010 position 0 → 置顶于 base 之前', () => {
  const out = mergePanelOrder(BASE, [panel('panel:top', 0)])
  assert.equal(out[0]!.ref, 'panel:top')
  assert.equal(out.length, BASE.length + 1)
})

test('TC-PLM-011 position 越界（负 / 超长）→ clamp 到 [0, base.length]', () => {
  // 负数在 panelTabsOf 归一为缺省，但 mergePanelOrder 自己也 clamp —— 双层防御
  const clamped = mergePanelOrder(BASE, [panel('panel:mid', 2)])
  assert.deepEqual(clamped.map((t) => t.ref), ['todos', 'context', 'panel:mid', 'files', 'logs'])
  const over = mergePanelOrder(BASE, [panel('panel:end', 999)])
  assert.equal(over.at(-1)!.ref, 'panel:end')
})

test('TC-PLM-012 同 position → 按 ref 字典序（两次调用结果相同）', () => {
  const panels = [panel('panel:z', 1), panel('panel:a', 1), panel('panel:m', 1)]
  const once = mergePanelOrder(BASE, panels)
  const twice = mergePanelOrder(BASE, [...panels].reverse())
  assert.deepEqual(once.map((t) => t.ref), twice.map((t) => t.ref), '输入顺序不得影响结果（确定性）')
  assert.deepEqual(once.map((t) => t.ref), ['todos', 'panel:a', 'panel:m', 'panel:z', 'context', 'files', 'logs'])
})

test('TC-PLM-013 面板 ref 已在 base 中 → 不重复插入（以 base 位置为准）', () => {
  const out = mergePanelOrder(BASE, [panel('files', 0)])
  assert.deepEqual(out.map((t) => t.ref), ['todos', 'context', 'files', 'logs'])
})

test('TC-PLM-014 position 为 NaN / 非整数 → 按缺省（追加末尾）处理', () => {
  // NaN/小数经 panelTabsOf 归一为 undefined；这里直接造 mergePanelOrder 输入
  const out = mergePanelOrder(BASE, [
    { ref: 'panel:n', title: 'n', builtin: false, position: Number.NaN },
    { ref: 'panel:f', title: 'f', builtin: false, position: 1.5 },
  ])
  assert.deepEqual(out.map((t) => t.ref), ['todos', 'context', 'files', 'logs', 'panel:n', 'panel:f'])
})

/* ============================================================
 * 附属契约（INSPECTOR_TAB_REFS / isPanelTabRef 的同源一致性）
 * ============================================================ */

test('TC-PLM-015 归一表与 Inspector 内置全集互洽（progress 例外已注明）', () => {
  // DOCK_TAB_TO_INSPECTOR 的值域 ⊆ INSPECTOR_TAB_REFS ∪ {logs 归一目标}
  for (const v of Object.values(DOCK_TAB_TO_INSPECTOR)) {
    assert.ok((INSPECTOR_TAB_REFS as readonly string[]).includes(v), `归一目标 ${v} 必须是 Inspector 内置 Tab`)
  }
  assert.ok(isPanelTabRef('panel:watchlist'))
  assert.equal(isPanelTabRef('todos'), false)
})
