/* ============================================================
 * ArkWork — 插件能力网关（v0.35.0 · M8）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §5.1 · §9（安全）
 *
 * 一句话：**Host 半伸手要东西的唯一柜台**。
 *   插件发 `{kind:'invoke', cap, params}` → 网关这里做三件事：
 *     ① **查权限**（清单声明 ∩ 白名单；默认拒绝）
 *     ② **查声明**（工具/视图必须先在 provides 里声明过，否则拒）
 *     ③ **真实现**（fs / net / shell / storage / 注册）
 *   然后把结果或一个带错误码的答复回给 Host 半。**没有第四条路**（纪律⑫）。
 *
 * 三条不可让步的规则：
 *  ① **默认拒绝**：`permissions` 缺省 = 什么都不给；不在白名单里的权限名在
 *     装载期就已经是 error（VP9），这里只管「有没有声明」。
 *  ② **撤销不需要权限**：`*.unregister` 一律放行。否则「用户关掉 net 权限后
 *     插件卸载卡在权限检查」——把权限收紧变成制造残留，方向是反的。
 *  ③ **路径永远经工作区断言**：插件给的相对路径只是**提示**，落盘前必须过
 *     `assertInWorkspace`（复用既有守卫，不另写一套）。realpath 挡 symlink 逃逸。
 *
 * 依赖全注入（IP1）：fs / fetch / shell / 存储 / 注册表都由调用方传入，
 * 于是「权限判定」这块最容易写错又最难端到端验证的逻辑可以纯函数式测。
 * ============================================================ */
import { RpcError, RPC_ERROR } from './wire.js'
import type { ArkCap } from './wire.js'
import type { PluginManifest, PluginPermission } from '@shared/types/plugin'

/* ============================================================
 * 能力 → 权限 的映射（唯一真源）
 * ============================================================ */
export const CAP_PERMISSION: Record<string, PluginPermission | null> = {
  log: null,
  'workspace.root': null, // 只回一个路径字符串，不改任何状态
  'fs.read': 'fs:workspace-read',
  'fs.list': 'fs:workspace-read',
  'fs.write': 'fs:workspace-write',
  'net.fetch': 'net',
  'shell.run': 'shell',
  'tools.register': 'tools.register',
  'tools.unregister': null, // ★ 规则②：撤销永远放行
  'views.register': 'views.register',
  'views.unregister': null,
  'panels.register': 'panels.register',
  'panels.unregister': null,
  // ★ 只有 `storage.get/set/delete` 三个具体能力；**不要**再加一个笼统的
  //   `storage` —— TC-PLG3-001 会当场把这种「表里有、能力表里没有」的项揪出来。
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'renderer.post': null, // 只往自己插件的 Client 半推消息，不触达宿主
}

/** 该能力需要的权限（null = 不需要） */
export function permissionForCap(cap: string): PluginPermission | null {
  if (!(cap in CAP_PERMISSION)) return null
  return CAP_PERMISSION[cap] ?? null
}

/** 能力名是否已知（未知 = 编程错误/版本不匹配，要明确报而不是静默拒绝） */
export function isKnownCap(cap: string): boolean {
  return cap in CAP_PERMISSION
}

/**
 * 权限判定（纯函数，本文件的**核心不变量**）。
 * @returns null = 放行；否则返回人话拒绝原因
 */
export function checkCapPermission(
  cap: string,
  granted: readonly string[],
): { ok: true } | { ok: false; need: PluginPermission; message: string } {
  const need = permissionForCap(cap)
  if (need === null) return { ok: true }
  if (granted.includes(need)) return { ok: true }
  return {
    ok: false,
    need,
    message: `插件未声明权限「${need}」，无法使用能力「${cap}」`,
  }
}

/* ============================================================
 * 网关依赖（全部注入）
 * ============================================================ */
export interface DirEntry {
  name: string
  type: 'file' | 'dir'
  size?: number
}

export interface RegisteredTool {
  regId: number
  pluginId: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** 全局唯一名（`plugin__<ns>__<name>`，供 assembleTools 用） */
  globalName: string
}

export interface PluginGatewayDeps {
  /** 该插件**实际生效**的权限（清单 ∩ 白名单，由 registry 算好） */
  permissionsOf(pluginId: string): readonly PluginPermission[] | undefined
  /** 该插件的清单（判「有没有在 provides 里声明」） */
  manifestOf(pluginId: string): PluginManifest | undefined
  /** 当前工作区根；未打开工作区返回 undefined */
  workspaceRoot(): string | undefined
  /** 读/写/列（实现方负责路径断言；网关只传绝对路径） */
  readText(abs: string): Promise<{ text: string; encoding?: string; eol?: string }>
  writeText(abs: string, text: string): Promise<{ path: string; revision?: string }>
  listDir(abs: string): Promise<DirEntry[]>
  /** 主进程代发 HTTP（规避 CORS）；实现方用自己的栈（net.fetch / 全局 fetch） */
  fetch(input: string, init?: Record<string, unknown>): Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }>
  runShell(
    cmd: string,
    args: string[],
    opts: unknown,
  ): Promise<{ code: number; stdout: string; stderr: string }>
  storage: {
    get(pluginId: string, key: string): Promise<unknown>
    set(pluginId: string, key: string, value: unknown): Promise<void>
    delete(pluginId: string, key: string): Promise<void>
  }
  registerTool(
    pluginId: string,
    def: { name: string; description: string; inputSchema: Record<string, unknown> },
  ): Promise<RegisteredTool>
  unregisterTool(pluginId: string, regId: number | undefined, name: string): Promise<void>
  registerView(pluginId: string, def: Record<string, unknown>): Promise<{ regId: number }>
  unregisterView(pluginId: string, regId: number | undefined, viewRef: string): Promise<void>
  registerPanel(pluginId: string, def: Record<string, unknown>): Promise<{ regId: number }>
  unregisterPanel(pluginId: string, regId: number | undefined, panelRef: string): Promise<void>
  /** 把消息推给该插件的 Client 半（无 Client 半时返回 false） */
  postToClient(pluginId: string, payload: unknown): boolean
  /** 路径断言钩子：把「插件给的工作区相对路径」变成可落盘的绝对路径 */
  resolveInWorkspace(rel: string): Promise<string>
}

/* ============================================================
 * 网关
 * ============================================================ */

/**
 * 只允许 `Provides.tools` 里声明过的工具名注册。
 *
 * 为什么「声明」和「注册」要**分别做**：声明是**给用户看的**（装插件前就能
 * 知道它会往模型工具表里塞什么），注册是运行期的实现。只做其中之一都不成立：
 * 只看注册 → 用户永远不知道插件会加什么工具（不可审计）；
 * 只看声明 → 插件可以注册一堆声明里没有的工具（名不副实）。
 */
function checkToolDeclared(m: PluginManifest | undefined, name: string): void {
  const declared = (m?.provides.tools ?? []).some((t) => t.name === name)
  if (!declared) {
    throw new RpcError(RPC_ERROR.E_TOOL_UNDECLARED, `工具「${name}」未在 plugin.json 的 provides.tools 中声明`, {
      fix: `在 provides.tools 里补一条 { "name": "${name}", … }`,
    })
  }
}

function checkViewDeclared(m: PluginManifest | undefined, viewRef: string): void {
  const declared = (m?.provides.views ?? []).some((v) => v.viewRef === viewRef)
  if (!declared) {
    throw new RpcError(RPC_ERROR.E_VIEW_UNDECLARED, `视图「${viewRef}」未在 plugin.json 的 provides.views 中声明`, {
      fix: `在 provides.views 里补一条 { "viewRef": "${viewRef}", … }`,
    })
  }
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const asStr = (v: unknown, dflt = ''): string => (typeof v === 'string' ? v : dflt)

export class PluginGateway {
  constructor(private readonly deps: PluginGatewayDeps) {}

  /**
   * 处理一次 Host 半的反向调用。**永不静默成功** —— 未知能力、缺权限、
   * 缺工作区一律抛带码的 RpcError（supervisor 会把它包成 reply 回给插件）。
   */
  async handleInvoke(pluginId: string, cap: ArkCap | string, params: unknown): Promise<unknown> {
    const granted = this.deps.permissionsOf(pluginId) ?? []

    if (!isKnownCap(cap)) {
      throw new RpcError(RPC_ERROR.E_NOT_FOUND, `未知能力「${cap}」`)
    }
    const perm = checkCapPermission(cap, granted)
    if (!perm.ok) {
      throw new RpcError(RPC_ERROR.E_PERMISSION_DENIED, perm.message, { cap, need: perm.need, granted })
    }

    const p = asObj(params)
    const manifest = this.deps.manifestOf(pluginId)

    switch (cap) {
      /* ---------- 无副作用 ---------- */
      case 'log':
        // 日志上行由 supervisor 的 notify 通道承载；能力形式保留给「插件要主动
        // 记一条宿主日志」的显式路径，回一个 ok 即可（不落到宿主日志的 loud 级别）
        return { ok: true }

      case 'workspace.root': {
        const root = this.deps.workspaceRoot()
        if (!root) throw new RpcError(RPC_ERROR.E_NO_WORKSPACE, '当前没有打开工作区')
        return root
      }

      /* ---------- 文件 ---------- */
      case 'fs.read': {
        const abs = await this.resolve(p.rel)
        const r = await this.deps.readText(abs)
        return { text: r.text, encoding: r.encoding ?? 'utf-8', eol: r.eol ?? '\n' }
      }
      case 'fs.write': {
        const abs = await this.resolve(p.rel)
        const r = await this.deps.writeText(abs, asStr(p.text))
        return { path: r.path, revision: r.revision }
      }
      case 'fs.list': {
        const abs = await this.resolve(p.rel)
        return { entries: await this.deps.listDir(abs) }
      }

      /* ---------- 网络 / 进程 ---------- */
      case 'net.fetch': {
        const url = asStr(p.url)
        if (!/^https?:\/\//i.test(url)) {
          throw new RpcError(RPC_ERROR.E_PERMISSION_DENIED, `net.fetch 只允许 http/https，收到「${url}」`, { url })
        }
        const r = await this.deps.fetch(url, p.init as Record<string, unknown> | undefined)
        return { status: r.status, headers: r.headers, body: r.body }
      }
      case 'shell.run': {
        const cmd = asStr(p.cmd)
        if (!cmd) throw new RpcError(RPC_ERROR.E_INTERNAL, 'shell.run 需要 cmd')
        const args = Array.isArray(p.args) ? p.args.map(String) : []
        return await this.deps.runShell(cmd, args, p.opts)
      }

      /* ---------- 注册（装载方向） ---------- */
      case 'tools.register': {
        const name = asStr(p.name)
        checkToolDeclared(manifest, name)
        const tool = await this.deps.registerTool(pluginId, {
          name,
          description: asStr(p.description),
          inputSchema: asObj(p.inputSchema),
        })
        return { regId: tool.regId, globalName: tool.globalName }
      }
      case 'views.register': {
        const viewRef = asStr(p.viewRef)
        checkViewDeclared(manifest, viewRef)
        return await this.deps.registerView(pluginId, {
          viewRef,
          title: asStr(p.title, viewRef),
          icon: p.icon,
          renderer: p.renderer,
          placement: p.placement,
        })
      }
      case 'panels.register':
        return await this.deps.registerPanel(pluginId, p)

      /* ---------- 注册（撤销方向，**不需要权限**） ---------- */
      case 'tools.unregister':
        await this.deps.unregisterTool(pluginId, typeof p.regId === 'number' ? p.regId : undefined, asStr(p.name))
        return { ok: true }
      case 'views.unregister':
        await this.deps.unregisterView(pluginId, typeof p.regId === 'number' ? p.regId : undefined, asStr(p.viewRef))
        return { ok: true }
      case 'panels.unregister':
        await this.deps.unregisterPanel(pluginId, typeof p.regId === 'number' ? p.regId : undefined, asStr(p.panelRef))
        return { ok: true }

      /* ---------- 私有存储 ---------- */
      case 'storage.get':
        return await this.deps.storage.get(pluginId, asStr(p.key))
      case 'storage.set':
        await this.deps.storage.set(pluginId, asStr(p.key), p.value)
        return { ok: true }
      case 'storage.delete':
        await this.deps.storage.delete(pluginId, asStr(p.key))
        return { ok: true }

      /* ---------- 推给 Client 半 ---------- */
      case 'renderer.post':
        return { delivered: this.deps.postToClient(pluginId, p.payload) }

      default:
        throw new RpcError(RPC_ERROR.E_NOT_FOUND, `未知能力「${cap}」`)
    }
  }

  /** 插件给的相对路径 → 经工作区断言的绝对路径（越界即 E_PATH_OUTSIDE_WORKSPACE） */
  private async resolve(rel: unknown): Promise<string> {
    const r = asStr(rel)
    try {
      return await this.deps.resolveInWorkspace(r)
    } catch (err) {
      // FsError 的错误码与网关的码是同一套口径（E_PATH_OUTSIDE_WORKSPACE）
      const code = (err as { code?: string })?.code
      if (code === 'E_PATH_OUTSIDE_WORKSPACE' || code === 'E_ARKWORK_RESERVED') {
        throw new RpcError(code, (err as Error).message, { rel: r })
      }
      throw err
    }
  }
}
