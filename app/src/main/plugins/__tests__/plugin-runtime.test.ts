/* ============================================================
 * ArkWork — 插件运行时用例库（v0.35.0 · B4）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §5.4 / §6 / §9（IP1 IP2）
 *
 * 本套件覆盖三块**最容易「离线全绿、真跑不过」**的地方：
 *  ① 线协议（wire.ts）：报文判别、端点适配、异步投递语义；
 *  ② Host 半运行时（host-runtime.ts）：装载格式、apply 语义、effect 逆序、
 *     「绝不半注册」、事件闭集、存储配额、心跳；
 *  ③ Supervisor：激活 / 超时 / 心跳判死 / **忙时不误杀** / 崩溃 / 幂等销毁。
 *
 * 为什么用**注入端点 + 注入时钟**而不是真起 utilityProcess：
 *  真实进程只能测「跑得起来」，测不了「超时时恰好做了什么」——而缺陷恰恰
 *  全在后者。注入之后，`advance(ms)` 能把 15s 超时压成一次函数调用，
 *  且**完全确定**（无 flake）。真进程路径由实机冒烟覆盖（B11）。
 * ============================================================ */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  RPC_ERROR,
  RpcError,
  isWireMessage,
  makeLinkedEndpoints,
  notify,
  replyErr,
  replyOk,
  rpcRequest,
  toErrorPayload,
  type ReplyMsg,
  type WireEndpoint,
  type WireMessage,
} from '../runtime/wire.js'
import {
  createHostRuntime,
  defaultLoadModule,
  pickApply,
  type HostRuntime,
} from '../runtime/host-runtime.js'
import {
  PluginSupervisor,
  type HostProcessHandle,
} from '../runtime/supervisor.js'
import type { PluginRuntimeStatus } from '@shared/types/plugin'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'plugins')

/* ============================================================
 * 通用工具：让「跨微任务的会话」可被确定地推进
 * ============================================================ */

/** 把当前微任务队列抽干（报文投递走 queueMicrotask） */
async function drain(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0))
}

/** 手动时钟 + 手动定时器队列：把超时压成一次 `advance()`，无 flake */
function makeClock(): {
  now: () => number
  setTimer: (fn: () => void, ms: number) => number
  clearTimer: (h: unknown) => void
  advance: (ms: number) => Promise<void>
  pending: () => number
} {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = (seq += 1)
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (h) => {
      timers.delete(h as number)
    },
    pending: () => timers.size,
    advance: async (ms) => {
      const target = now + ms
      for (;;) {
        let pick: [number, { at: number; fn: () => void }] | null = null
        for (const e of timers) {
          if (e[1].at <= target && (!pick || e[1].at < pick[1].at)) pick = e
        }
        if (!pick) break
        timers.delete(pick[0])
        now = pick[1].at
        pick[1].fn()
        await drain(6)
      }
      now = target
      await drain(6)
    },
  }
}

/* ============================================================
 * 假「主进程侧」：把 Host 半发来的 invoke 按脚本应答，并记录全部往返
 * ============================================================ */
interface FakeMain {
  invokes: Array<{ cap: string; params: unknown }>
  notifies: Array<{ method: string; params: unknown }>
  logs: string[]
  /** 发一条 main → host 的 rpc，返回应答报文 */
  rpc(method: string, params?: unknown): Promise<ReplyMsg>
  /** 只发不等（用于「不该有应答」的断言） */
  fire(method: string, params?: unknown): void
  /** 注入一个能力实现（覆盖缺省 `{}`） */
  setCap(cap: string, impl: (params: unknown) => unknown): void
}

function createFakeMain(ep: WireEndpoint): FakeMain {
  const invokes: FakeMain['invokes'] = []
  const notifies: FakeMain['notifies'] = []
  const logs: string[] = []
  const caps = new Map<string, (p: unknown) => unknown>()
  const waiters = new Map<number, (m: ReplyMsg) => void>()
  let nextId = 1

  ep.onMessage((m) => {
    if (m.kind === 'invoke') {
      invokes.push({ cap: m.cap, params: m.params })
      const impl = caps.get(m.cap)
      try {
        const result = impl ? impl(m.params) : { regId: invokes.length }
        ep.send(replyOk(m.id, result))
      } catch (err) {
        ep.send(replyErr(m.id, toErrorPayload(err)))
      }
      return
    }
    if (m.kind === 'notify') {
      notifies.push({ method: m.method, params: m.params })
      if (m.method === 'host/log') {
        const p = (m.params ?? {}) as { msg?: string }
        logs.push(String(p.msg ?? ''))
      }
      return
    }
    if (m.kind === 'reply') {
      const w = waiters.get(m.id)
      if (w) {
        waiters.delete(m.id)
        w(m)
      }
    }
  })

  return {
    invokes,
    notifies,
    logs,
    fire: (method, params) => ep.send(rpcRequest(nextId++, method, params)),
    rpc: (method, params) =>
      new Promise<ReplyMsg>((resolve) => {
        const id = nextId++
        waiters.set(id, resolve)
        ep.send(rpcRequest(id, method, params))
      }),
    setCap: (cap, impl) => caps.set(cap, impl),
  }
}

/** 起一组「Host 半 + 假主进程」 */
function makeHostPair(): { host: HostRuntime; main: FakeMain; ep: WireEndpoint } {
  const { a, b } = makeLinkedEndpoints()
  const host = createHostRuntime({ endpoint: b })
  const main = createFakeMain(a)
  return { host, main, ep: a }
}

const manifestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: '1.1',
  id: 'test.fixture',
  name: '夹具',
  version: '1.0.0',
  kind: 'panel',
  ...over,
})

/* ============================================================
 * 一、线协议（wire.ts）
 * ============================================================ */

test('TC-PLG2-001 报文判别：四种 kind 的形状要求（坏报文一律进不来）', () => {
  assert.equal(isWireMessage(rpcRequest(1, 'host/activate')), true)
  assert.equal(isWireMessage({ kind: 'invoke', id: 2, cap: 'fs.read' }), true)
  assert.equal(isWireMessage(replyOk(3)), true)
  assert.equal(isWireMessage(notify('host/heartbeat')), true)

  // 缺 id / id 非数字 / kind 未知 / 非对象 → 全部拒
  assert.equal(isWireMessage({ kind: 'rpc', method: 'x' }), false)
  assert.equal(isWireMessage({ kind: 'rpc', id: 'x', method: 'y' }), false)
  assert.equal(isWireMessage({ kind: 'nope' }), false)
  assert.equal(isWireMessage(null), false)
  assert.equal(isWireMessage([1, 2]), false)
  assert.equal(isWireMessage('hello'), false)
})

test('TC-PLG2-002 错误载荷：RpcError 保码，普通 Error 落 E_INTERNAL，字符串也不抛', () => {
  assert.deepEqual(toErrorPayload(new RpcError(RPC_ERROR.E_PERMISSION_DENIED, '没有 net 权限', { cap: 'net.fetch' })), {
    code: 'E_PERMISSION_DENIED',
    message: '没有 net 权限',
    data: { cap: 'net.fetch' },
  })
  assert.deepEqual(toErrorPayload(new Error('普通错误')), { code: 'E_INTERNAL', message: '普通错误' })
  assert.deepEqual(toErrorPayload('裸字符串'), { code: 'E_INTERNAL', message: '裸字符串' })
  assert.deepEqual(toErrorPayload(undefined), { code: 'E_INTERNAL', message: 'undefined' })
})

test('TC-PLG2-003 内存端点：缺省异步投递（永不同步回调），可切同步', async () => {
  const asyncPair = makeLinkedEndpoints()
  const got: WireMessage[] = []
  asyncPair.b.onMessage((m) => got.push(m))
  asyncPair.a.send(rpcRequest(1, 'host/activate'))
  // 关键断言：send 返回的**同一同步帧内**不该已经回调 —— 真实 MessagePort 就是这样
  assert.equal(got.length, 0, '缺省必须异步投递（同步回调会掩盖时序缺陷）')
  assert.equal(asyncPair.pendingCount(), 1)
  await drain(2)
  assert.equal(got.length, 1)
  assert.equal(asyncPair.pendingCount(), 0)

  const syncPair = makeLinkedEndpoints({ asyncDelivery: false })
  const got2: WireMessage[] = []
  syncPair.b.onMessage((m) => got2.push(m))
  syncPair.a.send(rpcRequest(2, 'host/activate'))
  assert.equal(got2.length, 1, '显式同步模式下应立即回调')
})

test('TC-PLG2-004 内存端点：onMessage 可多次注册（事件语义而非单槽）', async () => {
  const { a, b } = makeLinkedEndpoints()
  const seen: string[] = []
  b.onMessage(() => seen.push('first'))
  b.onMessage(() => seen.push('second'))
  a.send(rpcRequest(1, 'host/activate'))
  await drain(2)
  assert.deepEqual(seen, ['first', 'second'])
})

/* ============================================================
 * 二、Host 半运行时（host-runtime.ts）
 * ============================================================ */

test('TC-PLG2-010 prepare + activate + tool-call 全链路（真实夹具模块）', async () => {
  const { host, main } = makeHostPair()
  const r1 = await main.rpc('host/prepare', {
    pluginId: 'test.good',
    dir: join(FIXTURES, 'good'),
    manifest: manifestOf({ id: 'test.good', main: 'main.js' }),
    permissions: ['tools.register'],
  })
  assert.equal(r1.ok, true, `prepare 应成功：${JSON.stringify(r1.error)}`)

  const r2 = await main.rpc('host/activate')
  assert.equal(r2.ok, true, `activate 应成功：${JSON.stringify(r2.error)}`)
  assert.equal((r2.result as { activated: boolean }).activated, true)

  // tools.register 是反向能力调用，必须出现在主进程侧
  assert.ok(
    main.invokes.some((i) => i.cap === 'tools.register'),
    'apply 里的 ctx.ark.tools.register 必须经网关上行',
  )
  assert.ok(main.logs.includes('fixture-good applied'))

  const r3 = await main.rpc('host/tool-call', { name: 'ping', input: { a: 1 } })
  assert.equal(r3.ok, true)
  assert.deepEqual(r3.result, { pong: true, echo: { a: 1 } })

  const st = host.state()
  assert.equal(st.activated, true)
  assert.deepEqual(st.registeredTools, ['ping'])
  // 两个 ctx.effect + 一个 ctx.on + 一个 tools.register = 4 条可逆副作用
  assert.equal(st.effects, 4)
})

test('TC-PLG2-011 effect 撤销必须**逆序**（LIFO）—— 资源释放的通用正确顺序', async () => {
  const { host, main } = makeHostPair()
  await main.rpc('host/prepare', {
    pluginId: 'test.good',
    dir: join(FIXTURES, 'good'),
    manifest: manifestOf({ id: 'test.good', main: 'main.js' }),
    permissions: [],
  })
  await main.rpc('host/activate')

  const before = main.logs.length
  const r = await main.rpc('host/dispose')
  assert.equal(r.ok, true)
  assert.deepEqual(r.result, { revoked: 4, failed: [] })

  const tail = main.logs.slice(before)
  const i1 = tail.indexOf('revoke effect-1')
  const i2 = tail.indexOf('revoke effect-2')
  assert.ok(i1 >= 0 && i2 >= 0, `两条 effect 都该被撤销，实际：${JSON.stringify(tail)}`)
  assert.ok(i2 < i1, 'effect-2 先于 effect-1 撤销（后进先出）')
  assert.equal(host.state().effects, 0, '撤销后账本必须归零（纪律⑬的对称性判据）')
})

test('TC-PLG2-012 未 prepare 就 activate → E_NOT_PREPARED（不允许跳过装载）', async () => {
  const { main } = makeHostPair()
  const r = await main.rpc('host/activate')
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'E_NOT_PREPARED')
})

test('TC-PLG2-013 apply 抛错 → E_ACTIVATION_FAILED，且**半注册被全部收回**', async () => {
  const { host, main } = makeHostPair()
  await main.rpc('host/prepare', {
    pluginId: 'test.thrower',
    dir: join(FIXTURES, 'thrower'),
    manifest: manifestOf({ id: 'test.thrower', main: 'main.js' }),
    permissions: [],
  })
  const r = await main.rpc('host/activate')
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'E_ACTIVATION_FAILED')
  assert.match(r.error?.message ?? '', /夹具插件故意炸在 apply 里/)

  const st = host.state()
  assert.equal(st.activated, false)
  assert.equal(st.effects, 0, '抛错前登记的 effect 必须被收回（绝不半注册）')
  assert.deepEqual(st.registeredTools, [], '抛错前注册的工具必须被收回')
  assert.ok(
    main.invokes.some((i) => i.cap === 'tools.unregister'),
    '收回半注册要走 tools.unregister（与装载路径对称）',
  )
})

test('TC-PLG2-014 没有导出 apply → E_NO_APPLY 且提示可照做', async () => {
  const { main } = makeHostPair()
  const r = await main.rpc('host/prepare', {
    pluginId: 'test.noapply',
    dir: join(FIXTURES, 'noapply'),
    manifest: manifestOf({ id: 'test.noapply', main: 'main.js' }),
    permissions: [],
  })
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'E_NO_APPLY')
  assert.match(r.error?.message ?? '', /apply/)
  // 纪律⑦：报错必须给「改什么」，不能只给事实
  assert.match(String(r.error?.data?.fix ?? ''), /module\.exports|export/)
})

test('TC-PLG2-015 纯声明式插件（manifest 无 main）→ prepare 成功、activate 为合法空操作', async () => {
  const { main } = makeHostPair()
  const r1 = await main.rpc('host/prepare', {
    pluginId: 'test.declarative',
    dir: FIXTURES,
    manifest: manifestOf({ id: 'test.declarative' }), // 无 main
    permissions: [],
  })
  assert.equal(r1.ok, true)
  const r2 = await main.rpc('host/activate')
  assert.equal(r2.ok, true)
  assert.equal((r2.result as { activated: boolean }).activated, false, '零代码插件不产生 apply 动作')
})

test('TC-PLG2-016 ctx.on 事件名**闭集**：未登记即 E_EVENT_UNKNOWN（不静默不触发）', async () => {
  const { main } = makeHostPair()
  await main.rpc('host/prepare', {
    pluginId: 'test.events',
    dir: FIXTURES,
    manifest: manifestOf({ id: 'test.events' }),
    permissions: [],
  })
  // 用一个内联模块验证：apply 里监听一个不存在的事件名
  const inline = createHostRuntime({
    endpoint: makeLinkedEndpoints().b,
    loadModule: async () => ({
      apply: (ctx: unknown) => {
        ;(ctx as { on: (e: string, h: () => void) => void }).on('nope:event', () => {})
      },
    }),
  })
  const pair2 = makeLinkedEndpoints()
  const host2 = createHostRuntime({
    endpoint: pair2.b,
    loadModule: async () => ({
      apply: (ctx: unknown) => {
        ;(ctx as { on: (e: string, h: () => void) => void }).on('nope:event', () => {})
      },
    }),
  })
  const main2 = createFakeMain(pair2.a)
  await main2.rpc('host/prepare', {
    pluginId: 'test.bad-event',
    dir: FIXTURES,
    manifest: manifestOf({ id: 'test.bad-event', main: 'main.js' }),
    permissions: [],
  })
  const r = await main2.rpc('host/activate')
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'E_ACTIVATION_FAILED')
  assert.match(r.error?.message ?? '', /nope:event/)
  void inline
  void host2
})

test('TC-PLG2-017 host/emit 把宿主事件派发给 ctx.on；单个监听器抛错不影响其它监听器', async () => {
  const pair = makeLinkedEndpoints()
  const host = createHostRuntime({
    endpoint: pair.b,
    loadModule: async () => ({
      apply: (ctx: unknown) => {
        const c = ctx as { on: (e: string, h: (p: unknown) => void) => void; ark: { log: (l: string, m: string) => void } }
        c.on('workspace:changed', () => {
          throw new Error('第一个监听器坏了')
        })
        c.on('workspace:changed', (p) => c.ark.log('info', `second:${JSON.stringify(p)}`))
      },
    }),
  })
  const main = createFakeMain(pair.a)
  await main.rpc('host/prepare', {
    pluginId: 'test.emit',
    dir: FIXTURES,
    manifest: manifestOf({ id: 'test.emit', main: 'main.js' }),
    permissions: [],
  })
  await main.rpc('host/activate')
  const r = await main.rpc('host/emit', { event: 'workspace:changed', payload: { a: 1 } })
  assert.equal(r.ok, true, '监听器抛错不得让 emit 整体失败')
  assert.deepEqual(r.result, { delivered: 2 })
  assert.ok(main.logs.includes('second:{"a":1}'), '第二个监听器必须仍被调用')
  void host
})

test('TC-PLG2-018 私有存储：超配额抛 E_STORAGE_QUOTA（不静默截断）', async () => {
  const pair = makeLinkedEndpoints()
  createHostRuntime({ endpoint: pair.b, storageQuotaBytes: 8 * 1024 })
  const main = createFakeMain(pair.a)
  await main.rpc('host/prepare', {
    pluginId: 'test.hog',
    dir: join(FIXTURES, 'hog'),
    manifest: manifestOf({ id: 'test.hog', main: 'main.js' }),
    permissions: ['storage'],
  })
  const r = await main.rpc('host/activate')
  assert.equal(r.ok, false)
  assert.match(r.error?.message ?? '', /容量上限/)
})

test('TC-PLG2-019 心跳只在显式开启时发送，且可停', async () => {
  const clock = makeClock()
  const pair = makeLinkedEndpoints()
  const host = createHostRuntime({
    endpoint: pair.b,
    heartbeatMs: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  const main = createFakeMain(pair.a)
  // 未显式 start 时不发（避免测试环境里凭空多出定时器）
  await clock.advance(5000)
  assert.equal(main.notifies.filter((n) => n.method === 'host/heartbeat').length, 0)

  host.startHeartbeat()
  await clock.advance(3000)
  const beats = main.notifies.filter((n) => n.method === 'host/heartbeat').length
  assert.ok(beats >= 2, `应至少发出 2 次心跳，实际 ${beats}`)

  host.stopHeartbeat()
  const after = main.notifies.filter((n) => n.method === 'host/heartbeat').length
  await clock.advance(10_000)
  assert.equal(main.notifies.filter((n) => n.method === 'host/heartbeat').length, after, '停后不得再发')
})

test('TC-PLG2-027 ctx.ark.log 双参（level, msg）与单参（msg）都把内容送到主进程', async () => {
  // B2 实机冒烟发现：单参写法 log('内容') 按位置硬解会把消息丢进 level 位，
  // 主进程只见 `[plugin:x] ` 空前缀。此用例钉住两种形态都不丢内容。
  const { host, main } = makeHostPair()
  await main.rpc('host/prepare', {
    pluginId: 'test.logforms',
    dir: join(FIXTURES, 'logforms'),
    manifest: manifestOf({ id: 'test.logforms', main: 'main.js' }),
    permissions: [],
  })
  await main.rpc('host/activate')
  assert.ok(main.logs.includes('单参日志内容'), `单参日志内容必须到达主进程，实际：${JSON.stringify(main.logs)}`)
  assert.ok(main.logs.includes('双参日志内容'), `双参日志内容必须到达主进程，实际：${JSON.stringify(main.logs)}`)
  assert.equal(host.state().activated, true)
})

test('TC-PLG2-020 未知 rpc 方法 → E_NOT_FOUND（Host 半不实现的动作不装作成功）', async () => {
  const { main } = makeHostPair()
  const r = await main.rpc('host/nonexistent')
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'E_NOT_FOUND')
})

test('TC-PLG2-021 未注册的工具名 → E_NOT_FOUND + 指示去看 ctx.ark.tools.register', async () => {
  const { main } = makeHostPair()
  await main.rpc('host/prepare', {
    pluginId: 'test.good',
    dir: join(FIXTURES, 'good'),
    manifest: manifestOf({ id: 'test.good', main: 'main.js' }),
    permissions: [],
  })
  await main.rpc('host/activate')
  const r = await main.rpc('host/tool-call', { name: 'never_registered', input: {} })
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'E_NOT_FOUND')
  assert.match(String(r.error?.data?.fix ?? ''), /tools\.register/)
})

/* ============================================================
 * 三、模块装载格式（defaultLoadModule / pickApply）
 * ============================================================ */

test('TC-PLG2-022 .js（CJS）可装载并取出 apply', async () => {
  const mod = await defaultLoadModule(join(FIXTURES, 'good', 'main.js'), 'main.js')
  assert.equal(typeof pickApply(mod), 'function')
})

test('TC-PLG2-023 .mjs（ESM）同样可装载 —— 两种作者群体都得支持', async () => {
  const mod = await defaultLoadModule(join(FIXTURES, 'esm', 'main.mjs'), 'main.mjs')
  const apply = pickApply(mod)
  assert.equal(typeof apply, 'function')
})

test('TC-PLG2-024 .js 里写 ESM 语法 → E_MODULE_FORMAT，且**给出改名指令**', async () => {
  await assert.rejects(
    () => defaultLoadModule(join(FIXTURES, 'esmjs', 'main.js'), 'main.js'),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, RPC_ERROR.E_MODULE_FORMAT)
      // 这条 fix 是「作者能不能自己修好」的分水岭：不能只说语法错
      assert.match(String(err.data?.fix ?? ''), /\.mjs/)
      return true
    },
  )
})

test('TC-PLG2-025 TypeScript 入口 → E_MODULE_FORMAT（宿主不内置转译器，明说而不是崩）', async () => {
  await assert.rejects(
    () => defaultLoadModule(join(FIXTURES, 'good', 'main.ts'), 'main.ts'),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, RPC_ERROR.E_MODULE_FORMAT)
      assert.match(err.message, /TypeScript/)
      return true
    },
  )
})

test('TC-PLG2-026 pickApply 兼容三种导出形态', () => {
  assert.equal(typeof pickApply({ apply: () => {} }), 'function')
  assert.equal(typeof pickApply({ default: { apply: () => {} } }), 'function')
  assert.equal(typeof pickApply({ default: () => {} }), 'function')
  assert.equal(pickApply({}), null)
  assert.equal(pickApply({ apply: 42 }), null)
  assert.equal(pickApply(null), null)
})

/* ============================================================
 * 四、Supervisor（会话管理）
 * ============================================================ */

type BehaviourResult =
  | { ok: true; result?: unknown }
  | { ok: false; error: { code: string; message: string } }
  | 'silent'

/** 假 Host 半进程：按脚本应答，并记录收到的报文；测试可主动上行 */
class FakeHostProcess implements HostProcessHandle {
  readonly pid = 4242
  killed = false
  received: WireMessage[] = []
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()

  constructor(private readonly behave: (method: string, params: unknown) => BehaviourResult) {}

  postMessage(msg: unknown): void {
    const m = msg as WireMessage & { method?: string; id?: number; params?: unknown }
    this.received.push(m as WireMessage)
    // ★ 只有 `rpc` 才需要「Host 半应答」；主进程回给插件的 `reply` 若也走应答逻辑，
    //   会把「网关拒绝」打扮成成功 —— 夹具必须先对得上真实方向语义。
    if (m.kind !== 'rpc') {
      // 主进程下发的东西照原样交给「插件侧」监听器（用例据此断言网关的答复）
      this.emit('message', m as unknown as WireMessage)
      return
    }
    const r = this.behave(String(m.method ?? ''), m.params)
    if (r === 'silent') return
    Promise.resolve().then(() => {
      this.emit('message', { kind: 'reply', id: m.id, ok: r.ok, result: r.ok ? r.result : undefined, error: r.ok ? undefined : r.error })
    })
  }

  on(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
  }

  kill(): void {
    if (this.killed) return
    this.killed = true
    this.emit('exit', 0)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args)
  }

  /** 测试用：模拟插件主动上行 */
  hostSends(msg: WireMessage): void {
    this.emit('message', msg)
  }
}

type SupervisorOver = {
  timeouts?: Record<string, number>
  handleInvoke?: (pluginId: string, cap: string, params: unknown) => Promise<unknown>
}

const activateInput = (id: string) => ({
  id,
  dir: FIXTURES,
  manifest: manifestOf({ id, main: 'main.js' }),
  permissions: [],
})

function makeSupervisor(
  behave: (method: string, params: unknown) => BehaviourResult,
  over: SupervisorOver = {},
): { sup: PluginSupervisor; clock: ReturnType<typeof makeClock>; procs: FakeHostProcess[] } {
  const clock = makeClock()
  const procs: FakeHostProcess[] = []
  const sup = new PluginSupervisor({
    entryPath: '/tmp/plugin-host.js',
    spawn: () => {
      const p = new FakeHostProcess(behave)
      procs.push(p)
      return p
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...(over.timeouts ? { timeouts: over.timeouts } : {}),
    ...(over.handleInvoke ? { handleInvoke: over.handleInvoke } : {}),
  })
  return { sup, clock, procs }
}

const okBehave = (): BehaviourResult => ({ ok: true, result: { activated: true } })

test('TC-PLG2-030 激活成功：phase=active、记了 pid、耗时可读', async () => {
  const { sup, procs } = makeSupervisor(okBehave)
  const st = await sup.activate(activateInput('a.b'))
  assert.equal(st.phase, 'active')
  assert.equal(st.hostPid, 4242)
  assert.equal(typeof st.activationMs, 'number')
  assert.equal(sup.isActive('a.b'), true)
  assert.equal(sup.liveCount(), 1)
  assert.equal(procs[0]!.received.filter((m) => (m as { method?: string }).method === 'host/prepare').length, 1)
  assert.equal(procs[0]!.received.filter((m) => (m as { method?: string }).method === 'host/activate').length, 1)
})

test('TC-PLG2-031 激活幂等：已 active 不再 spawn 第二个进程', async () => {
  const { sup, procs } = makeSupervisor(okBehave)
  await sup.activate(activateInput('a.b'))
  await sup.activate(activateInput('a.b'))
  assert.equal(procs.length, 1)
})

test('TC-PLG2-032 prepare 不响应 → 5s 超时 → activation-failed，且进程被回收（不留孤儿）', async () => {
  const { sup, clock, procs } = makeSupervisor((m) => (m === 'host/prepare' ? 'silent' : okBehave()))
  const p = sup.activate(activateInput('slow'))
  await drain(4)
  await clock.advance(5_001)
  const st = await p
  assert.equal(st.phase, 'activation-failed')
  assert.match(String(st.lastError), /E_TIMEOUT|超时/)
  assert.equal(procs[0]!.killed, true, '失败路径必须杀进程 —— 否则「失败插件」会永久占一个进程')
  assert.equal(sup.statusOf('slow'), undefined, '失败会话不留在表里（避免诊断页显示幽灵条目）')
})

test('TC-PLG2-033 apply 卡死（activate 无应答）→ 超时 → 不产出插槽（registry 只看 phase）', async () => {
  const { sup, clock } = makeSupervisor((m) => (m === 'host/activate' ? 'silent' : okBehave()))
  const p = sup.activate(activateInput('hang'))
  await drain(4)
  await clock.advance(6_000)
  const st = await p
  assert.equal(st.phase, 'activation-failed')
  assert.equal(sup.isActive('hang'), false)
})

test('TC-PLG2-034 tool-call 超时 → E_TIMEOUT 抛给调用方（宿主不卡，这是独立进程的价值）', async () => {
  const { sup, clock } = makeSupervisor((m) =>
    m === 'host/tool-call' ? 'silent' : okBehave(),
  )
  await sup.activate(activateInput('t'))
  const p = sup.callTool('t', 'slow_tool', {})
  const guard = assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof RpcError)
    assert.equal(err.code, RPC_ERROR.E_TIMEOUT)
    return true
  })
  await drain(4)
  await clock.advance(30_001)
  await guard
  assert.equal(sup.isActive('t'), true, '一次调用超时不代表插件死了（进程仍在）')
})

test('TC-PLG2-035 未激活插件被调用 → E_HOST_DEAD（明确拒绝，不假装成功）', async () => {
  const { sup } = makeSupervisor(okBehave)
  await assert.rejects(
    () => sup.callTool('nobody', 'x', {}),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_HOST_DEAD,
  )
})

test('TC-PLG2-036 心跳连续缺失 → 判死并回收进程，phase=error', async () => {
  const { sup, clock, procs } = makeSupervisor(okBehave, { timeouts: { heartbeatMs: 1000, heartbeatMissLimit: 3 } })
  sup.startWatchdog()
  await sup.activate(activateInput('beat'))
  // 心跳从未上行 → 1000 * 3 = 3000ms 后应判死
  await clock.advance(3_100)
  await clock.advance(1_100)
  assert.equal(procs[0]!.killed, true, '心跳缺失必须回收进程')
  const st = sup.statusOf('beat')
  assert.equal(st, undefined, '判死后会话出表（诊断页靠 onPhaseChange 记录）')
  sup.stopWatchdog()
})

test('TC-PLG2-037 ★ 忙时不误杀：有在途调用时心跳缺失**不判死**（D78-c 加固）', async () => {
  const { sup, clock, procs } = makeSupervisor((m) => (m === 'host/tool-call' ? 'silent' : okBehave()), {
    timeouts: { heartbeatMs: 1000, heartbeatMissLimit: 3, toolCallMs: 60_000 },
  })
  sup.startWatchdog()
  await sup.activate(activateInput('busy'))
  const inflight = sup.callTool('busy', 'long_running', {}) // 60s 预算的合法慢调用
  void inflight.catch(() => {})
  await drain(4)
  // 插件正忙 → 心跳停是**正常**的；照判就是「正常慢调用被误杀」
  await clock.advance(30_000)
  assert.equal(procs[0]!.killed, false, '有在途调用时不得判死')
  assert.equal(sup.isActive('busy'), true)
  sup.stopWatchdog()
})

test('TC-PLG2-038 心跳正常上行则永不判死', async () => {
  const { sup, clock, procs } = makeSupervisor(okBehave, { timeouts: { heartbeatMs: 1000, heartbeatMissLimit: 3 } })
  sup.startWatchdog()
  await sup.activate(activateInput('healthy'))
  for (let i = 0; i < 12; i += 1) {
    procs[0]!.hostSends({ kind: 'notify', method: 'host/heartbeat', params: {} })
    await clock.advance(1_000)
  }
  assert.equal(procs[0]!.killed, false)
  assert.equal(sup.isActive('healthy'), true)
  sup.stopWatchdog()
})

test('TC-PLG2-039 进程意外退出 → phase=error，且 clearTimer 不留悬挂定时器', async () => {
  const { sup, clock, procs } = makeSupervisor((m) =>
    m === 'host/tool-call' ? 'silent' : okBehave(),
  )
  await sup.activate(activateInput('crash'))
  const p = sup.callTool('crash', 'x', {})
  void p.catch(() => {})
  await drain(4)
  assert.ok(clock.pending() > 0, '在途调用应挂着超时定时器')
  procs[0]!.emit('exit', 9) // 模拟崩溃
  await drain(4)
  assert.equal(sup.isActive('crash'), false)
  assert.equal(clock.pending(), 0, '在途请求的定时器必须被清掉（否则泄漏）')
  await assert.rejects(() => p, (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_HOST_DEAD)
})

test('TC-PLG2-040 未捕获异常：第 1 次保留进程（给一次重试），第 2 次判死', async () => {
  const { sup, procs } = makeSupervisor(okBehave)
  await sup.activate(activateInput('flaky'))
  procs[0]!.hostSends({ kind: 'notify', method: 'host/error', params: { code: 'E_INTERNAL', message: '第一次炸' } })
  await drain(2)
  assert.equal(procs[0]!.killed, false, '第一次异常保留进程（§6.4：给一次重试机会）')
  // ★ phase 是**健康度**、activatedOnce 是**事实**，两者必须分开：
  //   一次瞬时异常不能让用户的面板凭空消失，也不能让 callTool 永久失效。
  assert.equal(sup.statusOf('flaky')?.phase, 'error', '健康度如实报 error')
  assert.equal(sup.isActive('flaky'), true, '装载事实仍为「已激活」——插槽/工具不该因瞬时异常被撤')
  assert.match(String(sup.statusOf('flaky')?.lastError), /第一次炸/)

  // 一次成功调用即清零「连续错误」（口径是「连续」）
  await sup.callTool('flaky', 'ping', {})
  assert.equal(sup.statusOf('flaky')?.phase, 'active', '成功调用后健康度复位')

  procs[0]!.hostSends({ kind: 'notify', method: 'host/error', params: { code: 'E_INTERNAL', message: '第二次炸' } })
  await drain(2)
  assert.equal(sup.statusOf('flaky')?.phase, 'error')
  procs[0]!.hostSends({ kind: 'notify', method: 'host/error', params: { code: 'E_INTERNAL', message: '第三次炸' } })
  await drain(2)
  assert.equal(procs[0]!.killed, true, '连续 2 次异常即判死')
})

test('TC-PLG2-041 dispose 幂等：重复调用不重复杀、不抛', async () => {
  const { sup, procs } = makeSupervisor(okBehave)
  await sup.activate(activateInput('d'))
  await sup.dispose('d')
  await sup.dispose('d')
  await sup.dispose('never-existed')
  assert.equal(procs[0]!.killed, true)
  assert.equal(sup.liveCount(), 0)
})

test('TC-PLG2-042 dispose 时插件不响应 → 3s 后仍要杀掉（退出流程不能被拖住）', async () => {
  const { sup, clock, procs } = makeSupervisor((m) => (m === 'host/dispose' ? 'silent' : okBehave()))
  await sup.activate(activateInput('stubborn'))
  const p = sup.dispose('stubborn')
  await drain(4)
  await clock.advance(3_100)
  await p
  assert.equal(procs[0]!.killed, true)
})

test('TC-PLG2-043 空闲回收：超时未用即销毁，可被再次激活（重建）', async () => {
  const { sup, clock, procs } = makeSupervisor(okBehave, { timeouts: { idleRecycleMs: 10_000 } })
  await sup.activate(activateInput('idle'))
  await clock.advance(9_000)
  assert.deepEqual(await sup.sweepIdle(), [], '未到回收期不动它')
  await clock.advance(2_000)
  assert.deepEqual(await sup.sweepIdle(), ['idle'])
  assert.equal(procs[0]!.killed, true)
  await sup.activate(activateInput('idle'))
  assert.equal(procs.length, 2, '回收后再次激活必须重建进程')
})

test('TC-PLG2-044 空闲回收不动「有在途调用」的会话', async () => {
  const { sup, clock } = makeSupervisor((m) => (m === 'host/tool-call' ? 'silent' : okBehave()), {
    timeouts: { idleRecycleMs: 1_000, toolCallMs: 60_000 },
  })
  await sup.activate(activateInput('busy2'))
  const p = sup.callTool('busy2', 'slow', {})
  void p.catch(() => {})
  await drain(4)
  await clock.advance(5_000)
  assert.deepEqual(await sup.sweepIdle(), [], '在途调用的会话不得被回收')
})

test('TC-PLG2-045 反向能力调用经 handleInvoke 转发；未配网关则**默认拒绝**', async () => {
  const { sup, procs } = makeSupervisor(okBehave) // 刻意**不配** handleInvoke
  await sup.activate(activateInput('nocap'))
  const replies: WireMessage[] = []
  procs[0]!.on('message', (...a: unknown[]) => replies.push(a[0] as WireMessage))
  procs[0]!.hostSends({ kind: 'invoke', id: 77, cap: 'fs.read', params: { rel: 'a.txt' } })
  await drain(4)
  const reply = replies.find((m) => m.kind === 'reply' && m.id === 77)
  assert.ok(reply && reply.kind === 'reply')
  assert.equal(reply.ok, false)
  assert.equal(reply.error?.code, RPC_ERROR.E_PERMISSION_DENIED)
})

test('TC-PLG2-046 handleInvoke 正常时把结果回给 Host 半', async () => {
  const clock = makeClock()
  const procs: FakeHostProcess[] = []
  const sup = new PluginSupervisor({
    entryPath: '/tmp/plugin-host.js',
    spawn: () => {
      const p = new FakeHostProcess(okBehave)
      procs.push(p)
      return p
    },
    handleInvoke: async (id, cap, params) => ({ id, cap, params }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  await sup.activate(activateInput('cap'))
  const replies: WireMessage[] = []
  procs[0]!.on('message', (...a: unknown[]) => replies.push(a[0] as WireMessage))
  procs[0]!.hostSends({ kind: 'invoke', id: 5, cap: 'workspace.root', params: {} })
  await drain(6)
  const reply = replies.find((m) => m.kind === 'reply' && m.id === 5)
  assert.ok(reply && reply.kind === 'reply')
  assert.equal(reply.ok, true)
  assert.deepEqual(reply.result, { id: 'cap', cap: 'workspace.root', params: {} })
})

test('TC-PLG2-047 emit 在未激活时返回 0 且不抛（事件是尽力而为）', async () => {
  const { sup } = makeSupervisor(okBehave)
  assert.equal(await sup.emit('nobody', 'workspace:changed', {}), 0)
})

test('TC-PLG2-048 onPhaseChange 广播完整的运行期状态（诊断页的唯一数据源）', async () => {
  const seen: PluginRuntimeStatus[] = []
  const clock = makeClock()
  const sup = new PluginSupervisor({
    entryPath: '/tmp/plugin-host.js',
    spawn: () => new FakeHostProcess(okBehave),
    onPhaseChange: (s) => seen.push(s),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  await sup.activate(activateInput('diag'))
  assert.deepEqual(
    seen.map((s) => s.phase),
    ['activating', 'active'],
  )
  assert.deepEqual(seen[1]!.permissions, [])
  assert.equal(seen[1]!.hostPid, 4242)
})

test('TC-PLG2-049 killAll：同步收尾全部进程（应用退出路径不能用 await）', async () => {
  const { sup, procs } = makeSupervisor(okBehave)
  await sup.activate(activateInput('x1'))
  await sup.activate(activateInput('x2'))
  assert.equal(procs.length, 2)
  sup.killAll()
  assert.ok(procs.every((p) => p.killed))
  assert.equal(sup.liveCount(), 0)
})

test('TC-PLG2-050 激活失败后允许重试（作者改完插件点「重载」不该需要重启应用）', async () => {
  let fail = true
  const { sup, procs } = makeSupervisor((m) =>
    m === 'host/activate' && fail
      ? { ok: false, error: { code: 'E_ACTIVATION_FAILED', message: '第一次不行' } }
      : okBehave(),
  )
  const st1 = await sup.activate(activateInput('retry'))
  assert.equal(st1.phase, 'activation-failed')
  fail = false
  const st2 = await sup.activate(activateInput('retry'))
  assert.equal(st2.phase, 'active')
  assert.equal(procs.length, 2, '重试必须起新进程（旧进程已回收）')
})

test('TC-PLG2-051 日志上行按 level 分流（一条日志不该把调用链卡住）', async () => {
  const { sup, procs } = makeSupervisor(okBehave)
  await sup.activate(activateInput('log'))
  // 不抛即可；这里断言的是「上行日志不会反向要求应答」
  procs[0]!.hostSends({ kind: 'notify', method: 'host/log', params: { level: 'warn', msg: 'hello' } })
  await drain(2)
  assert.equal(sup.isActive('log'), true)
})

/* ============================================================
 * 五、★ D79：撤销窗口内的「迟到注册」竞态
 *
 * 实测暴露：`ctx.ark.tools.register()` 是异步的（经网关上行），作者完全可以
 * **不 await** 它 —— 于是 apply 抛错 / host/dispose 时，注销已经跑完，
 * 而那条 pending 的注册才姗姗落地，在账本上**追加一条新记录**：
 * 「撤销后账本非空」→ 纪律⑬的对称性断言失效，且留下一个幽灵工具。
 * ============================================================ */

test('TC-PLG2-060 ★ 不 await 的注册 + apply 抛错 → 迟到的注册必须自我了断', async () => {
  const pair = makeLinkedEndpoints()
  const host = createHostRuntime({
    endpoint: pair.b,
    loadModule: async () => ({
      apply: (ctx: unknown) => {
        const c = ctx as {
          ark: { tools: { register: (d: unknown) => Promise<unknown> } }
          effect: (f: () => void) => void
        }
        c.effect(() => {})
        // **故意不 await** —— 作者完全可能这样写，而这条注册会在撤销之后才落地
        void c.ark.tools.register({
          name: 'late_tool',
          description: '迟到的注册',
          inputSchema: { type: 'object' },
          handler: () => ({}),
        })
        throw new Error('炸在注册落地之前')
      },
    }),
  })
  const main = createFakeMain(pair.a)
  await main.rpc('host/prepare', {
    pluginId: 'test.late',
    dir: FIXTURES,
    manifest: manifestOf({ id: 'test.late', main: 'main.js' }),
    permissions: [],
  })
  const r = await main.rpc('host/activate')
  assert.equal(r.ok, false)
  assert.equal(r.error?.code, 'E_ACTIVATION_FAILED')
  await drain(8) // 让那条 pending 的注册真的落地
  const st = host.state()
  assert.equal(st.effects, 0, '迟到的注册不得进账本 —— 否则「撤销后账本非空」，撤销白做')
  assert.deepEqual(st.registeredTools, [], '迟到的工具不得留在内存表里')
  assert.ok(
    main.invokes.filter((i) => i.cap === 'tools.unregister').length >= 1,
    '迟到的注册必须当场反向撤销（与装载路径对称）',
  )
})

test('TC-PLG2-061 dispose 期间落地的注册同样自我了断（正常卸载路径）', async () => {
  const pair = makeLinkedEndpoints()
  const host = createHostRuntime({
    endpoint: pair.b,
    loadModule: async () => ({
      apply: (ctx: unknown) => {
        const c = ctx as {
          ark: { tools: { register: (d: unknown) => Promise<unknown> } }
          effect: (f: () => void) => void
        }
        c.effect(() => {})
        // 造一条「在一次 effect 撤销之后才落地」的注册
        c.effect(() => {
          void c.ark.tools.register({
            name: 'during_dispose',
            description: '拆解期间落地',
            inputSchema: { type: 'object' },
            handler: () => ({}),
          })
        })
      },
    }),
  })
  const main = createFakeMain(pair.a)
  await main.rpc('host/prepare', {
    pluginId: 'test.during',
    dir: FIXTURES,
    manifest: manifestOf({ id: 'test.during', main: 'main.js' }),
    permissions: [],
  })
  await main.rpc('host/activate')
  await main.rpc('host/dispose')
  await drain(8)
  assert.equal(host.state().effects, 0)
  assert.deepEqual(host.state().registeredTools, [])
})
