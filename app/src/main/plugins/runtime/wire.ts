/* ============================================================
 * ArkWork — 插件运行时线协议（v0.35.0 · M6/M7 的通信面）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §5.4 / §6
 *
 * 一句话：**主进程与 Host 半（utilityProcess）之间只有这一种报文**。
 *   没有第二通信面 —— 这正是纪律⑫「代码只要没有后门」的物理落地。
 *
 * 三种报文（kind 判别）：
 *   · `rpc`    main → host  一次方法调用（prepare / activate / tool-call / dispose / emit）
 *   · `reply`  双向         对 `rpc` 或 `invoke` 的应答（ok / error 二选一）
 *   · `invoke` host → main  **反向能力调用**（`ctx.ark.fs.read` 等由插件主动发起）
 *   · `notify` host → main  单向通知（日志 / 未捕获异常 / 心跳）
 *
 * ★ 缺陷回溯（D78）：设计文档 §5.4 把 `host/invoke` 写成「main→host 转发能力调用」，
 *   方向是反的 —— 能力调用**必然由 Host 半发起**（是插件在调 `ctx.ark.fs.read`），
 *   main 只是应答方。本文按正确方向实现，并把该行改写为 `ark/invoke`（host→main）。
 *   同时补上文档未列的 `host/emit`（main→host 推宿主事件，供 `ctx.on` 消费）。
 *
 * 本文件是**零依赖纯模块**（不 import electron / fs），因此 node:test 可直接覆盖
 * 报文的编解码、超时判定与端点适配 —— 这是 IP1 要求的「可注入依赖」。
 * ============================================================ */

/* ============================================================
 * 错误码（两侧共用；字符串常量而非 enum —— 跨进程序列化后必须可读）
 * ============================================================ */
export const RPC_ERROR = {
  /* 装载期 */
  E_MODULE_LOAD: 'E_MODULE_LOAD',
  E_MODULE_FORMAT: 'E_MODULE_FORMAT',
  E_NO_APPLY: 'E_NO_APPLY',
  E_ACTIVATION_FAILED: 'E_ACTIVATION_FAILED',
  E_ACTIVATION_TIMEOUT: 'E_ACTIVATION_TIMEOUT',
  E_NOT_PREPARED: 'E_NOT_PREPARED',
  /* 能力网关 */
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  E_TOOL_UNDECLARED: 'E_TOOL_UNDECLARED',
  E_VIEW_UNDECLARED: 'E_VIEW_UNDECLARED',
  E_TOOL_NAME_TAKEN: 'E_TOOL_NAME_TAKEN',
  E_VIEW_REF_TAKEN: 'E_VIEW_REF_TAKEN',
  E_NO_WORKSPACE: 'E_NO_WORKSPACE',
  E_PATH_OUTSIDE_WORKSPACE: 'E_PATH_OUTSIDE_WORKSPACE',
  E_CONFLICT: 'E_CONFLICT',
  E_STORAGE_QUOTA: 'E_STORAGE_QUOTA',
  E_SHELL_REFUSED: 'E_SHELL_REFUSED',
  E_NOT_FOUND: 'E_NOT_FOUND',
  /* 调用期 */
  E_TIMEOUT: 'E_TIMEOUT',
  E_EFFECT_INVALID: 'E_EFFECT_INVALID',
  E_EVENT_UNKNOWN: 'E_EVENT_UNKNOWN',
  E_HOST_DEAD: 'E_HOST_DEAD',
  E_INTERNAL: 'E_INTERNAL',
} as const
export type RpcErrorCode = (typeof RPC_ERROR)[keyof typeof RPC_ERROR]

/** 可跨进程传播的错误载荷（Error 实例过不去 MessagePort） */
export interface RpcErrorPayload {
  code: RpcErrorCode | string
  message: string
  /** 附加诊断（如超时 ms、越界路径）；**绝不放栈**（避免给插件探测宿主结构的机会） */
  data?: Record<string, unknown>
}

/** 宿主侧抛出的、带错误码的错误（网关与运行时统一用它） */
export class RpcError extends Error {
  readonly code: RpcErrorCode | string
  readonly data?: Record<string, unknown>
  constructor(code: RpcErrorCode | string, message: string, data?: Record<string, unknown>) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
  toPayload(): RpcErrorPayload {
    return { code: this.code, message: this.message, ...(this.data ? { data: this.data } : {}) }
  }
}

/** 任意 unknown 错误 → 可传播载荷（永不抛） */
export function toErrorPayload(err: unknown): RpcErrorPayload {
  if (err instanceof RpcError) return err.toPayload()
  if (err instanceof Error) return { code: RPC_ERROR.E_INTERNAL, message: err.message }
  return { code: RPC_ERROR.E_INTERNAL, message: String(err) }
}

/* ============================================================
 * 报文形状
 * ============================================================ */

/** main → host 的方法名（闭集；不在集合内的 method 一律 E_NOT_FOUND） */
export const HOST_METHODS = ['host/prepare', 'host/activate', 'host/tool-call', 'host/dispose', 'host/emit'] as const
export type HostMethod = (typeof HOST_METHODS)[number]

/** host → main 的反向能力名（闭集；与 `ctx.ark.*` 一一对应） */
export const ARK_CAPS = [
  'log',
  'workspace.root',
  'fs.read',
  'fs.write',
  'fs.list',
  'net.fetch',
  'shell.run',
  'tools.register',
  'tools.unregister',
  'views.register',
  'views.unregister',
  'panels.register',
  'panels.unregister',
  'storage.get',
  'storage.set',
  'storage.delete',
  'renderer.post',
] as const
export type ArkCap = (typeof ARK_CAPS)[number]

/** host → main 的单向通知（无应答） */
export const HOST_NOTIFIES = ['host/log', 'host/error', 'host/heartbeat'] as const
export type HostNotify = (typeof HOST_NOTIFIES)[number]

/** `ctx.on` 可监听的宿主事件（闭集；未登记 → E_EVENT_UNKNOWN） */
export const HOST_EVENTS = [
  'workspace:opened',
  'workspace:changed',
  'workspace:closing',
  'theme:changed',
  'host:theme-changed', // 别名（文档用名），与 theme:changed 同源
] as const
export type HostEvent = (typeof HOST_EVENTS)[number]

export interface RpcRequestMsg {
  kind: 'rpc'
  id: number
  method: HostMethod | string
  params?: unknown
}
export interface InvokeMsg {
  kind: 'invoke'
  id: number
  cap: ArkCap | string
  params?: unknown
}
export interface ReplyMsg {
  kind: 'reply'
  id: number
  ok: boolean
  result?: unknown
  error?: RpcErrorPayload
}
export interface NotifyMsg {
  kind: 'notify'
  method: HostNotify | string
  params?: unknown
}
export type WireMessage = RpcRequestMsg | InvokeMsg | ReplyMsg | NotifyMsg

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 报文判别（**入站必须过这一关**：坏报文一律丢弃，不进 handler） */
export function isWireMessage(v: unknown): v is WireMessage {
  if (!isObj(v)) return false
  switch (v.kind) {
    case 'rpc':
    case 'invoke':
      return typeof v.id === 'number' && Number.isFinite(v.id) && typeof (v as { method?: unknown }).method === 'string'
        ? true
        : typeof (v as { cap?: unknown }).cap === 'string'
    case 'reply':
      return typeof v.id === 'number' && typeof v.ok === 'boolean'
    case 'notify':
      return typeof v.method === 'string'
    default:
      return false
  }
}

export const rpcRequest = (id: number, method: HostMethod | string, params?: unknown): RpcRequestMsg => ({
  kind: 'rpc',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})
export const invoke = (id: number, cap: ArkCap | string, params?: unknown): InvokeMsg => ({
  kind: 'invoke',
  id,
  cap,
  ...(params === undefined ? {} : { params }),
})
export const replyOk = (id: number, result?: unknown): ReplyMsg => ({ kind: 'reply', id, ok: true, result })
export const replyErr = (id: number, error: RpcErrorPayload): ReplyMsg => ({ kind: 'reply', id, ok: false, error })
export const notify = (method: HostNotify | string, params?: unknown): NotifyMsg => ({ kind: 'notify', method, params })

/* ============================================================
 * 端点抽象（IP1：可注入依赖 —— 测试用内存端点，生产用 MessagePort 适配器）
 * ============================================================ */

/**
 * 一条消息端点。
 *
 * 为什么要抽象这一层：生产环境 Host 半用 `process.parentPort`、主进程用
 * `UtilityProcess` 实例，两者的 `on('message')` 语义**不对称**
 * （子进程收到 `{data}` 包装、主进程直接收到值）。把这层差异吃掉之后，
 * 运行时的全部逻辑都能在 node:test 里用内存端点跑到。
 */
export interface WireEndpoint {
  send(msg: WireMessage): void
  onMessage(handler: (msg: WireMessage) => void): void
  close(): void
}

/** 父进程侧：Electron `UtilityProcess`（`on('message')` 直接给值） */
export function endpointFromUtilityProcess(child: {
  postMessage(msg: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): void
}): WireEndpoint {
  return {
    send: (m) => child.postMessage(m),
    onMessage: (h) =>
      child.on('message', (...args: unknown[]) => {
        if (isWireMessage(args[0])) h(args[0])
      }),
    close: () => {},
  }
}

/** 子进程侧：`process.parentPort`（`on('message')` 给 `{data}` 包装） */
export function endpointFromParentPort(pp: {
  postMessage(msg: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): void
  start?(): void
}): WireEndpoint {
  return {
    send: (m) => pp.postMessage(m),
    onMessage: (h) =>
      pp.on('message', (...args: unknown[]) => {
        const first = args[0] as { data?: unknown } | undefined
        const payload = first && typeof first === 'object' && 'data' in first ? first.data : first
        if (isWireMessage(payload)) h(payload)
      }),
    close: () => {},
  }
}

/**
 * 测试用：造一对**互相连通**的内存端点。
 *
 * `asyncDelivery: true`（缺省）时经 `queueMicrotask` 投递 —— 这才符合真实
 * MessagePort 的行为（**永不同步回调**）。用它写用例能顺手抓出
 * 「靠同步回调才成立」的隐性时序依赖。
 *
 * `onMessage` 允许**多次注册**（与 EventEmitter 一致）：用例常常需要
 * 「一个 handler 记录全部报文 + 另一个 handler 等某个 id 的应答」。
 */
export function makeLinkedEndpoints(opts: { asyncDelivery?: boolean } = {}): {
  a: WireEndpoint
  b: WireEndpoint
  /** 已投递但未处理的消息条数（异步模式下用来断言「真的异步」） */
  pendingCount(): number
} {
  const handlers: Record<'a' | 'b', Array<(m: WireMessage) => void>> = { a: [], b: [] }
  let pending = 0

  const deliver = (which: 'a' | 'b', msg: WireMessage): void => {
    const run = (): void => {
      pending -= 1
      for (const h of [...handlers[which]]) h(msg)
    }
    if (opts.asyncDelivery === false) run()
    else {
      pending += 1
      queueMicrotask(run)
    }
  }

  const make = (self: 'a' | 'b', peer: 'a' | 'b'): WireEndpoint => ({
    send: (m) => deliver(peer, m),
    onMessage: (h) => {
      handlers[self].push(h)
    },
    close: () => {
      handlers[self] = []
    },
  })

  return { a: make('a', 'b'), b: make('b', 'a'), pendingCount: () => pending }
}

/* ============================================================
 * 超时常量（唯一真源：supervisor 与文档 §5.4 都用这里）
 * ============================================================ */
export const RPC_TIMEOUTS = {
  /** host/prepare：装载模块（5s） */
  prepareMs: 5_000,
  /** host/activate：跑 apply(ctx)（5s） */
  activateMs: 5_000,
  /** 反向能力调用（15s；清单可用 ctxTimeoutMs 覆盖，上限 60s） */
  invokeMs: 15_000,
  invokeMsMax: 60_000,
  /** host/tool-call：模型工具落到插件 handler（30s） */
  toolCallMs: 30_000,
  /** host/dispose：插件侧逆序撤销（3s；超时即 kill） */
  disposeMs: 3_000,
  /** 心跳间隔与判死阈值（连续 3 次缺失判死） */
  heartbeatMs: 3_000,
  heartbeatMissLimit: 3,
  /** 空闲回收（5 分钟；再次激活即重建） */
  idleRecycleMs: 5 * 60_000,
} as const

/** 常驻激活事件（决定「启动时是否立刻装载」） */
export const PERSISTENT_ACTIVATION_EVENTS = ['onStartup', 'onWorkspaceOpen'] as const

/**
 * 父进程 fork Host 半时注入的环境变量标记（唯一真源）。
 *
 * 为什么需要它：`host-entry.ts` 在被 `import` 时就要判断「我是不是那个被
 * fork 起来的子进程」。靠 `process.parentPort` 存在与否判不准（测试运行器
 * 也可能有同名端口语义），会让单测被一段无关的 bootstrap 噪音污染。
 * 显式标记还有个好处：**「谁启动了 Host 半」变成可追的事实**。
 */
export const HOST_ENV_FLAG = 'ARKWORK_PLUGIN_HOST'

/**
 * 该插件是否应在「宿主启动 / 工作区打开」时立刻激活。
 *
 * 语义对齐 VS Code 的 activationEvents：**没命中任何事件 = 不装载**（懒激活，A10）。
 * 例外：声明了 `onStartup` 的插件即便清单里没写其它事件也要立刻起。
 */
export function activationEventsOf(activation: readonly string[] | undefined): string[] {
  return activation ? [...activation] : []
}
