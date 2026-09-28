/* ============================================================
 * ArkWork — v0.36.0 B11/P3-b：工作台插件白名单（pluginRefs）单测
 * 载体：shared/utils/profile-manifest.ts（解析）+ panel-model.ts（消费端过滤）
 * 规格来源：docs/versions/v0.36.0/12-b11-fix-batch-design.md §四（P3-b）
 * 运行（cwd=app）：node scripts/run-tests.mjs b11-pluginrefs
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseManifest } from '../profile-manifest'
import {
  filterTabsByPluginRefs,
  builtinTabOf,
  type PanelTab,
} from '../panel-model'

/* ---------- 解析层 ---------- */

const baseRaw = () => ({
  schemaVersion: '1.0',
  id: 'wb.x',
  name: 'X',
  version: '1.0.0',
  agents: [{ id: '@a', name: 'A', personaText: 'p' }],
  capabilities: [],
  ui: { dockTabs: ['files'] },
  data: { memoryNamespace: 'x', shareCoreProfile: true },
  automation: [],
})

test('TC-PLUG-001a pluginRefs 合法数组解析通过', () => {
  const { profile, issues } = parseManifest({ ...baseRaw(), pluginRefs: ['ark.plugin.git-manager'] }, 'user')
  assert.ok(profile, issues.map((i) => i.message).join(';'))
  assert.deepEqual(profile?.pluginRefs, ['ark.plugin.git-manager'])
})

test('TC-PLUG-001b pluginRefs 缺省 = undefined（不过滤语义，存量兼容）', () => {
  const { profile } = parseManifest(baseRaw(), 'user')
  assert.equal(profile?.pluginRefs, undefined)
})

test('TC-PLUG-001c 显式空数组合法（= 全部隐藏，与未声明可区分）', () => {
  const { profile } = parseManifest({ ...baseRaw(), pluginRefs: [] }, 'user')
  assert.ok(profile)
  assert.deepEqual(profile?.pluginRefs, [])
})

test('TC-PLUG-001d pluginRefs 非法形状 → warning 忽略（不阻断）', () => {
  const { profile, issues } = parseManifest({ ...baseRaw(), pluginRefs: 'git' }, 'user')
  assert.ok(profile, 'warning 不阻断导入')
  assert.equal(profile?.pluginRefs, undefined)
  assert.ok(issues.some((i) => i.path === '$.pluginRefs' && i.level === 'warning'))
})

/* ---------- 消费端（Inspector 过滤） ---------- */

const pluginTab = (id: string): PanelTab => ({
  ref: `panel:${id}`,
  title: id,
  builtin: false,
  pluginId: id,
})

test('TC-PLUG-002a null = 不过滤（原样返回，存量行为不变）', () => {
  const tabs = [builtinTabOf('files')!, pluginTab('ark.plugin.git-manager')]
  assert.equal(filterTabsByPluginRefs(tabs, null).length, 2)
})

test('TC-PLUG-002b 白名单过滤：内置 Tab 保留、白名单外插件 Tab 移除', () => {
  const tabs: PanelTab[] = [builtinTabOf('files')!, pluginTab('ark.plugin.git-manager'), pluginTab('other.plugin')]
  const out = filterTabsByPluginRefs(tabs, ['ark.plugin.git-manager'])
  assert.deepEqual(out.map((t) => t.ref), ['files', 'panel:ark.plugin.git-manager'])
})

test('TC-PLUG-002c 空白名单 = 全部插件 Tab 隐藏、内置 Tab 仍在', () => {
  const tabs: PanelTab[] = [builtinTabOf('todos')!, pluginTab('a'), pluginTab('b')]
  const out = filterTabsByPluginRefs(tabs, [])
  assert.deepEqual(out.map((t) => t.ref), ['todos'])
})
