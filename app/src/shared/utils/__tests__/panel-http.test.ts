/* ============================================================
 * ArkWork — `http` 面板数据源的声明式映射（纯函数 · v0.34.1）
 * 规格来源：docs/versions/v0.34.1/04-system-design.md §5.3
 *
 * 为什么这组用例必须存在：映射器吃的是**第三方接口的响应**，形状随时会变。
 * 它一旦抛错，面板就白屏 —— 而白屏的原因（「接口改版了」）在 UI 上完全看不出来。
 * 因此这里用**真实接口快照**逐条钉住「永不抛错 + 形状正确 + 不静默造假」。
 *
 * 快照来源：东方财富公开行情接口（2026-09-18 实测），已裁剪为最小可断言形态。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs panel-http
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapHttpResponse, resolvePath } from '../panel-http.js'
import { applyTemplate, clampPollMs, PANEL_POLL_MIN_MS } from '@shared/types/vlib'

/* ---- 真实接口快照（结构保真，仅裁剪条数） ---- */
const QUOTES = {
  rc: 0,
  data: {
    total: 3,
    diff: [
      { f2: 1257.12, f3: -0.78, f12: '600519', f13: 1, f14: '贵州茅台' },
      { f2: 11.7, f3: 0.78, f12: '000001', f13: 0, f14: '平安银行' },
    ],
  },
}

const DETAIL = {
  rc: 0,
  data: { f43: 1257.12, f57: '600519', f58: '贵州茅台', f170: -0.78 },
}

const KLINES = {
  rc: 0,
  data: {
    code: '600519',
    klines: [
      '2026-09-17,1257.98,1266.98,1267.60,1254.00,17554,2217338283.00',
      '2026-09-18,1262.99,1257.12,1265.88,1256.10,24891,3135849108.00',
    ],
  },
}

/* ============================================================
 * 1. 路径取值
 * ============================================================ */

test('TC-PHTTP-001 resolvePath 命中/缺失/越层都返回 undefined 而不抛错', () => {
  assert.deepEqual(resolvePath(QUOTES, 'data.diff'), QUOTES.data.diff)
  assert.equal(resolvePath(QUOTES, 'data.nope'), undefined)
  assert.equal(resolvePath(QUOTES, 'data.diff.0.f14.deep'), undefined, '在数组上继续取属性 → undefined')
  assert.equal(resolvePath(null, 'a.b'), undefined)
  assert.equal(resolvePath(QUOTES, undefined), QUOTES, '无 path 时返回原对象')
})

/* ============================================================
 * 2. 三种元素形态
 * ============================================================ */

test('TC-PHTTP-002 对象数组 + columns：按字段名取列', () => {
  const res = mapHttpResponse(QUOTES, {
    url: 'https://x',
    path: 'data.diff',
    columns: [
      { key: 'f14', label: '名称' },
      { key: 'f2', label: '最新价' },
    ],
  })
  assert.equal(res.rows.length, 2)
  assert.deepEqual(res.rows[0], { f14: '贵州茅台', f2: 1257.12 })
  assert.equal(res.columns?.length, 2)
})

test('TC-PHTTP-003 单个对象 → 自动包成一行（个股详情接口就是这个形态）', () => {
  const res = mapHttpResponse(DETAIL, {
    url: 'https://x',
    path: 'data',
    columns: [{ key: 'f58', label: '名称' }, { key: 'f43', label: '最新价' }],
  })
  assert.equal(res.rows.length, 1, '对象必须包成单行，否则详情面板永远空')
  assert.deepEqual(res.rows[0], { f58: '贵州茅台', f43: 1257.12 })
})

test('TC-PHTTP-004 分隔符字符串数组 + columns：按位置取列（K 线接口形态）', () => {
  const res = mapHttpResponse(KLINES, {
    url: 'https://x',
    path: 'data.klines',
    split: ',',
    columns: [
      { key: 'date', label: '日期' },
      { key: 'open', label: '开盘' },
      { key: 'close', label: '收盘' },
      { key: 'high', label: '最高' },
      { key: 'low', label: '最低' },
    ],
  })
  assert.equal(res.rows.length, 2)
  assert.deepEqual(res.rows[1], {
    date: '2026-09-18',
    open: '1262.99',
    close: '1257.12',
    high: '1265.88',
    low: '1256.10',
  })
  // CandleChart 需要 date/open/high/low/close 五个键都能被解析成数字
  const row1 = res.rows[1]! as unknown as Record<string, string>
  for (const k of ['open', 'close', 'high', 'low']) {
    assert.ok(Number.isFinite(Number(row1[k])), `${k} 必须是数字字符串`)
  }
})

/* ============================================================
 * 3. 派生列与 limit
 * ============================================================ */

test('TC-PHTTP-005 derive 派生列：把「市场.代码」拼成 secid', () => {
  const res = mapHttpResponse(QUOTES, {
    url: 'https://x',
    path: 'data.diff',
    columns: [{ key: 'f12', label: '代码' }, { key: 'f13', label: '市场' }],
    derive: { secid: '{{f13}}.{{f12}}' },
  })
  assert.equal(res.rows[0]!.secid, '1.600519')
  assert.equal(res.rows[1]!.secid, '0.000001')
})

test('TC-PHTTP-006 limit 只取最近 N 条（K 线只要最近 120 根）', () => {
  const many = { data: { klines: Array.from({ length: 5 }, (_, i) => `d${i},1,2,3,4`) } }
  const res = mapHttpResponse(many, {
    url: 'https://x',
    path: 'data.klines',
    split: ',',
    columns: [{ key: 'date', label: '日期' }],
    limit: 2,
  })
  assert.equal(res.rows.length, 2)
  assert.deepEqual(res.rows.map((r) => r.date), ['d3', 'd4'], '必须取**最近**的，不是最前面的')
})

/* ============================================================
 * 4. 坏输入：永不抛错、不静默造假
 * ============================================================ */

test('TC-PHTTP-007 坏输入一律返回空行 + 诊断说明（绝不抛错、绝不造一行假数据）', () => {
  const cases: Array<[string, unknown, string | undefined]> = [
    ['null 响应', null, 'data.diff'],
    ['字符串响应', 'not json', 'data.diff'],
    ['路径命中字符串', QUOTES, 'data.total'],
    ['路径不存在', QUOTES, 'a.b.c'],
    ['空数组', { data: { diff: [] } }, 'data.diff'],
  ]
  for (const [name, payload, path] of cases) {
    const res = mapHttpResponse(payload, { url: 'https://x', path })
    assert.equal(res.rows.length, 0, `${name} 应得到空行`)
    assert.ok(res.note, `${name} 必须给出人话诊断（不能让用户对着空白面板猜）`)
  }
})

test('TC-PHTTP-008 数组里的非对象/非字符串元素被跳过而不是塞进 rows', () => {
  const res = mapHttpResponse({ data: { diff: [null, 42, { f14: 'x' }] } }, {
    url: 'https://x',
    path: 'data.diff',
    columns: [{ key: 'f14', label: '名称' }],
  })
  assert.equal(res.rows.length, 1)
  assert.deepEqual(res.rows[0], { f14: 'x' })
})

/* ============================================================
 * 5. 模板与轮询夹取（同一套语义：URL 参数化与派生列共用）
 * ============================================================ */

test('TC-PHTTP-009 applyTemplate：命中替换、缺失保留原样（缺失不静默变空串）', () => {
  assert.equal(
    applyTemplate('https://x?secid={{secid}}&f=1', { secid: '1.600519' }),
    'https://x?secid=1.600519&f=1',
  )
  assert.equal(applyTemplate('a={{nope}}', {}), 'a={{nope}}', '未提供的参数必须原样保留 —— 静默变空会打出错误请求')
  assert.equal(applyTemplate('{{ a }}', { a: 'v' }), 'v', '允许空白')
})

test('TC-PHTTP-010 clampPollMs 夹到 [3000, 600000]，非法值返回 undefined', () => {
  assert.equal(clampPollMs(100), PANEL_POLL_MIN_MS, '手抖写 100ms 必须被夹 —— 否则把行情接口当 DDoS 打')
  assert.equal(clampPollMs(8000), 8000)
  assert.equal(clampPollMs(10_000_000), 600000)
  assert.equal(clampPollMs(0), undefined)
  assert.equal(clampPollMs(undefined), undefined)
  assert.equal(clampPollMs('8000'), undefined)
  assert.equal(clampPollMs(Number.NaN), undefined)
})
