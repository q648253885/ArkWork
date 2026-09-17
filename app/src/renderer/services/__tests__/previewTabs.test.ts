/* ============================================================
 * v0.31.0 B2 修复 — renderer/services/previewTabs.ts 单测（TC-TAB-001..004）
 *
 * 载体纪律：纯函数夹具，零 store / 零 React / 零 IPC。
 * 抽模块的理由见 04-system-design §5.4.3 与 store/settle.ts 的先例：
 * `uiSlice` 顶层读 `import.meta.env`，Node 下无法实例化，
 * 故把「同路径只能有一个 Tab」这条**正确性不变量**下沉为可密闭断言。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs renderer/services/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findFileTab, type TabLike } from '../previewTabs.js'

function mkTabs(...defs: Array<{ id: string; kind: string; path?: string }>): TabLike[] {
  return defs.map((d) => ({
    id: d.id,
    target: d.kind === 'file' ? { kind: 'file', path: d.path ?? '' } : { kind: 'url', path: undefined },
  }))
}

/* ============================================================
 * TC-TAB-001 · 同路径命中（这是「保存 A 写出 B 缓冲」的直接防线）
 * ============================================================ */
test('TC-TAB-001 同路径 file Tab 必须被命中（否则会开出第二个 CM6 实例）', () => {
  const tabs = mkTabs(
    { id: 't1', kind: 'file', path: '/ws/a.ts' },
    { id: 't2', kind: 'file', path: '/ws/b.ts' },
  )
  assert.equal(findFileTab(tabs, '/ws/a.ts')?.id, 't1')
  assert.equal(findFileTab(tabs, '/ws/b.ts')?.id, 't2')
  assert.equal(findFileTab(tabs, '/ws/c.ts'), undefined, '未打开过的路径不得命中')
})

/* ============================================================
 * TC-TAB-002 · URL 目标不参与去重（保持「每次新建」）
 * ============================================================ */
test('TC-TAB-002 url 目标不参与去重（同一网址开两个浏览器 Tab 是有意义的）', () => {
  const tabs = mkTabs(
    { id: 'u1', kind: 'url' },
    { id: 'u2', kind: 'url' },
  )
  // 只看 kind：file 判定必须跳过所有 url Tab，且传入的 path 是否与 url 相同都不影响
  assert.equal(findFileTab(tabs, ''), undefined)
  assert.equal(findFileTab(tabs, '/ws/a.ts'), undefined)

  // 混合场景：url 在前，file 在后 → 命中的必须是 file 那个
  const mixed = mkTabs({ id: 'u1', kind: 'url' }, { id: 'f1', kind: 'file', path: '/ws/a.ts' })
  assert.equal(findFileTab(mixed, '/ws/a.ts')?.id, 'f1')
})

/* ============================================================
 * TC-TAB-003 · 空路径 Tab：按值匹配，不特殊豁免
 * ============================================================ */
test('TC-TAB-003 空路径（⌘E 占位 Tab）按值匹配，且不得与非空路径互串', () => {
  const tabs = mkTabs({ id: 'e1', kind: 'file', path: '' }, { id: 'f1', kind: 'file', path: '/ws/a.ts' })
  assert.equal(findFileTab(tabs, '')?.id, 'e1', '空路径 Tab 应可被复用（重复开空 Tab 无意义）')
  assert.equal(findFileTab(tabs, '/ws/a.ts')?.id, 'f1')
  assert.equal(findFileTab(tabs, '/'), undefined, '空路径 ≠ 根路径')
})

/* ============================================================
 * TC-TAB-004 · 容错与确定性：path 缺失视为空串；多个同路径返回第一个
 * ============================================================ */
test('TC-TAB-004 path 缺失容错 + 多命中返回第一个（确定性）', () => {
  // target 无 path 字段（结构容错，避免运行期 undefined === undefined 之外的意外）
  const noPath: TabLike[] = [{ id: 'x1', target: { kind: 'file' } }]
  assert.equal(findFileTab(noPath, '')?.id, 'x1', '缺 path 视为空串')

  // 历史数据里可能出现多个同路径 Tab（去重上线前留下的）→ 必须是确定性结果
  const dup = mkTabs(
    { id: 'a', kind: 'file', path: '/ws/a.ts' },
    { id: 'b', kind: 'file', path: '/ws/a.ts' },
  )
  assert.equal(findFileTab(dup, '/ws/a.ts')?.id, 'a', '返回第一个，保证行为确定')
})
