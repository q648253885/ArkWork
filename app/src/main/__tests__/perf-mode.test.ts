/* ============================================================
 * v0.31.1 — 低配机器性能降级契约单测（TC-PERF-001..004）
 *
 * 背景（用户实测，Windows）：双路 Xeon 2.40GHz / 16G 机器上应用运行非常卡。
 * 该类工作站常无独显或驱动评分低 → Chromium 静默回退 SwiftShader 软件渲染
 * （整个 UI 由弱单核光栅化），叠加 27 处 animation（含 6 处 infinite 连续
 * 动画）持续触发全屏重绘。
 *
 * 修复三层：
 *   ① globals.css 新增 html.perf-lite 降级块（等价 prefers-reduced-motion，
 *      抑制连续动画/过渡，保留一次性入场动画终态）；
 *   ② window.ts 在 did-finish-load 读 app.getGPUFeatureStatus()，
 *      判软件渲染（或 ARK_PERF_LITE=1）→ 注入 .perf-lite；并始终写
 *      `gpu status` 诊断日志（用户回报日志即可定位渲染后端）；
 *   ③ index.ts 提供 ARK_FORCE_GPU=1（强制启用被拉黑的 GPU）与
 *      ARK_PERF_LITE=1（手动强制降级）两个逃生开关。
 *
 * 载体约束：window.ts / index.ts 属 electron 链模块，Node 下无法实例化 ——
 * 源码契约体例（同 TC-CTX）。CSS 直接读文本。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs perf-mode
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const code = (rel: string): string => read(rel).replace(/\/\/.*$/gm, '')

/* ============================================================
 * TC-PERF-001 · perf-lite 降级块必须全局抑制连续动画
 * ============================================================ */
test('TC-PERF-001 globals.css 提供 html.perf-lite 全局动画抑制', () => {
  const css = read('../../renderer/styles/globals.css')
  assert.match(css, /html\.perf-lite \*/, 'perf-lite 必须作用于全量子树')
  assert.match(css, /html\.perf-lite[^{]*\{[^}]*animation-duration:\s*0\.01ms\s*!important/s)
  assert.match(css, /html\.perf-lite[^{]*\{[^}]*animation-iteration-count:\s*1\s*!important/s)
  assert.match(css, /html\.perf-lite[^{]*\{[^}]*transition-duration:\s*0\.01ms\s*!important/s)
})

/* ============================================================
 * TC-PERF-002 · 六处无限动画在 perf-lite 下必须被显式收口
 *   （这六处的 keyframes 承载语义：shimmer 只做扫光，光标闪烁只做提示）
 * ============================================================ */
test('TC-PERF-002 perf-lite 显式关闭 shimmer / 光标闪烁 / 状态条纹', () => {
  const css = read('../../renderer/styles/globals.css')
  for (const sel of ['react-reason', 'tool-card', 'turn-status', 'stream-caret']) {
    assert.match(
      css,
      new RegExp(`html\\.perf-lite[^{}]*\\.${sel}`),
      `perf-lite 必须覆盖 .${sel} 的连续动画`,
    )
  }
})

/* ============================================================
 * TC-PERF-003 · 主进程必须检测 GPU 后端并注入降级 class
 * ============================================================ */
test('TC-PERF-003 window.ts 检测 GPU 状态并注入 perf-lite（含诊断日志）', () => {
  const src = code('../window.ts')
  assert.match(src, /app\.getGPUFeatureStatus\(\)/, '必须读真实 GPU 特征状态')
  assert.match(src, /gpu_compositing/, '判定必须基于 gpu_compositing')
  assert.match(src, /classList\.add\('perf-lite'\)/, '软件渲染时必须注入 perf-lite')
  assert.match(src, /gpu status/, '必须留下可回报的 gpu status 诊断日志')
  assert.match(
    src,
    /did-finish-load[\s\S]{0,200}applyPerformanceMode/,
    '注入必须挂载在 did-finish-load（DOM 就绪）之后',
  )
})

/* ============================================================
 * TC-PERF-004 · 两个逃生开关必须存在（命令行环境变量）
 *   ARK_FORCE_GPU 的实现载体 = index.ts（必须早于窗口创建注册 switch）
 *   ARK_PERF_LITE 的实现载体 = window.ts（性能模式判定处）
 * ============================================================ */
test('TC-PERF-004 index.ts + window.ts 提供 ARK_FORCE_GPU / ARK_PERF_LITE 逃生开关', () => {
  const mainEntry = code('../index.ts')
  assert.match(mainEntry, /ARK_FORCE_GPU/, '必须支持强制启用被拉黑的 GPU')
  assert.match(mainEntry, /ignore-gpu-blocklist/, 'ARK_FORCE_GPU 需带 ignore-gpu-blocklist')
  assert.match(
    mainEntry,
    /enable-gpu-rasterization/,
    'ARK_FORCE_GPU 需带 enable-gpu-rasterization',
  )
  const win = code('../window.ts')
  assert.match(win, /ARK_PERF_LITE/, '必须支持手动强制性能降级')
})
