/* ============================================================
 * ArkWork — 插件 zip 安装器用例库（v0.36.0 · B2 / F3.2）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.4
 *
 * 门槛（§6 批次表 B2）：「zip 安装 → 启用 → 命令触发 → 卸载无残留」。
 * 本组钉住安装器的**判定语义**：
 *  · 错误码闭集（NO_FILE / EXTRACT_FAILED / MANIFEST_INVALID /
 *    ENGINES_MISMATCH / ENTRY_MISSING / ALREADY_EXISTS / IO_ERROR）；
 *  · 两段式（预览不落盘 → 确认才落盘）；
 *  · 默认禁用（安装 ≠ 启用，用户必须先审权限）；
 *  · 边界防护（穿越条目 / macOS 元数据剔除 / 单顶层目录剥离 / 覆盖安装）。
 *
 * 写入目标是 electron 桩的 userData（/tmp/arkwork-test-userData）——
 * 测试自清自扫，不碰真实用户数据。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-install
 * ============================================================ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

import { installPluginFromZip } from '../install.js'
import { getEnabledMap, pluginsDir } from '../store.js'
import { listPluginSummaries, listPlugins, setHostVersion, setPluginEnabled, uninstallPlugin } from '../registry.js'

const PLUGIN_ID = 'test.hello'
const TARGET = () => join(pluginsDir('global'), PLUGIN_ID)

/** 造一个能过 VP 校验的最小插件目录（可覆盖清单字段 / 附加文件） */
function makePluginDir(over: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkwork-pkg-src-'))
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      schemaVersion: '1.1',
      id: PLUGIN_ID,
      name: 'Test Hello',
      version: '0.1.0',
      kind: 'action',
      main: 'main.js',
      engines: { arkwork: '>=0.36.0' },
      provides: {
        action: { actionId: 'hello', label: 'Hello' },
        commands: [{ id: 'hello', title: '打个招呼' }],
      },
      permissions: [],
      ...over,
    }),
  )
  writeFileSync(join(dir, 'main.js'), 'module.exports = { apply() {} }\n')
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    writeFileSync(p, content)
  }
  return dir
}

/** 目录 → zip（可包一层顶层目录；附加原始条目用于构造恶意包） */
function zipDir(dir: string, opts: { wrap?: string; extraEntries?: Record<string, string> } = {}): string {
  const zip = new AdmZip()
  const walk = (cur: string, rel: string) => {
    for (const name of readdirSync(cur)) {
      const p = join(cur, name)
      const relName = rel ? `${rel}/${name}` : name
      const target = opts.wrap ? `${opts.wrap}/${relName}` : relName
      if (statSync(p).isDirectory()) walk(p, relName)
      else zip.addFile(target, readFileSync(p))
    }
  }
  walk(dir, '')
  for (const [name, content] of Object.entries(opts.extraEntries ?? {})) {
    zip.addFile(name, Buffer.from(content, 'utf-8'))
  }
  const out = join(mkdtempSync(join(tmpdir(), 'arkwork-pkg-zip-')), 'pkg.zip')
  zip.writeZip(out)
  return out
}

/**
 * 手工拼一个最小 zip（单 stored 条目）—— AdmZip 的 addFile 会把 `../`
 * 归一化掉，构造不出恶意包，只能按 PK 规范直接造字节。
 * CRC 置 0：本用例的穿越条目在 keep 过滤阶段就该被拒，走不到解压校验。
 */
function rawZipBytes(entryName: string, content: string): Buffer {
  const name = Buffer.from(entryName, 'utf-8')
  const data = Buffer.from(content, 'utf-8')

  // local file header：签名(4)+版本(2)+标志(2)+方法(2)+时间(2)+日期(2)
  //                  +CRC(4)+压缩后(4)+原始(4)+名长(2)+extra(2) = 30 字节
  const local = Buffer.alloc(30 + name.length + data.length)
  local.writeUInt32LE(0x04034b50, 0) // PK\x03\x04
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(0, 8) // method = stored（不压缩）
  local.writeUInt16LE(0, 10) // time
  local.writeUInt16LE(0x2100, 12) // date（1996-08-00，读端不校验）
  local.writeUInt32LE(0, 14) // CRC 置 0
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)
  name.copy(local, 30)
  data.copy(local, 30 + name.length)

  // central directory header：46 字节固定段 + 条目名
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0) // PK\x01\x02
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10) // stored
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0x2100, 14)
  central.writeUInt32LE(0, 16) // CRC 置 0
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(0, 42) // local header 偏移 = 0
  name.copy(central, 46)

  // EOCD：22 字节
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // PK\x05\x06
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(1, 8) // 本盘条目数
  eocd.writeUInt16LE(1, 10) // 总条目数
  eocd.writeUInt32LE(central.length, 12) // central directory 大小
  eocd.writeUInt32LE(local.length, 16) // central directory 偏移
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([local, central, eocd])
}

beforeEach(() => {
  setHostVersion('0.36.0')
  rmSync(TARGET(), { recursive: true, force: true })
})

/* ============================================================
 * 1. 错误码闭集
 * ============================================================ */

test('TC-PI-001 无 zipPath → NO_FILE（IPC 层据此弹文件选择框）', async () => {
  const res = await installPluginFromZip({})
  assert.equal(res.ok, false)
  assert.equal(res.error, 'NO_FILE')
})

test('TC-PI-002 zipPath 不存在 → NO_FILE', async () => {
  const res = await installPluginFromZip({ zipPath: '/tmp/definitely-not-there.zip' })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'NO_FILE')
})

test('TC-PI-003 非 zip 文本 → EXTRACT_FAILED（不是崩、不是静默）', async () => {
  const fake = join(mkdtempSync(join(tmpdir(), 'arkwork-pkg-bad-')), 'fake.zip')
  writeFileSync(fake, 'this is not a zip')
  const res = await installPluginFromZip({ zipPath: fake })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'EXTRACT_FAILED')
})

test('TC-PI-004 缺 plugin.json → MANIFEST_INVALID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkwork-pkg-nomf-'))
  writeFileSync(join(dir, 'main.js'), 'module.exports = {}\n')
  const res = await installPluginFromZip({ zipPath: zipDir(dir) })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'MANIFEST_INVALID')
})

test('TC-PI-005 清单非法（id 缺失）→ MANIFEST_INVALID，且带 VP 规则号', async () => {
  const dir = makePluginDir({ id: undefined })
  const res = await installPluginFromZip({ zipPath: zipDir(dir) })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'MANIFEST_INVALID')
  assert.match(res.message ?? '', /VP1/)
})

test('TC-PI-006 engines 不满足宿主版本 → ENGINES_MISMATCH', async () => {
  const dir = makePluginDir({ engines: { arkwork: '>=99.0.0' } })
  const res = await installPluginFromZip({ zipPath: zipDir(dir) })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'ENGINES_MISMATCH')
})

test('TC-PI-007 声明了 main 但文件缺失 → ENTRY_MISSING', async () => {
  const dir = makePluginDir({})
  rmSync(join(dir, 'main.js'))
  const res = await installPluginFromZip({ zipPath: zipDir(dir) })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'ENTRY_MISSING')
})

/* ============================================================
 * 2. 两段式：预览不落盘 → 确认才落盘
 * ============================================================ */

test('TC-PI-008 预览段：needsConfirm=true + 元数据 + 能力/权限，且不落盘', async () => {
  const dir = makePluginDir()
  const res = await installPluginFromZip({ zipPath: zipDir(dir) })
  assert.equal(res.ok, false, '预览段不是成功态（还没装）')
  assert.equal(res.needsConfirm, true)
  assert.equal(res.manifest?.id, PLUGIN_ID)
  assert.equal(res.manifest?.name, 'Test Hello')
  assert.equal(res.manifest?.version, '0.1.0')
  assert.deepEqual(res.permissions, [])
  assert.ok(res.capabilities?.some((c) => c.includes('命令')), '命令贡献要在预览里可见')
  assert.equal(existsSync(TARGET()), false, '预览段绝不落盘')
})

test('TC-PI-009 确认段：confirmed=true → ok，目录落盘，默认禁用', async () => {
  const dir = makePluginDir()
  const res = await installPluginFromZip({ zipPath: zipDir(dir), confirmed: true })
  assert.equal(res.ok, true)
  assert.equal(res.id, PLUGIN_ID)
  assert.equal(existsSync(join(TARGET(), 'plugin.json')), true)
  assert.equal(existsSync(join(TARGET(), 'main.js')), true)
  // ★ 安装 ≠ 启用：enabled map 必须显式记 false
  const enabled = await getEnabledMap('global')
  assert.equal(enabled[PLUGIN_ID], false)
})

/* ============================================================
 * 3. ALREADY_EXISTS 与覆盖安装
 * ============================================================ */

test('TC-PI-010 同 id 重复安装：无 overwrite → ALREADY_EXISTS + alreadyExists 标记', async () => {
  const dir = makePluginDir()
  const zip = zipDir(dir)
  const first = await installPluginFromZip({ zipPath: zip, confirmed: true })
  assert.equal(first.ok, true)
  const again = await installPluginFromZip({ zipPath: zip })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'ALREADY_EXISTS')
  assert.equal(again.alreadyExists, true)
})

test('TC-PI-011 覆盖安装：overwrite=true → 旧文件被替换（不留混合体）', async () => {
  const v1 = makePluginDir({ version: '0.1.0' }, { 'extra.txt': 'v1' })
  const v2 = makePluginDir({ version: '0.2.0' })
  const first = await installPluginFromZip({ zipPath: zipDir(v1), confirmed: true })
  assert.equal(first.ok, true)
  const res = await installPluginFromZip({ zipPath: zipDir(v2), confirmed: true, overwrite: true })
  assert.equal(res.ok, true)
  const manifest = JSON.parse(readFileSync(join(TARGET(), 'plugin.json'), 'utf-8')) as { version: string }
  assert.equal(manifest.version, '0.2.0')
  assert.equal(existsSync(join(TARGET(), 'extra.txt')), false, '旧文件必须随覆盖一起消失')
})

/* ============================================================
 * 4. 边界防护（F3.7）
 * ============================================================ */

test('TC-PI-012 全部条目都是穿越路径 → EXTRACT_FAILED（不放毒进盘）', async () => {
  // AdmZip 的 addFile 会把 `../` 归一化掉（写不出恶意包）——这里手工拼
  // zip 字节（stored 条目，CRC 不校验：本用例在解压前就该被拒）。
  const evil = join(mkdtempSync(join(tmpdir(), 'arkwork-pkg-evil-')), 'evil.zip')
  writeFileSync(evil, rawZipBytes('../evil.txt', 'pwn'))
  const res = await installPluginFromZip({ zipPath: evil })
  assert.equal(res.ok, false)
  assert.equal(res.error, 'EXTRACT_FAILED')
  assert.equal(existsSync(join(tmpdir(), 'evil.txt')), false)
})

test('TC-PI-013 __MACOSX / .DS_Store 被剔除；正常包不受影响', async () => {
  const dir = makePluginDir()
  const zip = zipDir(dir, { extraEntries: { '__MACOSX/._plugin.json': 'junk', 'hello/.DS_Store': 'junk' } })
  const res = await installPluginFromZip({ zipPath: zip, confirmed: true })
  assert.equal(res.ok, true)
  assert.equal(existsSync(join(TARGET(), '.DS_Store')), false)
  assert.equal(existsSync(join(TARGET(), 'plugin.json')), true)
})

test('TC-PI-014 单顶层目录包裹 → 剥掉（plugin.json 落在插件根）', async () => {
  const dir = makePluginDir()
  const res = await installPluginFromZip({ zipPath: zipDir(dir, { wrap: 'hello' }), confirmed: true })
  assert.equal(res.ok, true)
  assert.equal(existsSync(join(TARGET(), 'plugin.json')), true)
  assert.equal(existsSync(join(TARGET(), 'hello', 'plugin.json')), false)
})

/* ============================================================
 * 5. 卸载无残留（B2 门槛第 4 拍：卸载无残留）
 * ============================================================ */

test('TC-PI-015 安装→启用→卸载：目录消失 + 偏好死条目被对账清理', async () => {
  const dir = makePluginDir()
  const install = await installPluginFromZip({ zipPath: zipDir(dir), confirmed: true })
  assert.equal(install.ok, true)

  // 启用走真实启停路径（写偏好 + 停机钩子 + 重注册插槽）
  const on = await setPluginEnabled(PLUGIN_ID, true, 'global')
  assert.equal(on.ok, true, `启用失败：${on.reason ?? ''}`)
  let enabled = await getEnabledMap('global')
  assert.equal(enabled[PLUGIN_ID], true)

  // 卸载：撤销副作用 → 删目录 → 失效缓存 → 刷新插槽
  const off = await uninstallPlugin(PLUGIN_ID)
  assert.equal(off.ok, true, `卸载失败：${off.reason ?? ''}`)
  assert.equal(existsSync(TARGET()), false, '插件目录必须被删干净')

  // 残留检查：重扫（触发 D76 对账），列表与 enabled map 都不该有死条目
  const after = await listPlugins()
  assert.equal(after.some((p) => p.manifest.id === PLUGIN_ID), false)
  enabled = await getEnabledMap('global')
  assert.equal(PLUGIN_ID in enabled, false, 'enabled map 的死条目必须被对账清掉')
})

test('TC-PI-016 卸载不存在的插件 → not-found，不抛错', async () => {
  const res = await uninstallPlugin('test.never-installed')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not-found')
})

test('TC-PI-017 随包示例（bundled）不可卸载：拒绝 + 目录保留', async () => {
  // listPlugins 会触发 ensureSamplePlugins 落盘（随包示例归 global 作用域）
  await listPlugins()
  // v0.36.0：随包示例改为 Git Manager（股票插件已退役）
  const res = await uninstallPlugin('ark.plugin.git-manager')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'bundled')
  assert.equal(existsSync(join(pluginsDir('global'), 'ark.plugin.git-manager')), true, '随包示例目录必须原样保留')
})

/* ============================================================
 * 6. 列表启用态（D95 · 真跑一遍）
 * ============================================================ */

test('TC-PI-018 ★ UI 列表入口必须反映 plugins.json 的启用态（D95 回归）', async () => {
  // 为什么钉这条：D95 是「函数全对、接线错」——setPluginEnabled 正确写了
  // plugins.json，resolveEnabled 也正确解析，但 IPC List 走的是裸 listPlugins()
  // （enabled 是占位 false），于是管理页显示「1 个插件 · 0 个启用」、
  // 开关永远关着，而 Git 侧边栏其实一直在跑。
  // 只断言源码「有这句话」抓不到它（D89 教训），必须真装真启真列一遍。
  const res = await installPluginFromZip({ zipPath: zipDir(makePluginDir()), confirmed: true })
  assert.equal(res.ok, true)

  const rowOf = (rows: { id: string; enabled: boolean }[]) => rows.find((r) => r.id === PLUGIN_ID)

  // ① 装完默认禁用 → 列表必须是 false（用户还得审权限）
  assert.equal(rowOf(await listPluginSummaries())?.enabled, false, '安装 ≠ 启用')

  // ② 启用（写 plugins.json）→ 列表必须立刻是 true
  const on = await setPluginEnabled(PLUGIN_ID, true, 'global')
  assert.equal(on.ok, true, `启用失败：${on.reason ?? ''}`)
  assert.equal(rowOf(await listPluginSummaries())?.enabled, true, '启用后列表必须显示已启用（D95）')

  // ③ 停用 → 回到 false（开关两端都要对）
  const off = await setPluginEnabled(PLUGIN_ID, false, 'global')
  assert.equal(off.ok, true)
  assert.equal(rowOf(await listPluginSummaries())?.enabled, false, '停用后列表必须显示未启用')

  // ④ 卸载后列表里不再有它（别留幽灵行）
  await uninstallPlugin(PLUGIN_ID)
  assert.equal(rowOf(await listPluginSummaries()), undefined, '卸载后列表必须移除该行')
})
