/* ============================================================
 * v0.33.0 — 主题 token 净化契约（TC-THM-001..008）
 * 规格见 testcases/00-cumulative-matrix.md §5；
 * 被测：shared/utils/theme-tokens.ts（值白名单 + 只覆盖不新增）
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs theme-tokens
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isEmptyTheme,
  isSafeTokenValue,
  mergeThemeTokens,
  sanitizeThemeTokens,
} from '../theme-tokens.js'

test('TC-THM-001 十六进制颜色放行（3/4/6/8 位）', () => {
  for (const v of ['#fff', '#ffffff', '#ffffffaa', '#f0fa']) {
    assert.equal(isSafeTokenValue(v), true, v)
  }
  assert.equal(isSafeTokenValue('#ff'), false, '位数不足拒绝')
  assert.equal(isSafeTokenValue('#fffff'), false, '5 位拒绝')
  assert.equal(isSafeTokenValue('#gggggg'), false)
})

test('TC-THM-002 函数式颜色放行（rgb/rgba/hsl/hsla）', () => {
  for (const v of ['rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'hsl(120, 50%, 50%)', 'hsla(120,50%,50%,0.3)']) {
    assert.equal(isSafeTokenValue(v), true, v)
  }
  assert.equal(isSafeTokenValue('calc(1px + 2px)'), false, 'calc 不在白名单')
})

test('TC-THM-003 长度放行（px/rem/em/%）', () => {
  for (const v of ['12px', '1.5rem', '0.5em', '100%']) {
    assert.equal(isSafeTokenValue(v), true, v)
  }
})

test('TC-THM-004 注入面全部拒绝（默认拒绝纪律）', () => {
  for (const v of ['url(evil)', 'expression(x)', 'var(--x)', 'red; background:url(x)', 'red', '']) {
    assert.equal(isSafeTokenValue(v), false, JSON.stringify(v))
  }
  assert.equal(isSafeTokenValue(42), false, '非字符串一律 false')
})

test('TC-THM-005 合法键值保留；键无 -- 前缀 / 含大写 → rejected 并带 reason', () => {
  const r = sanitizeThemeTokens({
    light: { '--accent': '#3b82f6', 'accent': '#111', '--Accent': '#222' },
    dark: { '--accent': '#60a5fa' },
  })
  assert.equal(r.tokens.light['--accent'], '#3b82f6')
  assert.equal(r.tokens.dark['--accent'], '#60a5fa')
  assert.equal(r.rejected.length, 2)
  for (const rej of r.rejected) {
    assert.ok(rej.reason.length > 0, 'rejected 必须带原因')
    assert.equal(rej.group, 'light')
  }
})

test('TC-THM-006 值为数字 / 布尔 / 对象 → rejected（类型防御）', () => {
  const r = sanitizeThemeTokens({ light: { '--a': 1, '--b': true, '--c': { x: 1 }, '--d': '#fff' } })
  assert.equal(Object.keys(r.tokens.light).length, 1)
  assert.equal(r.rejected.length, 3)
})

test('TC-THM-007 非对象输入 → 空集合 + 不抛错', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    assert.doesNotThrow(() => sanitizeThemeTokens(bad))
    const r = sanitizeThemeTokens(bad)
    assert.equal(isEmptyTheme(r.tokens), true)
    // 数组/字符串也算非对象 → 空结果（组缺失不视为错误）
  }
  // 组缺失 → 该组空集，不算错误
  const half = sanitizeThemeTokens({ light: { '--a': '#fff' } })
  assert.equal(half.tokens.dark && Object.keys(half.tokens.dark).length, 0)
  assert.equal(half.rejected.length, 0)
})

test('TC-THM-008 light / dark 互不串味（同键不同值各自保留）', () => {
  const r = sanitizeThemeTokens({ light: { '--accent': '#3b82f6' }, dark: { '--accent': '#60a5fa' } })
  assert.notEqual(r.tokens.light['--accent'], r.tokens.dark['--accent'])
  const merged = mergeThemeTokens(r.tokens, { light: { '--accent': '#111111' } })
  assert.equal(merged.light['--accent'], '#111111', '后者覆盖前者')
  assert.equal(merged.dark['--accent'], '#60a5fa', 'dark 不被 light 覆盖波及')
  assert.equal(isEmptyTheme(mergeThemeTokens(null, undefined)), true)
})
