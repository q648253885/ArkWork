/* ============================================================
 * v0.27.1 Fix-1 — 市场 Tab 过滤已安装技能 单测
 *
 * 背景：市场 Tab 此前渲染全部市场条目，已安装技能仅置灰按钮
 * 仍占位展示。过滤谓词须与主进程安装判定一致：
 * item.installed === true 或 名称与本地已装技能重名。
 *
 * 运行（cwd=app）：./node_modules/.bin/tsx --test src/renderer/utils/__tests__/market-filter.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMarketItemInstalled, filterInstallableMarketItems } from '../market-filter.js'

test('isMarketItemInstalled: 条目自带 installed=true → 判定已安装', () => {
  assert.equal(isMarketItemInstalled({ id: 'a', name: 'X', installed: true }, new Set()), true)
})

test('isMarketItemInstalled: 名称与本地已装技能重名 → 判定已安装', () => {
  assert.equal(isMarketItemInstalled({ id: 'b', name: 'coder' }, new Set(['coder'])), true)
})

test('isMarketItemInstalled: 未安装且无重名 → 判定未安装', () => {
  assert.equal(isMarketItemInstalled({ id: 'c', name: 'writer' }, new Set(['coder'])), false)
})

test('isMarketItemInstalled: installed=false 且无重名 → 判定未安装', () => {
  assert.equal(isMarketItemInstalled({ id: 'd', name: 'reader', installed: false }, new Set(['coder'])), false)
})

test('filterInstallableMarketItems: 过滤 installed 标记与重名两类', () => {
  const items = [
    { id: '1', name: 'fresh-a' },
    { id: '2', name: 'installed-by-flag', installed: true },
    { id: '3', name: 'coder' },
    { id: '4', name: 'fresh-b' },
  ]
  const out = filterInstallableMarketItems(items, new Set(['coder']))
  assert.deepEqual(out.map((i) => i.id), ['1', '4'])
})

test('filterInstallableMarketItems: 保持原有顺序', () => {
  const items = [
    { id: 'z', name: 'zeta' },
    { id: 'a', name: 'alpha' },
    { id: 'm', name: 'mid', installed: true },
  ]
  const out = filterInstallableMarketItems(items, new Set())
  assert.deepEqual(out.map((i) => i.name), ['zeta', 'alpha'])
})

test('filterInstallableMarketItems: 全部已安装 → 空数组（驱动专用空态）', () => {
  const items = [
    { id: '1', name: 'coder', installed: true },
    { id: '2', name: 'coder' },
  ]
  assert.deepEqual(filterInstallableMarketItems(items, new Set(['coder'])), [])
})

test('filterInstallableMarketItems: 泛型保留额外字段', () => {
  interface Rich {
    id: string
    name: string
    installed?: boolean
    downloads: number
  }
  const items: Rich[] = [{ id: '1', name: 'tool', downloads: 42 }]
  const out = filterInstallableMarketItems(items, new Set<string>())
  assert.equal(out[0].downloads, 42)
})
