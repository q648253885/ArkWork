/**
 * ArkWork — 插件 preload 桥面契约（v0.35.0 · B6/B11 建立）
 *
 * 依据：docs/versions/v0.35.0/04-system-design.md §4（接口契约 M11/M12）
 *       §9 非功能设计 · 安全⑥「preload **只暴露具体函数**，绝不暴露 ipcRenderer」
 *       纪律⑤「双处校验」
 *
 * 本套件为**源码契约**（readFileSync + 正则），与 `graph-default-policy.test.ts`
 * 同手法：preload 依赖 electron 运行时，node:test 无 electron，故锁定
 * 「方法存在性 + 频道映射 + 安全边界」这些结构性不变量。
 *
 * ★ 为什么这组必须存在（B6 此前**零覆盖**）：
 *   preload 是渲染层与主进程之间唯一的窄口。桥面写错的两种后果都很安静：
 *     · 频道名拼错 → 渲染层 await 永不 resolve（表现为「点了没反应」）；
 *     · 白名单漏卡 → 插件调非法方法时静默 timeout，作者以为是自己的错。
 *   两条都不会在类型检查或其它用例里冒头。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-surface
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const PRELOAD = read('../index.ts')
const MAIN_IPC = read('../../main/ipc/plugin.ts')
const IPC_TYPES = read('../../shared/types/ipc.ts')

/** 断言 preload 里存在 `method: (args) => ipcRenderer.invoke('channel'` 形状 */
function assertInvoke(method: string, channel: string): void {
  assert.match(
    PRELOAD,
    new RegExp(`${method}:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${channel}'`),
    `plugin.${method} 必须映射到 ${channel}`,
  )
}

/** 断言 preload 里存在订阅形状 `method: (cb) => { ... ipcRenderer.on('channel'` */
function assertSubscribe(method: string, channel: string): void {
  assert.match(
    PRELOAD,
    new RegExp(`${method}:\\s*\\(cb\\)\\s*=>\\s*\\{[\\s\\S]{0,240}?ipcRenderer\\.on\\('${channel}'`),
    `plugin.${method} 必须订阅 ${channel}`,
  )
  assert.match(
    PRELOAD,
    new RegExp(`${method}:[\\s\\S]{0,400}?removeListener\\('${channel}'`),
    `plugin.${method} 必须返回退订函数（卸载对称性，否则监听器只增不减）`,
  )
}

/* ============================================================
 * 一、插拔面（v0.33.0 继承，逐项不得移除/改名）
 * ============================================================ */

test('TC-PRELOAD-003 ★ 插拔面六个方法逐项映射到既有频道（纯继承，不得改名）', () => {
  const inherited: Array<[string, string]> = [
    ['list', 'plugin:list'],
    ['setEnabled', 'plugin:set-enabled'],
    ['uninstall', 'plugin:uninstall'],
    ['openDir', 'plugin:open-dir'],
    ['exportSample', 'plugin:export-sample'],
  ]
  for (const [m, ch] of inherited) assertInvoke(m, ch)
  // rescan 无参数
  assert.match(PRELOAD, /rescan:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('plugin:rescan'\)/, 'rescan → plugin:rescan')
  assertSubscribe('onChanged', 'plugin:changed')
})

/* ============================================================
 * 二、运行期面（v0.35.0 新增）
 * ============================================================ */

test('TC-PRELOAD-004 ★ v0.35.0 运行期面：runtimeStatus / views / onRuntimeChanged', () => {
  assertInvoke('runtimeStatus', 'plugin:runtime-status')
  assert.match(PRELOAD, /views:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('plugin:views'\)/, 'views → plugin:views')
  assertSubscribe('onRuntimeChanged', 'plugin:runtime-changed')
})

/* ============================================================
 * 三、视图桥面（v0.35.0 新增）
 * ============================================================ */

test('TC-PRELOAD-005 ★ 桥面：viewOpen / viewClose 映射既有频道', () => {
  assertInvoke('viewOpen', 'plugin:view-open')
  assertInvoke('viewClose', 'plugin:view-close')
  assertSubscribe('onViewPost', 'plugin:view-post')
  assertSubscribe('onViewOpenRequest', 'plugin:view-open-request')
})

test('TC-PRELOAD-006 ★ viewEvent 必须走 `send` 而非 `invoke`（事件是单向尽力而为，不回执就卡不住 UI）', () => {
  assert.match(
    PRELOAD,
    /viewEvent:\s*\([^)]*\)\s*=>\s*\{\s*ipcRenderer\.send\('plugin:view-event'/,
    'viewEvent 必须用 send —— 用 invoke 会让「插件未响应」把调用方挂住',
  )
  assert.doesNotMatch(
    PRELOAD,
    /viewEvent[^\n]*ipcRenderer\.invoke\('plugin:view-event'/,
    'viewEvent 不得改成 invoke',
  )
})

/* ============================================================
 * 四、作者工具面（v0.35.0 新增）
 * ============================================================ */

test('TC-PRELOAD-007 作者工具面：scaffold / migrateCheck', () => {
  assertInvoke('scaffold', 'plugin:scaffold')
  assert.match(
    PRELOAD,
    /migrateCheck:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('plugin:migrate-check'\)/,
    'migrateCheck → plugin:migrate-check',
  )
})

/* ============================================================
 * 五、安全边界（§9 安全⑥ · 纪律⑤）—— 本组最高价值
 * ============================================================ */

test('TC-PRELOAD-008 ★★ 安全铁律：preload 只暴露 `ark` 一个对象，绝不把 ipcRenderer 交出去', () => {
  assert.match(
    PRELOAD,
    /contextBridge\.exposeInMainWorld\('ark',\s*ark\)/,
    '只能暴露聚合对象 ark',
  )
  // 任何把 ipcRenderer / ipcMain 直接挂到 window 的写法都是越界
  for (const bad of [
    /exposeInMainWorld\('ipcRenderer'/,
    /exposeInMainWorld\('electron'/,
    /exposeInMainWorld\([^)]*,\s*ipcRenderer\s*\)/,
  ]) {
    assert.doesNotMatch(PRELOAD, bad, '不得把 ipcRenderer 本体暴露给渲染层')
  }
})

test('TC-PRELOAD-009 ★ 纪律⑤ 双处校验：白名单既在 preload 先卡，也在 main 侧再卡一次', () => {
  // preload 侧：挡住作者写错方法名（开发期立刻可见）
  assert.match(PRELOAD, /PLUGIN_VIEW_METHODS as readonly string\[\]\)\.includes\(args\?\.method\)/, 'preload 必须先卡一次')
  assert.match(PRELOAD, /method-not-allowed/, '拒绝时给人话原因（纪律⑦）')
  // main 侧：真正的边界（沙箱里的 Client 半可绕过 preload 直发 IPC）
  assert.match(MAIN_IPC, /PLUGIN_VIEW_METHODS as readonly string\[\]\)\.includes\(method\)/, 'main 侧必须再卡一次')
})

test('TC-PRELOAD-010 ★ 白名单**同源**：preload 从 shared 引入，不得本地复制一份字面量', () => {
  assert.match(
    PRELOAD,
    /import\s*\{[^}]*PLUGIN_VIEW_METHODS[^}]*\}\s*from\s*'@shared\/types\/ipc'/,
    '必须从 @shared/types/ipc 引入唯一真源',
  )
  // 抄一份字面量会让 preload 与 main 的白名单悄悄漂移
  assert.doesNotMatch(PRELOAD, /const PLUGIN_VIEW_METHODS\s*=/, '不得在 preload 里重新定义白名单')
})

/* ============================================================
 * 六、与 main 侧的频道存在性对账（防止「preload 有、main 没有」的空频道）
 * ============================================================ */

test('TC-PRELOAD-011 ★ 每个 v0.35.0 新频道在 main 侧都有注册（不留空频道）', () => {
  const channels = [
    'PluginChannel.RuntimeStatus',
    'PluginChannel.Views',
    'PluginChannel.ViewOpen',
    'PluginChannel.ViewClose',
    'PluginChannel.ViewCall',
    'PluginChannel.ViewEvent',
    'PluginChannel.Scaffold',
    'PluginChannel.MigrateCheck',
  ]
  for (const c of channels) {
    assert.ok(MAIN_IPC.includes(c), `main 侧必须注册 ${c}（否则 preload 的调用永远没有应答）`)
  }
  // 广播频道（view-post / view-open-request / runtime-changed）必须存在同名常量
  for (const c of [
    'plugin:view-post',
    'plugin:view-open-request',
    'plugin:runtime-changed',
  ]) {
    assert.ok(IPC_TYPES.includes(c) || MAIN_IPC.includes(c), `频道常量 ${c} 必须存在于同源定义里`)
  }
})

test('TC-PRELOAD-012 频道常量集中在 shared/types/ipc（preload 与 main 不得各写一份字面量）', () => {
  assert.match(IPC_TYPES, /export const PLUGIN_VIEW_METHODS\s*=\s*\[/, '桥白名单常量必须定义在 shared 层')
  assert.match(IPC_TYPES, /export const PluginChannel\s*=/, 'PluginChannel 常量表必须定义在 shared 层')
})
