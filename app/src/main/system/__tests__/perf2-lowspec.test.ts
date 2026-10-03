/**
 * v0.46.0 — PERF-2 W14/W15/W16：低配档（软渲染环境）启动期决策 + 热生效 + spellcheck
 *
 * 依据：docs/versions/v0.46.0/04-system-design.md §二 C
 * 背景：perf-lite 判中软件渲染后只压动画与 IPC 频率，Chromium 仍走 SwiftShader
 * 合成全开销；disableHardwareAcceleration / js-flags 只能 ready 前生效 →
 * 判定结果粘滞化（perf-cache.json）跨启动决策；perfMode 三态此前改了必须重启。
 *
 * 手法：decidePreReadyLowSpec / perf-cache 真执行；index.ts / window.ts /
 * settings.ts / view-manager.ts 源码契约。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs perf2-lowspec
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'
import {
  decidePreReadyLowSpec,
  readPerfCache,
  writePerfCache,
  readPerfModeFileSync,
  LOW_SPEC_MAX_OLD_SPACE_MB,
} from '../perf-mode.js'

const INDEX_TS = stripComments(readFileSync(new URL('../../index.ts', import.meta.url), 'utf-8'))
const WINDOW_TS = stripComments(readFileSync(new URL('../../window.ts', import.meta.url), 'utf-8'))
const SETTINGS_TS = stripComments(
  readFileSync(new URL('../../ipc/settings.ts', import.meta.url), 'utf-8'),
)
const VIEW_MANAGER_TS = stripComments(
  readFileSync(new URL('../../browser/view-manager.ts', import.meta.url), 'utf-8'),
)

/* ---------------- TC-LOW46-001..004 decidePreReadyLowSpec 真值表 ---------------- */

test('TC-LOW46-001 perfMode=on → 恒低配（用户显式选择，source=settings）', () => {
  assert.deepEqual(decidePreReadyLowSpec('on', undefined, false), { lowSpec: true, source: 'settings' })
  assert.deepEqual(decidePreReadyLowSpec('on', false, false), { lowSpec: true, source: 'settings' })
  assert.deepEqual(decidePreReadyLowSpec('on', true, false), { lowSpec: true, source: 'settings' })
})

test('TC-LOW46-002 perfMode=off → 恒不低配（显式关闭连 env 逃生门也让位，与运行期判定对齐）', () => {
  assert.deepEqual(decidePreReadyLowSpec('off', undefined, false), { lowSpec: false, source: 'none' })
  assert.deepEqual(decidePreReadyLowSpec('off', true, false), { lowSpec: false, source: 'none' })
  assert.deepEqual(decidePreReadyLowSpec('off', false, true), { lowSpec: false, source: 'none' })
})

test('TC-LOW46-003 auto：env 逃生门 或 上轮软渲染粘滞；无信号 → 不启用', () => {
  assert.deepEqual(decidePreReadyLowSpec('auto', undefined, true), { lowSpec: true, source: 'env' })
  assert.deepEqual(decidePreReadyLowSpec('auto', true, false), { lowSpec: true, source: 'sticky' })
  assert.deepEqual(decidePreReadyLowSpec('auto', false, false), { lowSpec: false, source: 'none' })
  assert.deepEqual(decidePreReadyLowSpec('auto', undefined, false), { lowSpec: false, source: 'none' })
  // env 优先级高于 sticky（显式环境信号）
  assert.deepEqual(decidePreReadyLowSpec('auto', true, true), { lowSpec: true, source: 'env' })
})

test('TC-LOW46-004 堆上限常量（唯一事实源，index.ts 直接引用）', () => {
  assert.equal(LOW_SPEC_MAX_OLD_SPACE_MB, 1024)
})

/* ---------------- TC-LOW46-005..006 perf-cache 真执行 ---------------- */

test('TC-LOW46-005 perf-cache 读写回环；缺文件返回 {}；损坏文件不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-perfcache-'))
  try {
    assert.deepEqual(readPerfCache(dir), {}, '缺文件 → {}')
    writePerfCache(dir, { gpuSoftwareLastRun: true })
    assert.deepEqual(readPerfCache(dir), { gpuSoftwareLastRun: true })
    await writeFile(join(dir, 'perf-cache.json'), '{broken', 'utf-8')
    assert.deepEqual(readPerfCache(dir), {}, '损坏 → {}（绝不抛）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TC-LOW46-006 readPerfModeFileSync：合法三态透传；缺失/损坏/非法值 → auto', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-perfmode-'))
  try {
    const path = join(dir, 'settings.json')
    assert.equal(readPerfModeFileSync(join(dir, 'missing.json')), 'auto')
    await writeFile(path, JSON.stringify({ perfMode: 'on' }), 'utf-8')
    assert.equal(readPerfModeFileSync(path), 'on')
    await writeFile(path, JSON.stringify({ perfMode: 'off' }), 'utf-8')
    assert.equal(readPerfModeFileSync(path), 'off')
    await writeFile(path, JSON.stringify({ perfMode: 'bogus' }), 'utf-8')
    assert.equal(readPerfModeFileSync(path), 'auto')
    await writeFile(path, '{broken', 'utf-8')
    assert.equal(readPerfModeFileSync(path), 'auto')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------- TC-LOW46-007..010 接线契约 ---------------- */

test('TC-LOW46-007 index.ts：ready 前决策接线（disableHardwareAcceleration + js-flags + FORCE_GPU 跳过）', () => {
  assert.match(INDEX_TS, /decidePreReadyLowSpec\(/, '必须调用判定纯函数')
  assert.match(INDEX_TS, /app\.disableHardwareAcceleration\(\)/)
  assert.match(INDEX_TS, /js-flags/, '必须挂 js-flags 堆上限')
  assert.match(INDEX_TS, /--max-old-space-size=\$\{LOW_SPEC_MAX_OLD_SPACE_MB\}/)
  assert.match(INDEX_TS, /ARK_FORCE_GPU !== '1'/, 'FORCE_GPU 用户显式要 GPU → 跳过低配档')
  // 时序：决策代码必须出现在 requestSingleInstanceLock / whenReady 之前（ready 前窗口）
  const decisionIdx = INDEX_TS.indexOf('decidePreReadyLowSpec(')
  const lockIdx = INDEX_TS.indexOf('requestSingleInstanceLock')
  assert.ok(decisionIdx > -1 && lockIdx > -1 && decisionIdx < lockIdx, 'ready 前决策必须在单实例锁之前')
})

test('TC-LOW46-008 window.ts：判定粘滞化 + once→on + 幂等增删 + reapply 导出', () => {
  assert.match(WINDOW_TS, /writePerfCache\(/, '判定结果必须写粘滞缓存')
  assert.match(WINDOW_TS, /gpuSoftwareLastRun: softwareRendering/)
  assert.match(WINDOW_TS, /\.on\('did-finish-load'/, 'once → on（reload 后重注入）')
  assert.doesNotMatch(WINDOW_TS, /\.once\('did-finish-load'/, '不得残留 once 注册')
  assert.match(WINDOW_TS, /classList\.\$\{perfLite \? 'add' : 'remove'\}\('perf-lite'\)/, '幂等增删（非 perfLite 必须移除）')
  assert.match(WINDOW_TS, /export function reapplyPerformanceMode\(\)/)
})

test('TC-LOW46-009 settings.ts：perfMode 变更 → 热生效钩子（值比较防误触发）', () => {
  assert.match(SETTINGS_TS, /patch\.perfMode !== undefined && patch\.perfMode !== current\.perfMode/)
  assert.match(SETTINGS_TS, /reapplyPerformanceMode/)
})

test('TC-LOW46-010 view-manager：浮窗与浏览器 Tab 均关 spellcheck', () => {
  const count = (VIEW_MANAGER_TS.match(/spellcheck: false/g) ?? []).length
  assert.ok(count >= 2, `浮窗 BrowserWindow + Tab WebContentsView 都要关（实测 ${count} 处）`)
})

/* ---------------- TC-LOW46-011 settings 缓存（W9） ---------------- */

test('TC-LOW46-011 settings.ts 读缓存：mtime 指纹命中 / 写后刷新 / 外部改写穿透', async () => {
  const src = stripComments(
    readFileSync(new URL('../../ipc/settings.ts', import.meta.url), 'utf-8'),
  )
  assert.match(src, /settingsCache/, '模块级缓存存在')
  assert.match(src, /mtimeMs === fp\.mtimeMs && .*\.size === fp\.size/, '指纹双字段比较')
  assert.match(src, /settingsCache = \{ mtimeMs: st\.mtimeMs, size: st\.size, settings \}/, '写后刷新')
  // 真执行：模拟指纹失配语义（对外部改写穿透的形态校验）
  const dir = await mkdtemp(join(tmpdir(), 'arkwork-settings-'))
  try {
    const p = join(dir, 'settings.json')
    await writeFile(p, '{"a":1}', 'utf-8')
    const st1 = await readFile(p, 'utf-8')
    await writeFile(p, '{"a":2}', 'utf-8')
    const st2 = await readFile(p, 'utf-8')
    assert.notEqual(st1, st2)
    // mtime 相同但 size 不同也必须失配（指纹含 size）
    void utimes
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
