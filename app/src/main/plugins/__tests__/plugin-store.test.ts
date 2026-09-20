/* ============================================================
 * ArkWork — 插件持久化与两级作用域单测（v0.35.0 · B3/B10/B11 建立）
 * 规格来源：docs/versions/v0.35.0/04-system-design.md §4.3 / §4.4 · §8（迁移矩阵）
 *   · 两级作用域：`global`（{userData}/arkwork-data/plugins）优先级低于
 *     `workspace`（<workspace>/.arkwork/plugins）；
 *   · D76：启动对账清掉「已不存在且非随包」的死条目。
 *
 * ★ 本组用例**全程不碰真实 userData**：`store.ts` 专门留了 `__setDocForTest`
 *   这个测试缝（它的存在本身就是「这个模块要能被单测」的声明）。
 *   所有断言都打在**内存缓存**上 —— 因为要钉住的是**判定语义**
 *   （谁的开关说了算 / 什么该被清掉），而不是文件 IO。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-store
 * ============================================================ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scopeOfSource,
  resolveEnabled,
  reconcileKnownIds,
  markStaleOrderRef,
  clearStaleOrderRefs,
  __setDocForTest,
  ensureDirPackageType,
  ensurePluginsDir,
  pluginsDir,
  getEnabledMap,
  getOrderMap,
  type PluginsDoc,
} from '../store.js'
import { setWorkspaceDir } from '../../store/db.js'
import { SAMPLE_PLUGIN_IDS } from '../sample-plugins.js'

const STOCK = 'ark.plugin.stock'

function doc(enabled: Record<string, boolean>, order: Record<string, number> = {}): PluginsDoc {
  return { schemaVersion: '1.1', enabled, order, updatedAt: 0 }
}

beforeEach(() => {
  // 对账登记表是模块级状态，逐条用例必须从干净态开始
  clearStaleOrderRefs()
  __setDocForTest('global', doc({}))
  __setDocForTest('workspace', doc({}))
})

/* ============================================================
 * 1. 来源 → 作用域 反查
 * ============================================================ */

test('TC-PST-001 scopeOfSource：workspace 归工作区，bundled / global 都归全局', () => {
  assert.equal(scopeOfSource('workspace'), 'workspace')
  assert.equal(scopeOfSource('global'), 'global')
  // bundled 视为 global 侧（随包示例的开关写全局那份）
  assert.equal(scopeOfSource('bundled'), 'global')
})

test('TC-PST-002 pluginsDir：两级目录互不相同，且都落在 `.arkwork` / `arkwork-data` 语境下', () => {
  const ws = mkdtempSync(join(tmpdir(), 'arkwork-store-ws-'))
  try {
    setWorkspaceDir(ws)
    const g = pluginsDir('global')
    const w = pluginsDir('workspace')
    assert.notEqual(g, w, '两级不能是同一个目录')
    assert.ok(g.endsWith(join('arkwork-data', 'plugins')), `全局目录形状不对：${g}`)
    assert.equal(w, join(ws, '.arkwork', 'plugins'), '工作区插件目录应自包含在 <workspace>/.arkwork 下')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

/* ============================================================
 * 2. 启停优先级：workspace > global > manifest
 * ============================================================ */

test('TC-PST-003 ★ resolveEnabled 优先级：工作区覆盖全局，全局覆盖清单默认值', async () => {
  __setDocForTest('workspace', doc({ [STOCK]: false }))
  __setDocForTest('global', doc({ [STOCK]: true }))
  assert.deepEqual(await resolveEnabled(STOCK, true), { enabled: false, decidedBy: 'workspace' })

  // 工作区那份没有该项 → 回落到全局
  __setDocForTest('workspace', doc({}))
  assert.deepEqual(await resolveEnabled(STOCK, false), { enabled: true, decidedBy: 'global' })

  // 两级都没有 → 用清单自己的 enabledByDefault
  __setDocForTest('global', doc({}))
  assert.deepEqual(await resolveEnabled(STOCK, true), { enabled: true, decidedBy: 'manifest' })
  assert.deepEqual(await resolveEnabled('never.seen', false), { enabled: false, decidedBy: 'manifest' })
})

test('TC-PST-004 resolveEnabled 只认布尔值（脏数据不得被当成「用户显式改过」）', async () => {
  __setDocForTest('workspace', doc({ [STOCK]: 'yes' as unknown as boolean }))
  __setDocForTest('global', doc({ [STOCK]: true }))
  assert.deepEqual(await resolveEnabled(STOCK, false), { enabled: true, decidedBy: 'global' })
})

/* ============================================================
 * 3. ★ D76 死条目对账
 * ============================================================ */

test('TC-PST-005 ★ D76：只清「不在磁盘上且也不是随包示例」的条目（保守语义）', async () => {
  __setDocForTest(
    'global',
    doc({ 'dead.plugin': false, 'alive.plugin': true, [STOCK]: false }),
  )
  const res = await reconcileKnownIds(new Set(['alive.plugin']))
  assert.deepEqual(res.cleaned, ['dead.plugin'], '死条目必须被清，且只清它')
  const after = await getEnabledMap('global')
  assert.deepEqual(Object.keys(after).sort(), ['alive.plugin', STOCK].sort())
})

test('TC-PST-006 ★ D76：随包示例的开关**永远保留**（用户禁用示例是合法选择，示例也可能被重新落盘）', async () => {
  for (const id of SAMPLE_PLUGIN_IDS) {
    __setDocForTest('global', doc({ [id]: false }))
    const res = await reconcileKnownIds(new Set())
    assert.deepEqual(res.cleaned, [], `随包示例 ${id} 的开关不得被当死条目清掉`)
    assert.equal((await getEnabledMap('global'))[id], false, '值也必须原样留着')
  }
})

test('TC-PST-007 D76：无死条目 → cleaned 为空（且不改动其余任何项）', async () => {
  __setDocForTest('global', doc({ 'a.plugin': true, 'b.plugin': false }))
  const res = await reconcileKnownIds(new Set(['a.plugin', 'b.plugin']))
  assert.deepEqual(res.cleaned, [])
  const after = await getEnabledMap('global')
  assert.deepEqual(after, { 'a.plugin': true, 'b.plugin': false })
})

test('TC-PST-008 D76：对账只作用于指定作用域 —— 清全局不碰工作区', async () => {
  __setDocForTest('global', doc({ 'dead.global': true }))
  __setDocForTest('workspace', doc({ 'dead.workspace': true }))
  const res = await reconcileKnownIds(new Set(), 'global')
  assert.deepEqual(res.cleaned, ['dead.global'])
  assert.deepEqual(await getEnabledMap('workspace'), { 'dead.workspace': true }, '工作区那份不受影响')
})

test('TC-PST-009 ★ D76：markStaleOrderRef 登记的 order 引用被一并对账清掉，其余引用留着', async () => {
  __setDocForTest('global', doc({}, { 'view:dead': 1, 'view:alive': 2 }))
  markStaleOrderRef('view:dead')
  await reconcileKnownIds(new Set())
  assert.deepEqual(await getOrderMap('global'), { 'view:alive': 2 })
})

test('TC-PST-010 clearStaleOrderRefs 之后同一条 order 引用不再被清（登记是显式且一次性的）', async () => {
  __setDocForTest('global', doc({}, { 'view:kept': 3 }))
  markStaleOrderRef('view:kept')
  clearStaleOrderRefs()
  await reconcileKnownIds(new Set())
  assert.deepEqual(await getOrderMap('global'), { 'view:kept': 3 })
})

/* ============================================================
 * 4. 目录 package.json（决定 main.js 被当 CJS 还是 ESM）
 * ============================================================ */

test('TC-PST-011 ★ ensureDirPackageType 只补空缺：作者自己写的 package.json 绝不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkwork-store-pkg-'))
  try {
    ensureDirPackageType(dir)
    const file = join(dir, 'package.json')
    assert.ok(existsSync(file), '空缺时必须补一份')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), { type: 'commonjs', private: true })

    // 作者改过（例如要 ESM）→ 必须一字不改
    const mine = '{\n  "type": "module"\n}\n'
    writeFileSync(file, mine, 'utf-8')
    ensureDirPackageType(dir)
    assert.equal(readFileSync(file, 'utf-8'), mine, '绝不许覆盖作者的 package.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('TC-PST-012 纪律「扫描永不抛错」：ensurePluginsDir 在任何情况下都返回字符串且不抛', () => {
  let got = ''
  assert.doesNotThrow(() => {
    got = ensurePluginsDir('global')
  })
  assert.equal(typeof got, 'string')
  assert.ok(got.length > 0)
  // 幂等：再来一次同样不抛
  assert.doesNotThrow(() => ensurePluginsDir('global'))
})
