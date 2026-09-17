/* ============================================================
 * v0.31.1 — Windows WCO（titleBarOverlay）主题跟随契约单测
 *（TC-TH-001..004）
 *
 * 缺陷背景（用户实测，Windows + 暗色外观）：右上角最小化/最大化/
 * 关闭按钮区残留白底。
 * 根因：主窗口 `titleBarStyle: 'hidden' + titleBarOverlay` 的 `color`
 * 只在 createMainWindow 时按当时 `nativeTheme.shouldUseDarkColors`
 * 定死；此后无论应用内切换主题（theme:apply → nativeTheme.themeSource）
 * 还是系统切换（'updated' 事件），都只广播 renderer，overlay 从不更新。
 *
 * 载体约束：window.ts / ipc/theme.ts 属 electron 链模块，Node 下无法
 * 实例化 BrowserWindow —— 源码契约体例（同 TC-C3-PV）：把「overlay
 * 必须随主题解析结果同步」写死在测试里。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs ipc/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
/** 去掉行注释，避免说明文字里的示例代码干扰契约断言 */
const code = (rel: string): string => read(rel).replace(/\/\/.*$/gm, '')

/* ============================================================
 * TC-TH-001 · 颜色单一源：overlay 配色必须收敛到 window.ts 导出的
 * titleBarOverlayColors()，创建与运行时切换共用，禁止两处字面量漂移
 * ============================================================ */
test('TC-TH-001 window.ts 导出 titleBarOverlayColors + TITLEBAR_OVERLAY_HEIGHT（配色单一源）', () => {
  const src = code('../../window.ts')
  assert.match(
    src,
    /export const TITLEBAR_OVERLAY_HEIGHT\s*=\s*40/,
    'overlay 高度常量必须导出（运行时同步要与创建共用）',
  )
  assert.match(
    src,
    /export function titleBarOverlayColors\(\s*resolved:\s*'dark'\s*\|\s*'light'\s*\)[\s\S]*?color:\s*'#16181D'[\s\S]*?color:\s*'#FFFFFF'/,
    'titleBarOverlayColors 必须覆盖 dark(#16181D)/light(#FFFFFF) 两态',
  )
})

/* ============================================================
 * TC-TH-002 · 创建时：titleBarOverlay 必须经共享配色函数取值
 * ============================================================ */
test('TC-TH-002 createMainWindow 的 titleBarOverlay 走 titleBarOverlayColors，不得内联字面量', () => {
  const src = code('../../window.ts')
  assert.match(
    src,
    /titleBarOverlay:\s*\{\s*\.\.\.titleBarOverlayColors\(/,
    '创建时的 overlay 配色必须来自共享函数',
  )
  // 创建处不得再出现内联 color/symbolColor 字面量（防止双源漂移）
  const createBlock = src.match(/titleBarOverlay:\s*\{[\s\S]*?\n\s{6}\}/)?.[0] ?? ''
  assert.doesNotMatch(
    createBlock,
    /symbolColor:/,
    '创建处不得内联 symbolColor —— 配色只能出自 titleBarOverlayColors',
  )
})

/* ============================================================
 * TC-TH-003 · 运行时：主题解析结果变化必须同步 setTitleBarOverlay
 * ============================================================ */
test('TC-TH-003 ipc/theme.ts 的 onSystemChange 回调内必须按主题调用 setTitleBarOverlay', () => {
  const src = code('../theme.ts')
  // 回调体内：win32 守卫 + 遍历窗口 + overlay 同步
  assert.match(
    src,
    /onSystemChange\(\(systemTheme\)\s*=>\s*\{[\s\S]*?process\.platform\s*===\s*'win32'[\s\S]*?setTitleBarOverlay\(\s*\{\s*\.\.\.titleBarOverlayColors\(systemTheme\)/,
    '主题变化回调必须（win32 守卫下）用解析结果同步 overlay 配色',
  )
})

/* ============================================================
 * TC-TH-004 · 防御：非 WCO 窗口调用 setTitleBarOverlay 抛错必须被
 * 吞掉（try/catch），不得中断其余窗口的同步与广播
 * ============================================================ */
test('TC-TH-004 setTitleBarOverlay 调用须包裹 try/catch（Browser 浮窗无 WCO）', () => {
  const src = code('../theme.ts')
  const cb = src.match(/onSystemChange\(\(systemTheme\)\s*=>\s*\{[\s\S]*\}\)\s*\n\}/)?.[0] ?? ''
  assert.match(cb, /try\s*\{[\s\S]*?setTitleBarOverlay[\s\S]*?\}\s*catch\s*\{/, '必须 try/catch 包裹')
  // 广播循环必须存在于同步逻辑之后（异常不阻断 theme:system-changed）
  assert.match(
    cb,
    /setTitleBarOverlay[\s\S]*?for\s*\(const win of BrowserWindow\.getAllWindows\(\)\)\s*\{\s*win\.webContents\.send\('theme:system-changed'/,
    'overlay 同步之后仍需执行 theme:system-changed 广播',
  )
})
