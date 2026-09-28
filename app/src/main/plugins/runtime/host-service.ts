/* ============================================================
 * ArkWork — 插件宿主服务（v0.35.0 · 组合根）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §2（三层架构）· §6（关键流程）
 *
 * 这个文件把四块拼成一台能跑的机器：
 *   registry（有哪些插件、启用了谁）
 *     ↕ host-service（本文件：注册表 + 存储 + 视图会话 + 广播）
 *   supervisor（每插件一个 utilityProcess）
 *     ↕ gateway（权限闸门 + 能力实现）
 *
 * **它是唯一知道「插件进程」存在的地方** —— IPC 层、模型工具层、插槽层
 * 都只跟它打交道，不直接摸 supervisor。这条约束是「换实现不牵动上层」的前提。
 *
 * ★ 贡献点登记与插槽登记的分工（容易搞混，写清楚）：
 *   · **声明**（`plugin.json` 的 provides）→ registry 转成插槽条目（供装配器引用）；
 *   · **运行期注册**（插件在 `apply(ctx)` 里 `ctx.ark.tools.register(...)`）
 *     → 落到本文件的注册表，它才是「模型真的能调到这个工具」的事实源。
 *   两者必须都齐：只有声明 = 用户看得到但调不动；只有注册 = 用户看不见却能被模型调。
 * ============================================================ */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'

import { logger } from '../../system/logger.js'
import { getArkworkDir, getWorkspaceDir, JsonDoc } from '../../store/db.js'
import { assertInWorkspace } from '../../fs/guard.js'
import { pluginEffects } from '../effects.js'
import { listInstalledPlugins, invalidatePlugins, refreshPluginSlots } from '../registry.js'
import { scopeOfSource, setEnabled, pluginsDir, type PluginScope } from '../store.js'
import { RpcError } from './wire.js'
import { PluginGateway, type DirEntry, type PluginGatewayDeps, type RegisteredTool } from './gateway.js'
import { PluginSupervisor, type HostProcessHandle, type SpawnHostFn } from './supervisor.js'
import { createGitService, GitError, type GitService } from '../../git/service.js'
import { logGitAudit } from '../../git/audit.js'
// v0.36.0：git 写操作复用 agent 的会话模式与 renderer 确认浮层（与 shell 同源）
import { resolveEffectiveMode } from '../../agent/session-mode.js'
import { makeRendererConfirm } from '../../agent/registry.js'
import type { PluginManifest, PluginPermission, PluginRuntimeStatus } from '@shared/types/plugin'
import type { PluginViewMethod } from '@shared/types/ipc'
import { globalPluginToolName, summarizePluginToolResult } from '@shared/utils/plugin-tool-name'

/* ============================================================
 * 索引（registry 是异步的，网关需要同步查 → 这里缓存一份）
 * ============================================================ */
interface IndexEntry {
  id: string
  dir: string
  source: 'bundled' | 'global' | 'workspace'
  manifest: PluginManifest
  permissions: PluginPermission[]
  enabled: boolean
  /**
   * 校验失败原因（VP1–VP10）。
   *
   * 为什么索引里要带它：`enabled` 已经把「校验失败」并成了 false
   * （见 `refreshIndex`），单看 `enabled === false` 分不出
   * 「用户手动禁用」与「清单根本不合格」—— 而这两者给用户的处置建议完全不同
   * （前者「去打开它」，后者「去修清单」）。诊断面板与模型侧的 `plugin_detail`
   * 都靠这个字段区分。
   */
  invalidReason?: string
}

/* ============================================================
 * 视图会话
 * ============================================================ */
export interface ViewSession {
  sessionId: string
  pluginId: string
  viewRef: string
  title: string
  /** 打开时的工作区（会话与工作区绑定 —— 换工作区即失效） */
  workspace: string
  openedAt: number
}

/* ============================================================
 * 服务依赖（可注入 → 单测可跑）
 * ============================================================ */
export interface PluginHostServiceOptions {
  /** `out/main/plugin-host.js` 的绝对路径 */
  entryPath: string
  /** 生产用 spawn（缺省 utilityProcess.fork）；测试注入假进程 */
  spawn?: SpawnHostFn
  /** 宿主版本注入（VP8 判定用） */
  hostVersion?: string
  /** 主题模式（`ui.theme.get` 用） */
  themeMode?: () => 'light' | 'dark'
  /** 渲染层广播出口（缺省用 BrowserWindow；测试注入收集器） */
  broadcast?: (channel: string, payload: unknown) => void
  /** 取数栈（`net.fetch` / `data.request` 用） */
  fetch?: (input: string, init?: Record<string, unknown>) => Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }>
  now?: () => number
}

export class PluginHostService {
  readonly supervisor: PluginSupervisor
  readonly gateway: PluginGateway

  private readonly index = new Map<string, IndexEntry>()
  private readonly tools = new Map<string, RegisteredTool[]>()
  private readonly views = new Map<string, Array<Record<string, unknown>>>()
  private readonly panels = new Map<string, Array<Record<string, unknown>>>()
  private readonly sessions = new Map<string, ViewSession>()
  private readonly storageDocs = new Map<string, JsonDoc<Record<string, unknown>>>()
  private regSeq = 0
  /** v0.36.0：git 服务（懒创建 —— 未用到 git 前不触发 dugite 加载） */
  private git: GitService | null = null
  private readonly opts: PluginHostServiceOptions

  constructor(opts: PluginHostServiceOptions) {
    this.opts = opts
    this.gateway = new PluginGateway(this.buildGatewayDeps())
    this.supervisor = new PluginSupervisor({
      entryPath: opts.entryPath,
      handleInvoke: (pluginId, cap, params) => this.gateway.handleInvoke(pluginId, cap, params),
      onPhaseChange: (status) => this.opts.broadcast?.('plugin:runtime-changed', status),
      ...(opts.spawn ? { spawn: opts.spawn } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    })
  }

  /* ============================================================
   * 索引
   * ============================================================ */

  /** 重新扫描并刷新同步索引（启动 / 启停 / 卸载 / 重扫后调用） */
  async refreshIndex(): Promise<IndexEntry[]> {
    const plugins = await listInstalledPlugins()
    this.index.clear()
    for (const p of plugins) {
      this.index.set(p.manifest.id, {
        id: p.manifest.id,
        dir: p.dir,
        source: p.source,
        manifest: p.manifest,
        // 实际生效的权限 = 清单声明 ∩ 白名单（纯函数校验器已在装载期把白名单外的拒掉）
        permissions: [...(p.manifest.permissions ?? [])],
        enabled: p.enabled && !p.invalidReason,
        ...(p.invalidReason ? { invalidReason: p.invalidReason } : {}),
      })
    }
    return Array.from(this.index.values())
  }

  entryOf(id: string): IndexEntry | undefined {
    return this.index.get(id)
  }

  /**
   * 某一级作用域的插件 id。
   *
   * 唯一调用点是**工作区切换**：workspace 来源的插件目录随工作区一起被换掉，
   * 进程必须在此之前拆干净（否则插件继续持有一个「用户以为已经离开的」目录，
   * 后续任何一次 `fs.read` 都读到旧工作区的内容）。
   */
  listBySource(source: IndexEntry['source']): string[] {
    const out: string[] = []
    for (const [id, e] of this.index) if (e.source === source) out.push(id)
    return out
  }

  /**
   * 索引快照（模型侧控制工具 / 诊断面板用）。
   *
   * 返回的是**浅拷贝数组，元素是索引条目本体** —— 调用方只读。
   * 之所以给同步接口：模型工具在一个 ReAct 步里要连续查好几次
   * （列表 → 详情 → 启停），每次都 `await listInstalledPlugins()` 会重新扫盘，
   * 而扫描结果在一次工具调用内部不可能变。
   */
  indexSnapshot(): IndexEntry[] {
    return Array.from(this.index.values())
  }

  /** 单个插件的运行期阶段（未激活 → `registered`，与诊断口径一致） */
  phaseOf(id: string): PluginRuntimeStatus['phase'] {
    return this.runtimeStatuses().find((s) => s.id === id)?.phase ?? 'registered'
  }

  /* ============================================================
   * 激活
   * ============================================================ */

  /**
   * 确保插件已激活（幂等）。
   *
   * 三种「不激活」都是**合法**的，且必须区分开（诊断页要能看出是哪一种）：
   *  · 不在索引里 → not-found；
   *  · 被禁用 / 校验失败 → 不启动进程，phase 由上层记为 registered；
   *  · 纯声明式插件（无 main）→ 走进程内注册路径，起进程是浪费。
   */
  async ensureActivated(pluginId: string): Promise<{ ok: boolean; phase: PluginRuntimeStatus['phase']; message?: string }> {
    const e = this.index.get(pluginId)
    if (!e) return { ok: false, phase: 'stopped', message: '插件不在册（可能已被卸载）' }
    if (!e.enabled) return { ok: false, phase: 'stopped', message: '插件未启用' }
    if (!e.manifest.main) {
      // 纯声明式插件：没有 Host 半可跑。它贡献的插槽在 registry 侧已生效。
      return { ok: true, phase: 'registered', message: '纯声明式插件（无 Host 半）' }
    }
    const status = await this.supervisor.activate({
      id: pluginId,
      dir: e.dir,
      manifest: e.manifest as unknown as Record<string, unknown>,
      permissions: e.permissions,
    })
    return {
      ok: status.phase === 'active',
      phase: status.phase,
      ...(status.lastError ? { message: status.lastError } : {}),
    }
  }

  /** 启动时/工作区打开时：把命中常驻激活事件的插件拉起来（懒激活，A10） */
  async activatePersistentPlugins(trigger: 'startup' | 'workspace'): Promise<string[]> {
    const want = trigger === 'startup' ? 'onStartup' : 'onWorkspaceOpen'
    const started: string[] = []
    for (const e of this.index.values()) {
      if (!e.enabled || !e.manifest.main) continue
      const events = e.manifest.activation ?? []
      if (!events.includes(want)) continue
      const r = await this.ensureActivated(e.id)
      if (r.ok) started.push(e.id)
    }
    if (started.length > 0) logger.info('System', `[plugin] ${trigger} 激活 ${started.length} 个插件：${started.join(', ')}`)
    return started
  }

  /* ============================================================
   * 工具（模型可见）
   * ============================================================ */

  /**
   * **清单声明**的插件工具 —— `assembleTools` 的数据源。
   *
   * 为什么取清单声明而不是运行期 `registeredTools()`（这是本模块最容易搞错的一处）：
   * 运行期注册要先 `apply(ctx)` 才发生，而插件是**懒激活**的 ——
   * 用运行期注册做数据源，会导致「模型永远看不到一个还没被激活的插件的工具，
   * 而它永远不会被激活，因为没人会去调一个看不见的工具」这个死锁。
   *
   * 对照 VS Code：工具清单来自 `package.json` 的贡献点（静态），
   * 真正的 `activate` 发生在**第一次调用**时（见下方 `callPluginTool`）。
   * 这里照抄这个分工：**看见靠声明，能调靠激活**。
   *
   * 禁用 / 校验失败的插件不产出（`enabled` 已在 `refreshIndex` 里并入校验结果）。
   */
  declaredTools(): RegisteredTool[] {
    const out: RegisteredTool[] = []
    for (const [id, e] of this.index) {
      if (!e.enabled) continue
      for (const t of e.manifest.provides.tools ?? []) {
        out.push({
          regId: -1, // 未注册（声明位），区别于运行期注册的正数 regId
          pluginId: id,
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
          globalName: PluginHostService.globalToolName(id, t.name),
        })
      }
    }
    return out
  }

  /** 全部启用插件**已注册**的工具（运行期真源；诊断与「实际可调」判定用） */
  registeredTools(): RegisteredTool[] {
    const out: RegisteredTool[] = []
    for (const [, list] of this.tools) out.push(...list)
    return out
  }

  /** 工具名 → 归属插件（模型调用时路由用） */
  ownerOfTool(globalName: string): { pluginId: string; name: string } | undefined {
    for (const [pluginId, list] of this.tools) {
      for (const t of list) if (t.globalName === globalName) return { pluginId, name: t.name }
    }
    return undefined
  }

  /** 工具名 → 归属插件（**声明**口径：运行期注册里没有时回落到清单声明） */
  ownerOfDeclaredTool(globalName: string): { pluginId: string; name: string } | undefined {
    for (const t of this.declaredTools()) {
      if (t.globalName === globalName) return { pluginId: t.pluginId, name: t.name }
    }
    return undefined
  }

  /**
   * 模型调用插件工具。
   *
   * 两步（顺序不能反）：
   *  ① 用**声明**查出归属（此刻进程可能还没起）；
   *  ② 按需激活，再走 supervisor 的调用通道。
   * 直接查运行期注册会在懒激活时误报「未知的插件工具」——
   * 那是个把人引向错误方向的报错（工具明明存在，只是插件还没起来）。
   */
  async callPluginTool(globalName: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    const owner = this.ownerOfDeclaredTool(globalName) ?? this.ownerOfTool(globalName)
    if (!owner) throw new Error(`未知的插件工具：${globalName}`)

    const activation = await this.ensureActivated(owner.pluginId)
    if (!activation.ok) {
      throw new Error(
        `plugin-tool-unavailable: 插件 ${owner.pluginId} 未能激活（${activation.message ?? activation.phase}）`,
      )
    }

    const result = await this.supervisor.callTool(owner.pluginId, owner.name, input)
    return { result, summary: summarizePluginToolResult(owner.pluginId, owner.name, result) }
  }

  /** 全局工具的命名空间前缀（与 MCP 同款手法，防与内置工具/skill 撞名） */
  static globalToolName(pluginId: string, name: string): string {
    return globalPluginToolName(pluginId, name)
  }

  /* ============================================================
   * 视图会话
   * ============================================================ */

  /** 打开视图：按需激活 → 签发会话 → 给出 iframe URL */
  async openView(pluginId: string, viewRef: string): Promise<
    | { ok: true; session: ViewSession; rel: string }
    | { ok: false; reason: 'not-found' | 'no-renderer' | 'activation-failed'; message?: string }
  > {
    const e = this.index.get(pluginId)
    if (!e) return { ok: false, reason: 'not-found', message: `插件 ${pluginId} 不在册` }
    const view = (e.manifest.provides.views ?? []).find((v) => v.viewRef === viewRef)
    if (!view) return { ok: false, reason: 'not-found', message: `插件未声明视图 ${viewRef}` }
    const rel = view.renderer ?? e.manifest.renderer
    if (!rel) return { ok: false, reason: 'no-renderer', message: `视图 ${viewRef} 没有 Client 半入口` }

    // 有 Host 半就必须先激活（Client 半可能依赖它提供的数据）
    if (e.manifest.main) {
      const a = await this.ensureActivated(pluginId)
      if (!a.ok && a.phase !== 'registered') {
        return { ok: false, reason: 'activation-failed', message: a.message }
      }
    }

    const session: ViewSession = {
      sessionId: `${pluginId}#${viewRef}#${randomUUID()}`,
      pluginId,
      viewRef,
      title: view.title,
      // 会话与工作区绑定：切换工作区时会话一律失效（避免「A 工作区的插件界面在 B 工作区里活着」）
      workspace: getWorkspaceDir(),
      openedAt: this.opts.now?.() ?? Date.now(),
    }
    this.sessions.set(session.sessionId, session)
    // 记账（纪律⑬）：进程/工作区异常时，会话也要能被统一撤掉
    pluginEffects.register(pluginId, 'view-session', session.sessionId, () => {
      this.sessions.delete(session.sessionId)
    })
    return { ok: true, session, rel }
  }

  closeView(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  sessionOf(sessionId: string): ViewSession | undefined {
    return this.sessions.get(sessionId)
  }

  openViewCount(): number {
    return this.sessions.size
  }

  /** 关闭某插件的全部会话（禁用 / 卸载 / 进程死亡时） */
  closeViewsOf(pluginId: string): number {
    let n = 0
    for (const [sid, s] of this.sessions) {
      if (s.pluginId === pluginId) {
        this.sessions.delete(sid)
        n += 1
      }
    }
    return n
  }

  /** 关闭全部会话（工作区切换 / 退出） */
  closeAllViews(): void {
    this.sessions.clear()
  }

  /**
   * Client 半的桥调用（**第二个、更窄的网关**）。
   *
   * 为什么 Client 半的方法要白名单：iframe 里跑的是完全不可信代码，
   * 它能触达宿主的方式只有这一个函数。白名单是**闭集**，未列出的方法
   * 一律 `method-not-allowed`（不是静默忽略 —— 静默会让作者以为调通了）。
   */
  async viewCall(
    sessionId: string,
    method: string,
    params: unknown,
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
    const s = this.sessions.get(sessionId)
    // ★ 会话不匹配 → **安全丢弃**（不回报栈、不回声；避免把会话 id 变成可探测信息）
    if (!s) return { ok: false, error: { code: 'E_SESSION_INVALID', message: '视图会话无效或已关闭' } }
    // 工作区已经换了 → 该会话失效
    if (s.workspace !== getWorkspaceDir()) {
      this.sessions.delete(sessionId)
      return { ok: false, error: { code: 'E_SESSION_INVALID', message: '工作区已切换，视图会话失效' } }
    }

    const ALLOWED = new Set<PluginViewMethod>([
      'ui.ready',
      'ui.resize',
      'ui.theme.get',
      'ui.toast',
      'ui.openPanel',
      'data.request',
      'storage.get',
      'storage.set',
      'host.call',
    ])
    if (!ALLOWED.has(method as PluginViewMethod)) {
      return { ok: false, error: { code: 'method-not-allowed', message: `桥方法「${method}」不在白名单内` } }
    }

    const p = (params ?? {}) as Record<string, unknown>
    try {
      switch (method) {
        case 'ui.ready':
          return { ok: true, result: { pluginId: s.pluginId, viewRef: s.viewRef, workspace: s.workspace } }
        case 'ui.theme.get':
          return { ok: true, result: { mode: this.opts.themeMode?.() ?? 'dark' } }
        case 'ui.resize': {
          // 只回显夹过的尺寸：拒绝插件把浮窗撑到离谱大小（宿主 UI 的边界不由插件定）
          const w = clamp(Number(p.w) || 0, 240, 2400)
          const h = clamp(Number(p.h) || 0, 160, 1600)
          return { ok: true, result: { w, h } }
        }
        case 'ui.toast': {
          this.opts.broadcast?.('plugin:view-post', {
            sessionId,
            payload: { kind: 'toast', message: String(p.message ?? ''), level: String(p.level ?? 'info') },
          })
          return { ok: true }
        }
        case 'ui.openPanel':
          // 经宿主打开面板：插件只能**请求**，真正的打开动作由渲染层按自己的规则决定
          this.opts.broadcast?.('plugin:view-open-request', { pluginId: s.pluginId, viewRef: String(p.panelRef ?? '') })
          return { ok: true }
        case 'data.request':
          // ★ Client 半没有直连网络（CSP connect-src 'none'），这条路是它的唯一出口，
          //   因此必须**复用同一个权限闸门** —— 否则「Client 半」就成了绕过 net 权限的后门。
          return await this.clientFetch(s.pluginId, p)
        case 'storage.get':
        case 'storage.set': {
          const perm = this.index.get(s.pluginId)?.permissions ?? []
          if (!perm.includes('storage')) {
            return { ok: false, error: { code: 'E_PERMISSION_DENIED', message: '插件未声明 storage 权限' } }
          }
          const key = String(p.key ?? '')
          if (!key) return { ok: false, error: { code: 'E_INTERNAL', message: 'storage 需要 key' } }
          const doc = this.storageDoc(s.pluginId)
          if (method === 'storage.get') {
            const cur = await doc.read()
            return { ok: true, result: cur[key] }
          }
          const cur = await doc.read()
          const next = { ...cur, [key]: p.value }
          await doc.write(next)
          return { ok: true }
        }
        case 'host.call': {
          // v0.36.0：转发到该插件 Host 半的 ctx.views.onCall 注册表（宿主只搬运）。
          // 未注册 = E_NOT_FOUND 原样回给 Client 半；插件未激活 = E_HOST_DEAD。
          const inner = String(p.method ?? '')
          if (!inner) return { ok: false, error: { code: 'E_INTERNAL', message: 'host.call 需要 method' } }
          try {
            const result = await this.supervisor.callViewMethod(s.pluginId, inner, p.params)
            return { ok: true, result }
          } catch (err) {
            const code = (err as { code?: unknown }).code
            return {
              ok: false,
              error: {
                code: typeof code === 'string' && code ? code : 'E_INTERNAL',
                message: err instanceof Error ? err.message : String(err),
              },
            }
          }
        }
        default:
          return { ok: false, error: { code: 'method-not-allowed', message: `未实现 ${method}` } }
      }
    } catch (err) {
      return {
        ok: false,
        error: { code: 'E_INTERNAL', message: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  private async clientFetch(
    pluginId: string,
    p: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
    const perm = this.index.get(pluginId)?.permissions ?? []
    if (!perm.includes('net')) {
      return { ok: false, error: { code: 'E_PERMISSION_DENIED', message: '插件未声明 net 权限' } }
    }
    const url = String(p.url ?? '')
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: { code: 'E_PERMISSION_DENIED', message: `只允许 http/https，收到「${url}」` } }
    }
    const r = await this.deps().fetch(url, p.init as Record<string, unknown> | undefined)
    return { ok: true, result: r }
  }

  /* ============================================================
   * 销毁
   * ============================================================ */

  /**
   * 停用一个插件：撤会话 → 撤注册 → 停进程 → 撤主进程侧账本。
   *
   * 顺序很重要：**先撤会话**（否则正在用的 iframe 会在注册表被清空后继续调桥，
   * 撞上一连串「未知方法」）；再撤注册；最后停进程与账本。
   */
  async disposePlugin(pluginId: string, opts: { purgeData?: boolean } = {}): Promise<void> {
    const views = this.closeViewsOf(pluginId)
    this.tools.delete(pluginId)
    this.views.delete(pluginId)
    this.panels.delete(pluginId)
    if (opts.purgeData) this.purgeStorage(pluginId)
    await this.supervisor.dispose(pluginId)
    const r = await pluginEffects.revokeAll(pluginId)
    if (views > 0 || r.revoked > 0) {
      logger.info('System', `[plugin] 停用 ${pluginId}：关闭 ${views} 个视图会话，撤销 ${r.revoked} 项副作用`)
    }
  }

  /**
   * ★ v0.36.0（F3.2）：清除插件私有 KV（plugin-storage/<id>.json）。
   * 卸载勾选「删除数据」时调用；内存缓存同步移除，避免半清理状态。
   */
  purgeStorage(pluginId: string): void {
    this.storageDocs.delete(pluginId)
    try {
      rmSync(join(getArkworkDir(), 'plugin-storage', `${pluginId}.json`), { force: true })
    } catch (err) {
      logger.warn('System', `[plugin] 清除 ${pluginId} 私有数据失败：${String(err)}`)
    }
  }

  /**
   * ★ v0.36.0（F3.3）：触发一条插件命令。
   * 命令是懒激活事件之一：先 ensureActivated（幂等），再直发 `host/emit`。
   * 错误向上抛（supervisor.runCommand 的 E_HOST_DEAD / E_NOT_FOUND 语义），
   * 由 IPC 层转成 `{ok:false, message}`。
   */
  async runCommand(pluginId: string, commandId: string): Promise<void> {
    const e = this.index.get(pluginId)
    if (!e) throw new Error(`插件 ${pluginId} 不在册（可能已被卸载）`)
    if (!e.enabled) throw new Error(`插件 ${pluginId} 未启用，请先在插件面板启用`)
    const declared = (e.manifest.provides.commands ?? []).some((c) => c.id === commandId)
    if (!declared) throw new Error(`插件 ${pluginId} 未声明命令「${commandId}」`)
    await this.ensureActivated(pluginId)
    await this.supervisor.runCommand(pluginId, commandId)
  }

  /** 应用退出（同步，不能 await） */
  shutdown(): void {
    this.sessions.clear()
    this.supervisor.killAll()
    // v0.36.0（D82）：生产装配开始启动 watchdog/idle-sweeper（bootstrap ②.5），
    // 退出/重装配路径必须同步停表 —— killAll 只杀会话不停定时器，否则泄漏的
    // tick 会继续空转（重装配场景下旧实例的定时器还攥着已失效的会话表）。
    this.supervisor.stopWatchdog()
  }

  /* ============================================================
   * 诊断
   * ============================================================ */

  runtimeStatuses(): PluginRuntimeStatus[] {
    const out: PluginRuntimeStatus[] = []
    for (const e of this.index.values()) {
      const live = this.supervisor.statusOf(e.id)
      if (live) {
        out.push(live)
        continue
      }
      // 没起过进程的（纯声明式 / 未激活）也要出现在诊断页上，
      // 否则用户会以为「这个插件根本没被识别」
      out.push({
        id: e.id,
        phase: e.enabled ? 'registered' : 'stopped',
        permissions: [...e.permissions],
      })
    }
    return out
  }

  /* ============================================================
   * 内部：网关依赖
   * ============================================================ */

  private deps(): { fetch: NonNullable<PluginHostServiceOptions['fetch']> } {
    return {
      fetch:
        this.opts.fetch ??
        (async () => ({ status: 0, headers: {}, body: '' })),
    }
  }

  /**
   * v0.36.0：git 服务装配（懒创建）。
   *  · root    = 当前工作区（repo 唯一作用域，随工作区切换）；
   *  · mode    = agent 会话权限模式（与 shell 同源：session override > defaultMode）；
   *  · confirm = renderer 美观浮层（与 shell 工具确认同一条通道）；
   *  · audit   = .arkwork/logs/git-audit.jsonl（写类 op 逐条落盘）。
   */
  private gitService(): GitService {
    if (!this.git) {
      this.git = createGitService({
        root: () => getWorkspaceDir(),
        mode: () => resolveEffectiveMode(getWorkspaceDir()),
        confirm: async (req) => {
          const confirm = makeRendererConfirm()
          const outcome = await confirm({
            requestId: randomUUID(),
            skillName: `Git · ${req.op}（${req.pluginId}）`,
            command: req.summary,
            cwd: req.root,
            impacts: req.impacts,
            risk: 'medium',
          })
          return outcome.allowed
            ? { allowed: true }
            : { allowed: false, ...(outcome.reason ? { reason: outcome.reason } : {}) }
        },
        audit: (entry) => logGitAudit(entry),
      })
    }
    return this.git
  }

  private buildGatewayDeps(): PluginGatewayDeps {
    const broadcast = (channel: string, payload: unknown): void => this.opts.broadcast?.(channel, payload)

    return {
      permissionsOf: (id) => this.index.get(id)?.permissions,
      manifestOf: (id) => this.index.get(id)?.manifest,
      workspaceRoot: () => getWorkspaceDir(),

      /* ---------- 文件（一律经工作区断言；realpath 挡 symlink 逃逸） ---------- */
      readText: async (abs) => {
        const safe = await assertInWorkspace(abs)
        return { text: readFileSync(safe, 'utf-8'), encoding: 'utf-8', eol: '\n' }
      },
      writeText: async (abs, text) => {
        const safe = await assertInWorkspace(abs)
        mkdirSync(join(safe, '..'), { recursive: true })
        writeFileSync(safe, text, 'utf-8')
        return { path: safe, revision: String(Date.now()) }
      },
      listDir: async (abs) => {
        const safe = await assertInWorkspace(abs)
        const out: DirEntry[] = []
        for (const name of readdirSync(safe).sort()) {
          if (name.startsWith('.')) continue
          try {
            const st = statSync(join(safe, name))
            out.push(
              st.isDirectory()
                ? { name, type: 'dir' }
                : { name, type: 'file', size: st.size },
            )
          } catch {
            /* 读不了就不列（扫描纪律：永不抛错） */
          }
        }
        return out
      },

      /* ---------- 网络 / 进程 ---------- */
      fetch: (input, init) => this.deps().fetch(input, init),
      runShell: (cmd, args) =>
        new Promise((resolveP) => {
          execFile(cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
            resolveP({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
          })
        }),

      /* ---------- 存储 ---------- */
      storage: {
        get: async (id, key) => (await this.storageDoc(id).read())[key],
        set: async (id, key, value) => {
          const doc = this.storageDoc(id)
          await doc.write({ ...(await doc.read()), [key]: value })
        },
        delete: async (id, key) => {
          const doc = this.storageDoc(id)
          const cur = { ...(await doc.read()) }
          delete cur[key]
          await doc.write(cur)
        },
      },

      /* ---------- 注册（双账：本文件持有事实源；pluginEffects 兜底崩溃残留） ---------- */
      registerTool: async (pluginId, def) => {
        const regId = (this.regSeq += 1)
        const tool: RegisteredTool = {
          regId,
          pluginId,
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
          globalName: PluginHostService.globalToolName(pluginId, def.name),
        }
        const list = this.tools.get(pluginId) ?? []
        // 同名覆盖（插件重载时会重新注册）：先摘旧的再放新的
        const next = list.filter((t) => t.name !== def.name)
        next.push(tool)
        this.tools.set(pluginId, next)
        pluginEffects.register(pluginId, 'tool', def.name, () => {
          this.unregisterToolSync(pluginId, def.name)
        })
        return tool
      },
      unregisterTool: async (pluginId, _regId, name) => {
        this.unregisterToolSync(pluginId, name)
      },
      registerView: async (pluginId, def) => {
        const regId = (this.regSeq += 1)
        const viewRef = String(def.viewRef ?? '')
        const list = (this.views.get(pluginId) ?? []).filter((v) => v.viewRef !== viewRef)
        list.push({
          viewRef,
          title: String(def.title ?? viewRef),
          icon: def.icon,
          renderer: def.renderer,
          // 边界纪律：插件只控浮窗与右侧侧边栏
          placement: def.placement === 'float' ? 'float' : 'dock',
        })
        this.views.set(pluginId, list)
        pluginEffects.register(pluginId, 'view', viewRef, () => {
          this.views.set(pluginId, (this.views.get(pluginId) ?? []).filter((v) => v.viewRef !== viewRef))
        })
        return { regId }
      },
      unregisterView: async (pluginId, _regId, viewRef) => {
        this.views.set(pluginId, (this.views.get(pluginId) ?? []).filter((v) => v.viewRef !== viewRef))
      },
      registerPanel: async (pluginId, def) => {
        const regId = (this.regSeq += 1)
        const list = (this.panels.get(pluginId) ?? []).filter((v) => v.panelRef !== def.panelRef)
        list.push(def)
        this.panels.set(pluginId, list)
        return { regId }
      },
      unregisterPanel: async (pluginId, _regId, panelRef) => {
        this.panels.set(pluginId, (this.panels.get(pluginId) ?? []).filter((v) => v.panelRef !== panelRef))
      },

      /* ---------- 推给 Client 半 ---------- */
      postToClient: (pluginId, payload) => {
        const targets = Array.from(this.sessions.values()).filter((s) => s.pluginId === pluginId)
        if (targets.length === 0) {
          logger.debug('System', `[plugin:${pluginId}] renderer.post 被丢弃（没有打开的视图会话）`)
          return false
        }
        for (const t of targets) broadcast('plugin:view-post', { sessionId: t.sessionId, payload })
        return true
      },

      /* ---------- git（v0.36.0：封闭白名单；GitError → RpcError 保码转换） ---------- */
      gitRun: async (pluginId, op, args) => {
        try {
          return await this.gitService().run(pluginId, op, args)
        } catch (err) {
          if (err instanceof GitError) {
            throw new RpcError(
              err.code,
              err.message,
              err.detail && typeof err.detail === 'object' ? (err.detail as Record<string, unknown>) : undefined,
            )
          }
          throw err
        }
      },

      /* ---------- 路径断言 ---------- */
      resolveInWorkspace: async (rel) => {
        const root = getWorkspaceDir()
        const abs = resolve(root, rel)
        const r = relative(root, abs)
        if (r.startsWith('..') || (r !== '' && sep && r.split(sep).includes('..')) || rel.startsWith('/')) {
          const e = new Error(`路径越出工作区：${rel}`) as Error & { code?: string }
          e.code = 'E_PATH_OUTSIDE_WORKSPACE'
          throw e
        }
        return await assertInWorkspace(abs)
      },
    }
  }

  private unregisterToolSync(pluginId: string, name: string): void {
    this.tools.set(pluginId, (this.tools.get(pluginId) ?? []).filter((t) => t.name !== name))
  }

  private storageDoc(pluginId: string): JsonDoc<Record<string, unknown>> {
    let doc = this.storageDocs.get(pluginId)
    if (!doc) {
      const dir = join(getArkworkDir(), 'plugin-storage')
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      } catch {
        /* 建不出来时 JsonDoc 会在写的时候再报一次 */
      }
      doc = new JsonDoc<Record<string, unknown>>(join(dir, `${pluginId}.json`), {})
      this.storageDocs.set(pluginId, doc)
    }
    return doc
  }

  /** 已注册的视图（供 `plugin:views` 与诊断用） */
  registeredViews(): Array<{ pluginId: string; view: Record<string, unknown> }> {
    const out: Array<{ pluginId: string; view: Record<string, unknown> }> = []
    for (const [pluginId, list] of this.views) for (const v of list) out.push({ pluginId, view: v })
    return out
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n) || n <= 0) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

/* ============================================================
 * 单例装配
 * ============================================================ */
let service: PluginHostService | null = null

export function initPluginHostService(opts: PluginHostServiceOptions): PluginHostService {
  service?.shutdown()
  service = new PluginHostService(opts)
  return service
}

export function getPluginHostService(): PluginHostService | null {
  return service
}

/** 需要服务已装配的调用点用这个（未装配即抛，避免静默空实现） */
export function requirePluginHostService(): PluginHostService {
  if (!service) throw new Error('[plugin] 插件宿主服务尚未初始化')
  return service
}

export function resetPluginHostService(): void {
  service?.shutdown()
  service = null
}

/* ============================================================
 * 与 registry 的协作（启停/卸载后必须同步刷新索引）
 * ============================================================ */
export async function refreshPluginsAndIndex(): Promise<void> {
  invalidatePlugins()
  await refreshPluginSlots()
  await service?.refreshIndex()
}

/** 某插件被停用 / 卸载 / 禁用时，把它从运行态里彻底摘掉 */
export async function teardownPlugin(pluginId: string, opts?: { purgeData?: boolean }): Promise<void> {
  await service?.disposePlugin(pluginId, opts)
}

export { pluginsDir, scopeOfSource, setEnabled, type PluginScope, type PluginManifest }
export type { HostProcessHandle }

/* ============================================================
 * 工具名的命名空间 —— 真源在 `@shared/utils/plugin-tool-name`（纯模块，
 * 供 agent 引擎静态依赖，避免把 Electron 依赖拖进引擎模块图）。
 * 此处转出，让既有调用点（IPC / 模型工具 / 测试）不必多记一个路径。
 * ============================================================ */
export {
  PLUGIN_TOOL_PREFIX,
  globalPluginToolName,
  isPluginToolName,
  splitPluginToolName,
  summarizePluginToolResult,
  prettyPluginToolName,
} from '@shared/utils/plugin-tool-name'
