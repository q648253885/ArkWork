/* ============================================================
 * ArkWork — 随包示例插件单测（v0.34.0 · P4 建立；v0.34.1 · P6 重写）
 * 规格来源：docs/versions/v0.34.1/04-system-design.md §5 / §5.1
 *
 * ★ v0.34.1 重写原因（用户裁决）：
 *   v0.34.0 的四个示例是**假数据演示件**（插件指南 / 运行时指标 / 工作区数据表 /
 *   .kchart 渲染器），它们证明了机制能跑，却也让人误以为「插件就是放示例表格的」。
 *   现全部删除，只保留一个**真实功能插件**：股票行情（多面板 + 联网取数 + 行点击）。
 *
 * 本组钉住四件缺一不可的事：
 *   ① **清单合法** —— 唯一示例必须过 VP1–VP6 且**零 warning**（官方示范不能自带坏数据）；
 *   ② **默认启用** —— 真实功能插件默认就该可见（假数据示例才默认禁用）；
 *   ③ **按 id 补写且永不覆盖用户改动** —— 已存在且被改过的一字不改；缺失的补写；
 *      ★ v0.34.2：**未被改动过的副本要能随版本升级**（否则修正永远送不到存量机器）；
 *   ④ **退役清理** —— 四个假数据示例的残留目录会被显式删除，不留垃圾。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs sample-plugins
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RAW_SAMPLE_PLUGINS,
  SAMPLE_PLUGIN_IDS,
  SAMPLE_PLUGIN_MANIFESTS,
  isSamplePlugin,
  rawManifestOf,
  sampleManifestForExport,
} from '../sample-plugins.js'
import {
  ensureSamplePlugins,
  removeRetiredSamplePlugins,
  isUntouchedCopy,
  seedTextOf,
  RETIRED_SAMPLE_PLUGIN_IDS,
  SEED_STRING_MIGRATIONS,
  SEED_SIDECAR,
} from '../seed.js'
import { RETIRED_PANEL_REFS } from '../migrate.js'
import { parsePluginManifest } from '@shared/utils/plugin-manifest'
import { mapHttpResponse } from '@shared/utils/panel-http'
import { applyTemplate, VLIB_COMPONENTS, type HttpSourceSpec } from '@shared/types/vlib'

/** 每个用例独立临时目录（互不污染，可并发） */
function tmpPluginDir(): string {
  return mkdtempSync(join(tmpdir(), 'arkwork-sample-plugins-'))
}

const STOCK = 'ark.plugin.stock'

/* ============================================================
 * 1. 清单合法性（坏样本会误导所有照着样例写插件的用户）
 * ============================================================ */

test('TC-SMPL-001 随包示例恰为 1 个真实插件（假数据演示件已全部下线）', () => {
  assert.equal(SAMPLE_PLUGIN_MANIFESTS.length, 1, 'v0.34.1 起只保留一个真实功能示例')
  assert.equal(RAW_SAMPLE_PLUGINS.length, 1)
  assert.equal(SAMPLE_PLUGIN_IDS.size, 1)
  assert.equal(SAMPLE_PLUGIN_MANIFESTS[0]!.id, STOCK)
})

test('TC-SMPL-002 示例清单再跑一遍 VP1–VP6 仍零 error 零 warning（同一校验路径）', () => {
  for (const raw of RAW_SAMPLE_PLUGINS) {
    const r = parsePluginManifest(raw)
    assert.ok(r.manifest, `示例插件 ${String(raw.id)} 未过校验：${JSON.stringify(r.issues)}`)
    assert.equal(r.issues.filter((i) => i.level === 'error').length, 0)
    // v0.34.0 D54：示例自身也不得出现「含模板占位符」告警（否则等于官方示范坏数据）
    assert.equal(
      r.issues.filter((i) => i.level === 'warning').length,
      0,
      `${String(raw.id)} 不应有 warning：${JSON.stringify(r.issues)}`,
    )
  }
})

test('TC-SMPL-003 示例是 panel 类，且 provides 与 kind 自洽（多面板形态）', () => {
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  assert.equal(m.kind, 'panel')
  // v0.34.1：多面板插件用 provides.panels；VP2 允许二者其一
  const panels = m.provides.panels ?? []
  assert.ok(panels.length > 0, '多面板示例必须提供 provides.panels')
  assert.ok(m.provides[m.kind] || panels.length > 0, 'provides 必须含自身 kind 那一项（VP2）')
})

/* ============================================================
 * 2. 真实功能示例的三项能力点（这就是「接入范例」的价值）
 * ============================================================ */

test('TC-SMPL-004 示例覆盖「单面板 + http 联网取数 + 派生列」三类能力', () => {
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  const panels = m.provides.panels ?? []
  // ★ v0.35.0（D75）：三面板 → 单面板。原「个股详情」「日K线」被用户点名为废弃项，
  //   已从随包示例摘除（见 TC-SMPL-026 的回归锁）
  assert.equal(panels.length, 1, 'D75 后只保留「自选股」一个面板')
  const refs = panels.map((p) => p.panelRef)
  assert.deepEqual(refs, ['panel:stock-quotes'])

  // ① http 数据源：真实联网，且只允许 https
  for (const p of panels) {
    assert.equal(p.data.kind, 'http', `${p.panelRef} 必须是 http 源（真实数据）`)
    const url = String((p.data.http as { url?: string } | undefined)?.url ?? '')
    assert.match(url, /^https:\/\//, `${p.panelRef} 的 url 必须是 https`)
  }

  // ② 行点击**必须不存在**：它唯一的指向就是那两个废弃面板，
  //    留着 = 用户点一行什么都不会发生（比没有交互更难排查）
  assert.equal(panels[0]!.interact, undefined, 'D75 后不得再声明 interact.onRowClick')

  // ③ 派生列仍在：secid 不再驱动浮窗，但它仍是「行级标识」的表达范例
  //    （未来任何个股级视图/工具都能直接复用；TC-SMPL-023/025 继续把守其解析正确性）
  const quotes = panels[0]!.data.http as { derive?: Record<string, string>; pollMs?: number }
  assert.deepEqual(quotes.derive, { secid: '{{f13}}.{{f12}}' }, '派生列必须保留')

  // ④ 轮询间隔不低于宿主下限（否则宿主夹取，等于作者意图失真）
  if (quotes.pollMs) assert.ok(quotes.pollMs >= 3000, 'pollMs 应 ≥3000')
})

test('TC-SMPL-013 ★ 取数主机回归锁：自选股不得再用 push2 主机（实测 ERR_EMPTY_RESPONSE）', () => {
  // 依据：v0.34.2 D56-b 实测（Electron net.fetch + 系统代理）
  //   push2.eastmoney.com   ulist.np / stock/get → net::ERR_EMPTY_RESPONSE（×3）
  //   push2delay.eastmoney.com 同接口 → 200 + 合法 JSON
  // 这条用例把「主机选择」钉住 —— 换回 push2 会让面板在真机上直接打不开，
  // 而单测/CI 环境根本发现不了（密闭环境不联网）。
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  const panels = m.provides.panels ?? []
  const urls = panels.map((p) => String((p.data.http as { url?: string } | undefined)?.url ?? ''))

  for (const u of urls) {
    assert.doesNotMatch(
      u,
      /^https:\/\/push2\.eastmoney\.com/,
      `不得使用 push2 主机（实测不可达）：${u}`,
    )
  }
  const quotes = urls.find((u) => u.includes('ulist.np'))!
  assert.match(quotes, /^https:\/\/push2delay\.eastmoney\.com\//, '自选股走 push2delay')
  // ★ v0.35.0（D75）：detail / kline 两条 URL 已随面板一起摘除，
  //   「它们不得复活」由 TC-SMPL-026 单独把守（这里不再断言不存在的东西）
})

/**
 * ★ v0.35.0（D75）退役回归锁。
 *
 * 这条用例存在的理由：那两个面板被摘除是**用户指令**（「删除废弃的侧边栏插件」）。
 * 写代码的人很容易在后续版本里「顺手把删掉的面板加回来」（它们看着挺有用），
 * 而加回来不会有任何测试变红 —— 除非有这么一条锁。
 *
 * 同时把守「摘除必须连带摘掉引用它的 interact」—— 半摘（删了面板留了交互）
 * 会造出一个「点了没反应」的死交互，比完整保留更难排查。
 */
test('TC-SMPL-026 ★ D75 退役锁：两个废弃面板不得复活，且不得遗留指向它们的交互', () => {
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  const refs = (m.provides.panels ?? []).map((p) => p.panelRef)
  for (const retired of RETIRED_PANEL_REFS) {
    assert.ok(!refs.includes(retired), `废弃面板 ${retired} 不得重新出现在随包示例里`)
  }
  // 全清单任意深度都不得残留对废弃 ref 的引用（interact / 未来的新字段都覆盖）
  const text = JSON.stringify(RAW_SAMPLE_PLUGINS)
  for (const retired of RETIRED_PANEL_REFS) {
    assert.ok(!text.includes(retired), `清单里不得残留 ${retired} 的任何引用`)
  }
  // `CandleChart` 组件本身**不退役**（Q4 裁决）—— 它仍应是合法白名单组件，
  // 只是随包示例不再用它（这里断言白名单仍在，防止有人把「删示例」误做成「删组件」）
  assert.ok(VLIB_COMPONENTS.includes('CandleChart'), 'CandleChart 应保留在组件白名单里')
})

/* ============================================================
 * 3. 默认启用（真实功能 ≠ 假数据演示）
 * ============================================================ */

test('TC-SMPL-006 ★ 真实功能示例 enabledByDefault=true（假数据示例才默认禁用）', () => {
  for (const raw of RAW_SAMPLE_PLUGINS) {
    assert.equal(raw.enabledByDefault, true, `${String(raw.id)} 是真实功能插件，默认应启用`)
  }
  for (const m of SAMPLE_PLUGIN_MANIFESTS) {
    assert.equal(m.enabledByDefault, true, `${m.id} 解析后也必须是 true`)
  }
})

/* ============================================================
 * 4. 来源判定与导出接口
 * ============================================================ */

test('TC-SMPL-007 isSamplePlugin 按 id 判定，且与导出清单同源', () => {
  for (const raw of RAW_SAMPLE_PLUGINS) assert.equal(isSamplePlugin(String(raw.id)), true)
  assert.equal(isSamplePlugin('local.demo'), false, '用户自建插件不得被误判为随包示例')
  assert.equal(isSamplePlugin(''), false)
  assert.equal(isSamplePlugin('ark.plugin.not-exists'), false)
  // 退役的假数据示例**不再**被认作随包示例（否则会以 bundled 身份复活）
  for (const id of RETIRED_SAMPLE_PLUGIN_IDS) assert.equal(isSamplePlugin(id), false)
})

test('TC-SMPL-008 导出接口：已知 id 取回同一份，未知 id 返回 null（不抛错）', () => {
  const first = SAMPLE_PLUGIN_MANIFESTS[0]!
  assert.deepEqual(sampleManifestForExport(first.id), first, '导出必须与内存同一份（同源）')
  assert.equal(sampleManifestForExport('no.such.plugin'), null)
  assert.equal(rawManifestOf('no.such.plugin'), null)
  assert.ok(rawManifestOf(STOCK), '可编辑副本必须能取到（落盘用）')
})

/* ============================================================
 * 5. 落盘：按 id 补写 + 永不覆盖 + 退役清理
 * ============================================================ */

test('TC-SMPL-009 空目录首启 → 落盘 1 份，目录名/id/文件名三者一致', () => {
  const dir = tmpPluginDir()
  try {
    const res = ensureSamplePlugins(dir)
    assert.equal(res.seeded, true, '空目录应执行落盘')
    assert.deepEqual(res.written, [STOCK])
    const subdirs = readdirSync(dir)
    assert.deepEqual(subdirs, [STOCK], '目录名必须等于插件 id')
    const file = join(dir, STOCK, 'plugin.json')
    assert.ok(existsSync(file))
    const written = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    assert.equal(written.id, STOCK)
    assert.ok(parsePluginManifest(written).manifest, '落盘后必须仍合法（不能被序列化改坏）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-010 ★ 按 id 补写：已有示例一字不改，缺失的补写（升级能送到新示例）', () => {
  const dir = tmpPluginDir()
  try {
    // 用户自建插件 + 用户改过的示例副本
    const userDir = join(dir, 'local.mine')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'plugin.json'), '{"id":"local.mine"}', 'utf-8')

    ensureSamplePlugins(dir)
    const stockFile = join(dir, STOCK, 'plugin.json')
    writeFileSync(stockFile, '{"id":"ark.plugin.stock","name":"用户改过"}', 'utf-8')

    // 删掉示例 → 下次启动必须补回（旧策略「目录有插件就整批跳过」做不到这点）
    rmSync(join(dir, STOCK), { recursive: true, force: true })
    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.written, [STOCK], '缺失的示例必须补写')
    assert.ok(existsSync(stockFile))

    // 已存在的用户副本不被覆盖
    writeFileSync(stockFile, '{"id":"ark.plugin.stock","name":"用户改过"}', 'utf-8')
    const res2 = ensureSamplePlugins(dir)
    assert.deepEqual(res2.written, [], '已存在则一字不改')
    assert.equal(
      readFileSync(stockFile, 'utf-8'),
      '{"id":"ark.plugin.stock","name":"用户改过"}',
      '绝不覆盖用户文件',
    )
    assert.equal(
      readFileSync(join(userDir, 'plugin.json'), 'utf-8'),
      '{"id":"local.mine"}',
      '用户自建插件不受影响',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-011 目录不存在 → 递归创建后落盘（不因目录缺失而静默失败）', () => {
  const parent = tmpPluginDir()
  const dir = join(parent, 'nested', 'plugins')
  try {
    assert.equal(existsSync(dir), false)
    const res = ensureSamplePlugins(dir)
    assert.equal(res.seeded, true)
    assert.deepEqual(res.written, [STOCK])
    assert.ok(existsSync(dir), '应递归创建目录')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('TC-SMPL-012 ★ 退役清理：四个假数据示例的残留目录被删除，用户插件不动', () => {
  const dir = tmpPluginDir()
  try {
    for (const id of RETIRED_SAMPLE_PLUGIN_IDS) {
      mkdirSync(join(dir, id), { recursive: true })
      writeFileSync(join(dir, id, 'plugin.json'), `{"id":"${id}"}`, 'utf-8')
    }
    const userDir = join(dir, 'local.mine')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'plugin.json'), '{"id":"local.mine"}', 'utf-8')

    const removed = removeRetiredSamplePlugins(dir)
    assert.equal(removed.length, RETIRED_SAMPLE_PLUGIN_IDS.length, '退役示例必须全部清掉')
    assert.deepEqual(readdirSync(dir), ['local.mine'], '只删退役示例，用户插件保留')

    // 幂等：再跑一次不报错、不误删
    assert.deepEqual(removeRetiredSamplePlugins(dir), [])
    // ensureSamplePlugins 内部会先清理 —— 顺序反了会把刚删掉的又写回来（不可能，因为已退役）
    ensureSamplePlugins(dir)
    for (const id of RETIRED_SAMPLE_PLUGIN_IDS) {
      assert.equal(existsSync(join(dir, id)), false, `${id} 不得复活`)
    }
    assert.ok(existsSync(join(dir, STOCK, 'plugin.json')), '新示例必须落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * 6. v0.34.2（D57）：未改动副本随版本升级（修正必须送得到存量机器）
 * ============================================================ */

/** 造一份「旧版随包内容」：把现用主机名倒推回退役主机名（即 v0.34.1 落盘的文本） */
function legacyTextOf(id: string): string {
  const raw = rawManifestOf(id)!
  let text = seedTextOf(raw)
  for (const [oldText, newText] of SEED_STRING_MIGRATIONS) text = text.split(newText).join(oldText)
  return text
}

test('TC-SMPL-014 ★ 存量机器路径：无副文件 + 仅差退役主机 → 判定「未改动」并升级（修正送达）', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, STOCK)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    const legacy = legacyTextOf(STOCK)
    assert.notEqual(legacy, seedTextOf(rawManifestOf(STOCK)!), '旧文本必须与新版不同（否则用例空转）')
    writeFileSync(file, legacy, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.upgraded, [STOCK], '仅主机不同的旧副本必须被升级 —— 否则修正永远送不到')
    assert.equal(readFileSync(file, 'utf-8'), seedTextOf(rawManifestOf(STOCK)!), '升级后内容 = 新版随包内容')
    assert.ok(existsSync(join(sub, SEED_SIDECAR)), '升级后必须补写指纹副文件')
    const side = JSON.parse(readFileSync(join(sub, SEED_SIDECAR), 'utf-8')) as { hash: string; version: string }
    // 绑到清单自身的 version（而非硬编码字面量）—— 断言的是「副文件如实记录了
    // 落盘那一版的版本号」这条不变量；硬编码会让每次版本号 +1 都制造一次假红。
    assert.equal(side.version, String(rawManifestOf(STOCK)!.version), '副文件记录插件版本（人可读凭据）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-015 ★ 用户改过的副本（改过数据源/自选股）→ 一字不改，且不误判为升级', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, STOCK)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    // 用户把自选股改成了自己的清单（真实用法，见 sample-plugins.ts 注释）
    const mine = legacyTextOf(STOCK).replace('1.600519,0.000001', '0.002415,1.600036')
    writeFileSync(file, mine, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.upgraded, [], '用户副本绝不能被升级覆盖')
    assert.deepEqual(res.written, [])
    assert.equal(readFileSync(file, 'utf-8'), mine, '内容必须一字不改')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-016 副文件指纹匹配（正常升级路径）→ 覆盖 + 刷新指纹；再跑一次幂等', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, STOCK)
  const file = join(sub, 'plugin.json')
  const sideFile = join(sub, SEED_SIDECAR)
  try {
    mkdirSync(sub, { recursive: true })
    const legacy = legacyTextOf(STOCK)
    writeFileSync(file, legacy, 'utf-8')
    writeFileSync(
      sideFile,
      `${JSON.stringify({ hash: createHash('sha256').update(legacy, 'utf8').digest('hex'), version: '1.0.0', seededAt: '2026-01-01T00:00:00.000Z' })}\n`,
      'utf-8',
    )

    const first = ensureSamplePlugins(dir)
    assert.deepEqual(first.upgraded, [STOCK])
    const after = readFileSync(file, 'utf-8')

    // 幂等：内容已是最新 → 不再写 plugin.json、不再报升级
    const second = ensureSamplePlugins(dir)
    assert.deepEqual(second.upgraded, [])
    assert.deepEqual(second.written, [])
    assert.equal(readFileSync(file, 'utf-8'), after)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-017 首启落盘即建立指纹；副文件放在插件自己目录内（不污染 plugins/ 根）', () => {
  const dir = tmpPluginDir()
  try {
    ensureSamplePlugins(dir)
    assert.ok(existsSync(join(dir, STOCK, SEED_SIDECAR)), '首启就该有指纹（否则下次无法判定未改动）')
    assert.deepEqual(readdirSync(dir), [STOCK], 'plugins/ 根目录只能有插件目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-018 isUntouchedCopy 真值表：坏 JSON / 坏指纹 / 空指纹一律按「用户副本」保守处理', () => {
  const raw = rawManifestOf(STOCK)!
  const bundled = seedTextOf(raw)
  const legacy = legacyTextOf(STOCK)

  assert.equal(isUntouchedCopy(bundled, raw, null), true, '内容一致 → 未改动')
  assert.equal(isUntouchedCopy(legacy, raw, null), true, '仅差退役主机 → 视为未改动（存量路径）')
  // 空白差异不算改动：判定是 **JSON 语义级**（格式化工具重排不该被当成用户编辑）
  assert.equal(isUntouchedCopy(`${legacy} `, raw, null), true, '空白/缩进差异不是用户改动')
  assert.equal(isUntouchedCopy(`${JSON.stringify(JSON.parse(legacy))}`, raw, null), true, '重排后语义不变 → 未改动')
  // 语义差异才算改动
  assert.equal(isUntouchedCopy('{"id":"ark.plugin.stock"}', raw, null), false, '用户简写副本 → 不动')
  assert.equal(isUntouchedCopy(legacy.replace('"自选股"', '"我的自选"'), raw, null), false, '改了标题 → 用户副本')
  assert.equal(isUntouchedCopy('not json at all', raw, null), false, '坏 JSON → 不动（不抛错）')
  assert.equal(isUntouchedCopy('{}', raw, {}), false, '空指纹字段不构成凭据')

  // 指纹路径真正要覆盖的场景：**未来版本语义变更**时，仍能凭指纹认出
  // 「这是随包写下的旧内容」→ 升级（否则每改一次字段就得再补一条迁移规则）
  const oldSemantic = JSON.stringify({ ...raw, version: '1.0.0' }, null, 2) + '\n'
  const oldHash = createHash('sha256').update(oldSemantic, 'utf8').digest('hex')
  assert.equal(isUntouchedCopy(oldSemantic, raw, { hash: oldHash }), true, '指纹匹配 → 未改动（语义不同也升级）')
  assert.equal(
    isUntouchedCopy(oldSemantic.replace('"自选股"', '"我的自选"'), raw, { hash: oldHash }),
    false,
    '指纹不匹配 + 语义也不同 → 用户改过，绝不动',
  )
})

test('TC-SMPL-019 退役主机迁移映射必须是非空且新旧不同（否则归一化比对会退化成恒真）', () => {
  assert.ok(SEED_STRING_MIGRATIONS.length > 0)
  for (const [from, to] of SEED_STRING_MIGRATIONS) {
    assert.notEqual(from, to)
    assert.ok(from.length > 0)
    assert.ok(to.length > 0)
  }
  // 方向 [旧, 新] 必须能被反过来用于「造旧副本」（见 legacyTextOf）
  const bundled = seedTextOf(rawManifestOf(STOCK)!)
  assert.notEqual(legacyTextOf(STOCK), bundled, '迁移表必须真的能把新内容还原成旧样子')
})

/* ---------- 上一版官方副本夹具（v0.34.1 落盘原文） ---------- */

const FIXTURE_V0341 = readFileSync(new URL('./fixtures/sample-plugins.v0.34.1.json', import.meta.url), 'utf-8')

test('TC-SMPL-020 ★ 迁移声明完整性：拿 v0.34.1 官方副本原文判定「未改动」必须成立', () => {
  // 这条用例是**静默失败模式的把守者**：只要有人改了随包示例的内容（URL/文案/字段）
  // 却忘了在 SEED_STRING_MIGRATIONS 里声明，本用例就会红 ——
  // 否则存量机器上那份「原封未动」的副本会被误判成用户副本，修正永远送不到，
  // 而 CI 里一切全绿（v0.34.2 真实踩过：D56-b 主机迁移 + 描述文案两处改动）。
  const raw = rawManifestOf(STOCK)!
  assert.equal(
    isUntouchedCopy(FIXTURE_V0341, raw, null),
    true,
    '上一版官方副本必须被判为「未改动」→ 可升级；否则用户永远拿不到本次修正',
  )
  // 反向：夹具本身确实不是新版内容（否则用例空转）
  assert.notEqual(FIXTURE_V0341, seedTextOf(raw), '夹具应与新版内容不同')
})

test('TC-SMPL-021 ★ 端到端：v0.34.1 官方副本 → ensure 升级到新版（修正真的送达）', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, STOCK)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    writeFileSync(file, FIXTURE_V0341, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.upgraded, [STOCK], '必须升级')
    const after = readFileSync(file, 'utf-8')
    assert.equal(after, seedTextOf(rawManifestOf(STOCK)!))
    assert.doesNotMatch(after, /push2\.eastmoney\.com/, '升级后不得残留实测不可达的主机')
    assert.match(after, /push2delay\.eastmoney\.com/, '升级后必须是实测可用的主机')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-022 用户改过自选股清单（在官方副本基础上）→ 绝不被升级覆盖', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, STOCK)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    const mine = FIXTURE_V0341.replace('1.600519,0.000001', '0.002415,1.600036')
    assert.notEqual(mine, FIXTURE_V0341)
    writeFileSync(file, mine, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.upgraded, [])
    assert.equal(readFileSync(file, 'utf-8'), mine, '用户清单必须原封不动')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * D62 ★ 行点击参数链端到端钉：出厂清单 → 派生 secid → 详情 URL
 *
 * 为什么放在这组：D62 是一条**只有把「出厂清单的真实形状」喂进映射器**
 * 才会暴露的缺陷。单元用例（TC-PHTTP-005）恰好把 `f13` 也写进了 columns，
 * 于是永远看不到「derive 引用了未投影字段」这条真实路径。
 * 本组用**清单自身的 spec** 驱动映射器，形状与线上完全一致。
 * ============================================================ */

/** 东方财富 ulist.np 的真实响应形状（f13 是**数字**市场码，且未被声明进 columns） */
const EASTMONEY_ULIST = {
  rc: 0,
  data: {
    total: 2,
    diff: [
      { f2: 1257.12, f3: -0.78, f4: -9.86, f12: '600519', f13: 1, f14: '贵州茅台', f18: 1266.98 },
      { f2: 11.7, f3: 0.78, f4: 0.09, f12: '000001', f13: 0, f14: '平安银行', f18: 11.61 },
    ],
  },
}

/** 出厂清单某面板的 http 规格（缺失即抛 —— 用例前提不成立时应当**响亮失败**） */
function httpSpecOf(ref: string): HttpSourceSpec {
  const p = (SAMPLE_PLUGIN_MANIFESTS[0]!.provides.panels ?? []).find((x) => x.panelRef === ref)
  assert.ok(p, `出厂清单必须有 ${ref}`)
  assert.ok(p!.data.http, `${ref} 必须是 http 数据源`)
  return p!.data.http!
}

test('TC-SMPL-023 ★ D62 回归：出厂「自选股」spec 必须派生出可用的 secid（f13 不在 columns 里）', () => {
  const quotes = httpSpecOf('panel:stock-quotes')
  // 前提断言：本用例的有效性依赖「derive 引用的字段确实没被投影展示」
  const colKeys = (quotes.columns ?? []).map((c) => c.key)
  assert.ok(!colKeys.includes('f13'), '前提：f13（市场码）本就不该出现在展示列里')
  assert.match(String(quotes.derive?.secid), /\{\{f13\}\}/, '前提：secid 模板确实引用 f13')

  const res = mapHttpResponse(EASTMONEY_ULIST, quotes)
  assert.equal(res.rows.length, 2)
  // 缺陷现象：secid 退化成字面量 '{{f13}}.600519' → 详情接口 data:null → 空面板
  for (const r of res.rows) {
    assert.doesNotMatch(String(r.secid), /\{\{/, `secid 不得残留未解析占位符：${String(r.secid)}`)
  }
  assert.equal(res.rows[0]!.secid, '1.600519', '沪市市场码 1')
  assert.equal(res.rows[1]!.secid, '0.000001', '深市市场码 0')
  assert.doesNotMatch(String(res.note), /未解析/, '解析成功时不得报「未解析」噪音')
})

test('TC-SMPL-024 ★ D62 机制守卫：派生 secid 代入 URL 模板必须零 {{…}} 残留（消费者已随 D75 退役）', () => {
  // ★ D75 背景（本用例从「端到端」降级为「机制级」的原因）：
  //   原先消费「派生 secid」的两个面板 —— `panel:stock-detail`（个股详情）与
  //   `panel:stock-kline`（日K线）—— 已被用户点名为废弃项并摘除，随包清单里
  //   再没有任何 URL 模板引用 secid。于是这条 D62 用例的**原始诉求**（拿出厂
  //   清单的真实形状喂进映射器、钉死详情/K线 URL 被完全替换）已无随包载体。
  //
  //   但 D62 钉住的**机制**（`derive` 产出的字段代入 `applyTemplate` 必须完全
  //   替换、零 `{{…}}` 残留）仍然通用 —— 未来的插件照样会这么用。故此处刻意
  //   保留该 ID、改为**机制级**守卫，而不是连机制一起悄悄丢掉。
  const quotes = httpSpecOf('panel:stock-quotes')
  const rows = mapHttpResponse(EASTMONEY_ULIST, quotes).rows
  const secid = String(rows[0]!.secid)
  assert.equal(secid, '1.600519', '前提：derive 必须先产出正确的 secid（沪市市场码 1）')

  // 模板用「未来插件会写的样子」（secid 走 query，与东方财富真实接口同形）。
  // 这不是替身断言：applyTemplate 是否残留占位符只取决于入参，与 URL 真伪无关。
  const tpl = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={{secid}}&klt=101'
  const resolved = applyTemplate(tpl, { secid })
  assert.doesNotMatch(resolved, /\{\{[\w.-]+\}\}/, `URL 模板必须被完全替换，实际：${resolved}`)
  assert.match(resolved, /secid=1\.600519(&|$)/, '必须带上真实 secid')

  // 反向钉：退役面板确实不再提供任何 URL 模板（否则上面的「机制级」说法不成立）
  const refs = (SAMPLE_PLUGIN_MANIFESTS[0]!.provides.panels ?? []).map((p) => p.panelRef)
  for (const retired of RETIRED_PANEL_REFS) {
    assert.ok(!refs.includes(retired), `退役面板 ${retired} 不得重新出现`)
  }
})

test('TC-SMPL-025 ★ D62 回归：响应缺 f13 时，note 必须点名「派生字段未解析」（不静默空面板）', () => {
  const quotes = httpSpecOf('panel:stock-quotes')
  // 模拟接口字段变更（或模板字段名拼错）：f13 消失
  const broken = { rc: 0, data: { diff: [{ f2: 1, f12: '600519', f14: '贵州茅台' }] } }
  const res = mapHttpResponse(broken, quotes)
  assert.match(String(res.rows[0]!.secid), /\{\{f13\}\}/, '未命中变量按 applyTemplate 语义原样保留')
  assert.match(String(res.note), /未解析/, 'note 必须把人话原因说出来')
  assert.match(String(res.note), /secid/, 'note 必须点名是哪个派生字段')
})
