/* ============================================================
 * ArkWork — 插件运行时「装配接线」契约断言（v0.36.0 · B1）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.4（D80/D81/D82）
 *
 * **为什么是静态断言而不是单测**：D80/D81/D82 三处缺陷的共同形态是
 *   「函数本身全对，错的是装配层没人调用/没传参数」—— 这种缺陷恰恰
 *   发生在真实 Electron 生产路径，单测环境（electron-stub）里：
 *    · stub 的 utilityProcess.fork 是空壳，测不出 env 注入（D80）；
 *    · stub 的 net.fetch 不存在，选栈永远回落 global，测不出 net 接线（D81）；
 *    · watchdog/sweeper 是定时器，单测里起真定时器就是 flake 源（D82）。
 *   所以把「生产装配文件里必须存在这行接线」钉死为源码契约（同 TC-PFCH-004
 *   的纪律：挂点/选路类代码必须有测试把守）。v0.35.0 实测教训：
 *   `setHostVersion` 没人调 → 所有声明 engines 的插件装不上（D79 同型）。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/plugins/__tests__/plugin-wiring.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripComments } from '@shared/utils/source-guard'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 与文件内 /** * 注释、// 行注释无关地取「纯源码」——接线断言不数注释里的示例 */
const read = (rel: string): string =>
  stripComments(readFileSync(join(HERE, rel), 'utf-8'))

const supervisorSrc = read('../runtime/supervisor.ts')
const bootstrapSrc = read('../bootstrap.ts')
const hostServiceSrc = read('../runtime/host-service.ts')
const hostRuntimeSrc = read('../runtime/host-runtime.ts')
const fetchStackSrc = read('../../net/fetch-stack.ts')

/* ============================================================
 * 1. D80 —— utilityProcess.fork 必须注入 HOST_ENV_FLAG
 * ============================================================ */

test("TC-WIRE-001 ★ fork 调用必须注入 env（含 HOST_ENV_FLAG='1'）——否则宿主进程拒绝握手", () => {
  // 生产 spawn 实现里的 fork 选项：env 必须显式透传（fork 不像 child_process 默认继承）
  assert.match(
    supervisorSrc,
    /utilityProcess\.fork\([\s\S]{0,200}env:\s*\{\s*\.\.\.process\.env,\s*\[HOST_ENV_FLAG\]:\s*'1'/,
    'spawnUtilityProcess 的 fork 选项必须带 env: { ...process.env, [HOST_ENV_FLAG]: \'1\' } —— ' +
      '漏掉它 wire.ts 的宿主检测永远不成立，插件卡死在 preparing（D80）',
  )
})

test('TC-WIRE-002 wire.ts 的宿主检测逻辑必须存在（env 标记的消费端）', () => {
  const wireSrc = read('../runtime/wire.ts')
  assert.match(wireSrc, /HOST_ENV_FLAG/, 'wire.ts 必须定义/使用 HOST_ENV_FLAG')
})

/* ============================================================
 * 2. D81 —— 装配层必须把真源取数栈传给宿主服务
 * ============================================================ */

test('TC-WIRE-003 ★ bootstrap 必须传 fetch: pluginFetch() 给 initPluginHostService', () => {
  assert.match(
    bootstrapSrc,
    /initPluginHostService\(\{[\s\S]{0,400}?fetch:\s*pluginFetch\(\)/,
    'bootstrap 装配必须注入 fetch —— 漏掉它插件网关拿到空壳默认实现，' +
      'net.fetch 能力永远 {status:0, body:\'\'}（D81 / as-built §14.1 P0-2）',
  )
  assert.match(bootstrapSrc, /from '\.\.\/net\/fetch-stack\.js'/, '必须从取数栈真源引入（不得本地另造选栈）')
})

test('TC-WIRE-004 pluginFetch 必须现场经 pickFetch 选栈（禁裸 fetch）', () => {
  const calls = fetchStackSrc.match(/(?<![.\w])fetch\s*\(/g) ?? []
  assert.equal(
    calls.length,
    0,
    `net/fetch-stack.ts 出现 ${calls.length} 处裸 fetch 调用 —— 选栈必须收敛在 pickFetch 单点`,
  )
  assert.match(fetchStackSrc, /pickFetch\(\)/, 'pluginFetch 必须经 pickFetch 选栈（net 优先，认系统代理）')
  assert.match(fetchStackSrc, /impl: fetch as unknown as FetchLike/, '回落分支必须保留（纯 Node 单测兜底）')
})

/* ============================================================
 * 3. D82 —— 生产装配必须启动 watchdog / idle-sweeper，且退出收口
 * ============================================================ */

test('TC-WIRE-005 ★ 生产装配必须启动 watchdog 与 idle sweeper（只允许测试调用 = 未接线）', () => {
  assert.match(bootstrapSrc, /supervisor\.startWatchdog\(\)/, 'bootstrap 必须启动心跳看门狗（D82）')
  assert.match(bootstrapSrc, /supervisor\.startIdleSweeper\(\)/, 'bootstrap 必须启动空闲回收（D82）')
})

test('TC-WIRE-006 host-service.shutdown() 必须停表（防定时器泄漏空转）', () => {
  // killAll 只杀会话不停定时器；开了 watchdog 之后，退出/重装配路径必须同步 stop
  const shutdownBody = hostServiceSrc.slice(hostServiceSrc.indexOf('shutdown(): void'))
  assert.match(
    shutdownBody,
    /supervisor\.stopWatchdog\(\)/,
    'PluginHostService.shutdown() 必须调用 supervisor.stopWatchdog()，否则泄漏的 tick 继续空转',
  )
})

test('TC-WIRE-007 watchdog/sweeper 必须幂等启动（重复装配不得叠加定时器）', () => {
  // startWatchdog / startIdleSweeper 的第一行必须是重入护栏
  for (const name of ['startWatchdog', 'startIdleSweeper'] as const) {
    const body = supervisorSrc.slice(supervisorSrc.indexOf(`${name}(): void`))
    assert.match(body, /if \(\s*this\.\w+Timer\s*!==\s*undefined\s*\)\s*return/, `${name} 必须有重入护栏`)
  }
})

/* ============================================================
 * 4. D83 —— Host 半心跳计时器必须有全局默认（实机第四断点）
 * ============================================================ */

test('TC-WIRE-008 ★ createHostRuntime 的计时器必须有全局默认（生产入口只传 endpoint）', () => {
  // host-entry 生产入口只传 { endpoint }，若 setTimer/clearTimer 无默认，
  // 心跳 tick 永不调度 → 所有健康插件激活 ~9s 后被看门狗误杀（D83）
  for (const dep of ['setTimer', 'clearTimer'] as const) {
    assert.match(
      hostRuntimeSrc,
      new RegExp(`const ${dep} = deps\\.${dep} \\?\\? `),
      `createHostRuntime 必须给 deps.${dep} 全局默认 —— 缺它则心跳/超时在真实进程中静默失效`,
    )
  }
  // 心跳调度不得再走可空路径（deps.setTimer?.() 在无注入时是静默 no-op）
  const beatBody = hostRuntimeSrc.slice(hostRuntimeSrc.indexOf('function startHeartbeat'))
  assert.doesNotMatch(beatBody, /deps\.setTimer\?\./, 'startHeartbeat 不得用 deps.setTimer?.()（无注入即静默不跑）')
})

/* ============================================================
 * 5. D84 —— setHostVersion 必须先于一切插件扫描（profile 挂载会触发刷新）
 * ============================================================ */

test('TC-WIRE-009 ★ index.ts 的 setHostVersion 必须先于 bootstrapIpcSideEffects（VP8 才不会用 0.0.0 判 engines）', () => {
  const indexSrc = read('../../index.ts')
  const setAt = indexSrc.indexOf('setHostVersion(app.getVersion())')
  const scanAt = indexSrc.indexOf('bootstrapIpcSideEffects()')
  assert.ok(setAt >= 0, 'index.ts whenReady 内必须调用 setHostVersion(app.getVersion())')
  assert.ok(scanAt >= 0, 'index.ts 必须存在 bootstrapIpcSideEffects（顺序锚点）')
  assert.ok(
    setAt < scanAt,
    `setHostVersion（位置 ${setAt}）必须先于 bootstrapIpcSideEffects（位置 ${scanAt}）—— ` +
      'profile 挂载会触发插件扫描，晚注入则 engines 判定拿的是占位版本 0.0.0（D84）',
  )
})
