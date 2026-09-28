/* ============================================================
 * ArkWork — 随包示例插件单测（v0.34.0 · P4 建立；v0.34.1 · P6 重写；
 *                        v0.36.0 · F3.5 随「股票退役 → Git Manager 登场」再重写）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §3.5
 *
 * ★ v0.36.0 重写原因（用户裁决：「删除股票插件，开发一个 git 管理插件」）：
 *   股票行情插件移入退役名单（RETIRED_SAMPLE_PLUGIN_IDS），唯一随包示例改为
 *   **代码插件** ark.plugin.git-manager（Host 半 + 自带界面 + git 封闭白名单）。
 *   原股票专属用例（D62 派生 secid 端到端 / push2 主机回归锁）随之退役 ——
 *   派生字段机制由 panel-http.test.ts 的合成 spec 用例继承，机制不丢。
 *
 * 本组钉住五件缺一不可的事：
 *   ① **清单合法** —— 唯一示例必须过 VP1–VP6 且**零 warning**（官方示范不能自带坏数据）；
 *   ② **代码插件四要素** —— main Host 半 / provides.views / provides.commands /
 *      git 权限声明与引擎门槛，一个都不能少；
 *   ③ **按 id 补写且永不覆盖用户改动** —— 已存在且被改过的一字不改；缺失的补写；
 *      未被改动过的副本要能随版本升级（否则修正永远送不到存量机器）；
 *   ④ **随包文件载荷（files）** —— main.js / panel.html 逐字节落盘、升级可送达、
 *      用户改过不覆盖；载荷也有指纹（D88：清单没变但代码变了，同样要送达）；
 *   ⑤ **退役清理** —— 股票插件等退役示例的残留目录被显式删除，不留垃圾。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs sample-plugins
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const GIT = 'ark.plugin.git-manager'

/** 现行随包清单的落盘文本（剥离 files 载荷 —— 与 seed.ts 的 manifestTextOf 同口径） */
function bundledTextOf(id: string): string {
  const { files: _files, ...manifest } = rawManifestOf(id)!
  return seedTextOf(manifest)
}

/** 造一份「旧版随包清单文本」：只把 version 倒推（归一化比对会抹掉 version 差异 → 判未改动） */
function legacyTextOf(id: string): string {
  const { files: _files, ...manifest } = rawManifestOf(id)!
  return seedTextOf({ ...manifest, version: '0.9.9' })
}

/* ============================================================
 * 1. 清单合法性（坏样本会误导所有照着样例写插件的用户）
 * ============================================================ */

test('TC-SMPL-001 随包示例恰为 1 个真实插件（股票已退役，Git Manager 接棒）', () => {
  assert.equal(SAMPLE_PLUGIN_MANIFESTS.length, 1, 'v0.36.0 起唯一示例 = Git 管理代码插件')
  assert.equal(RAW_SAMPLE_PLUGINS.length, 1)
  assert.equal(SAMPLE_PLUGIN_IDS.size, 1)
  assert.equal(SAMPLE_PLUGIN_MANIFESTS[0]!.id, GIT)
})

test('TC-SMPL-002 示例清单再跑一遍 VP1–VP6 仍零 error 零 warning（同一校验路径）', () => {
  for (const raw of RAW_SAMPLE_PLUGINS) {
    const { files: _files, ...manifest } = raw
    const r = parsePluginManifest(manifest)
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

test('TC-SMPL-003 示例是 panel 类，且 provides 与 kind 自洽（代码视图形态）', () => {
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  assert.equal(m.kind, 'panel')
  // v0.36.0：面板类插件允许携带代码视图（VP2 二者其一）；本示例走 provides.views
  const views = m.provides.views ?? []
  assert.ok(views.length > 0, 'Git Manager 必须提供 provides.views（自带界面）')
  const v = views[0]!
  assert.equal(v.viewRef, 'view:git', 'viewRef 必须带 view: 前缀（与运行期注册一致）')
  assert.equal(v.renderer, 'panel.html', '代码视图必须有 Client 半入口')
  assert.equal(v.placement, 'dock', '边界纪律：插件视图只能 dock/float')
})

/* ============================================================
 * 2. 代码插件示例的四要素（这就是「代码插件接入范例」的价值）
 * ============================================================ */

test('TC-SMPL-004 代码插件四要素：main / views / commands / 权限与引擎门槛', () => {
  const m = SAMPLE_PLUGIN_MANIFESTS[0]!
  assert.equal(m.main, 'main.js', '必须有 Host 半入口（工具/命令/视图注册都在它里面）')
  assert.ok((m.provides.views ?? []).length > 0, '必须有代码视图')
  assert.ok((m.provides.commands ?? []).some((c) => c.id === 'git.status'), '必须有 QuickAction 命令')
  // 权限闭集：git 能力 + 视图注册，缺一不可也不可多
  assert.deepEqual([...(m.permissions ?? [])].sort(), ['git', 'views.register'])
  // 引擎门槛：ctx.ark.git 是 v0.36.0 引入的能力，低于它的宿主必须拒绝激活
  assert.equal(
    (m.engines as { arkwork?: string } | undefined)?.arkwork,
    '^0.36.0',
    'engines.arkwork 必须声明 ^0.36.0（git 能力门槛）',
  )
})

test('TC-SMPL-013 ★ 随包文件载荷与清单分离：files 不进 plugin.json（VP 校验面干净）', () => {
  // v0.36.0：`files` 是 seed 的落盘载荷，不是清单字段。写进清单既污染用户副本，
  // 也会让 VP 校验白白面对一个它不认识的顶层键。这条用例把「分离」钉死。
  for (const raw of RAW_SAMPLE_PLUGINS) {
    const onDisk = JSON.parse(bundledTextOf(String(raw.id))) as Record<string, unknown>
    assert.equal('files' in onDisk, false, '落盘后的 plugin.json 不得含 files 字段')
    // 载荷必须真实存在且为字符串（否则落盘会产出空文件）
    const files = raw.files as Record<string, string> | undefined
    assert.ok(files, `${String(raw.id)} 必须携带 files 载荷`)
    for (const [name, content] of Object.entries(files ?? {})) {
      assert.ok(typeof content === 'string' && content.length > 0, `随包文件 ${name} 不得为空`)
    }
    assert.ok('main.js' in (files ?? {}), 'Host 半源码必须随包携带')
    assert.ok('panel.html' in (files ?? {}), 'Client 半页面必须随包携带')
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

test('TC-SMPL-007 isSamplePlugin 按 id 判定，且与导出清单同源（含股票退役判定）', () => {
  for (const raw of RAW_SAMPLE_PLUGINS) assert.equal(isSamplePlugin(String(raw.id)), true)
  assert.equal(isSamplePlugin('local.demo'), false, '用户自建插件不得被误判为随包示例')
  assert.equal(isSamplePlugin(''), false)
  assert.equal(isSamplePlugin('ark.plugin.not-exists'), false)
  // 退役示例（含 v0.36.0 的股票插件）**不再**被认作随包示例（否则会以 bundled 身份复活）
  for (const id of RETIRED_SAMPLE_PLUGIN_IDS) assert.equal(isSamplePlugin(id), false)
  assert.ok(RETIRED_SAMPLE_PLUGIN_IDS.includes('ark.plugin.stock'), '股票插件必须在退役名单里')
})

test('TC-SMPL-008 导出接口：已知 id 取回同一份，未知 id 返回 null（不抛错）', () => {
  const first = SAMPLE_PLUGIN_MANIFESTS[0]!
  assert.deepEqual(sampleManifestForExport(first.id), first, '导出必须与内存同一份（同源）')
  assert.equal(sampleManifestForExport('no.such.plugin'), null)
  assert.equal(rawManifestOf('no.such.plugin'), null)
  assert.ok(rawManifestOf(GIT), '可编辑副本必须能取到（落盘用）')
})

/* ============================================================
 * 5. 落盘：按 id 补写 + 永不覆盖 + 退役清理
 * ============================================================ */

test('TC-SMPL-009 空目录首启 → 落盘 1 份（清单 + 随包文件），目录名/id/文件名三者一致', () => {
  const dir = tmpPluginDir()
  try {
    const res = ensureSamplePlugins(dir)
    assert.equal(res.seeded, true, '空目录应执行落盘')
    assert.deepEqual(res.written, [GIT])
    const subdirs = readdirSync(dir)
    assert.deepEqual(subdirs, [GIT], '目录名必须等于插件 id')
    const file = join(dir, GIT, 'plugin.json')
    assert.ok(existsSync(file))
    const written = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    assert.equal(written.id, GIT)
    assert.ok(parsePluginManifest(written).manifest, '落盘后必须仍合法（不能被序列化改坏）')
    // v0.36.0：随包文件同时落盘（没有它们，代码插件就是一个空壳）
    assert.ok(existsSync(join(dir, GIT, 'main.js')), 'Host 半必须落盘')
    assert.ok(existsSync(join(dir, GIT, 'panel.html')), 'Client 半必须落盘')
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
    const gitFile = join(dir, GIT, 'plugin.json')
    writeFileSync(gitFile, `{"id":"${GIT}","name":"用户改过"}`, 'utf-8')

    // 删掉示例 → 下次启动必须补回（旧策略「目录有插件就整批跳过」做不到这点）
    rmSync(join(dir, GIT), { recursive: true, force: true })
    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.written, [GIT], '缺失的示例必须补写')
    assert.ok(existsSync(gitFile))

    // 已存在的用户副本不被覆盖
    writeFileSync(gitFile, `{"id":"${GIT}","name":"用户改过"}`, 'utf-8')
    const res2 = ensureSamplePlugins(dir)
    assert.deepEqual(res2.written, [], '已存在则一字不改')
    assert.equal(
      readFileSync(gitFile, 'utf-8'),
      `{"id":"${GIT}","name":"用户改过"}`,
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
    assert.deepEqual(res.written, [GIT])
    assert.ok(existsSync(dir), '应递归创建目录')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('TC-SMPL-012 ★ 退役清理：股票插件等退役示例的残留目录被删除，用户插件不动', () => {
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
    assert.ok(existsSync(join(dir, GIT, 'plugin.json')), '新示例必须落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * 6. 未改动副本随版本升级（修正必须送得到存量机器）
 * ============================================================ */

test('TC-SMPL-014 ★ 存量机器路径：无副文件 + 仅差 version → 判定「未改动」并升级（修正送达）', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, GIT)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    const legacy = legacyTextOf(GIT)
    assert.notEqual(legacy, bundledTextOf(GIT), '旧文本必须与新版不同（否则用例空转）')
    writeFileSync(file, legacy, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.upgraded, [GIT], '仅差 version 的旧副本必须被升级 —— 否则修正永远送不到')
    assert.equal(readFileSync(file, 'utf-8'), bundledTextOf(GIT), '升级后内容 = 新版随包内容')
    assert.ok(existsSync(join(sub, SEED_SIDECAR)), '升级后必须补写指纹副文件')
    const side = JSON.parse(readFileSync(join(sub, SEED_SIDECAR), 'utf-8')) as { hash: string; version: string }
    // 绑到清单自身的 version（而非硬编码字面量）—— 断言的是「副文件如实记录了
    // 落盘那一版的版本号」这条不变量；硬编码会让每次版本号 +1 都制造一次假红。
    assert.equal(side.version, String(rawManifestOf(GIT)!.version), '副文件记录插件版本（人可读凭据）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-015 ★ 用户改过的副本（改过标题）→ 一字不改，且不误判为升级', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, GIT)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    // 用户把展示标题改成了自己的（真实用法 —— plugin.json 是用户副本）
    const mine = legacyTextOf(GIT).replace('"Git 管理"', '"我的 Git"')
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
  const sub = join(dir, GIT)
  const file = join(sub, 'plugin.json')
  const sideFile = join(sub, SEED_SIDECAR)
  try {
    mkdirSync(sub, { recursive: true })
    const legacy = legacyTextOf(GIT)
    writeFileSync(file, legacy, 'utf-8')
    writeFileSync(
      sideFile,
      `${JSON.stringify({ hash: createHash('sha256').update(legacy, 'utf8').digest('hex'), version: '0.9.9', seededAt: '2026-01-01T00:00:00.000Z' })}\n`,
      'utf-8',
    )

    const first = ensureSamplePlugins(dir)
    assert.deepEqual(first.upgraded, [GIT])
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
    assert.ok(existsSync(join(dir, GIT, SEED_SIDECAR)), '首启就该有指纹（否则下次无法判定未改动）')
    assert.deepEqual(readdirSync(dir), [GIT], 'plugins/ 根目录只能有插件目录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-018 isUntouchedCopy 真值表：坏 JSON / 坏指纹 / 空指纹一律按「用户副本」保守处理', () => {
  const raw = rawManifestOf(GIT)!
  const bundled = bundledTextOf(GIT)
  const legacy = legacyTextOf(GIT)
  const { files: _files, ...manifest } = raw

  assert.equal(isUntouchedCopy(bundled, raw, null), true, '内容一致 → 未改动')
  assert.equal(isUntouchedCopy(legacy, raw, null), true, '仅差 version → 视为未改动（存量路径）')
  // 空白差异不算改动：判定是 **JSON 语义级**（格式化工具重排不该被当成用户编辑）
  assert.equal(isUntouchedCopy(`${legacy} `, raw, null), true, '空白/缩进差异不是用户改动')
  assert.equal(isUntouchedCopy(`${JSON.stringify(JSON.parse(legacy))}`, raw, null), true, '重排后语义不变 → 未改动')
  // 语义差异才算改动
  assert.equal(isUntouchedCopy(`{"id":"${GIT}"}`, raw, null), false, '用户简写副本 → 不动')
  assert.equal(isUntouchedCopy(legacy.replace('"Git 管理"', '"我的 Git"'), raw, null), false, '改了标题 → 用户副本')
  assert.equal(isUntouchedCopy('not json at all', raw, null), false, '坏 JSON → 不动（不抛错）')
  assert.equal(isUntouchedCopy('{}', raw, {}), false, '空指纹字段不构成凭据')

  // 指纹路径真正要覆盖的场景：**未来版本语义变更**时，仍能凭指纹认出
  // 「这是随包写下的旧内容」→ 升级（否则每改一次字段就得再补一条迁移规则）
  const oldSemantic = JSON.stringify({ ...manifest, version: '0.9.9' }, null, 2) + '\n'
  const oldHash = createHash('sha256').update(oldSemantic, 'utf8').digest('hex')
  assert.equal(isUntouchedCopy(oldSemantic, raw, { hash: oldHash }), true, '指纹匹配 → 未改动（语义不同也升级）')
  assert.equal(
    isUntouchedCopy(oldSemantic.replace('"Git 管理"', '"我的 Git"'), raw, { hash: oldHash }),
    false,
    '指纹不匹配 + 语义也不同 → 用户改过，绝不动',
  )
})

test('TC-SMPL-019 迁移映射表必须是非空且新旧不同（否则归一化比对会退化成恒真）', () => {
  // v0.36.0：股票插件退役后，表里存量条目不再有消费对象 —— 但**机制**保留：
  // 未来对 Git Manager 的文案/主机类修正仍走这张表（漏声明 = 存量收不到修正）。
  assert.ok(SEED_STRING_MIGRATIONS.length > 0)
  for (const [from, to] of SEED_STRING_MIGRATIONS) {
    assert.notEqual(from, to)
    assert.ok(from.length > 0)
    assert.ok(to.length > 0)
  }
})

/* ============================================================
 * 7. v0.36.0：随包文件载荷（files）的落盘语义
 * ============================================================ */

test('TC-SMPL-020 ★ files 逐字节落盘：main.js / panel.html 与字面量完全一致（序列化不得改坏代码）', () => {
  const dir = tmpPluginDir()
  try {
    ensureSamplePlugins(dir)
    const raw = rawManifestOf(GIT)!
    const files = raw.files as Record<string, string>
    for (const [name, content] of Object.entries(files)) {
      assert.equal(readFileSync(join(dir, GIT, name), 'utf-8'), content, `随包文件 ${name} 必须逐字节一致`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-021 ★ 端到端：旧版副本 + 缺失的 main.js → 升级后清单与文件同时送达', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, GIT)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    writeFileSync(file, legacyTextOf(GIT), 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.upgraded, [GIT], '必须升级')
    assert.equal(readFileSync(file, 'utf-8'), bundledTextOf(GIT))
    // 升级路径会无条件重写随包文件 —— 「修正送达」对代码插件同样成立
    assert.ok(existsSync(join(sub, 'main.js')), '升级必须补齐随包文件')
    const files = rawManifestOf(GIT)!.files as Record<string, string>
    assert.equal(readFileSync(join(sub, 'main.js'), 'utf-8'), files['main.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-022 ★ 用户改过随包文件（main.js）但清单未动 → 只补缺失，不覆盖用户代码', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, GIT)
  const mainFile = join(sub, 'main.js')
  try {
    ensureSamplePlugins(dir)
    const userCode = '// 用户改过：我的定制版'
    writeFileSync(mainFile, userCode, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.written, [], '清单已是最新 → 不写')
    assert.deepEqual(res.upgraded, [])
    assert.deepEqual(res.refreshed, [], '指纹记录的哈希 ≠ 磁盘内容 = 用户副本 → 不同步（D88）')
    assert.equal(readFileSync(mainFile, 'utf-8'), userCode, '指纹不命中 = 用户改过 → 绝不覆盖用户的 main.js')
    assert.equal(readFileSync(join(sub, 'plugin.json'), 'utf-8'), bundledTextOf(GIT))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * 8. v0.36.0 · D88：载荷指纹 —— 「清单没变、代码变了」这一格
 *
 * 实机 B3 冒烟发现：指纹副文件只记 plugin.json 的哈希，载荷文件不在指纹里
 * ⇒ 修好随包插件源码、重建、重跑，磁盘副本**纹丝不动**，同一个 TypeError
 * 反复复现。根因是「清单已是最新」分支只补缺失文件、从不升级已存在的载荷。
 * 这两条用例把该格的两种结局钉死：官方旧副本要送达，用户副本要保住。
 * ============================================================ */

/** 把插件目录的载荷指纹改成「磁盘当前内容」的哈希（模拟：磁盘那份就是上一版官方副本） */
function stampPayloadHash(sub: string, name: string, content: string): void {
  const sideFile = join(sub, SEED_SIDECAR)
  const side = JSON.parse(readFileSync(sideFile, 'utf-8')) as { files?: Record<string, string> }
  side.files = { ...(side.files ?? {}), [name]: createHash('sha256').update(content, 'utf8').digest('hex') }
  writeFileSync(sideFile, `${JSON.stringify(side, null, 2)}\n`, 'utf-8')
}

test('TC-SMPL-023 ★ D88：清单未动但载荷是旧版官方副本 → 载荷必须被同步（修正可达）', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, GIT)
  const mainFile = join(sub, 'main.js')
  try {
    ensureSamplePlugins(dir) // 首启：落盘 + 建指纹
    const bundled = (rawManifestOf(GIT)!.files as Record<string, string>)['main.js']!

    // 模拟「上一版随包内容」：磁盘上是一份**旧版官方副本**，指纹里记的就是它
    const older = '// 上一版随包 main.js（未含本版修复）'
    assert.notEqual(older, bundled, '旧版内容必须与新版不同（否则用例空转）')
    writeFileSync(mainFile, older, 'utf-8')
    stampPayloadHash(sub, 'main.js', older)

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.refreshed, [GIT], '清单没变但载荷变了 —— 必须报告「载荷已同步」')
    assert.deepEqual(res.upgraded, [], '清单不该被写（它与新版一致）')
    assert.deepEqual(res.written, [])
    assert.equal(res.seeded, true, '载荷同步也算「本次执行了落盘动作」')
    assert.equal(readFileSync(mainFile, 'utf-8'), bundled, '官方旧副本必须被新版覆盖 —— 否则修正永远送不到')
    // 指纹要跟着更新，否则下次又判定不出来（漏更新 = 每次启动都重复覆盖）
    const after = JSON.parse(readFileSync(join(sub, SEED_SIDECAR), 'utf-8')) as { files?: Record<string, string> }
    assert.equal(after.files?.['main.js'], createHash('sha256').update(bundled, 'utf8').digest('hex'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-024 ★ D88：幂等 —— 载荷已是最新时不重复同步、不重复报账', () => {
  const dir = tmpPluginDir()
  try {
    ensureSamplePlugins(dir)
    // 紧接的第二次启动：清单与载荷都已是新版 → 什么账都不该报
    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.refreshed, [])
    assert.deepEqual(res.upgraded, [])
    assert.deepEqual(res.written, [])
    assert.equal(res.seeded, false, '无事可做时 seeded 必须为 false（否则启动日志每次都说「做了事」）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-025 ★ D88：指纹缺该文件记录（存量副文件）→ 按「随包本体」同步（宁可送达不可静默）', () => {
  const dir = tmpPluginDir()
  const sub = join(dir, GIT)
  const mainFile = join(sub, 'main.js')
  try {
    ensureSamplePlugins(dir)
    const bundled = (rawManifestOf(GIT)!.files as Record<string, string>)['main.js']!
    // 模拟本特性之前的存量副文件：只有 plugin.json 的 hash，没有 files 字段
    writeFileSync(mainFile, '// 旧版落下的官方副本', 'utf-8')
    const sideFile = join(sub, SEED_SIDECAR)
    const side = JSON.parse(readFileSync(sideFile, 'utf-8')) as Record<string, unknown>
    delete side.files
    writeFileSync(sideFile, `${JSON.stringify(side, null, 2)}\n`, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.refreshed, [GIT], '指纹缺失时按随包本体处理 —— 修正是第一优先级')
    assert.equal(readFileSync(mainFile, 'utf-8'), bundled)
    // 同步后必须补上文件指纹，从此可区分官方副本与用户副本
    const after = JSON.parse(readFileSync(sideFile, 'utf-8')) as { files?: Record<string, string> }
    assert.ok(after.files?.['main.js'], '同步后必须补写载荷指纹（否则永远回到「无法区分」状态）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================================================
 * 9. v0.36.0 · D91/D92：竖排栏标签与图标 —— 升级可达性 + 与渲染层的契约
 *
 * 实机复验发现的两处「单测全绿但界面不对」：
 *   D91 竖排栏标签「Git Man…」内容 52px / 渲染 37px → 被裁切（栏宽 44px）
 *   D92 插件声明 icon:'GitBranch'，图标集里只有 'Branch' → 静默退化成圆点
 * 修完代码不算完：**存量安装必须收得到**（否则用户机器上还是白点 + 截断标签）。
 * ============================================================ */

/**
 * ★ 冻结夹具：v0.36.0 出厂时随包落盘的官方副本**逐字原文**。
 *
 * 为什么要冻结而不是「拿现行清单倒推」：倒推出来的副本按构造就能被归一化命中，
 * 用例会**空转通过**，等于没有把守（v0.34.2 之后股票插件退役、原把守者失效，
 * 空窗期就是这么来的）。冻结件取自真实机器的 `{userData}/arkwork-data/plugins/
 * ark.plugin.git-manager/plugin.json`，是「上一版官方副本」最忠实的样本。
 *
 * 维护方式：本版若再改随包内容 → 在这里**追加一份新的冻结件**（旧的保留，
 * 它代表更早的存量用户），并在 `SEED_STRING_MIGRATIONS` 里补上对应条目。
 */
const V0360_FROZEN_OFFICIAL_GIT = `{
  "schemaVersion": "1.1",
  "id": "ark.plugin.git-manager",
  "name": "Git 管理",
  "version": "1.0.0",
  "author": "ArkWork",
  "description": "工作区 Git 状态、暂存、提交、历史与推送（封闭白名单操作，写操作需宿主确认）",
  "kind": "panel",
  "main": "main.js",
  "renderer": "panel.html",
  "enabledByDefault": true,
  "engines": {
    "arkwork": "^0.36.0"
  },
  "permissions": [
    "git",
    "views.register"
  ],
  "provides": {
    "views": [
      {
        "viewRef": "view:git",
        "title": "Git Manager",
        "icon": "GitBranch",
        "renderer": "panel.html",
        "placement": "dock"
      }
    ],
    "commands": [
      {
        "id": "git.status",
        "title": "Git: 刷新状态"
      }
    ]
  }
}
`

test('TC-SMPL-026 ★ 冻结的 v0.36.0 官方副本（无指纹 / 未改动）→ 判未改动并升级（迁移表把守者）', () => {
  const raw = rawManifestOf(GIT)!
  // ① 纯判定层：无副文件的存量副本必须被判为「未改动」，否则修正永远送不到
  assert.equal(
    isUntouchedCopy(V0360_FROZEN_OFFICIAL_GIT, raw, null),
    true,
    '上一版官方副本被判成「用户副本」= 迁移条目漏声明 = 整批存量用户收不到修正',
  )

  // ② 端到端：真落盘 + 真升级 + 清单里确实换成新值
  const dir = tmpPluginDir()
  const sub = join(dir, GIT)
  const file = join(sub, 'plugin.json')
  try {
    mkdirSync(sub, { recursive: true })
    writeFileSync(file, V0360_FROZEN_OFFICIAL_GIT, 'utf-8')

    const res = ensureSamplePlugins(dir)
    assert.deepEqual(res.upgraded, [GIT], '必须升级')
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as {
      provides: { views: Array<{ title: string; icon: string }> }
    }
    const v = onDisk.provides.views[0]!
    assert.equal(v.title, 'Git', 'D91：竖排栏标签已收敛为 3 字以内')
    assert.equal(v.icon, 'Branch', 'D92：图标名已换成图标集里真实存在的那个')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-SMPL-027 ★ D91：随包插件声明的 view.title 必须装得进竖排栏（≤3 字）', async () => {
  const { RAIL_LABEL_MAX_CHARS } = await import('../../../renderer/utils/label-guard.js')
  for (const raw of RAW_SAMPLE_PLUGINS) {
    for (const v of (raw.provides as { views?: Array<{ title: string }> }).views ?? []) {
      assert.ok(
        v.title.length <= RAIL_LABEL_MAX_CHARS,
        `随包插件 ${String(raw.id)} 的视图标题「${v.title}」(${v.title.length} 字) 超过竖排栏预算 ` +
          `${RAIL_LABEL_MAX_CHARS} —— 官方示范不能自带会被截断的数据`,
      )
    }
  }
})

test('TC-SMPL-028 ★ D92：随包插件声明的图标名必须存在于渲染层图标集（写错会静默变圆点）', () => {
  const iconsSource = readFileSync(
    join(fileURLToPath(new URL('../../../renderer/', import.meta.url)), 'icons.tsx'),
    'utf-8',
  )
  const known = new Set(
    [...iconsSource.matchAll(/^ {2}([A-Z][A-Za-z0-9]*):\s*\(?/gm)].map((m) => m[1]!),
  )
  assert.ok(known.size >= 50, `图标集解析异常：只认出 ${known.size} 个名字`)

  for (const raw of RAW_SAMPLE_PLUGINS) {
    const declared: string[] = []
    for (const v of (raw.provides as { views?: Array<{ icon?: string }> }).views ?? []) {
      if (v.icon) declared.push(v.icon)
    }
    // Host 半运行期注册的那份也必须一致（作者最容易只改清单、忘了 main.js）
    const mainJs = (raw.files as Record<string, string> | undefined)?.['main.js'] ?? ''
    for (const m of mainJs.matchAll(/icon:\s*'([^']+)'/g)) declared.push(m[1]!)

    assert.ok(declared.length > 0, `随包插件 ${String(raw.id)} 应至少声明一个图标`)
    for (const name of declared) {
      assert.ok(
        known.has(name),
        `图标名「${name}」不在渲染层图标集中（${String(raw.id)}）—— ` +
          '界面上会静默退化成一颗圆点，且控制台只在运行时才告警',
      )
    }
  }
})

test('TC-SMPL-029 ★ D94：随包插件引用的 CSS 变量必须在宿主主题契约内（契约外 = 主题失配）', async () => {
  // 宿主只把 PLUGIN_THEME_TOKENS 白名单内的令牌经桥发给插件；契约外的名字宿主
  // 不下发，插件就会落到自己写的浅色兜底值 —— 实机表现：深色主题下按钮/输入框
  // 是一块块白底（D94，靠截图肉眼发现）。这条用例把「随包示范不得引用契约外
  // 令牌」钉死，谁再往 panel.html 里塞自造令牌名就红。
  // ★ D96：从 shared 取契约（原名在 renderer/utils/plugin-theme.ts，
  //   那边依赖 window/document，main 侧 import 它会把 DOM 拖进 node 端的
  //   类型域 —— tsconfig.node.json 无 DOM lib，直接 4 个 TS2304/TS2584）。
  const { PLUGIN_THEME_TOKENS } = await import('@shared/utils/plugin-theme-tokens.js')
  const contract = new Set<string>(PLUGIN_THEME_TOKENS)
  assert.ok(contract.has('--bg-surface-2'), '契约自检：背景阶梯应在白名单内')

  const offenders: string[] = []
  for (const raw of RAW_SAMPLE_PLUGINS) {
    const files = (raw.files as Record<string, string> | undefined) ?? {}
    for (const [name, content] of Object.entries(files)) {
      for (const m of content.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        const token = m[1]!
        if (!contract.has(token)) offenders.push(`${String(raw.id)}/${name}: ${token}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '随包插件引用了主题契约之外的 CSS 变量 —— 宿主不会下发它们，深浅色主题下会失配：\n' +
      offenders.join('\n'),
  )
})
