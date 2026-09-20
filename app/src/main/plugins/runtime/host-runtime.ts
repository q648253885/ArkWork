/* ============================================================
 * ArkWork — Host 半运行时（v0.35.0 · M6 的核心，可注入依赖）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §2（三层边界）· §5.1 · §6
 *
 * 本文件就是**跑在 `utilityProcess` 里的那半**（`host-entry.ts` 只负责把它
 * 接到 `process.parentPort` 上，逻辑全在这里 —— 这样 IP1 的「可注入依赖」
 * 才成立：node:test 用内存端点直接驱动它，不需要真的起进程）。
 *
 * 三条硬边界在这里被物理执行：
 *  ① **主进程永不 import 插件代码** —— `import()` 只发生在本文件里；
 *  ② Host 半**只能**经 `endpoint` 访问宿主 —— 本文件不 import electron、
 *     不读环境变量、不开文件句柄；一切副作用都要 `invoke(...)` 请主进程代做；
 *  ③ `apply(ctx)` 抛错 = 整插件不激活，**不留半个注册**（纪律②）。
 *
 * 可逆 effect（纪律⑬）在这里有**两份账**：
 *  · **插件侧账**（本文件）：`ctx.effect()` 登记的清理函数，`host/dispose` 时逆序跑；
 *  · **宿主侧账**（`main/plugins/effects.ts`）：主进程登记的工具/视图/面板/插槽注册，
 *    `revokeAll(pluginId)` 时逆序撤。
 *  两份都幂等，谁先谁后都不漏 —— 这是「卸载路径与装载路径对称」的实现方式。
 * ============================================================ */
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { RpcError, RPC_ERROR, toErrorPayload, notify, replyErr, replyOk } from './wire.js'
import type { ArkCap, InvokeMsg, WireEndpoint, WireMessage } from './wire.js'

/* ============================================================
 * 依赖注入面
 * ============================================================ */

export interface HostRuntimeDeps {
  /** 唯一通信面（生产：parentPort 适配器；测试：内存端点） */
  endpoint: WireEndpoint
  /** 动态装载插件模块（测试可注入假实现，从而无需真文件） */
  loadModule?: (absPath: string, mainEntry: string) => Promise<unknown>
  /** 反向调用超时（0 = 不设超时；测试用 0 便于同步驱动） */
  invokeTimeoutMs?: number
  /** 单插件私有 KV 容量上限（字节） */
  storageQuotaBytes?: number
  /** 心跳间隔（ms；0/缺省 = 不发心跳 —— 测试默认静默） */
  heartbeatMs?: number
  /** 计时器注入（测试可换成假计时器；缺省用全局） */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

/** `host/prepare` 的入参 */
export interface PrepareParams {
  pluginId: string
  /** 插件目录绝对路径（由主进程给出，Host 半不自行推导） */
  dir: string
  /** 只读清单快照 */
  manifest: Record<string, unknown>
  /** 实际生效的权限（清单声明 ∩ 白名单，主进程已算好） */
  permissions: string[]
}

/** 诊断用快照（`host/dispose` 之前可查） */
export interface HostRuntimeState {
  pluginId: string | null
  prepared: boolean
  activated: boolean
  /** 插件侧账未撤销条目数 */
  effects: number
  registeredTools: string[]
  registeredViews: string[]
  registeredPanels: string[]
  /** 私有 KV 已用字节 */
  storageBytes: number
}

export interface HostRuntime {
  handleMessage(msg: WireMessage): void
  /** 安装 uncaughtException / unhandledRejection 上报（bootstrap 调用；测试可不装） */
  installCrashHooks(): void
  /**
   * 起心跳循环（单向 notify；主进程据此判死）。
   * 为什么心跳由 Host 半自己发而不是主进程 ping：插件 `while(true)` 时
   * 事件循环被占满，**只有自主心跳才会停** —— 这才测得出「无响应」。
   */
  startHeartbeat(ms?: number): void
  stopHeartbeat(): void
  state(): HostRuntimeState
  /** 插件侧已登记的 effect 标签（对称性断言用） */
  effectLabels(): string[]
}

/* ============================================================
 * 默认模块装载器
 * ============================================================ */

/**
 * 装载插件 Host 半模块。
 *
 * **格式规则（与 Node 原生语义一致，不做魔法）**：
 *  · `main.cjs` → CJS；`main.mjs` → ESM；
 *  · `main.js`  → 由**最近的 package.json 的 `type`** 决定。为了让作者不必
 *    关心上层目录，`store.ensurePluginsDir()` 会在插件根目录补一份
 *    `{"type":"commonjs"}` —— 因此 `.js` 缺省就是 CJS（与 VS Code 同款抉择）；
 *  · 想在 `.js` 里写 `export function apply` 的作者有两条正路：改名为 `.mjs`，
 *    或在自己的插件目录放一份 `{"type":"module"}` 的 package.json。
 *
 * 为什么要在 `.js` 上**预检 ESM 语法**：Node 抛的是
 * `SyntaxError: Unexpected token 'export'`，作者拿到这句话根本不知道要改名。
 * 我们提前拦下来，给一条能照做的指令（纪律⑦：静默/晦涩退化必须换成人话）。
 */
export async function defaultLoadModule(absPath: string, mainEntry: string): Promise<unknown> {
  const ext = extname(absPath).toLowerCase()
  if (ext === '.ts' || ext === '.tsx') {
    throw new RpcError(
      RPC_ERROR.E_MODULE_FORMAT,
      `Host 半入口「${mainEntry}」是 TypeScript，宿主不内置转译器`,
      { fix: '先编译成 .js/.cjs/.mjs 再放进插件目录' },
    )
  }
  if (ext === '.js' || ext === '') {
    let src = ''
    try {
      src = await readFile(absPath, 'utf-8')
    } catch {
      src = ''
    }
    if (/^\s*(?:export|import)\s/m.test(src)) {
      throw new RpcError(
        RPC_ERROR.E_MODULE_FORMAT,
        `Host 半入口「${mainEntry}」用了 ESM 语法，但 .js 在本插件目录下按 CommonJS 解析`,
        { fix: `改名为 ${mainEntry.replace(/\.js$/, '')}.mjs，或改用 CommonJS（module.exports = { apply }）` },
      )
    }
  }
  return await import(pathToFileURL(absPath).href)
}

/** 从装载结果里取 `apply`（兼容 `export function apply` / `module.exports = {apply}` / `export default`） */
export function pickApply(mod: unknown): ((ctx: unknown) => unknown) | null {
  const candidates: unknown[] = []
  if (mod && typeof mod === 'object') {
    const m = mod as Record<string, unknown>
    candidates.push(m.apply)
    const def = m.default
    if (def && typeof def === 'object') candidates.push((def as Record<string, unknown>).apply)
    else if (typeof def === 'function') candidates.push(def)
  } else if (typeof mod === 'function') {
    candidates.push(mod)
  }
  const hit = candidates.find((c) => typeof c === 'function')
  return hit ? (hit as (ctx: unknown) => unknown) : null
}

/* ============================================================
 * 运行时工厂
 * ============================================================ */

const isFn = (v: unknown): v is (...a: unknown[]) => unknown => typeof v === 'function'

export function createHostRuntime(deps: HostRuntimeDeps): HostRuntime {
  const { endpoint } = deps
  const loadModule = deps.loadModule ?? ((abs: string, rel: string) => defaultLoadModule(abs, rel))
  const storageQuota = deps.storageQuotaBytes ?? 256 * 1024
  const invokeTimeoutMs = deps.invokeTimeoutMs ?? 0

  /* ---------- 状态 ---------- */
  let prepared = false
  let activated = false
  let pluginId: string | null = null
  let pluginDir = ''
  let manifest: Record<string, unknown> = {}
  let permissions: ReadonlySet<string> = new Set()
  let apply: ((ctx: unknown) => unknown) | null = null

  /* ---------- 插件侧 effect 账（逆序撤销，逐条隔离） ---------- */
  const effects: Array<{ label: string; dispose: () => unknown }> = []

  /**
   * ★ **拆解窗口**标志（本版实测暴露的竞态，记 D79）。
   *
   * 病：`ctx.ark.tools.register()` 是异步的（要经网关上行），作者完全可以
   * **不 await** 它 —— 于是 `apply` 抛错 / `host/dispose` 时，注销已经跑完，
   * 而那条 pending 的注册才姗姗落地，在账本上**追加一条新记录**。
   * 结果就是「撤销后账本非空」—— 撤销白做，纪律⑬的对称性断言直接失效。
   *
   * 治法：**把「注册有效」与「激活在效期」绑成一件事** —— 单一标志 `activationLive`。
   *  · `host/activate` 开始 → 置 true；
   *  · `revokeLocalEffects()` 开始 → 置 false，且**直到下一次 activate 之前不再置 true**。
   *  任何注册（含 ctx.effect）在落地时若 `activationLive === false`，当场自我了断。
   *
   *  为什么试过两种更弱的判据都不够（都被 TC-PLG2-060/061 钉住）：
   *   ① 只看「撤销函数的执行期」（最早的写法）：那条 pending 注册往往在撤销循环
   *      **退出之后**才落地（它还差几个微任务），窗口早已关闭 → 漏网；
   *   ② 再加「世代号」：能挡住「撤销**之前**发起、之后落地」的注册，却挡不住
   *      「撤销**期间**发起、之后落地」的 —— 它记下的就是新一代的号，比对必然相等 → 仍漏网。
   *  真正正确的不变量是**生命周期**（这次激活还算不算数），而不是时序。
   */
  let activationLive = false

  const recordEffect = (kind: string, label: string, dispose: () => unknown): (() => void) => {
    if (!activationLive) {
      try {
        void dispose()
      } catch {
        /* 迟到注册的自我了断失败：不抛给插件 */
      }
      return () => {}
    }
    const entry = { label: `${kind}:${label}`, dispose }
    effects.push(entry)
    return () => {
      const i = effects.indexOf(entry)
      if (i >= 0) effects.splice(i, 1)
      try {
        void entry.dispose()
      } catch {
        /* 主动提前释放失败：不抛给插件（dispose 全流程还会再兜一次） */
      }
    }
  }

  /* ---------- 注册表（宿主侧真源在主进程；这里的表只用于「本进程内可路由」） ---------- */
  const toolHandlers = new Map<string, (input: unknown) => unknown>()
  const viewRegIds = new Map<string, number>()
  const panelRegIds = new Map<string, number>()
  const eventHandlers = new Map<string, Set<(payload: unknown) => unknown>>()
  const storage = new Map<string, string>()
  let storageBytes = 0

  /* ---------- 反向调用（host → main）的应答登记 ---------- */
  let nextId = 1
  const pendingInvokes = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: unknown }
  >()

  function invokeMain(cap: ArkCap | string, params?: unknown): Promise<unknown> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer =
        invokeTimeoutMs > 0
          ? deps.setTimer?.(() => {
              pendingInvokes.delete(id)
              reject(new RpcError(RPC_ERROR.E_TIMEOUT, `能力调用 ${cap} 超时（${invokeTimeoutMs}ms）`, { cap }))
            }, invokeTimeoutMs)
          : undefined
      pendingInvokes.set(id, { resolve, reject, timer })
      endpoint.send({ kind: 'invoke', id, cap, ...(params === undefined ? {} : { params }) })
    })
  }

  /** 薄封装：缺权限由主进程判定（Host 半无权也不该自行放宽），这里只透传 */
  const cap = (name: ArkCap, params?: unknown): Promise<unknown> => invokeMain(name, params)

  /* ---------- ctx：插件作者唯一能看到的东西 ---------- */
  const ctx = {
    get manifest(): Readonly<Record<string, unknown>> {
      return manifest
    },
    /** ★ 相对文档的**放宽**（D78-b）：返回 Disposer 而非 void —— 作者可提前释放，纯增益 */
    effect(disposer: unknown): () => void {
      if (!isFn(disposer)) {
        throw new RpcError(RPC_ERROR.E_EFFECT_INVALID, 'ctx.effect 需要一个函数（撤销函数）')
      }
      return recordEffect('effect', `#${effects.length + 1}`, disposer as () => unknown)
    },
    on(event: unknown, handler: unknown): () => void {
      if (typeof event !== 'string' || !isFn(handler)) {
        throw new RpcError(RPC_ERROR.E_EVENT_UNKNOWN, 'ctx.on(event, handler) 需要 (string, function)')
      }
      // 事件名闭集：未登记即报错。为什么不在主进程兜：作者写错事件名时
      // 「静默不触发」是最难查的一类 bug（纪律⑦）。
      if (!KNOWN_EVENTS.has(event)) {
        throw new RpcError(RPC_ERROR.E_EVENT_UNKNOWN, `未知宿主事件「${event}」`, {
          fix: `可选：${Array.from(KNOWN_EVENTS).join(' / ')}`,
        })
      }
      let set = eventHandlers.get(event)
      if (!set) {
        set = new Set()
        eventHandlers.set(event, set)
      }
      const fn = handler as (p: unknown) => unknown
      set.add(fn)
      const off = (): void => {
        set!.delete(fn)
      }
      recordEffect('listener', event, off)
      return off
    },
    ark: {
      /** 日志是单向通知（无应答）—— 不该让一条日志把调用链卡住 */
      log(level: unknown, msg: unknown, data?: unknown): void {
        endpoint.send(notify('host/log', { level: String(level ?? 'info'), msg: String(msg ?? ''), data }))
      },
      workspace: {
        root: (): Promise<unknown> => cap('workspace.root'),
      },
      fs: {
        read: (rel: unknown): Promise<unknown> => cap('fs.read', { rel }),
        write: (rel: unknown, text: unknown): Promise<unknown> => cap('fs.write', { rel, text }),
        list: (rel: unknown): Promise<unknown> => cap('fs.list', { rel }),
      },
      net: {
        fetch: (url: unknown, init?: unknown): Promise<unknown> => cap('net.fetch', { url, init }),
      },
      shell: {
        run: (cmd: unknown, args?: unknown, opts?: unknown): Promise<unknown> =>
          cap('shell.run', { cmd, args, opts }),
      },
      tools: {
        register: (def: unknown): Promise<unknown> => registerTool(def),
      },
      views: {
        register: (def: unknown): Promise<unknown> => registerView(def),
      },
      panels: {
        register: (def: unknown): Promise<unknown> => registerPanel(def),
      },
      storage: {
        get: async (key: unknown): Promise<unknown> => {
          const k = String(key)
          const local = storage.get(k)
          if (local !== undefined) return JSON.parse(local) as unknown
          return await cap('storage.get', { key: k })
        },
        set: async (key: unknown, value: unknown): Promise<void> => {
          const k = String(key)
          let json: string
          try {
            json = JSON.stringify(value) ?? 'null'
          } catch {
            throw new RpcError(RPC_ERROR.E_INTERNAL, 'storage.set 的值无法序列化为 JSON')
          }
          const prev = storage.get(k) ?? ''
          const next = storageBytes - prev.length + json.length
          if (next > storageQuota) {
            throw new RpcError(
              RPC_ERROR.E_STORAGE_QUOTA,
              `插件私有存储超出容量上限（${storageQuota} 字节）`,
              { used: storageBytes, incoming: json.length, quota: storageQuota },
            )
          }
          storageBytes = next
          storage.set(k, json)
          await cap('storage.set', { key: k, value })
        },
        delete: async (key: unknown): Promise<void> => {
          const k = String(key)
          const prev = storage.get(k)
          if (prev !== undefined) {
            storageBytes -= prev.length
            storage.delete(k)
          }
          await cap('storage.delete', { key: k })
        },
      },
      /** 向本插件的 Client 半推事件（无 Client 半时主进程静默丢弃 + debug 日志） */
      renderer: {
        post: (payload: unknown): void => {
          endpoint.send(notify('host/log', { level: 'debug', msg: 'ark:to-client', data: payload }))
          void cap('renderer.post', { payload }).catch(() => {})
        },
      },
    },
  }

  const KNOWN_EVENTS = new Set<string>([
    'workspace:opened',
    'workspace:changed',
    'workspace:closing',
    'theme:changed',
    'host:theme-changed',
  ])

  /* ---------- 工具 / 视图 / 面板注册 ---------- */

  async function registerTool(def: unknown): Promise<() => void> {
    if (!def || typeof def !== 'object') {
      throw new RpcError(RPC_ERROR.E_INTERNAL, 'tools.register 需要 { name, description, inputSchema, handler }')
    }
    const d = def as Record<string, unknown>
    const name = String(d.name ?? '')
    if (!name || !isFn(d.handler)) {
      throw new RpcError(RPC_ERROR.E_INTERNAL, 'tools.register 需要 name 与 handler(函数)')
    }
    if (toolHandlers.has(name)) {
      throw new RpcError(RPC_ERROR.E_TOOL_NAME_TAKEN, `工具名「${name}」已被本插件注册`)
    }
    // 主进程负责「名字是否在清单声明中」的判定（E_TOOL_UNDECLARED）与全局唯一性
    const regId = (await cap('tools.register', {
      name,
      description: String(d.description ?? ''),
      inputSchema: d.inputSchema ?? { type: 'object', properties: {} },
    })) as { regId?: number } | undefined
    // ★ D79：激活已失效 → 当场撤掉，绝不进账本（否则「撤销后账本非空」）
    if (!activationLive) {
      await cap('tools.unregister', { regId: regId?.regId, name }).catch(() => {})
      return () => {}
    }
    toolHandlers.set(name, d.handler as (i: unknown) => unknown)
    return recordEffect('tool', name, () => {
      toolHandlers.delete(name)
      return cap('tools.unregister', { regId: regId?.regId, name }).catch(() => {})
    })
  }

  async function registerView(def: unknown): Promise<() => void> {
    if (!def || typeof def !== 'object') throw new RpcError(RPC_ERROR.E_INTERNAL, 'views.register 需要对象')
    const d = def as Record<string, unknown>
    const viewRef = String(d.viewRef ?? '')
    if (!viewRef) throw new RpcError(RPC_ERROR.E_INTERNAL, 'views.register 需要 viewRef')
    if (d.placement !== 'dock' && d.placement !== 'float') {
      // 边界纪律：插件只控浮窗与右侧侧边栏。闭集判定，别的值一律拒。
      throw new RpcError(RPC_ERROR.E_VIEW_UNDECLARED, '视图 placement 只能是 "dock"（右侧侧边栏）或 "float"（浮窗）')
    }
    const res = (await cap('views.register', {
      viewRef,
      title: String(d.title ?? viewRef),
      icon: d.icon === undefined ? undefined : String(d.icon),
      renderer: d.renderer === undefined ? undefined : String(d.renderer),
      placement: d.placement,
    })) as { regId?: number } | undefined
    if (!activationLive) {
      await cap('views.unregister', { regId: res?.regId, viewRef }).catch(() => {})
      return () => {}
    }
    viewRegIds.set(viewRef, res?.regId ?? 0)
    return recordEffect('view', viewRef, () => {
      viewRegIds.delete(viewRef)
      return cap('views.unregister', { regId: res?.regId, viewRef }).catch(() => {})
    })
  }

  async function registerPanel(def: unknown): Promise<() => void> {
    if (!def || typeof def !== 'object') throw new RpcError(RPC_ERROR.E_INTERNAL, 'panels.register 需要对象')
    const d = def as Record<string, unknown>
    const panelRef = String(d.panelRef ?? '')
    if (!panelRef) throw new RpcError(RPC_ERROR.E_INTERNAL, 'panels.register 需要 panelRef')
    const res = (await cap('panels.register', d)) as { regId?: number } | undefined
    if (!activationLive) {
      await cap('panels.unregister', { regId: res?.regId, panelRef }).catch(() => {})
      return () => {}
    }
    panelRegIds.set(panelRef, res?.regId ?? 0)
    return recordEffect('panel', panelRef, () => {
      panelRegIds.delete(panelRef)
      // 面板卸载走与工具/视图并列的第三条通道：主进程按 regId 精确摘除
      return cap('panels.unregister', { regId: res?.regId, panelRef }).catch(() => {})
    })
  }

  /* ---------- 撤销（纪律⑬的插件侧实现） ---------- */
  async function revokeLocalEffects(): Promise<{ revoked: number; failed: string[] }> {
    const failed: string[] = []
    let revoked = 0
    activationLive = false // ★ D79：本次激活就此失效，之后落地的注册一律自我了断
    try {
      while (effects.length > 0) {
        const e = effects.pop()!
        try {
          await e.dispose()
          revoked += 1
        } catch (err) {
          failed.push(`${e.label} → ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      /* 刻意不在此处复位 activationLive：失效是**单向**的，
       * 只有下一次 host/activate 才能重新开启（见 D79 的两种失败判据）。 */
    }
    eventHandlers.clear()
    return { revoked, failed }
  }

  /* ---------- 方法派发 ---------- */

  async function onPrepare(params: unknown): Promise<unknown> {
    if (prepared) return { pluginId, reused: true }
    const p = (params ?? {}) as Partial<PrepareParams>
    pluginId = String(p.pluginId ?? '')
    pluginDir = String(p.dir ?? '')
    manifest = (p.manifest ?? {}) as Record<string, unknown>
    permissions = new Set(Array.isArray(p.permissions) ? p.permissions.map(String) : [])
    if (!pluginId || !pluginDir) {
      throw new RpcError(RPC_ERROR.E_NOT_PREPARED, 'host/prepare 需要 pluginId 与 dir')
    }
    const mainEntry = typeof manifest.main === 'string' ? manifest.main : ''
    if (mainEntry) {
      const abs = joinInside(pluginDir, mainEntry)
      let mod: unknown
      try {
        mod = await loadModule(abs, mainEntry)
      } catch (err) {
        if (err instanceof RpcError) throw err
        throw new RpcError(RPC_ERROR.E_MODULE_LOAD, `装载 ${mainEntry} 失败：${err instanceof Error ? err.message : String(err)}`)
      }
      apply = pickApply(mod)
      if (!apply) {
        throw new RpcError(RPC_ERROR.E_NO_APPLY, `Host 半入口 ${mainEntry} 没有导出 apply(ctx)`, {
          fix: 'module.exports = { apply } 或 export function apply(ctx) { … }（ESM 请用 .mjs）',
        })
      }
    }
    prepared = true
    return { pluginId }
  }

  async function onActivate(): Promise<unknown> {
    if (!prepared) throw new RpcError(RPC_ERROR.E_NOT_PREPARED, 'host/activate 之前必须先 host/prepare')
    if (!apply) return { activated: false, reason: 'no-host-half' } // 纯 UI/声明式插件：合法
    if (activated) return { activated: true, reused: true }
    const t0 = Date.now()
    activationLive = true // ★ D79：本次激活开始，注册重新被接受
    try {
      await apply(ctx)
    } catch (err) {
      // 绝不半注册：抛错即把插件侧已登记的 effect 全部撤掉
      await revokeLocalEffects()
      throw new RpcError(
        RPC_ERROR.E_ACTIVATION_FAILED,
        `apply(ctx) 执行失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    activated = true
    return { activated: true, ms: Date.now() - t0, effects: effects.length }
  }

  async function onToolCall(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { name?: string; input?: unknown }
    const name = String(p.name ?? '')
    const h = toolHandlers.get(name)
    if (!h) throw new RpcError(RPC_ERROR.E_NOT_FOUND, `插件未注册工具「${name}」`, { fix: '在 apply(ctx) 里 ctx.ark.tools.register(...)' })
    return await h(p.input)
  }

  async function onDispose(): Promise<unknown> {
    const r = await revokeLocalEffects()
    activated = false
    return r
  }

  function joinInside(dir: string, rel: string): string {
    // 与主进程的 realpath 校验互补：这里只做**形状**兜底（`..` 已经在 VP10 拦过，
    // 但 Host 半不能假设主进程一定校验过 —— 纵深防御，代价只有一次字符串检查）
    if (rel.split('/').some((s) => s === '..' || s === '' || s === '.')) {
      throw new RpcError(RPC_ERROR.E_MODULE_LOAD, `入口路径「${rel}」含非法段`)
    }
    return `${dir.replace(/[/\\]+$/, '')}/${rel}`
  }

  /* ---------- 入站分发 ---------- */

  function handleMessage(msg: WireMessage): void {
    if (msg.kind === 'reply') {
      const p = pendingInvokes.get(msg.id)
      if (!p) return
      pendingInvokes.delete(msg.id)
      if (p.timer !== undefined) deps.clearTimer?.(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new RpcError(msg.error?.code ?? RPC_ERROR.E_INTERNAL, msg.error?.message ?? '未知错误', msg.error?.data))
      return
    }
    if (msg.kind === 'rpc') {
      void dispatchRpc(msg.id, msg.method, msg.params)
    }
    // invoke / notify 是 host → main 方向，Host 半收到即丢弃（不回声、不报错）
  }

  async function dispatchRpc(id: number, method: string, params: unknown): Promise<void> {
    try {
      switch (method) {
        case 'host/prepare':
          endpoint.send(replyOk(id, await onPrepare(params)))
          return
        case 'host/activate':
          endpoint.send(replyOk(id, await onActivate()))
          return
        case 'host/tool-call':
          endpoint.send(replyOk(id, await onToolCall(params)))
          return
        case 'host/dispose': {
          const r = await onDispose()
          endpoint.send(replyOk(id, r))
          return
        }
        case 'host/emit': {
          const p = (params ?? {}) as { event?: string; payload?: unknown }
          const set = eventHandlers.get(String(p.event ?? ''))
          if (set) {
            for (const h of Array.from(set)) {
              try {
                await h(p.payload)
              } catch (err) {
                // 单个监听器抛错不得影响其它监听器，也不得让主进程收到「emit 失败」
                endpoint.send(notify('host/log', { level: 'warn', msg: `事件 ${p.event} 的监听器抛错：${String(err)}` }))
              }
            }
          }
          endpoint.send(replyOk(id, { delivered: set?.size ?? 0 }))
          return
        }
        default:
          throw new RpcError(RPC_ERROR.E_NOT_FOUND, `未知方法「${method}」`)
      }
    } catch (err) {
      endpoint.send(replyErr(id, toErrorPayload(err)))
    }
  }

  /* ---------- 崩溃上报 ---------- */

  function installCrashHooks(): void {
    const proc = (globalThis as { process?: NodeJS.Process }).process
    if (!proc) return
    proc.on('uncaughtException', (err: unknown) => {
      endpoint.send(notify('host/error', { phase: 'runtime', ...toErrorPayload(err) }))
    })
    proc.on('unhandledRejection', (reason: unknown) => {
      endpoint.send(notify('host/error', { phase: 'runtime', ...toErrorPayload(reason) }))
    })
  }

  /* ---------- 心跳 ---------- */

  let beatTimer: unknown
  function stopHeartbeat(): void {
    if (beatTimer !== undefined) {
      deps.clearTimer?.(beatTimer)
      beatTimer = undefined
    }
  }

  function startHeartbeat(ms?: number): void {
    const every = ms ?? deps.heartbeatMs ?? 0
    if (every <= 0) return
    stopHeartbeat()
    const tick = (): void => {
      endpoint.send(notify('host/heartbeat', { at: Date.now() }))
      beatTimer = deps.setTimer?.(tick, every)
    }
    beatTimer = deps.setTimer?.(tick, every)
  }

  /* ★ 端点自挂：工厂**自己**订阅，而不是让调用方记得去挂。
   *   忘记挂订阅的表现是「插件毫无反应且不报错」—— 属于最难查的一类。
   *   把订阅收进工厂，bootstrap 与测试就都不可能漏。 */
  endpoint.onMessage(handleMessage)

  return {
    handleMessage,
    installCrashHooks,
    startHeartbeat,
    stopHeartbeat,
    state: () => ({
      pluginId,
      prepared,
      activated,
      effects: effects.length,
      registeredTools: Array.from(toolHandlers.keys()),
      registeredViews: Array.from(viewRegIds.keys()),
      registeredPanels: Array.from(panelRegIds.keys()),
      storageBytes,
    }),
    effectLabels: () => effects.map((e) => e.label),
  }
}

/** 供 `host-entry` 与测试复用的入口签名 */
export type PluginApply = (ctx: unknown) => unknown
/** 反向调用报文的窄化工具（主进程侧用） */
export const isInvokeMsg = (m: WireMessage): m is InvokeMsg => m.kind === 'invoke'
