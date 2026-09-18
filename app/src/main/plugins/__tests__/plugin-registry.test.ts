/* ============================================================
 * v0.33.0 — 插件注册表契约（TC-PLGR-001..008）
 * 规格见 testcases/00-cumulative-matrix.md §7；
 * 被测：main/plugins/registry.ts（贡献点转换）+ sample-plugins.ts（随包示例清单）
 *
 * 测法说明（重要）：
 *   registry 的 IO 半边（listPlugins / setEnabled / uninstall）依赖
 *   electron userData 真实目录，单测不触碰 —— 它们的「免重启链路」
 *   用**源码契约**把守（同 profile-ui-contract 的既有体例）；
 *   贡献点转换是纯函数（InstalledPlugin[] → SlotEntry[]），直接密闭覆盖。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-registry
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SAMPLE_PLUGIN_MANIFESTS } from '../sample-plugins.js'
import {
  BUILTIN_PANEL_REFS,
  builtinManifestForExport,
  pluginContributions,
  pluginSummaries,
  uninstallPlugin,
} from '../registry.js'
import { parsePluginManifest } from '@shared/utils/plugin-manifest'
import { BUILTIN_EXTENSIONS } from '@shared/utils/renderer-ext'
import type { InstalledPlugin, PluginManifest } from '@shared/types/plugin'

const REGISTRY_SRC = readFileSync(new URL('../registry.ts', import.meta.url), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

function manifestOf(id: string, over: Record<string, unknown> = {}): PluginManifest {
  const raw = {
    schemaVersion: '1.0',
    id,
    name: id,
    version: '1.0.0',
    kind: 'panel',
    provides: {
      panel: { panelRef: `panel:${id.split('.').at(-1)}`, title: id, component: 'DataTable', data: { kind: 'static', rows: [{ a: 1 }] } },
    },
    ...over,
  }
  const r = parsePluginManifest(raw)
  assert.ok(r.manifest, `夹具清单必须合法：${JSON.stringify(r.issues)}`)
  return r.manifest!
}

function installed(m: PluginManifest, over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return { manifest: m, source: 'local', dir: '', enabled: true, ...over }
}

/* ============================================================
 * 内置插件（同一校验路径，无特殊通道）
 * ============================================================ */

test('TC-PLGR-001 随包示例齐备且每个都通过 parsePluginManifest（同一校验）', () => {
  // v0.34.1：示例从「4 个假数据演示件」收敛为「1 个真实功能插件」——
  // 数量不再是要守的不变量，**真实性**才是（见 TC-PLGR-001b）。
  assert.ok(SAMPLE_PLUGIN_MANIFESTS.length >= 1, `随包示例应 ≥1 个，实际 ${SAMPLE_PLUGIN_MANIFESTS.length}`)
  for (const m of SAMPLE_PLUGIN_MANIFESTS) {
    // 内置清单必须是「再跑一遍 VP1–VP6 也零 error」的模范样本
    const r = parsePluginManifest(m as unknown as Record<string, unknown>)
    assert.ok(r.manifest, `内置插件 ${m.id} 未通过统一校验：${JSON.stringify(r.issues)}`)
    assert.equal(r.manifest!.id, m.id)
  }
  // 导出样例与内置同源
  assert.deepEqual(builtinManifestForExport(SAMPLE_PLUGIN_MANIFESTS[0]!.id), SAMPLE_PLUGIN_MANIFESTS[0])
  assert.equal(builtinManifestForExport('no.such'), null)
})

test('TC-PLGR-001b ★ 随包示例必须是真实功能插件（不得再有 static 假数据示例）', () => {
  // 为什么钉这条：v0.34.0 的四个示例全是 `data.kind: 'static'` 的假数据，
  // 它们只证明「机制能跑」，用户却会以为插件就是放示例表格的 —— 范例本身在说谎。
  for (const m of SAMPLE_PLUGIN_MANIFESTS) {
    const panels = [m.provides.panel, ...(m.provides.panels ?? [])].filter(
      (x): x is NonNullable<typeof x> => !!x,
    )
    assert.ok(panels.length > 0, `${m.id} 必须贡献至少一个面板`)
    for (const pd of panels) {
      assert.notEqual(
        pd.data.kind,
        'static',
        `${m.id}/${pd.panelRef} 不得用 static 假数据 —— 随包示例必须是真实功能`,
      )
    }
  }
})

/* ============================================================
 * 贡献点转换（纯函数）
 * ============================================================ */

test('TC-PLGR-002 启用的 panel 插件 → ui.panel 条目，payload 含 panelRef/component/pluginId', () => {
  const m = manifestOf('ark.plugin.t2', {})
  const [e] = pluginContributions([installed(m)])
  assert.ok(e)
  assert.equal(e!.kind, 'ui.panel')
  assert.equal(e!.id, m.provides.panel!.panelRef)
  assert.equal(e!.source, 'plugin')
  const p = e!.payload as unknown as Record<string, unknown>
  assert.equal(p.panelRef, m.provides.panel!.panelRef)
  assert.equal(p.component, 'DataTable')
  assert.equal(p.pluginId, m.id)
})

test('TC-PLGR-003 禁用的插件 / invalidReason 插件 → 不产出任何条目', () => {
  const m = manifestOf('ark.plugin.t3')
  assert.equal(pluginContributions([installed(m, { enabled: false })]).length, 0)
  assert.equal(pluginContributions([installed(m, { invalidReason: '目录名不一致' })]).length, 0)
})

test('TC-PLGR-004 免重启链路：setEnabled → invalidate → refresh（源码契约）', () => {
  // setPluginEnabled 必须先落盘启停、再清缓存、再刷插槽 —— 缺一步就会出现
  // 「UI 显示已禁用但面板还在」或「已禁用但重扫后又回来」
  const fn = REGISTRY_SRC.slice(REGISTRY_SRC.indexOf('export async function setPluginEnabled'))
  const body = fn.slice(0, fn.indexOf('export async function uninstallPlugin'))
  assert.match(body, /await setEnabled\(/, '必须先持久化启停状态')
  assert.match(body, /invalidatePlugins\(\)/, '必须清列表缓存')
  assert.match(body, /await refreshPluginSlots\(\)/, '必须重刷插件来源插槽（免重启）')
  // 纯函数侧的等价断言：同一插件 enabled 翻转 → 条目消失
  const m = manifestOf('ark.plugin.t4')
  assert.equal(pluginContributions([installed(m, { enabled: true })]).length, 1)
  assert.equal(pluginContributions([installed(m, { enabled: false })]).length, 0)
})

test('TC-PLGR-005 逐插件隔离：1 好 1 坏的输入 → 只产好的，且不抛错', () => {
  const good = manifestOf('ark.plugin.good')
  // 「坏」在 registry 的判据里 = invalidReason 非空（buildUserEntry 对校验失败
  // 的插件就是标 invalidReason 而非产出 manifest）—— 这里直接按该形态构造
  const badM = manifestOf('ark.plugin.bad')
  const broken: InstalledPlugin = { manifest: badM, source: 'local', dir: '', enabled: true, invalidReason: 'VP1 $.version: 不是语义化版本' }
  assert.doesNotThrow(() => pluginContributions([broken, installed(good)]))
  const out = pluginContributions([broken, installed(good)])
  assert.equal(out.length, 1)
  assert.equal((out[0]!.payload as unknown as Record<string, unknown>).pluginId, 'ark.plugin.good')
})

test('TC-PLGR-006 refreshPluginSlots 只清 plugin 来源（D42 语义的接线契约）', () => {
  assert.match(REGISTRY_SRC, /resetProfileSlots\('plugin'\)/, '刷新必须按来源清，不得全清（否则会连 profile 装配一起抹掉）')
  assert.match(REGISTRY_SRC, /registerSlot\(e\.kind, e, 'plugin'\)/, '重注册必须以 plugin 来源登记')
  // D48：当前台已装配同 id 面板（profile 来源，带 manifest position）→ 插件条目跳过，
  // 否则撞「profile 占用不能由 plugin 覆盖」并产生顺序双写
  assert.match(REGISTRY_SRC, /resolveSlots\(e\.kind, \{ source: 'profile' \}\)/, '注册前必须查 profile 来源占用')
  assert.match(REGISTRY_SRC, /continue/, '命中 profile 装配 → 跳过而非 warn（这是预期路径）')
})

test('TC-PLGR-007 uninstall 对随包示例插件拒绝（源码契约 + 真实行为 + BUILTIN_PANEL_REFS 同源）', async () => {
  const fn = REGISTRY_SRC.slice(REGISTRY_SRC.indexOf('export async function uninstallPlugin'))
  const body = fn.slice(0, fn.indexOf('export function builtinManifestForExport'))
  // v0.34.0（P4）：来源语义由 'builtin' 改为 'bundled'（随包示例 → 可禁用不可删）
  assert.match(body, /reason: 'bundled'/, '随包示例插件必须拒绝卸载')
  assert.doesNotMatch(body, /reason: 'builtin'/, "旧的 'builtin' 来源语义不得残留（P4 改名须彻底）")
  assert.match(body, /rmSync/, '用户插件卸载必须删目录')

  // 行为断言（不只 grep 源码）：未知 id 在**不触碰文件系统**的前提下返回 not-found，
  // 证明该函数可被真实调用且不抛错 —— 守住「契约测试不能只断言源码文本」这条纪律。
  const res = await uninstallPlugin('no.such.plugin')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not-found')

  // 随包示例面板 ref 与 panelRefToInspectorTab 的内置全集同源（供 V2 引用闭合）
  for (const ref of BUILTIN_PANEL_REFS) {
    assert.match(ref, /^panel:[a-z]+$/, ref)
  }
})

test('TC-PLGR-008 renderer 接管内置扩展名：未 override 不产出；override 产出', () => {
  const mk = (override: boolean): InstalledPlugin => {
    const m = manifestOf('ark.plugin.r8', {
      kind: 'renderer',
      provides: { renderer: { rendererKind: 'table', extensions: ['csv'], override } },
    })
    return installed(m)
  }
  assert.equal(pluginContributions([mk(false)]).length, 0, '.csv 已被内置占用且未 override → 忽略')
  const out = pluginContributions([mk(true)])
  assert.equal(out.length, 1)
  assert.equal(out[0]!.kind, 'ui.renderer')
  assert.equal(out[0]!.id, 'renderer:csv')
  // 夹具本身占用的是真内置扩展名（否则这条用例没有测到目标分支）
  assert.ok(BUILTIN_EXTENSIONS.includes('csv'))
  // 非占用扩展名（kchart）无需 override 也产出
  const fresh = manifestOf('ark.plugin.r8b', {
    kind: 'renderer',
    provides: { renderer: { rendererKind: 'table', extensions: ['kchart'], override: false } },
  })
  assert.equal(pluginContributions([installed(fresh)]).length, 1)
})

/* ============================================================
 * pluginSummaries（UI 列表行的派生）
 * ============================================================ */

test('TC-PLGR-009 summaries：禁用/非法插件不贡献 panelRefs；uninstallable 按来源', () => {
  const panel = manifestOf('ark.plugin.s1')
  const disabledM = manifestOf('ark.plugin.s2')
  const builtinM = manifestOf('ark.plugin.s3')
  const rows = pluginSummaries([
    installed(panel),
    installed(disabledM, { enabled: false }),
    installed(builtinM, { source: 'bundled' }),
  ])
  assert.equal(rows[0]!.panelRefs!.length, 1)
  assert.equal(rows[1]!.panelRefs!.length, 0, '禁用插件不得进编辑器可选项')
  assert.equal(rows[1]!.homeModules!.length, 0)
  assert.equal(rows[2]!.uninstallable, false, '随包示例不可卸载')
  assert.equal(rows[0]!.uninstallable, true)
})
