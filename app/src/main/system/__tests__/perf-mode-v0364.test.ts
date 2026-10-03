/**
 * v0.36.4 详测 — PERF-1 性能模式三态 + perf-lite 流式攒批窗口放大
 *
 * 依据：docs/versions/v0.36.4/16-v0364-windows-compat-design.md §二 PERF-1
 * 用户实测：Windows 低配 VM（2 核 2.4G 无显卡）运行非常卡顿。
 *
 * 修复面：
 *   - perf-mode.ts：进程级 perfLite 开关（window.ts 判定后写入，消费方只读）；
 *   - window.ts：设置三态（auto/on/off）合并 GPU/env 判定 + VM 漏判修补
 *     （gl=disabled / overridden 都计入软件渲染）；
 *   - llm-stream.ts：perf-lite 激活时流式攒批窗口 40–80ms → 150–250ms
 *     （低配机上高频 IPC + markdown 重渲是抢 CPU 大户；权威数据不受影响）。
 *
 * 手法：perf-mode / pump 真执行；window.ts / SettingsContent 源码契约。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/system/__tests__/perf-mode.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const { setPerfLiteActive, isPerfLiteActive, PERF_LITE_WINDOW_MIN_MS, PERF_LITE_WINDOW_MAX_MS } =
  await import('../perf-mode.js')
const { createTextDeltaPump } = await import('../../agent/llm-stream.js')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 剥离注释走唯一真源 @shared/utils/source-guard（D101/D102，TC-D102-001 守卫）
const WINDOW_TS = stripComments(readFileSync(new URL('../../window.ts', import.meta.url), 'utf-8'))
const SETTINGS_UI = stripComments(
  readFileSync(new URL('../../../renderer/components/SettingsContent.tsx', import.meta.url), 'utf-8'),
)

/* ---------------- 真执行：perf-mode 状态模块 ---------------- */

test('TC-PERF2-001 进程级开关读写 + 常量值（150–250ms）', () => {
  assert.equal(PERF_LITE_WINDOW_MIN_MS, 150)
  assert.equal(PERF_LITE_WINDOW_MAX_MS, 250)
  setPerfLiteActive(true)
  assert.equal(isPerfLiteActive(), true)
  setPerfLiteActive(false)
  assert.equal(isPerfLiteActive(), false, '关闭后消费方立即回到常规窗口')
  setPerfLiteActive(false)
  assert.equal(isPerfLiteActive(), false, '重复写同值无害')
})

/* ---------------- 真执行：perf-lite 流式攒批窗口 ---------------- */

test('TC-PERF2-002 perf-lite 激活时攒批窗口放大（首包立即发，后续 ≥150ms 才发）', async () => {
  setPerfLiteActive(true)
  try {
    const sent: string[] = []
    const pump = createTextDeltaPump('t_perf', 'turn', 'text', (p) => sent.push(p.text))
    pump.push('首包') // 首包立即广播（首字延迟优先，不受窗口影响）
    assert.deepEqual(sent, ['首包'])
    pump.push('第二包') // perf-lite：窗口 150–250ms
    await sleep(100)
    assert.deepEqual(sent, ['首包'], '100ms 时第二包尚未流出（常规 40ms 窗口早已发出 → 证明窗口已放大）')
    await sleep(200) // 累计 300ms > 250ms
    assert.deepEqual(sent, ['首包', '第二包'], '300ms 时第二包应已流出')
    pump.flush()
    assert.equal(pump.accumulated, '首包第二包', 'accumulated 不丢字（权威数据不受攒批影响）')
  } finally {
    setPerfLiteActive(false)
  }
})

test('TC-PERF2-003 perf-lite 关闭时回到常规窗口（40–80ms），flush 立即清空缓冲', async () => {
  setPerfLiteActive(false)
  const sent: string[] = []
  const pump = createTextDeltaPump('t_perf2', 'turn', 'text', (p) => sent.push(p.text))
  pump.push('一')
  pump.push('二')
  pump.flush() // flush 必须立即发出缓冲残余（完整响应返回前调用）
  assert.deepEqual(sent, ['一', '二'], 'flush 立即流出（不等窗口）')
  assert.equal(pump.accumulated, '一二')
})

/* ---------------- 源码契约：window.ts 三态合并 + SettingsContent 设置面 ---------------- */

test('TC-PERF2-004 window.ts：设置三态读入 + off 逃生门 + VM 漏判修补 + 进程级写回', () => {
  assert.match(WINDOW_TS, /perfMode = \(await getSettings\(\)\)\.perfMode \?\? 'auto'/, '设置三态读入（缺省 auto）')
  assert.match(
    WINDOW_TS,
    /perfMode === 'on' \|\| \(perfMode !== 'off' && \(softwareRendering \|\| envLite\)\)/,
    "三态合并：on 恒开；off 是逃生门（恒关）；auto 由 GPU/env 判定",
  )
  assert.match(
    WINDOW_TS,
    /\/software\|overridden\/i\.test\(status\['gpu_compositing'\] \?\? ''\)[\s\S]{0,80}\/software\|overridden\|disabled\/i\.test\(status\['gl'\] \?\? ''\)/,
    'VM 漏判修补：gpu_compositing 的 overridden 与 gl 的 disabled 都计入软件渲染',
  )
  assert.match(WINDOW_TS, /setPerfLiteActive\(perfLite\)/, '判定结果必须写入进程级开关（供流式攒批消费）')
  // v0.46.0（PERF-2 W15）改写（纪律㉔）：单边 add → 幂等 add/remove（热生效 +
  // reload 重注入不残留）；粘滞缓存与 reapply 由 perf2-lowspec 套件钉（两条腿）。
  assert.match(WINDOW_TS, /classList\.\$\{perfLite \? 'add' : 'remove'\}\('perf-lite'\)/, '渲染端 CSS 降级类保留且幂等增删（v0.46.0 语义）')
})

test('TC-PERF2-005 设置页：性能模式三态 radio + i18n key + 写回 ark.settings', () => {
  assert.match(SETTINGS_UI, /PERF_MODES/, 'PERF_MODES 三态数组应存在')
  for (const id of ["'auto'", "'on'", "'off'"]) {
    assert.ok(SETTINGS_UI.includes(id), `PERF_MODES 应含 ${id}`)
  }
  assert.match(SETTINGS_UI, /patch\(\{ perfMode: m\.id \}\)/, 'radio 选择应写回 perfMode')
  assert.match(SETTINGS_UI, /settings\.performance\.modeTitle|modeAutoDesc/, '性能设置区应有 i18n 文案')
  assert.match(SETTINGS_UI, /<PerformanceSection \/>/, 'PerformanceSection 应被挂载进设置页')
})
