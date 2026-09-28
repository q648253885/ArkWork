/* ============================================================
 * ArkWork — 插件视图桥（v0.35.0 · M13 的纯逻辑半边）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §5.2
 *
 * Client 半跑在 `<iframe sandbox="allow-scripts">` 里（**无 allow-same-origin**
 * → 拿不到宿主 DOM / storage / cookie）。它与宿主之间只有 `postMessage` 一条路，
 * 报文形状就是本文件的契约。
 *
 * 为什么把这块单独抽成 **shared 层的纯模块**：
 *  ① 渲染层的 `PluginViewHost` 与主进程的脚手架模板**必须用同一套方法名与报文形状**
 *     —— 两处各写一份，作者照脚手架写出来的插件就会对接不上（且不会有任何报错）；
 *  ② 它是纯函数/纯类型，node:test 可以直接覆盖，不必起 electron 或渲染环境。
 *
 * 报文（四类）：
 *   宿主 → Client：`{kind:'lifecycle', phase, sessionId, manifest}` 装载/卸载握手
 *   宿主 → Client：`{kind:'event',  payload}`                        Host 半推来的事件
 *   Client → 宿主：`{kind:'call',   id, method, params}`             白名单桥调用
 *   宿主 → Client：`{kind:'reply',  id, ok, result|error}`           统一应答
 *
 * ★ 安全铁律：每次 `call` 由**容器**补上 `sessionId`（来自 lifecycle 握手，
 *   插件自己填的一律忽略）。这样插件无法伪造别人的会话 id。
 * ============================================================ */

/** 桥调用白名单（**唯一真源**；与 `shared/types/ipc.ts` 的 PLUGIN_VIEW_METHODS 同源同序） */
export const BRIDGE_METHODS = [
  'ui.ready',
  'ui.resize',
  'ui.theme.get',
  'ui.toast',
  'ui.openPanel',
  'data.request',
  'storage.get',
  'storage.set',
  // v0.36.0：转发到该插件 Host 半的 `ctx.views.onCall(method, handler)` 注册表 ——
  // params = { method: string, params?: unknown }。Handler 由插件自己的代码注册，
  // 宿主不经手任何业务逻辑（只做搬运与超时），因此不构成额外攻击面。
  'host.call',
] as const
export type BridgeMethod = (typeof BRIDGE_METHODS)[number]

export function isBridgeMethod(m: unknown): m is BridgeMethod {
  return typeof m === 'string' && (BRIDGE_METHODS as readonly string[]).includes(m)
}

/* ============================================================
 * 报文类型
 * ============================================================ */
export interface LifecycleMsg {
  kind: 'lifecycle'
  phase: 'activate' | 'deactivate'
  sessionId: string
  manifest: { id: string; name: string; version: string; permissions?: string[] }
  /**
   * ★ 宿主设计令牌快照（`--bg-base` → `#FFFFFF`…）。
   *
   * 为什么搭在握手报文里而不是让插件自己调 `ui.theme.get`：
   * 白名单方法要等握手完成才能调，而**首帧渲染**就在握手之后立刻发生 ——
   * 插件若不在首帧拿到颜色，就会先闪一帧裸样式（浅色插件在深色宿主里
   * 尤其刺眼）。把令牌随握手一起送到，首帧即正确。
   */
  theme?: Record<string, string>
}

/** `kind:'event'` 的载荷约定：主题变更（宿主切换浅/深时推） */
export const BRIDGE_EVENT_THEME = 'theme'
export interface ThemeEventPayload {
  type: typeof BRIDGE_EVENT_THEME
  tokens: Record<string, string>
}

export interface EventMsg {
  kind: 'event'
  payload: unknown
}

export interface CallMsg {
  kind: 'call'
  id: number
  method: string
  params?: unknown
  /** 由容器注入；插件自填**会被忽略** */
  sessionId?: string
}

export interface ReplyMsg {
  kind: 'reply'
  id: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export type BridgeMsg = LifecycleMsg | EventMsg | CallMsg | ReplyMsg

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 报文判别。**两个方向都过这一关**：iframe 里的是完全不可信代码，
 * 形状不对的报文必须原样丢弃（不进任何分支）。
 */
export function parseBridgeMsg(v: unknown): BridgeMsg | null {
  if (!isObj(v)) return null
  switch (v.kind) {
    case 'lifecycle':
      return v.phase === 'activate' || v.phase === 'deactivate'
        ? (v as unknown as LifecycleMsg)
        : null
    case 'event':
      return v as unknown as EventMsg
    case 'call':
      return typeof v.id === 'number' && typeof v.method === 'string' ? (v as unknown as CallMsg) : null
    case 'reply':
      return typeof v.id === 'number' && typeof v.ok === 'boolean' ? (v as unknown as ReplyMsg) : null
    default:
      return null
  }
}

/* ============================================================
 * 容器侧（PluginViewHost 的纯逻辑）
 * ============================================================ */

/** 给 iframe 注入 sessionId 并把 `call` 送到主进程的传输函数 */
export type CallTransport = (
  sessionId: string,
  method: string,
  params: unknown,
) => Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>

export interface BridgeHostOptions {
  sessionId: string
  /** 把报文投递给 iframe（调用方在拿到 `contentWindow` 后绑定好目标） */
  post(msg: BridgeMsg): void
  /** 把桥调用送到主进程 */
  transport: CallTransport
  /** 诊断（未知方法 / 非白名单调用）；**不回声给插件**，只落宿主的日志 */
  onRejected?: (reason: string, msg: CallMsg) => void
}

export interface BridgeHost {
  /** 处理一条来自 iframe 的原始报文 */
  onMessage(raw: unknown): void
  /** 下发 lifecycle 握手（iframe load 后调 activate；卸载时调 deactivate） */
  handshake(
    phase: 'activate' | 'deactivate',
    manifest: LifecycleMsg['manifest'],
    theme?: Record<string, string>,
  ): void
  /** 下发一条事件（Host 半 `renderer.post` 的下游） */
  pushEvent(payload: unknown): void
}

/**
 * 容器侧的报文处理器。
 *
 * 只负责三件事：**白名单过滤 → 补 sessionId 转发 → 回 reply**。
 * 任何「插件自填的 sessionId」都在这里被**丢弃并覆盖**（安全铁律）。
 */
export function createBridgeHost(opts: BridgeHostOptions): BridgeHost {
  return {
    handshake(phase, manifest, theme) {
      opts.post({
        kind: 'lifecycle',
        phase,
        sessionId: opts.sessionId,
        manifest,
        ...(theme && Object.keys(theme).length > 0 ? { theme } : {}),
      })
    },
    pushEvent(payload) {
      opts.post({ kind: 'event', payload })
    },
    onMessage(raw) {
      const msg = parseBridgeMsg(raw)
      if (!msg || msg.kind !== 'call') return

      if (!isBridgeMethod(msg.method)) {
        opts.onRejected?.(`方法「${msg.method}」不在白名单内`, msg)
        return
      }
      void (async () => {
        // ★ 用容器持有的 sessionId，**忽略**报文里的任何自填值
        const res = await opts.transport(opts.sessionId, msg.method, msg.params)
        opts.post({
          kind: 'reply',
          id: msg.id,
          ok: res.ok,
          ...(res.ok ? { result: res.result } : { error: res.error }),
        })
      })()
    },
  }
}

/* ============================================================
 * Client 半的作者侧助手（脚手架与示例插件共用）
 * ============================================================ */

/**
 * 生成注入到插件 HTML 里的**最小桥客户端**源码。
 *
 * 为什么把它作为「源码字符串」而不是 import：插件目录是纯 JS，没有构建步骤，
 * 不能 `import` 宿主的模块（也不该 —— 那会把宿主源码暴露成插件的依赖）。
 * 脚手架直接把这段贴进 `renderer.js`，作者打开就能看到全部实现（无黑箱）。
 */
export function bridgeClientSource(opts: { pluginName: string }): string {
  return `/* ---------- ArkWork 插件桥客户端（由脚手架生成，可直接改） ----------
 * 你只需要记住两件事：
 *   1. 收到 lifecycle 握手后，用 call(method, params) 调宿主；
 *   2. 宿主推来的事件走 onHostEvent(fn) 回调。
 * 可用的宿主方法（白名单）：${BRIDGE_METHODS.join(' / ')}
 *
 * ⚠️ 本段是**经典脚本**（由 <script src> 加载），不得使用 import / export ——
 *    写了会让整个 renderer.js 语法错误、界面白屏且控制台之外的日志里没有线索。
 * ------------------------------------------------------------- */
const pending = new Map()
let seq = 1
let sessionId = null

/** 调宿主。握手完成前调用会被拒绝。 */
function call(method, params) {
  if (!sessionId) return Promise.reject(new Error('宿主尚未完成握手'))
  const id = seq++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parent.postMessage({ kind: 'call', id, method, params }, '*')
  })
}

const listeners = []
/** 订阅宿主推来的事件 */
function onHostEvent(fn) { listeners.push(fn) }

/**
 * 把宿主设计令牌贴到 :root。
 * 握手报文里就带着首帧要用的令牌，主题切换时再以事件推一次。
 * 插件不必做任何事 —— 这行 if 让你的界面自动跟随宿主深浅色。
 */
function applyTheme(tokens) {
  if (!tokens) return
  const root = document.documentElement
  for (const k of Object.keys(tokens)) root.style.setProperty(k, tokens[k])
}

/** 由插件自己实现的渲染入口（脚手架给了一个最小实现，随便改） */
function render(info) {
  document.getElementById('app').textContent =
    info.name + ' v' + info.version + '（插件 id：' + info.pluginId + '）'
}

window.addEventListener('message', (e) => {
  const m = e.data
  if (!m || typeof m !== 'object') return
  if (m.kind === 'lifecycle') {
    sessionId = m.sessionId
    if (m.phase === 'activate') {
      applyTheme(m.theme)
      void call('ui.ready', { name: ${JSON.stringify(opts.pluginName)} })
      render({ pluginId: m.manifest.id, name: m.manifest.name, version: m.manifest.version })
    } else {
      sessionId = null
    }
    return
  }
  if (m.kind === 'event') {
    // 宿主主题变了：先贴令牌，再交给插件自己的监听器
    if (m.payload && m.payload.type === '${BRIDGE_EVENT_THEME}') applyTheme(m.payload.tokens)
    for (const fn of listeners) fn(m.payload)
    return
  }
  if (m.kind === 'reply') {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.result)
    else p.reject(new Error((m.error && m.error.message) || '调用失败'))
  }
})
`
}
