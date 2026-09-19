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
import { parsePluginManifest } from '@shared/utils/plugin-manifest'

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

test('TC-SMPL-004 示例覆盖多面板 / http 联网取数 / 行点击三类能力', () => {
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  const panels = m.provides.panels ?? []
  assert.equal(panels.length, 3, '列表 + 详情 + K 线三面板')
  const refs = panels.map((p) => p.panelRef)
  assert.deepEqual(refs, ['panel:stock-quotes', 'panel:stock-detail', 'panel:stock-kline'])

  // ① http 数据源：三个面板全部真实联网，且只允许 https
  for (const p of panels) {
    assert.equal(p.data.kind, 'http', `${p.panelRef} 必须是 http 源（真实数据）`)
    const url = String((p.data.http as { url?: string } | undefined)?.url ?? '')
    assert.match(url, /^https:\/\//, `${p.panelRef} 的 url 必须是 https`)
  }

  // ② 行点击 → 浮窗打开详情 + K 线，参数取自当前行字段
  const click = panels[0]!.interact?.onRowClick
  assert.ok(click, '列表面板必须声明行点击')
  assert.deepEqual(click!.panelRefs, ['panel:stock-detail', 'panel:stock-kline'])
  assert.deepEqual(click!.params, { secid: 'secid' })

  // ③ 参数化 URL：详情/K线面板的 url 含 {{secid}} 占位符
  for (const p of panels.slice(1)) {
    const url = String((p.data.http as { url?: string } | undefined)?.url ?? '')
    assert.match(url, /\{\{secid\}\}/, `${p.panelRef} 的 url 必须含 {{secid}} 占位符`)
  }

  // ④ 轮询间隔不低于宿主下限（否则宿主夹取，等于作者意图失真）
  for (const p of panels) {
    const spec = p.data.http as { pollMs?: number } | undefined
    if (spec?.pollMs) assert.ok(spec.pollMs >= 3000, `${p.panelRef} 的 pollMs 应 ≥3000`)
  }
})

test('TC-SMPL-013 ★ 取数主机回归锁：自选股/详情不得再用 push2 主机（实测 ERR_EMPTY_RESPONSE）', () => {
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
  const detail = urls.find((u) => u.includes('stock/get'))!
  assert.match(detail, /^https:\/\/push2delay\.eastmoney\.com\//, '个股详情走 push2delay')
  const kline = urls.find((u) => u.includes('kline'))!
  assert.match(kline, /^https:\/\/push2his\.eastmoney\.com\//, 'K 线走 push2his（实测 200）')
})

test('TC-SMPL-005 K 线面板必须用 CandleChart 且声明开高低收四列（形状自洽）', () => {
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  const kline = (m.provides.panels ?? []).find((p) => p.panelRef === 'panel:stock-kline')!
  assert.equal(kline.component, 'CandleChart')
  const spec = kline.data.http as { split?: string; columns?: Array<{ key: string }> }
  assert.equal(spec.split, ',', 'K 线接口每行是逗号分隔字符串')
  const keys = (spec.columns ?? []).map((c) => c.key)
  for (const k of ['date', 'open', 'close', 'high', 'low']) {
    assert.ok(keys.includes(k), `CandleChart 需要 ${k} 字段，实际：${keys.join(',')}`)
  }
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
    assert.equal(side.version, '1.0.1', '副文件记录插件版本（人可读凭据）')
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
