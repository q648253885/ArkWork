/* ============================================================
 * ArkWork — 插件清单外科式迁移单测（v0.35.0 · B10/B11 建立）
 * 规格来源：docs/versions/v0.35.0/04-system-design.md §8（迁移矩阵）· §四 A12
 *   用户裁决（指令原文第 2 条）：「删除废弃的侧边栏插件」
 *   → `ark.plugin.stock` 的 `panel:stock-detail` / `panel:stock-kline` 退役。
 *
 * ★ 本组用例存在的理由（说给下一个改这里的人）：
 *   光改 `sample-plugins.ts` 只能让**新装机**的用户看不到那两个面板。
 *   已装机的用户磁盘上躺着一份 v0.34.x 落下的 plugin.json，它才是运行期真正
 *   被读的那份 —— 不改它，用户升级之后面板照旧存在。而那份文件的既定语义是
 *   **用户副本**（`seed.ts` 头注释），所以整体覆盖是错的，只能**外科式**摘除。
 *   一组用例同时钉住两件相反方向的事：
 *     ① 废弃项必须被摘掉（否则 A12 没落地）；
 *     ② 用户的其它编辑必须一字不动（否则「外科式」退化成「整体覆盖」）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-migrate
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  migratePluginManifest,
  migratePluginManifestsOnDisk,
  RETIRED_PANEL_REFS,
} from '../migrate.js'
import { RAW_SAMPLE_PLUGINS } from '../sample-plugins.js'

/** 一份「上一版官方副本」形状的最小清单（含两个待退役面板 + 一条行点击） */
function legacyRaw(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    id: 'ark.plugin.stock',
    name: '股票行情',
    version: '1.0.0',
    description: '自选股实时行情 + 个股详情 + 日 K 线（东方财富公开接口，真实联网数据）',
    kind: 'panel',
    provides: {
      panels: [
        {
          panelRef: 'panel:stock-quotes',
          title: '自选股',
          component: 'DataTable',
          data: { kind: 'http', http: { url: 'https://x/y' } },
          interact: {
            onRowClick: { panelRefs: ['panel:stock-detail', 'panel:stock-kline'], params: { secid: 'secid' } },
          },
        },
        { panelRef: 'panel:stock-detail', title: '个股详情', component: 'DataTable', data: { kind: 'http', http: { url: 'https://x/d' } } },
        { panelRef: 'panel:stock-kline', title: '日K线', component: 'CandleChart', data: { kind: 'http', http: { url: 'https://x/k' } } },
      ],
      views: [{ viewRef: 'view:extra' }],
    },
  }
}

const panelsOf = (raw: Record<string, unknown>): Array<Record<string, unknown>> =>
  ((raw.provides as { panels: Array<Record<string, unknown>> }).panels)

/* ============================================================
 * 1. 纯函数：摘除规则 ① ② ③ ④
 * ============================================================ */

test('TC-PMIG-001 ★ 规则①：panelRef 命中废弃集的面板被整条摘掉（记录在 removedPanels）', () => {
  const { next, result } = migratePluginManifest(legacyRaw())
  assert.deepEqual(result.removedPanels.sort(), [...RETIRED_PANEL_REFS].sort())
  const refs = panelsOf(next).map((p) => p.panelRef)
  assert.deepEqual(refs, ['panel:stock-quotes'], '只应剩下自选股面板')
})

test('TC-PMIG-002 ★ 规则②：onRowClick 的引用**全部**命中废弃集 → 摘掉整个 onRowClick', () => {
  const { next, result } = migratePluginManifest(legacyRaw())
  assert.equal(result.removedInteract, true)
  const quotes = panelsOf(next).find((p) => p.panelRef === 'panel:stock-quotes')!
  assert.equal(quotes.interact, undefined, '留下「点了没反应」的交互比没有交互更难排查')
})

test('TC-PMIG-003 规则③：**部分**命中 → 只摘命中项，用户自己加的面板引用留着', () => {
  const raw = legacyRaw()
  const quotes = panelsOf(raw).find((p) => p.panelRef === 'panel:stock-quotes')!
  ;(quotes.interact as { onRowClick: { panelRefs: string[] } }).onRowClick.panelRefs = [
    'panel:stock-detail',
    'panel:my-custom', // 用户自己加的
  ]
  const { next, result } = migratePluginManifest(raw)
  assert.deepEqual(result.prunedInteractRefs, ['panel:stock-detail'])
  assert.equal(result.removedInteract, false, '还有存活引用，不该整条摘')
  const after = panelsOf(next).find((p) => p.panelRef === 'panel:stock-quotes')!
  const refs = (after.interact as { onRowClick: { panelRefs: string[] } }).onRowClick.panelRefs
  assert.deepEqual(refs, ['panel:my-custom'], '用户那部分是他的东西，必须留')
})

test('TC-PMIG-004 规则④：摘完 panelRefs 变空 → 摘掉整个 onRowClick，且 interact 空了也一并摘掉', () => {
  const raw = legacyRaw()
  const quotes = panelsOf(raw).find((p) => p.panelRef === 'panel:stock-quotes')!
  ;(quotes.interact as { onRowClick: { panelRefs: string[] } }).onRowClick.panelRefs = ['panel:stock-kline']
  const { next } = migratePluginManifest(raw)
  const after = panelsOf(next).find((p) => p.panelRef === 'panel:stock-quotes')!
  assert.equal(after.interact, undefined, 'interact 只剩空壳时也应收干净')
})

test('TC-PMIG-005 无 provides.panels / provides 非对象 → 原样返回、changed=false（不写回）', () => {
  for (const raw of [
    { id: 'x' },
    { id: 'x', provides: {} },
    { id: 'x', provides: { panels: 'nope' } },
    { id: 'x', provides: null },
    { id: 'x', provides: [] },
  ] as Array<Record<string, unknown>>) {
    const { next, result } = migratePluginManifest(raw)
    assert.equal(result.changed, false)
    assert.equal(next, raw, '未改动时必须是**同一个对象引用**（调用方据此决定不写盘）')
  }
})

test('TC-PMIG-006 无命中 → changed=false 且 next === raw（身份相等即「绝不无谓重排用户文件」）', () => {
  const raw = legacyRaw()
  panelsOf(raw).pop()
  panelsOf(raw).pop() // 摘掉两个退役面板 → 已无命中
  const quotes = panelsOf(raw)[0]!
  delete quotes.interact
  const { next, result } = migratePluginManifest(raw)
  assert.equal(result.changed, false)
  assert.equal(next, raw)
})

test('TC-PMIG-007 规则⑤：provides 里除 panels 外的键（views / tools）原样保留', () => {
  const { next } = migratePluginManifest(legacyRaw())
  assert.deepEqual((next.provides as { views: unknown[] }).views, [{ viewRef: 'view:extra' }])
})

test('TC-PMIG-008 ★ 规则⑥：顶层其它键（含用户的 version / name / 其它编辑）一字不动', () => {
  const raw = legacyRaw()
  raw.version = '9.9.9-user-edit'
  raw.myCustomField = { hello: 'world' }
  const { next } = migratePluginManifest(raw)
  assert.equal(next.version, '9.9.9-user-edit', '迁移只摘废弃项，改版本号是别人的事')
  assert.deepEqual(next.myCustomField, { hello: 'world' })
  assert.equal(next.id, 'ark.plugin.stock')
  assert.equal(next.schemaVersion, '1.0', 'schemaVersion 也不动（老清单仍合法）')
})

test('TC-PMIG-009 形状非法的面板条目原样保留（本迁移只摘废弃项，不顺手清理 —— 谁的锅要说清）', () => {
  const raw = legacyRaw()
  panelsOf(raw).push(null as unknown as Record<string, unknown>)
  panelsOf(raw).push('junk' as unknown as Record<string, unknown>)
  panelsOf(raw).push({ noPanelRef: true })
  const { next } = migratePluginManifest(raw)
  const refs: unknown[] = panelsOf(next).map((p) => (p && (p as Record<string, unknown>).panelRef) ?? p)
  assert.ok(refs.includes(null), 'null 条目应保留')
  assert.ok(refs.includes('junk'), '字符串条目应保留')
  assert.ok(refs.some((r) => r && typeof r === 'object' && (r as Record<string, unknown>).noPanelRef === true))
})

test('TC-PMIG-010 ★ 入参不被修改（纯函数；改入参会让调用方的内存态与磁盘态悄悄分叉）', () => {
  const raw = legacyRaw()
  const snapshot = JSON.stringify(raw)
  migratePluginManifest(raw)
  assert.equal(JSON.stringify(raw), snapshot, '原对象必须保持不动')
})

test('TC-PMIG-011 幂等：对迁移结果再迁移 → changed=false（启动多次扫描不会反复重排文件）', () => {
  const first = migratePluginManifest(legacyRaw())
  const second = migratePluginManifest(first.next)
  assert.equal(second.result.changed, false)
  assert.equal(second.next, first.next)
})

test('TC-PMIG-012 退役集可注入（未来再退役面板时，调用点不必改签名）', () => {
  const { next, result } = migratePluginManifest(legacyRaw(), ['panel:stock-kline'])
  assert.deepEqual(result.removedPanels, ['panel:stock-kline'])
  assert.ok(panelsOf(next).some((p) => p.panelRef === 'panel:stock-detail'), '未列入的不该被摘')
})

test('TC-PMIG-013 ★ 与真实随包清单结构对齐：v0.34.1 官方副本迁移后 == 现行随包清单的骨架', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/sample-plugins.v0.34.1.json', import.meta.url), 'utf-8'),
  ) as Record<string, unknown>
  const { next, result } = migratePluginManifest(fixture)
  const bundled = RAW_SAMPLE_PLUGINS[0]!
  assert.equal(result.changed, true, '真实夹具里确实有待退役项（否则本用例空转）')

  // 只比对**骨架**（面板身份与顺序）：URL 主机/文案由 seed.ts 的字符串迁移另行归一，
  // 不属本模块职责 —— 混进来会让两条迁移机制互相耦合。
  const skeleton = (raw: Record<string, unknown>) =>
    panelsOf(raw).map((p) => ({ ref: p.panelRef, title: p.title, component: p.component, icon: p.icon }))
  assert.deepEqual(skeleton(next), skeleton(bundled), '迁移后的面板骨架必须与随包清单一致')

  // 并且迁移结果里不应再有任何指向退役面板的引用（含 interact）
  assert.ok(!JSON.stringify(next).includes('panel:stock-detail'))
  assert.ok(!JSON.stringify(next).includes('panel:stock-kline'))
  assert.ok(!JSON.stringify(bundled).includes('panel:stock-detail'), '随包清单自身也已清干净')
})

/* ============================================================
 * 2. 磁盘写回：apply / dry-run / 逐插件隔离
 * ============================================================ */

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'arkwork-migrate-'))
}

function writePlugin(root: string, dirName: string, raw: unknown): string {
  const sub = join(root, dirName)
  mkdirSync(sub, { recursive: true })
  const file = join(sub, 'plugin.json')
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8')
  return file
}

test('TC-PMIG-014 migratePluginManifestsOnDisk 默认写回：退役项被摘、文件被重排为 2 空格缩进', () => {
  const dir = tmpDir()
  try {
    const file = writePlugin(dir, 'ark.plugin.stock', legacyRaw())
    const touched = migratePluginManifestsOnDisk(dir)
    assert.deepEqual(touched, ['ark.plugin.stock'])
    const after = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    assert.ok(!JSON.stringify(after).includes('panel:stock-detail'), '退役面板必须从磁盘上消失')
    assert.ok(!JSON.stringify(after).includes('panel:stock-kline'))
    assert.equal(readFileSync(file, 'utf-8'), `${JSON.stringify(after, null, 2)}\n`, '写回口径为 2 空格缩进 + 结尾换行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-PMIG-015 ★ dry-run（apply:false）：只报 touched、磁盘一字不改（检查按钮用这条路径）', () => {
  const dir = tmpDir()
  try {
    const file = writePlugin(dir, 'ark.plugin.stock', legacyRaw())
    const before = readFileSync(file, 'utf-8')
    const touched = migratePluginManifestsOnDisk(dir, { apply: false })
    assert.deepEqual(touched, ['ark.plugin.stock'], '仍要如实报告「会改哪些」')
    assert.equal(readFileSync(file, 'utf-8'), before, 'dry-run 绝不能落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-PMIG-016 ★ 逐插件隔离：一个坏 JSON 不阻断其余插件的迁移（也不抛）', () => {
  const dir = tmpDir()
  try {
    writePlugin(dir, 'broken.one', legacyRaw())
    writeFileSync(join(dir, 'broken.one', 'plugin.json'), '{ 这不是 JSON', 'utf-8')
    const goodFile = writePlugin(dir, 'good.one', legacyRaw())
    // 目录里放一个非目录项（应被跳过）
    writeFileSync(join(dir, 'README.md'), 'not a plugin', 'utf-8')

    let touched: string[] = []
    assert.doesNotThrow(() => {
      touched = migratePluginManifestsOnDisk(dir)
    })
    assert.deepEqual(touched, ['good.one'], '坏文件被跳过，好文件照常迁移')
    assert.ok(!readFileSync(goodFile, 'utf-8').includes('panel:stock-detail'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-PMIG-017 已干净的清单不写回（touched 为空、mtime 不变）', () => {
  const dir = tmpDir()
  try {
    const clean = migratePluginManifest(legacyRaw()).next
    const file = writePlugin(dir, 'ark.plugin.stock', clean)
    const before = readFileSync(file, 'utf-8')
    const touched = migratePluginManifestsOnDisk(dir)
    assert.deepEqual(touched, [])
    assert.equal(readFileSync(file, 'utf-8'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-PMIG-018 目录不存在 → 返回空数组（不抛）', () => {
  assert.deepEqual(migratePluginManifestsOnDisk(join(tmpdir(), 'arkwork-does-not-exist-xyz')), [])
})
