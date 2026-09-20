/* ============================================================
 * ArkWork — 插件视图桥（纯逻辑半边）单测（v0.35.0 · B7/B11 建立）
 * 规格来源：docs/versions/v0.35.0/04-system-design.md §5.2 · §9（可测性 IP3）
 *   IP3 原文：「渲染侧 `PluginViewHost` 的桥逻辑抽纯模块（`plugin-view-bridge.ts`）
 *             单测，组件只做接线」——本文件就是该条纪律的物理载体。
 *
 * ★ 为什么必须有「白名单跨模块一致」这条用例：
 *   iframe 里的 Client 半是**完全不可信代码**，它与宿主之间只有 postMessage。
 *   方法名白名单在本仓有**两个**落点 —— `shared/utils/plugin-view-bridge.ts`
 *   的 BRIDGE_METHODS 与 `shared/types/ipc.ts` 的 PLUGIN_VIEW_METHODS。
 *   两处一旦漂移，现象是「插件调 ui.toast，宿主回一句不在白名单」——
 *   而脚手架生成的 renderer.js 恰恰照 BRIDGE_METHODS 写，作者会以为自己写错了。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-view-bridge
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BRIDGE_METHODS,
  BRIDGE_EVENT_THEME,
  isBridgeMethod,
  parseBridgeMsg,
  createBridgeHost,
  bridgeClientSource,
  type BridgeMsg,
} from '../plugin-view-bridge.js'
import { PLUGIN_VIEW_METHODS } from '@shared/types/ipc'

/* ============================================================
 * 1. 白名单（唯一真源）与跨模块一致性
 * ============================================================ */

test('TC-PVB-001 ★ 白名单跨模块一致：BRIDGE_METHODS 与 PLUGIN_VIEW_METHODS 同源同序', () => {
  assert.deepEqual(
    [...BRIDGE_METHODS],
    [...PLUGIN_VIEW_METHODS],
    '两处白名单漂移会让「脚手架生成的调用」被宿主拒绝，且看起来像作者的错',
  )
})

test('TC-PVB-002 白名单无重复；isBridgeMethod 真值表', () => {
  assert.equal(new Set(BRIDGE_METHODS).size, BRIDGE_METHODS.length, '不得有重复方法名')
  for (const m of BRIDGE_METHODS) assert.equal(isBridgeMethod(m), true)
  for (const bad of ['ui.clear', 'eval', '', 'UI.READY', 'ui.ready ', 42, null, undefined]) {
    assert.equal(isBridgeMethod(bad), false, `${String(bad)} 不应在白名单内`)
  }
})

/* ============================================================
 * 2. 报文判别：形状不对必须原样丢弃（两个方向共用）
 * ============================================================ */

test('TC-PVB-003 parseBridgeMsg：非对象 / 未知 kind / 非法 lifecycle.phase 一律 null', () => {
  const bad: unknown[] = [
    null,
    undefined,
    'lifecycle',
    42,
    [],
    {},
    { kind: 'nope' },
    { kind: 'lifecycle' }, // 缺 phase
    { kind: 'lifecycle', phase: 'idle' }, // phase 非法
  ]
  for (const v of bad) assert.equal(parseBridgeMsg(v), null, `${JSON.stringify(v)} 应被丢弃`)
})

test('TC-PVB-004 parseBridgeMsg：call 缺 id/method、reply 缺 ok 一律 null', () => {
  assert.equal(parseBridgeMsg({ kind: 'call', method: 'ui.ready' }), null)
  assert.equal(parseBridgeMsg({ kind: 'call', id: 1 }), null)
  assert.equal(parseBridgeMsg({ kind: 'call', id: '1', method: 'ui.ready' }), null)
  assert.equal(parseBridgeMsg({ kind: 'reply', id: 1 }), null)
  assert.equal(parseBridgeMsg({ kind: 'reply', id: 1, ok: 'yes' }), null)
  // 合法
  assert.ok(parseBridgeMsg({ kind: 'call', id: 1, method: 'ui.ready' }))
  assert.ok(parseBridgeMsg({ kind: 'reply', id: 1, ok: false }))
  assert.ok(parseBridgeMsg({ kind: 'lifecycle', phase: 'deactivate' }))
  assert.ok(parseBridgeMsg({ kind: 'event', payload: { a: 1 } }))
})

/* ============================================================
 * 3. 容器侧处理器：白名单过滤 → 补 sessionId → 回 reply
 * ============================================================ */

/** 造一个可观测的容器（记录投递给 iframe 的报文与转发到主进程的调用） */
function harness(opts: { sessionId?: string; result?: unknown; ok?: boolean } = {}) {
  const posted: BridgeMsg[] = []
  const calls: Array<{ sessionId: string; method: string; params: unknown }> = []
  const rejected: string[] = []
  const host = createBridgeHost({
    sessionId: opts.sessionId ?? 'sess-1',
    post: (m) => posted.push(m),
    transport: async (sessionId, method, params) => {
      calls.push({ sessionId, method, params })
      return opts.ok === false
        ? { ok: false, error: { code: 'E_DENIED', message: '不给' } }
        : { ok: true, result: opts.result ?? { fine: true } }
    },
    onRejected: (reason) => rejected.push(reason),
  })
  return { host, posted, calls, rejected }
}

/** 等一个微任务轮次（transport 是异步的，reply 在下一轮投出） */
const tick = () => new Promise((r) => setTimeout(r, 0))

test('TC-PVB-005 handshake：activate 携带 theme；空/缺席 theme 时字段不出现在报文里', () => {
  const a = harness()
  a.host.handshake('activate', { id: 'p', name: 'P', version: '1.0.0' }, { '--bg-base': '#fff' })
  assert.deepEqual(a.posted[0], {
    kind: 'lifecycle',
    phase: 'activate',
    sessionId: 'sess-1',
    manifest: { id: 'p', name: 'P', version: '1.0.0' },
    theme: { '--bg-base': '#fff' },
  })

  const b = harness()
  b.host.handshake('activate', { id: 'p', name: 'P', version: '1.0.0' })
  assert.equal((b.posted[0] as { theme?: unknown }).theme, undefined, '无 theme 时不该出现空对象')

  const c = harness()
  c.host.handshake('deactivate', { id: 'p', name: 'P', version: '1.0.0' }, {})
  assert.equal((c.posted[0] as { theme?: unknown }).theme, undefined, '{} 视为无 theme')
  assert.equal((c.posted[0] as { phase: string }).phase, 'deactivate')
})

test('TC-PVB-006 pushEvent 报文形状为 {kind:"event", payload}', () => {
  const h = harness()
  h.host.pushEvent({ type: BRIDGE_EVENT_THEME, tokens: { '--bg-base': '#000' } })
  assert.deepEqual(h.posted[0], {
    kind: 'event',
    payload: { type: BRIDGE_EVENT_THEME, tokens: { '--bg-base': '#000' } },
  })
})

test('TC-PVB-007 ★ 白名单外的方法被拒且**不转发**（诊断只落宿主日志，不回声给插件）', async () => {
  const h = harness()
  h.host.onMessage({ kind: 'call', id: 7, method: 'fs.readFile', params: { p: '/etc/passwd' } })
  await tick()
  assert.equal(h.calls.length, 0, '非白名单方法绝不得到转发')
  assert.equal(h.posted.length, 0, '也不回 reply —— 否则等于把探测结果告诉插件')
  assert.equal(h.rejected.length, 1)
  assert.match(h.rejected[0]!, /fs\.readFile/)
})

test('TC-PVB-008 ★ 安全铁律：插件自填的 sessionId 被丢弃，transport 收到容器持有的那个', async () => {
  const h = harness({ sessionId: 'container-owned' })
  h.host.onMessage({ kind: 'call', id: 1, method: 'ui.toast', params: {}, sessionId: 'forged-by-plugin' })
  await tick()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0]!.sessionId, 'container-owned', '绝不能用插件自填的会话 id')
})

test('TC-PVB-009 非 call 类报文（event / reply / lifecycle / 垃圾）一律不触发 transport', async () => {
  const h = harness()
  const nonCalls: unknown[] = [
    { kind: 'lifecycle', phase: 'activate' },
    { kind: 'event', payload: {} },
    { kind: 'reply', id: 1, ok: true },
    'junk',
    null,
    { kind: 'call' }, // 形状不全
  ]
  for (const m of nonCalls) h.host.onMessage(m)
  await tick()
  assert.equal(h.calls.length, 0)
  assert.equal(h.posted.length, 0)
})

test('TC-PVB-010 reply 形状：成功带 result，失败带 error（且 id 与请求一致）', async () => {
  const okh = harness({ result: { rows: 3 } })
  okh.host.onMessage({ kind: 'call', id: 41, method: 'data.request', params: { spec: 'x' } })
  await tick()
  assert.deepEqual(okh.posted[0], { kind: 'reply', id: 41, ok: true, result: { rows: 3 } })
  assert.deepEqual(okh.calls[0]!.params, { spec: 'x' }, 'params 原样透传')

  const failh = harness({ ok: false })
  failh.host.onMessage({ kind: 'call', id: 42, method: 'ui.toast' })
  await tick()
  assert.deepEqual(failh.posted[0], {
    kind: 'reply',
    id: 42,
    ok: false,
    error: { code: 'E_DENIED', message: '不给' },
  })
})

test('TC-PVB-011 多个并发 call 各自收到对应 reply（不串号）', async () => {
  const h = harness()
  h.host.onMessage({ kind: 'call', id: 1, method: 'ui.ready' })
  h.host.onMessage({ kind: 'call', id: 2, method: 'ui.resize' })
  h.host.onMessage({ kind: 'call', id: 3, method: 'storage.get' })
  await tick()
  const replies = h.posted.filter((m): m is Extract<BridgeMsg, { kind: 'reply' }> => m.kind === 'reply')
  assert.deepEqual(
    replies.map((r) => r.id).sort((a, b) => a - b),
    [1, 2, 3],
  )
})

/* ============================================================
 * 4. Client 半源码（脚手架直接贴进插件 renderer.js）
 * ============================================================ */

test('TC-PVB-012 ★ 生成的客户端源码必须是**语法合法**的经典脚本（白屏事故的根因就是它写坏）', () => {
  const src = bridgeClientSource({ pluginName: '测试插件' })
  // new Function 只做**解析**不执行 —— 语法错误会在这里抛
  assert.doesNotThrow(() => {
    new Function(src)
  }, '脚手架生成的客户端源码语法必须合法')
  // 经典脚本铁律：不得出现 import / export（由 <script src> 加载）
  assert.doesNotMatch(src, /^\s*import\s/m, '不得使用 import')
  assert.doesNotMatch(src, /^\s*export\s/m, '不得使用 export')
})

test('TC-PVB-013 客户端源码把白名单方法名如实告知作者（作者不需要读宿主源码）', () => {
  const src = bridgeClientSource({ pluginName: 'P' })
  for (const m of BRIDGE_METHODS) {
    assert.ok(src.includes(m), `源码注释里应列出可用的宿主方法 ${m}`)
  }
})

test('TC-PVB-014 ★ 客户端源码必须内建主题跟随（否则深色宿主里首帧闪白）', () => {
  const src = bridgeClientSource({ pluginName: 'P' })
  assert.match(src, /applyTheme/)
  assert.ok(src.includes(BRIDGE_EVENT_THEME), '应处理主题变更事件')
  assert.match(src, /m\.theme/, '握手报文里的 theme 必须被应用（首帧即正确）')
  // 插件名以 JSON 字面量注入（防引号/换行把源码写坏）
  const tricky = bridgeClientSource({ pluginName: 'a"b\nc\\d' })
  assert.doesNotThrow(() => {
    new Function(tricky)
  })
})
