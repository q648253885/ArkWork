/* ============================================================
 * ArkWork — 插件视图挂点存在性契约（v0.35.0 · B7/B11 建立）
 * 规格来源：docs/versions/v0.35.0/04-system-design.md §7（UI 挂点）
 *           §9 可测性 IP3：「组件只做接线（**挂点存在性另测**）」
 *           v0.34.4 纪律⑨：「挂点存在性检查：契约用例不得只 grep 源码文本」
 *
 * ★ 为什么必须单独一组（而不是并进 abilities-tabs 那类源码契约）：
 *   本仓有过一次**把死组件钉成正确**的事故 —— `TC-PUI-009` 断言了自 v0.17 起
 *   就没有挂载点的 `RightDock.tsx`，于是「全绿」反而把错误固化了下来。
 *   教训是：**「文件里有这个名字」不等于「它在渲染树里」**。
 *   因此本组的每条用例都必须同时满足两个条件才算通过：
 *     ① 组件被 import；
 *     ② 组件出现在 **JSX 位置**（`<PluginViewHost`），即真的被当作元素渲染。
 *
 * 局限（诚实登记）：仍无法证明**运行时**真的渲染出 iframe（那需要渲染基建）。
 *   本组钉的是「接线在渲染树里」这一级 —— 比 grep 强，比运行时弱。
 *   缺口见 §9.2 已知欠账，不假装已覆盖。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-view-mount
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const INSPECTOR = read('../Inspector.tsx')
const PREVIEW = read('../preview/PreviewWindow.tsx')
const PLUGIN_SLICE = read('../../store/slices/pluginSlice.ts')
const HOST = read('../plugins/PluginViewHost.tsx')

/**
 * 去掉注释后的源码。
 *
 * 必须用它的理由：本仓的注释里**故意**会写反向说明（例如「**不带** `allow-same-origin`」）。
 * 直接对原文做否定断言，会把「正确地写明不做这件事」判成「做了这件事」——
 * 那是最典型的假红，且会诱使后来者删掉那条好注释。
 */
/** 注释剥离唯一真源见 `shared/utils/source-guard`（D101/D102）；`strip` 别名保留，避免改动全部下游调用点 */
const strip = (s: string): string => stripComments(s)

const HOST_CODE = strip(HOST)

/** 「接线」判据：既 import，又出现在 JSX 位置（尖括号） */
function assertMountPoint(src: string, component: string, label: string): void {
  assert.match(
    src,
    new RegExp(`import\\s*\\{[^}]*\\b${component}\\b[^}]*\\}\\s*from`),
    `${label} 必须 import ${component}`,
  )
  assert.match(
    src,
    new RegExp(`<${component}[\\s/>]`),
    `${label} 必须以 JSX 元素使用 <${component} /> —— 只 import 不用就是「死接线」`,
  )
}

/* ============================================================
 * 1. 两个宿主挂点（设计 §7：Inspector 内容区 / 浮窗）
 * ============================================================ */

test('TC-PVM-001 ★ Inspector 是插件视图的 dock 宿主（import + JSX 双条件）', () => {
  assertMountPoint(INSPECTOR, 'PluginViewHost', 'Inspector')
})

test('TC-PVM-002 ★ 浮窗宿主同样渲染插件视图（§7「Inspector 内容区 / 浮窗」两处都要有）', () => {
  assertMountPoint(PREVIEW, 'PluginViewHost', 'PreviewWindow 的浮窗宿主')
})

test('TC-PVM-003 ★★ 渲染条件必须绑定「当前 Tab 是插件视图」，而不是无条件渲染', () => {
  // 无条件渲染 = 插件容器盖在宿主原生界面上；本版明确要求「视觉上不冒充宿主原生界面」
  assert.match(INSPECTOR, /currentTab\?\.view\s*&&\s*<PluginViewHost/, 'Inspector 必须以 currentTab.view 为条件')
  assert.match(PREVIEW, /tab\.view\s*\)\s*return\s*<PluginViewHost/, '浮窗宿主必须以 tab.view 为条件')
})

/* ============================================================
 * 2. 数据来源：必须走 store，不得自持 state（v0.31.0 双挂载教训）
 * ============================================================ */

test('TC-PVM-004 ★ 视图清单来自 store（单一真源），不得各宿主自持 useState', () => {
  assert.match(INSPECTOR, /useStore\(\(s\)\s*=>\s*s\.pluginViews\)/, 'Inspector 必须读 store 的 pluginViews')
  assert.match(PREVIEW, /useStore\(\(s\)\s*=>\s*s\.pluginViews\)/, '浮窗宿主必须读同一份 pluginViews')
  // 各自 useState 会让两个宿主的清单分叉（v0.31.0 的 FilesPanel 双挂载就是这么踩的）
  assert.doesNotMatch(
    INSPECTOR,
    /useState[^\n]*pluginViews/,
    '不得用本地 state 缓存插件视图清单',
  )
})

test('TC-PVM-005 ★ 插件视图与 profile 面板是**两路**来源，合并只发生在拿 tabs 的地方', () => {
  // pluginSlice 头注释声明：合流为一条会让「profile 面板重算」把运行期视图冲掉
  assert.match(PLUGIN_SLICE, /pluginViews/, 'pluginSlice 必须持有 pluginViews')
  assert.match(INSPECTOR, /mergePanelOrder\(\s*mergePanelOrder\(/, '三层拼接：内置 → profile 面板 → 插件视图')
})

/* ============================================================
 * 3. 容器自身（防「容器被换成空壳」）
 * ============================================================ */

test('TC-PVM-006 ★ 容器必须真的产出 iframe 且带沙箱（换成 div 占位就是空壳）', () => {
  assert.match(HOST_CODE, /<iframe/, 'PluginViewHost 必须渲染 iframe')
  assert.match(HOST_CODE, /sandbox=/, 'iframe 必须带 sandbox')
  // 安全铁律（§9 安全④）：不得给 allow-same-origin，否则 iframe 能摸到宿主 DOM/storage
  assert.doesNotMatch(HOST_CODE, /allow-same-origin/, '沙箱不得包含 allow-same-origin')
  assert.match(HOST_CODE, /sandbox="allow-scripts"/, '沙箱取值就是 allow-scripts 这一项')
})

test('TC-PVM-007 容器必须经桥与主进程通信（不得直连 window.api）', () => {
  assert.match(HOST, /createBridgeHost/, '必须用共享的桥纯模块（与脚手架同源）')
  assert.doesNotMatch(HOST_CODE, /window\.api\./, '渲染层不得直连 window.api')
})
