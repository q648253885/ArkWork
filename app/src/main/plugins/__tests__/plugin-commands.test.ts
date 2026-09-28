/* ============================================================
 * ArkWork — 插件命令贡献点用例库（v0.36.0 · B2 / F3.3）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.4
 *
 * 两层各测各的：
 *  ① Supervisor.runCommand —— 命令投递的**传输语义**（E_HOST_DEAD /
 *     E_NOT_FOUND / 事件名形状 / 报文载荷）。沿用 plugin-runtime.test 的
 *     「注入假进程 + 注入时钟」手法 —— 真实进程只能测「跑得起来」，
 *     测不了「投递失败时到底谁该报什么错」。
 *  ② registry —— 命令槽登记（`plugin-command:<pluginId>:<cmdId>`，ui.action，
 *     与插件 kind 无关）与 declaredPluginCommands（QuickAction 数据源：
 *     只含启用且合法的插件，禁用即消失）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-commands
 * ============================================================ */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RPC_ERROR, RpcError, type WireMessage } from '../runtime/wire.js'
import { PluginSupervisor, type HostProcessHandle } from '../runtime/supervisor.js'
import {
  declaredPluginCommands,
  invalidatePlugins,
  pluginContributions,
  setHostVersion,
} from '../registry.js'
// InstalledPlugin 的真源在 shared/types（v0.36.0 起 registry 不再转出口 —— 原来从
// '../registry.js' 取类型属于「借道出口」，registry 调整导出面即断，属隐式耦合）
import type { InstalledPlugin } from '@shared/types/plugin'
import { pluginsDir, __setDocForTest } from '../store.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ============================================================
 * 假 Host 半进程（与 plugin-runtime.test 同款手法，按需精简）
 * ============================================================ */

type BehaviourResult = { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } } | 'silent'

class FakeHostProcess implements HostProcessHandle {
  readonly pid = 4242
  killed = false
  received: WireMessage[] = []
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()

  constructor(private readonly behave: (method: string, params: unknown) => BehaviourResult) {}

  postMessage(msg: unknown): void {
    const m = msg as WireMessage & { method?: string; id?: number; params?: unknown }
    this.received.push(m as WireMessage)
    if (m.kind !== 'rpc') return
    const r = this.behave(String(m.method ?? ''), m.params)
    if (r === 'silent') return
    Promise.resolve().then(() => {
      this.emit('message', {
        kind: 'reply',
        id: m.id,
        ok: r.ok,
        result: r.ok ? r.result : undefined,
        error: r.ok ? undefined : r.error,
      })
    })
  }

  on(event: 'message' | 'exit' | 'error', listener: (...a: unknown[]) => void): void {
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
}

/** 手动时钟：本组用例不压超时，只需让 now / setTimer / clearTimer 可注入 */
function makeClock() {
  let now = 1_000_000
  const timers = new Map<number, () => void>()
  let nextId = 1
  return {
    now: () => now,
    setTimer: (fn: () => void, _ms: number) => {
      const id = nextId
      nextId += 1
      timers.set(id, fn)
      return id
    },
    // 宿主注入的 clearTimer 接的是「任意句柄」（TimerHandle 由宿主定义，见 supervisor 契约）：
    // 这里按 number 存表，签名放宽到 unknown 以匹配注入点（收窄会让类型层面拒绝该实现）
    clearTimer: (h: unknown) => void timers.delete(h as number),
  }
}

const okBehave = (): BehaviourResult => ({ ok: true, result: { activated: true } })

const manifestOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: '1.1',
  id: 'test.cmd',
  name: 'Test Cmd',
  version: '1.0.0',
  kind: 'action',
  main: 'main.js',
  ...over,
})

const activateInput = (id: string) => ({
  id,
  dir: HERE,
  manifest: manifestOf({ id, main: 'main.js' }),
  permissions: [],
})

function makeSupervisor(
  behave: (method: string, params: unknown) => BehaviourResult,
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
  })
  return { sup, clock, procs }
}

/* ============================================================
 * ① Supervisor.runCommand —— 命令投递语义
 * ============================================================ */

test('TC-PC-001 runCommand 成功：事件名 = command:<id>，载荷 = { commandId }，正常返回', async () => {
  const { sup, procs } = makeSupervisor((m) => {
    if (m === 'host/emit') return { ok: true, result: { delivered: 1 } }
    return okBehave()
  })
  await sup.activate(activateInput('a.b'))
  await sup.runCommand('a.b', 'hello')
  const emit = procs[0]!.received.find((m) => (m as { method?: string }).method === 'host/emit') as
    | { params?: { event?: string; payload?: unknown } }
    | undefined
  assert.ok(emit, '必须向 Host 半发 host/emit')
  assert.equal(emit.params?.event, 'command:hello')
  assert.deepEqual(emit.params?.payload, { commandId: 'hello' })
})

test('TC-PC-002 未激活的插件 runCommand → E_HOST_DEAD，且不 spawn 任何进程', async () => {
  const { sup, procs } = makeSupervisor(okBehave)
  await assert.rejects(
    () => sup.runCommand('never.activated', 'hello'),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, RPC_ERROR.E_HOST_DEAD)
      return true
    },
  )
  assert.equal(procs.length, 0, '命令投递不得懒激活之外再起进程')
})

test('TC-PC-003 delivered=0（插件没监听）→ E_NOT_FOUND，报错文案要能区分「没监听」与「成功无效果」', async () => {
  const { sup } = makeSupervisor((m) => {
    if (m === 'host/emit') return { ok: true, result: { delivered: 0 } }
    return okBehave()
  })
  await sup.activate(activateInput('a.b'))
  await assert.rejects(
    () => sup.runCommand('a.b', 'nobody-listens'),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, RPC_ERROR.E_NOT_FOUND)
      assert.match(err.message, /未监听/)
      return true
    },
  )
})

test('TC-PC-004 Host 半应答错误 → 错误码原样透传（不吞成 success / 不改判）', async () => {
  const { sup } = makeSupervisor((m) => {
    if (m === 'host/emit') return { ok: false, error: { code: RPC_ERROR.E_INTERNAL, message: 'handler exploded' } }
    return okBehave()
  })
  await sup.activate(activateInput('a.b'))
  await assert.rejects(
    () => sup.runCommand('a.b', 'boom'),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, RPC_ERROR.E_INTERNAL)
      return true
    },
  )
})

/* ============================================================
 * ② registry —— 命令槽登记 + declaredPluginCommands
 * ============================================================ */

const enabledPlugin = (id: string, commands: Array<{ id: string; title: string }>): InstalledPlugin =>
  ({
    dir: '/tmp/unused',
    source: 'global',
    enabled: true,
    invalidReason: undefined,
    manifest: manifestOf({ id, provides: { commands, action: { actionId: 'x', label: 'x' } } }),
  }) as unknown as InstalledPlugin

test('TC-PC-005 命令槽登记：id = plugin-command:<pluginId>:<cmdId>，kind = ui.action，与插件 kind 无关', () => {
  const p = enabledPlugin('test.hello', [{ id: 'hello', title: '打个招呼' }])
  const entries = pluginContributions([p])
  const cmd = entries.find((e) => e.id === 'plugin-command:test.hello:hello')
  assert.ok(cmd, '声明的命令必须产出插槽条目')
  assert.equal(cmd!.kind, 'ui.action')
  assert.ok(cmd!.label.includes('打个招呼'), '条目 label 应带命令 title（用户可见）')
})

test('TC-PC-006 禁用 / 校验失败的插件不得登记命令槽', () => {
  const disabled = { ...enabledPlugin('test.off', [{ id: 'c', title: 'C' }]), enabled: false } as InstalledPlugin
  const invalid = {
    ...enabledPlugin('test.bad', [{ id: 'c', title: 'C' }]),
    invalidReason: 'VP1 $.id: bad',
  } as InstalledPlugin
  const entries = pluginContributions([disabled, invalid])
  assert.equal(entries.filter((e) => e.id.startsWith('plugin-command:')).length, 0)
})

test('TC-PC-007 declaredPluginCommands 只含启用且合法的插件；禁用即从 QuickAction 数据源消失', async () => {
  setHostVersion('0.36.0')
  __setDocForTest('global', { schemaVersion: '1.1', enabled: {}, order: {}, updatedAt: 0 })
  __setDocForTest('workspace', { schemaVersion: '1.1', enabled: {}, order: {}, updatedAt: 0 })

  const gdir = pluginsDir('global')
  const make = (dirName: string, id: string, enabledByDefault: boolean) => {
    const d = join(gdir, dirName)
    mkdirSync(d, { recursive: true })
    writeFileSync(
      join(d, 'plugin.json'),
      JSON.stringify({
        schemaVersion: '1.1',
        id,
        name: dirName,
        version: '1.0.0',
        kind: 'action',
        main: 'main.js',
        enabledByDefault,
        provides: {
          action: { actionId: 'x', label: 'x' },
          commands: [{ id: 'hi', title: 'Hi' }],
        },
        permissions: [],
      }),
    )
    writeFileSync(join(d, 'main.js'), 'module.exports = { apply() {} }\n')
  }
  // 自清 + 兜底清（共享 userData 目录可能残留早前跑挂的坏目录）
  for (const junk of ['on', 'off', 'test.cmd.on', 'test.cmd.off']) {
    rmSync(join(gdir, junk), { recursive: true, force: true })
  }
  // 目录名约定 = 完整 id（registry 扫描规则：dirName === manifest.id）
  make('test.cmd.on', 'test.cmd.on', true)
  make('test.cmd.off', 'test.cmd.off', false)
  try {
    invalidatePlugins()
    const cmds = await declaredPluginCommands()
    const mine = cmds.filter((c) => c.pluginId.startsWith('test.cmd.'))
    assert.deepEqual(
      mine.map((c) => c.pluginId),
      ['test.cmd.on'],
      '只有启用插件进 QuickAction 数据源',
    )
    assert.equal(mine[0]!.command.id, 'hi')
    assert.equal(mine[0]!.command.title, 'Hi')
    assert.equal(mine[0]!.pluginName, 'test.cmd.on')
  } finally {
    rmSync(join(gdir, 'test.cmd.on'), { recursive: true, force: true })
    rmSync(join(gdir, 'test.cmd.off'), { recursive: true, force: true })
    invalidatePlugins()
  }
})

beforeEach(() => {
  // 宿主版本影响 VP8 engines 判定（默认 '0.0.0' 会把任何带 engines 的插件判死）
  setHostVersion('0.36.0')
})
