/* ============================================================
 * v0.31.0 C3 — 文件浮窗最小化/恢复契约单测（TC-C3-PV-001..006）
 *
 * 缺陷背景（用户实测）：浮窗最小化后点击底部胶囊，恢复出来的是**空窗**。
 * 根因：`minimizePreview` 只留胶囊展示字段（title/icon/tabCount），整窗
 * `tabs/bounds/pinned` 全部丢弃；`restoreMinimized` 写死 `tabs: []` 重建。
 *
 * 载体约束：`uiSlice` 顶层读 `import.meta.env`，Node 下无法实例化 store
 * （见 open-doc-wiring.test.ts 头注），故本套件与 TC-WIRE 同体例 ——
 * 源码契约断言：把「最小化必须留快照 / 恢复必须用快照」写死在测试里。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs renderer/store/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
/** 去掉行注释，避免说明文字里的示例代码干扰契约断言 */
const code = (rel: string): string => read(rel).replace(/\/\/.*$/gm, '')

/* ============================================================
 * TC-C3-PV-001 · 类型契约：胶囊必须携带整窗快照
 * ============================================================ */
test('TC-C3-PV-001 MinimizedCapsule 含 snapshot: PreviewWindowState（整窗快照字段）', () => {
  const src = code('../types.ts')
  assert.match(
    src,
    /interface MinimizedCapsule\s*\{[\s\S]*?snapshot:\s*PreviewWindowState/,
    '胶囊缺 snapshot 字段 → 恢复无数据可重建（本缺陷的直接来源）',
  )
})

/* ============================================================
 * TC-C3-PV-002 · 最小化：必须留存整窗快照（tabs/bounds/pinned）
 * ============================================================ */
test('TC-C3-PV-002 minimizePreview 经 capsuleOf 留存整窗快照，不得只存展示字段', () => {
  const src = code('../slices/uiSlice.ts')
  // 快照构造：浅拷贝整窗 + 复制 tabs 数组
  assert.match(
    src,
    /const capsuleOf = \(pw: PreviewWindowState\): MinimizedCapsule =>[\s\S]*?snapshot:\s*\{\s*\.\.\.pw,\s*tabs:\s*\[\.\.\.pw\.tabs\]\s*\}/,
    'capsuleOf 必须写入 snapshot（{ ...pw, tabs: [...pw.tabs] }）',
  )
  // 最小化走 capsuleOf（而非手写只剩 title/icon/tabCount 的胶囊）
  assert.match(
    src,
    /minimizePreview:[\s\S]{0,400}?const capsule = capsuleOf\(s\.previewWindow\)/,
    'minimizePreview 必须经 capsuleOf 快照整窗',
  )
})

/* ============================================================
 * TC-C3-PV-003 · 恢复：必须按快照重建，禁止空窗重建
 * ============================================================ */
test('TC-C3-PV-003 restoreMinimized 用 capsule.snapshot 重建；不得再出现 tabs:[] 空窗', () => {
  const src = code('../slices/uiSlice.ts')
  assert.match(
    src,
    /restoreMinimized:[\s\S]{0,600}?previewWindow:\s*capsule\.snapshot/,
    '恢复必须直接采用快照（tabs / activeTabId / bounds / pinned 全保留）',
  )
  assert.ok(
    !/tabs:\s*\[\]/.test(src),
    'uiSlice 不得重建空 tabs 浮窗 —— 这是「最小化后恢复成空窗」的病灶本体',
  )
})

/* ============================================================
 * TC-C3-PV-004 · 交换保护：恢复时已有现窗 → 现窗入最小化列表，两边不丢
 * ============================================================ */
test('TC-C3-PV-004 恢复时已有其他浮窗：现窗先快照入列（交换），不得静默覆盖丢失', () => {
  const src = code('../slices/uiSlice.ts')
  assert.match(
    src,
    /minimizedPreviews:\s*s\.previewWindow\s*\?\s*\[\.\.\.rest,\s*capsuleOf\(s\.previewWindow\)\]\s*:\s*rest/,
    'restoreMinimized 必须在覆盖 previewWindow 前把现窗收入最小化列表',
  )
})

/* ============================================================
 * TC-C3-PV-005 · 胶囊 ✕ = 丢弃（仅移除），不得「恢复+关闭」两步
 * ============================================================ */
test('TC-C3-PV-005 胶囊 ✕ 走 discardMinimized；不得 restore 后再 close（交换语义下会误伤现窗）', () => {
  const src = code('../../components/preview/PreviewWindow.tsx')
  assert.match(
    src,
    /const discardMinimized = useStore\(\(s\) => s\.discardMinimized\)/,
    'MinimizedCapsules 必须接入 discardMinimized',
  )
  assert.ok(
    !/restoreMinimized\(c\.id\)[\s\S]{0,120}closePreview\(\)/.test(src),
    '禁止「restoreMinimized + closePreview」两步 —— 交换语义下会把现窗误最小化',
  )
  assert.match(
    src,
    /discardMinimized\(c\.id\)/,
    '✕ 按钮必须调用 discardMinimized',
  )
})

/* ============================================================
 * TC-C3-PV-006 · 丢弃：仅移除胶囊，不触碰现窗
 * ============================================================ */
test('TC-C3-PV-006 discardMinimized 仅过滤 minimizedPreviews，不触碰 previewWindow', () => {
  const src = code('../slices/uiSlice.ts')
  assert.match(
    src,
    /discardMinimized:\s*\(id\)\s*=>\s*set\(\(s\)\s*=>\s*\(\{\s*minimizedPreviews:\s*s\.minimizedPreviews\.filter\(\(c\) => c\.id !== id\)\s*\}\)\)/,
    'discardMinimized 语义必须收敛为「仅移除胶囊」',
  )
})
