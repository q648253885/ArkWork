/* ============================================================
 * v0.33.0 — 宿主组件数据形状校验契约（TC-VD-001..011）
 * 规格见 testcases/00-cumulative-matrix.md §4；
 * 被测：shared/utils/vlib-data.ts（「组件只认形状，不认业务」的执行者）
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs vlib-data
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPanelDataEmpty, listVLibComponents, validatePanelData } from '../vlib-data.js'
import { VLIB_COMPONENTS, VLIB_DATA_REQUIREMENT, PANEL_DATA_KINDS, isPanelDataKind } from '@shared/types/vlib'

/** 按组件需求造一份「最小正确形状」的数据；kind 可切换（D61 起表驱动遍历全部 kind） */
function goodData(component: string, kind: string = 'static'): Record<string, unknown> {
  switch (VLIB_DATA_REQUIREMENT[component as keyof typeof VLIB_DATA_REQUIREMENT]) {
    case 'rows': return { kind, rows: [{ a: 1 }] }
    case 'metrics': return { kind, metrics: [{ label: '涨幅', value: '+1.2%' }] }
    case 'points': return { kind, points: [1, 2, 3] }
    case 'text': return { kind, text: '# 标题' }
    case 'value': return { kind, value: { any: 'thing' } }
    default: return { kind }
  }
}

test('TC-VD-001 DataTable + rows:[] → ok；缺 rows → error（原因含 rows）', () => {
  assert.deepEqual(validatePanelData('DataTable', { kind: 'static', rows: [] }), { ok: true }, '空数组是 empty 态不是形状错')
  const bad = validatePanelData('DataTable', { kind: 'static' })
  assert.equal(bad.ok, false)
  assert.match(bad.ok ? '' : bad.reason, /rows/)
})

test('TC-VD-002 表格类四组件同样接受 rows', () => {
  for (const c of ['CandleChart', 'TimelineBoard', 'MediaGrid', 'KeyValueList']) {
    assert.deepEqual(validatePanelData(c, { kind: 'static', rows: [{ k: 'v' }] }), { ok: true }, c)
    assert.equal(validatePanelData(c, { kind: 'static' }).ok, false, c)
  }
})

test('TC-VD-003 MetricCard + metrics:[] → ok；缺 → error', () => {
  assert.deepEqual(validatePanelData('MetricCard', { kind: 'static', metrics: [] }), { ok: true })
  const bad = validatePanelData('MetricCard', { kind: 'static', rows: [{ a: 1 }] })
  assert.equal(bad.ok, false)
  assert.match(bad.ok ? '' : bad.reason, /metrics/)
})

test('TC-VD-004 Sparkline：points 含非数字 → error', () => {
  assert.equal(validatePanelData('Sparkline', { kind: 'static', points: [1, 'a', 3] }).ok, false)
  assert.equal(validatePanelData('Sparkline', { kind: 'static', points: [1, Number.NaN, 3] }).ok, false, 'NaN 也不放行')
  assert.deepEqual(validatePanelData('Sparkline', { kind: 'static', points: [1, 2.5, 3] }), { ok: true })
})

test('TC-VD-005 Sparkline + points:[] → ok（empty 态归 PanelHost，不是形状错）', () => {
  assert.deepEqual(validatePanelData('Sparkline', { kind: 'static', points: [] }), { ok: true })
  assert.equal(isPanelDataEmpty('Sparkline', { kind: 'static', points: [] }), true, '空由 PanelHost 判')
})

test('TC-VD-006 文本组件 text 空串合法', () => {
  for (const c of ['LogStream', 'MarkdownView']) {
    assert.deepEqual(validatePanelData(c, { kind: 'static', text: '' }), { ok: true })
  }
})

test('TC-VD-007 LogStream 缺 text → error', () => {
  const bad = validatePanelData('LogStream', { kind: 'static' })
  assert.equal(bad.ok, false)
  assert.match(bad.ok ? '' : bad.reason, /text/)
})

test('TC-VD-008 JsonView：null 不算有值；{} 与 0 都算', () => {
  assert.equal(validatePanelData('JsonView', { kind: 'static', value: null }).ok, false)
  assert.deepEqual(validatePanelData('JsonView', { kind: 'static', value: {} }), { ok: true })
  assert.deepEqual(validatePanelData('JsonView', { kind: 'static', value: 0 }), { ok: true })
})

test('TC-VD-009 未知组件名 → error（原因含「未知组件」）', () => {
  const bad = validatePanelData('NotAComponent', { kind: 'static', rows: [] })
  assert.equal(bad.ok, false)
  assert.match(bad.ok ? '' : bad.reason, /未知组件/)
})

test('TC-VD-010 data 为 null / undefined → error 且不抛错', () => {
  for (const d of [null, undefined]) {
    assert.doesNotThrow(() => validatePanelData('DataTable', d))
    assert.equal(validatePanelData('DataTable', d).ok, false)
  }
  // 非对象（数组/数字）同样拦下
  assert.equal(validatePanelData('DataTable', [1, 2]).ok, false)
  assert.equal(validatePanelData('DataTable', 42).ok, false)
})

test('TC-VD-011 全部 10 组件 × 全部 4 kind 各有一条正确形状 → ok（表驱动穷尽白名单）', () => {
  assert.equal(VLIB_COMPONENTS.length, 10)
  assert.equal(PANEL_DATA_KINDS.length, 4)
  for (const c of VLIB_COMPONENTS) {
    for (const k of PANEL_DATA_KINDS) {
      // D61：此前只跑了 static + mcp，`http` 从未被穷举 —— 白名单漏项因此长期潜伏。
      // 形状校验与 kind 无关（组件只认形状），故 4 个 kind 必须等价放行。
      assert.deepEqual(validatePanelData(c, goodData(c, k)), { ok: true }, `${c} + kind=${k} 的正确形状必须通过`)
      const mcp = { ...goodData(c, k), server: 's', method: 'm' }
      assert.doesNotThrow(() => validatePanelData(c, mcp), `${c} + kind=${k}`)
    }
  }
  assert.equal(listVLibComponents().length, 10)
})

test('TC-VD-012 [D61 回归] http 源必须放行：取数成功后不得被形状层二次拒绝', () => {
  // 真实故障：面板 http 取数成功（UI 显「6 行」），却在渲染前被 validatePanelData
  // 以「未知数据源 kind「http」」拒绝 → 用户看到「插件打开失败」。
  const httpRows = { kind: 'http', rows: [{ a: 1 }] }
  assert.deepEqual(validatePanelData('DataTable', httpRows), { ok: true }, 'http + rows 必须 ok')
  assert.deepEqual(validatePanelData('KeyValueList', { kind: 'http', rows: [{ k: 'v' }] }), { ok: true })
  assert.deepEqual(validatePanelData('MetricCard', { kind: 'http', metrics: [{ label: 'x', value: '1' }] }), { ok: true })
  // http 的 http 规格对象不属于形状层职责，多带字段不影响判定
  const withSpec = { kind: 'http', rows: [{ a: 1 }], http: { url: 'https://example.com/a.json', path: 'data.list' }, pollMs: 5000 }
  assert.deepEqual(validatePanelData('DataTable', withSpec), { ok: true })
})

test('TC-VD-013 [D61 回归] 四路白名单必须共用单一事实源 isPanelDataKind（防枚举漏项）', () => {
  // 纪律：新增 kind 时任何一处硬编码 `!== 'x'` 链都会漏。此处钉住「守卫即事实源」。
  assert.equal(isPanelDataKind('static'), true)
  assert.equal(isPanelDataKind('file'), true)
  assert.equal(isPanelDataKind('http'), true, 'http 必须被事实源认可')
  assert.equal(isPanelDataKind('mcp'), true)
  assert.equal(isPanelDataKind('websocket'), false, '未登记 kind 一律拒绝')
  assert.equal(isPanelDataKind(undefined), false)
  assert.equal(isPanelDataKind(123), false)
  // 事实源必须与类型层枚举逐字一致
  for (const k of PANEL_DATA_KINDS) assert.equal(isPanelDataKind(k), true, k)
})
