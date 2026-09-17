/* ============================================================
 * v0.31.0 B2 修复 — 「打开文件」接线契约单测（TC-WIRE-001..006）
 *
 * 为什么必须是**源码契约**用例：
 *   本次线上缺陷（用户实测「点开文件浮窗无法编辑」）的根因**不是逻辑错误**，
 *   而是**接线缺失** —— `fsSlice.openDoc`（探针判定 → 可编辑则开编辑器 Tab）
 *   实现完整、typecheck 通过、TC-DOC 八条全绿，但**没有任何调用方**：
 *   所有打开文件的入口都直连 `openPreview`，渲染器由 `detectRenderer` 按扩展名给，
 *   于是任何文件都落在只读渲染器上，编辑器不可达。
 *   这类缺陷**功能用例测不出来**（被测单元本身是对的），只能靠「入口必须走哪条路」
 *   的契约断言把守 —— 与 TC-GUARD-001（单一实现）/ TC-PKG-003（懒加载边界）同一体例。
 *
 * 载体约束：`uiSlice` / `fsSlice` / `conversationSlice` 顶层读 `import.meta.env`，
 * Node 下无法实例化，故本套件只做源码契约，不实例化 store。
 *
 * 维护约定：新增「打开工作区文件」的入口时，请把它加进 ENTRY_FILES 并补一条断言；
 *          需要保留只读入口（`.arkwork` 内部产物等）时，在注释里写明理由，不要放宽整条规则。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs renderer/store/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

/** 打开工作区文件的入口（**一律不得直连 openPreview**） */
const ENTRY_FILES: Array<[string, string]> = [
  ['../../components/QuickOpen.tsx', 'QuickOpen（⌘P 文件切换）'],
  ['../../components/QuickAction.tsx', 'QuickAction（⌘K 快捷动作的文件项）'],
  ['../../components/Composer.tsx', 'Composer（输入框 @ 文件项）'],
]

/* ============================================================
 * TC-WIRE-001 · 主路径：选中文件必须走 openDoc
 * ============================================================ */
test('TC-WIRE-001 conversationSlice.selectFile 走 openDoc（编辑器可达的唯一主路径）', () => {
  const src = read('../slices/conversationSlice.ts')
  assert.match(src, /get\(\)\.openDoc\(path\)/, 'selectFile 必须调 fsSlice.openDoc')
  assert.ok(
    !/openPreview\(/.test(src),
    'conversationSlice 不得再直连 openPreview —— 它会把渲染器按扩展名定死，编辑器永不可达',
  )
})

/* ============================================================
 * TC-WIRE-002 · 其余入口：一律 openDoc，不得直连 openPreview
 * ============================================================ */
test('TC-WIRE-002 打开文件的其余入口全部走 openDoc（OpenDoc 单一门面）', () => {
  for (const [rel, label] of ENTRY_FILES) {
    const src = read(rel)
    assert.ok(!/openPreview\s*\(/.test(src), `${label} 不得直连 openPreview`)
    assert.match(src, /openDoc/, `${label} 必须使用 openDoc`)
  }
})

/* ============================================================
 * TC-WIRE-003 · openDoc 的两条兜底：`.arkwork` 拦截 + 探针失败不阻断打开
 * ============================================================ */
test('TC-WIRE-003 openDoc 拦 .arkwork，且探针失败时退回只读 Tab（不静默退化）', () => {
  const src = read('../slices/fsSlice.ts')
  assert.match(src, /isArkworkInternal\(path\)/, '必须拦 `.arkwork`（否则能编辑一个永远存不下去的文件）')
  assert.match(
    src,
    /openPreview\(path,\s*\{\s*pinned:\s*mode === 'pinned'\s*\}\)/,
    '`.arkwork` 分支应退回只读渲染 Tab',
  )
  // catch 分支必须仍然开 Tab（修复前所有入口是 openPreview，「点了文件一定能看到东西」是既有承诺）
  const catchIdx = src.indexOf('探针失败')
  assert.ok(catchIdx > 0, 'catch 分支需写明「探针失败仍要能打开」的理由')
  assert.match(
    src.slice(catchIdx, catchIdx + 700),
    /openPreview\(path/,
    'catch 分支必须回退到 openPreview，而不是只弹 toast',
  )
})

/* ============================================================
 * TC-WIRE-004 · openPreview 按路径复用 Tab（防两个 CM6 争用同一 handle 槽位）
 * ============================================================ */
test('TC-WIRE-004 uiSlice.openPreview 复用同路径 Tab，并让新 renderer 生效', () => {
  const src = read('../slices/uiSlice.ts')
  assert.match(src, /findFileTab\(/, '必须用纯函数 findFileTab 判定复用')
  assert.match(src, /activeTabId:\s*dup\.id/, '复用时必须激活已有 Tab（否则用户看不到响应）')
  assert.match(
    src,
    /t\.id === dup\.id \? \{ \.\.\.t, renderer,/,
    '复用时必须写入新的 renderer —— 这正是「只读打开过的文件再次走 openDoc 升级为编辑器」的通路',
  )
  // 保留「不复用」的语义：URL Tab 仍每次新建（见 previewTabs.test.ts TC-TAB-002）
  assert.match(src, /tab-\$\{Date\.now\(\)\}/, '新建 Tab 路径必须保留（URL 目标仍走它）')
})

/* ============================================================
 * TC-WIRE-005 · 渲染器下拉对所有 Tab 统一生效（D22 用户裁决）
 * ------------------------------------------------------------
 * 旧裁决（editor 短路压过 rendererOverrides）已废除：
 * 它导致 css/code 这类默认进编辑器的 Tab 从下拉选其他格式毫无反应。
 * 新口径：**首次打开按 detectRenderer 匹配类型（openDoc 的 defaultToEditor），
 * 之后任何格式均可互切**；editor 也在下拉里，切走后一键可达，
 * 不存在「回不到编辑器」—— 文档状态（docs/dirty/viewMode）全程保留。
 * ============================================================ */
test('TC-WIRE-005 activeRenderer 一律尊重 rendererOverrides（editor 不再短路）', () => {
  const src = read('../../components/preview/PreviewWindow.tsx')
  assert.match(
    src,
    /rendererOverrides\[activeTab\.id\] \?\? activeTab\.renderer/,
    'activeRenderer 必须统一走 rendererOverrides 覆盖链',
  )
  assert.doesNotMatch(
    src,
    /activeTab\.renderer === 'editor'\s*\?\s*'editor'/,
    "editor 不得再短路压过 rendererOverrides —— 否则 css/code Tab 无法切换格式",
  )
  // editor 必须留在下拉可选项里（切走后一键切回的唯一通路）
  const reg = read('../../components/preview/registry.ts')
  assert.match(reg, /editor: \{/, 'RENDERER_REGISTRY 必须含 editor 项')
})

/* ============================================================
 * TC-WIRE-006 · 产物跳转复用共享谓词（消除硬编码字面量）
 * ============================================================ */
test('TC-WIRE-006 ProgressPanel 用共享谓词判 .arkwork，不再硬编码字面量', () => {
  const src = read('../../components/dock/ProgressPanel.tsx')
  assert.match(src, /isArkworkInternal\(path\)/, '必须用共享纯函数判定')
  assert.ok(
    !/path\.includes\('\.arkwork\/'\)/.test(src),
    "不得再硬编码 `.arkwork/` 字面量 —— 它漏判「无尾斜杠」的 `.arkwork` 路径",
  )
})
