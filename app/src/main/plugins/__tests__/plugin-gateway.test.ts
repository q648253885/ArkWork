/* ============================================================
 * ArkWork — 插件能力网关用例库（v0.35.0 · B5 / M8）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §5.1 · §9（安全）
 *
 * 网关是**唯一的安全收口点**，因此这套用例的重心不是「功能能跑」，
 * 而是**「不该给的绝不给」**：
 *  · 权限表与能力表的**结构对等**（新增能力忘了配权限 = 静默越权，必须机器拦）；
 *  · 默认拒绝（没声明就没得用）；
 *  · 撤销类能力**不受权限约束**（否则收紧权限会制造残留）；
 *  · 「声明 ∩ 注册」双查（工具/视图必须先在清单里出现）。
 * ============================================================ */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CAP_PERMISSION,
  PluginGateway,
  checkCapPermission,
  isKnownCap,
  permissionForCap,
  type PluginGatewayDeps,
} from '../runtime/gateway.js'
import { ARK_CAPS, RPC_ERROR, RpcError } from '../runtime/wire.js'
import { parsePluginManifest } from '@shared/utils/plugin-manifest'
import type { PluginManifest, PluginPermission } from '@shared/types/plugin'

/* ============================================================
 * 夹具
 * ============================================================ */

const manifestOf = (raw: Record<string, unknown>): PluginManifest => {
  const r = parsePluginManifest(raw)
  assert.ok(r.manifest, `夹具清单必须合法：${JSON.stringify(r.issues)}`)
  return r.manifest!
}

const DECLARED = manifestOf({
  schemaVersion: '1.1',
  id: 'test.cap',
  name: '能力夹具',
  version: '1.0.0',
  kind: 'panel',
  // VP7：声明了 provides.tools 就必须有 Host 半入口（工具得有地方执行）
  main: 'main.js',
  provides: {
    panels: [{ panelRef: 'panel:cap', title: '能力', component: 'DataTable', data: { kind: 'static', rows: [] } }],
    views: [{ viewRef: 'view:cap', title: '能力视图', renderer: 'renderer.js', placement: 'dock' }],
    tools: [{ name: 'cap_echo', description: '回显', inputSchema: { type: 'object' } }],
  },
})

interface Calls {
  read: string[]
  write: Array<{ abs: string; text: string }>
  list: string[]
  fetch: string[]
  shell: string[]
  events: string[]
}

function makeDeps(
  over: Partial<PluginGatewayDeps> & { permissions?: PluginPermission[] } = {},
): { deps: PluginGatewayDeps; calls: Calls } {
  const calls: Calls = { read: [], write: [], list: [], fetch: [], shell: [], events: [] }
  const permissions = over.permissions ?? []
  const deps: PluginGatewayDeps = {
    permissionsOf: () => permissions,
    manifestOf: () => DECLARED,
    workspaceRoot: () => '/tmp/ws',
    readText: async (abs) => {
      calls.read.push(abs)
      return { text: `内容:${abs}` }
    },
    writeText: async (abs, text) => {
      calls.write.push({ abs, text })
      return { path: abs, revision: 'r1' }
    },
    listDir: async (abs) => {
      calls.list.push(abs)
      return [{ name: 'a.txt', type: 'file', size: 3 }]
    },
    fetch: async (input) => {
      calls.fetch.push(input)
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":1}' }
    },
    runShell: async (cmd, args) => {
      calls.shell.push([cmd, ...args].join(' '))
      return { code: 0, stdout: 'done', stderr: '' }
    },
    storage: {
      get: async () => ({ stored: true }),
      set: async () => {},
      delete: async () => {},
    },
    registerTool: async (pluginId, def) => ({
      regId: 7,
      pluginId,
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      globalName: `plugin__test.cap__${def.name}`,
    }),
    unregisterTool: async () => {},
    registerView: async () => ({ regId: 8 }),
    unregisterView: async () => {},
    registerPanel: async () => ({ regId: 9 }),
    unregisterPanel: async () => {},
    postToClient: () => true,
    resolveInWorkspace: async (rel) => {
      if (rel.includes('..')) {
        const e = new Error(`越界：${rel}`) as Error & { code?: string }
        e.code = 'E_PATH_OUTSIDE_WORKSPACE'
        throw e
      }
      return `/tmp/ws/${rel}`
    },
    ...over,
  }
  return { deps, calls }
}

/* ============================================================
 * 一、权限表的结构对等（防「新增能力忘了配权限」）
 * ============================================================ */

test('TC-PLG3-001 ★ 能力表与权限表必须**逐项对等**（漏配权限 = 静默越权）', () => {
  const caps = new Set<string>(ARK_CAPS as readonly string[])
  const mapped = new Set(Object.keys(CAP_PERMISSION))
  const missing = [...caps].filter((c) => !mapped.has(c))
  const extra = [...mapped].filter((c) => !caps.has(c))
  assert.deepEqual(missing, [], `这些能力没有权限登记（会变成无条件放行）：${missing.join(', ')}`)
  assert.deepEqual(extra, [], `权限表里有已不存在的能力：${extra.join(', ')}`)
})

test('TC-PLG3-002 需要权限的能力必须显式登记；无副作用能力显式登记为 null', () => {
  // 「null」不是「忘了填」而是「刻意的无权限」—— 这条用例把两者区分开
  assert.equal(permissionForCap('fs.read'), 'fs:workspace-read')
  assert.equal(permissionForCap('fs.write'), 'fs:workspace-write')
  assert.equal(permissionForCap('net.fetch'), 'net')
  assert.equal(permissionForCap('shell.run'), 'shell')
  assert.equal(permissionForCap('tools.register'), 'tools.register')
  assert.equal(permissionForCap('views.register'), 'views.register')
  assert.equal(permissionForCap('storage.set'), 'storage')

  assert.equal(permissionForCap('log'), null)
  assert.equal(permissionForCap('workspace.root'), null)
  // ★ 撤销类一律 null：收紧权限不该把插件卡在卸载路上
  assert.equal(permissionForCap('tools.unregister'), null)
  assert.equal(permissionForCap('views.unregister'), null)
  assert.equal(permissionForCap('panels.unregister'), null)
})

test('TC-PLG3-003 checkCapPermission：默认拒绝 + 撤销例外', () => {
  assert.equal(checkCapPermission('fs.read', []).ok, false)
  assert.equal(checkCapPermission('fs.read', ['fs:workspace-read']).ok, true)
  assert.equal(checkCapPermission('fs.read', ['net']).ok, false, '别的权限不能顶替')
  assert.equal(checkCapPermission('tools.unregister', []).ok, true, '撤销不需要权限')
  assert.equal(checkCapPermission('nonsense', []).ok, true, '未知能力的判定交给 handleInvoke')
  assert.equal(isKnownCap('fs.read'), true)
  assert.equal(isKnownCap('nope'), false)
})

/* ============================================================
 * 二、默认拒绝（端到端走 handleInvoke）
 * ============================================================ */

test('TC-PLG3-010 零权限插件调 fs.read → E_PERMISSION_DENIED，且**没有真的读文件**', async () => {
  const { deps, calls } = makeDeps({ permissions: [] })
  const gw = new PluginGateway(deps)
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'fs.read', { rel: 'a.txt' }),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, RPC_ERROR.E_PERMISSION_DENIED)
      assert.equal(err.data?.need, 'fs:workspace-read')
      return true
    },
  )
  assert.deepEqual(calls.read, [], '被拒的能力不得产生任何副作用（拒绝必须在实现之前）')
})

test('TC-PLG3-011 声明了权限才放行；读到的内容原样回给插件', async () => {
  const { deps, calls } = makeDeps({ permissions: ['fs:workspace-read'] })
  const gw = new PluginGateway(deps)
  const r = (await gw.handleInvoke('test.cap', 'fs.read', { rel: 'a.txt' })) as { text: string }
  assert.equal(r.text, '内容:/tmp/ws/a.txt')
  assert.deepEqual(calls.read, ['/tmp/ws/a.txt'])
})

test('TC-PLG3-012 未知能力 → E_NOT_FOUND（不装作成功，也不静默忽略）', async () => {
  const { deps } = makeDeps({ permissions: ['net', 'shell', 'storage'] })
  const gw = new PluginGateway(deps)
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'fs.deleteEverything', {}),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_NOT_FOUND,
  )
})

test('TC-PLG3-013 未打开工作区时 workspace.root → E_NO_WORKSPACE（明确说明而不是回空串）', async () => {
  const { deps } = makeDeps({ workspaceRoot: () => undefined })
  const gw = new PluginGateway(deps)
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'workspace.root', {}),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_NO_WORKSPACE,
  )
})

test('TC-PLG3-014 路径越界 → E_PATH_OUTSIDE_WORKSPACE 原码透传（插件能按码分支）', async () => {
  const { deps } = makeDeps({ permissions: ['fs:workspace-read'] })
  const gw = new PluginGateway(deps)
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'fs.read', { rel: '../../etc/passwd' }),
    (err: unknown) => err instanceof RpcError && err.code === 'E_PATH_OUTSIDE_WORKSPACE',
  )
})

/* ============================================================
 * 三、撤销类能力不受权限约束（否则「降权」会制造残留）
 * ============================================================ */

test('TC-PLG3-020 ★ 零权限插件仍可 unregister（卸载路径不得被权限卡住）', async () => {
  const { deps } = makeDeps({ permissions: [] })
  const gw = new PluginGateway(deps)
  assert.deepEqual(await gw.handleInvoke('test.cap', 'tools.unregister', { regId: 7, name: 'cap_echo' }), { ok: true })
  assert.deepEqual(await gw.handleInvoke('test.cap', 'views.unregister', { regId: 8, viewRef: 'view:cap' }), { ok: true })
  assert.deepEqual(await gw.handleInvoke('test.cap', 'panels.unregister', { regId: 9, panelRef: 'panel:cap' }), {
    ok: true,
  })
})

/* ============================================================
 * 四、「声明 ∩ 注册」双查
 * ============================================================ */

test('TC-PLG3-030 注册未在 provides.tools 声明的工具 → E_TOOL_UNDECLARED + 给改法', async () => {
  const { deps } = makeDeps({ permissions: ['tools.register'] })
  const gw = new PluginGateway(deps)
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'tools.register', { name: 'surprise', description: 'x', inputSchema: {} }),
    (err: unknown) => {
      assert.ok(err instanceof RpcError)
      assert.equal(err.code, RPC_ERROR.E_TOOL_UNDECLARED)
      assert.match(String(err.data?.fix ?? ''), /provides\.tools/)
      return true
    },
  )
})

test('TC-PLG3-031 注册已声明的工具 → 成功，且回**全局唯一名**（防与 skill 撞名）', async () => {
  const { deps } = makeDeps({ permissions: ['tools.register'] })
  const gw = new PluginGateway(deps)
  const r = (await gw.handleInvoke('test.cap', 'tools.register', {
    name: 'cap_echo',
    description: '回显',
    inputSchema: { type: 'object' },
  })) as { regId: number; globalName: string }
  assert.equal(r.regId, 7)
  assert.equal(r.globalName, 'plugin__test.cap__cap_echo')
})

test('TC-PLG3-032 注册未在 provides.views 声明的视图 → E_VIEW_UNDECLARED', async () => {
  const { deps } = makeDeps({ permissions: ['views.register'] })
  const gw = new PluginGateway(deps)
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'views.register', { viewRef: 'view:ghost', placement: 'dock' }),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_VIEW_UNDECLARED,
  )
})

test('TC-PLG3-033 声明过的视图可注册', async () => {
  const { deps } = makeDeps({ permissions: ['views.register'] })
  const gw = new PluginGateway(deps)
  const r = (await gw.handleInvoke('test.cap', 'views.register', {
    viewRef: 'view:cap',
    placement: 'float',
  })) as { regId: number }
  assert.equal(r.regId, 8)
})

/* ============================================================
 * 五、具体能力的边界
 * ============================================================ */

test('TC-PLG3-040 net.fetch 只放行 http/https（file:// 与自定义协议一律拒）', async () => {
  const { deps, calls } = makeDeps({ permissions: ['net'] })
  const gw = new PluginGateway(deps)
  for (const bad of ['file:///etc/passwd', 'arkwork-plugin://x/y', 'ftp://a/b', 'data:text/plain,hi']) {
    await assert.rejects(
      () => gw.handleInvoke('test.cap', 'net.fetch', { url: bad }),
      (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_PERMISSION_DENIED,
      `应拒绝 ${bad}`,
    )
  }
  assert.deepEqual(calls.fetch, [], '被拒的 URL 绝不能真的发出去')
  await gw.handleInvoke('test.cap', 'net.fetch', { url: 'https://example.com/a' })
  assert.deepEqual(calls.fetch, ['https://example.com/a'])
})

test('TC-PLG3-041 storage 往返与删除走网关转发（宿主侧才落盘）', async () => {
  const { deps } = makeDeps({ permissions: ['storage'] })
  const gw = new PluginGateway(deps)
  assert.deepEqual(await gw.handleInvoke('test.cap', 'storage.get', { key: 'k' }), { stored: true })
  assert.deepEqual(await gw.handleInvoke('test.cap', 'storage.set', { key: 'k', value: 1 }), { ok: true })
  assert.deepEqual(await gw.handleInvoke('test.cap', 'storage.delete', { key: 'k' }), { ok: true })
})

test('TC-PLG3-042 renderer.post 回报投递结果（没有 Client 半时如实说 0）', async () => {
  const { deps } = makeDeps({ postToClient: () => false })
  const gw = new PluginGateway(deps)
  assert.deepEqual(await gw.handleInvoke('test.cap', 'renderer.post', { payload: { a: 1 } }), { delivered: false })
})

test('TC-PLG3-043 shell.run 需要 shell 权限；拿到权限后参数按数组传（不拼字符串）', async () => {
  const denied = new PluginGateway(makeDeps({ permissions: [] }).deps)
  await assert.rejects(
    () => denied.handleInvoke('test.cap', 'shell.run', { cmd: 'ls' }),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_PERMISSION_DENIED,
  )
  const { deps, calls } = makeDeps({ permissions: ['shell'] })
  const gw = new PluginGateway(deps)
  await gw.handleInvoke('test.cap', 'shell.run', { cmd: 'ls', args: ['-la', '/tmp'] })
  assert.deepEqual(calls.shell, ['ls -la /tmp'])
})

test('TC-PLG3-044 权限是**逐项**的：给了 write 不等于给了 read', async () => {
  const { deps } = makeDeps({ permissions: ['fs:workspace-write'] })
  const gw = new PluginGateway(deps)
  await gw.handleInvoke('test.cap', 'fs.write', { rel: 'a.txt', text: 'x' })
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'fs.read', { rel: 'a.txt' }),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_PERMISSION_DENIED,
  )
})

test('TC-PLG3-045 清单缺失（插件刚被卸载）时注册类能力一律拒 —— 不靠「查不到就放行」', async () => {
  const { deps } = makeDeps({ permissions: ['tools.register'], manifestOf: () => undefined })
  const gw = new PluginGateway(deps)
  await assert.rejects(
    () => gw.handleInvoke('test.cap', 'tools.register', { name: 'cap_echo', description: 'x', inputSchema: {} }),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_TOOL_UNDECLARED,
  )
})

test('TC-PLG3-046 permissionsOf 返回 undefined（未知插件）→ 视为零权限', async () => {
  const { deps } = makeDeps({ permissions: [] })
  const gw = new PluginGateway({ ...deps, permissionsOf: () => undefined })
  await assert.rejects(
    () => gw.handleInvoke('ghost', 'fs.read', { rel: 'a.txt' }),
    (err: unknown) => err instanceof RpcError && err.code === RPC_ERROR.E_PERMISSION_DENIED,
  )
})
