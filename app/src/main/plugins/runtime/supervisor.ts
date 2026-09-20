/* ============================================================
 * ArkWork — 插件 Host 半会话管理（v0.35.0 · M7）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §3（M7）· §5.4 · §6.1 · §6.3 · §6.4
 *
 * 职责：`pluginId → 一个 utilityProcess` 的全生命周期。
 *   spawn → prepare → activate → (tool-call | emit)* → dispose → kill
 *
 * 四条不可让步的稳定性规则：
 *  ① **每插件独立进程** —— 一个插件 `while(true)` 不卡宿主，也不卡别的插件；
 *  ② **绝不半注册** —— prepare/activate 任一失败，该插件 phase 落 `activation-failed`
 *     且**不产出任何插槽条目**（registry 只看 phase 是否为 active）；
 *  ③ **心跳只在空闲时判死** —— 插件正在跑一次 20s 的合法工具调用时，
 *     心跳当然会停；若照判就变成「正常的慢调用被误杀」。因此**有在途调用即暂停判死**
 *     （这是本版相对文档 §6.4 的一处**加固**，见 D78-c）；
 *  ④ **销毁必然收口** —— 不论正常 dispose、超时、崩溃还是应用退出，
 *     进程都必须死，且只死一次（`killed` 幂等标志）。
 *
 * 依赖注入（IP1）：`spawn` 由外部传入 —— 生产用 `utilityProcess.fork`，
 * 测试用假进程句柄，于是「超时 / 判死 / 崩溃 / 幂等销毁」这些**最容易在真实
 * 环境才炸**的分支可以在 node:test 里逐条断言。
 * ============================================================ */
import {
  RPC_TIMEOUTS,
  RpcError,
  RPC_ERROR,
  HOST_ENV_FLAG,
  endpointFromUtilityProcess,
  rpcRequest,
  toErrorPayload,
} from './wire.js'
import type { WireMessage, ArkCap } from './wire.js'
import type { PluginPermission, PluginRuntimePhase, PluginRuntimeStatus } from '@shared/types/plugin'
import { logger } from '../../system/logger.js'
import { utilityProcess } from 'electron'

/* ============================================================
 * 进程句柄（utilityProcess 的最小投影；测试可替换）
 * ============================================================ */
export interface HostProcessHandle {
  postMessage(msg: unknown): void
  on(event: 'message' | 'exit' | 'error', listener: (...args: unknown[]) => void): void
  kill(): void
  readonly pid?: number
}

export type SpawnHostFn = (opts: { entryPath: string; pluginId: string }) => HostProcessHandle

/** 生产实现：Electron `utilityProcess.fork`（官方定位即「运行不可信服务」） */
export function spawnUtilityProcess(opts: { entryPath: string; pluginId: string }): HostProcessHandle {
  // 延迟 require：本模块被 node:test 直接 import 时不应拉入 electron
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { utilityProcess } = require('electron') as typeof import('electron')
  const child = utilityProcess.fork(opts.entryPath, [], {
    serviceName: `arkwork-plugin:${opts.pluginId}`,
    stdio: 'pipe',
  })
  const tag = `[plugin:${opts.pluginId}]`
  child.stdout?.on('data', (b: Buffer) => logger.info('System', `${tag} ${String(b).trimEnd()}`))
  child.stderr?.on('data', (b: Buffer) => logger.warn('System', `${tag} ${String(b).trimEnd()}`))
  // `utilityProcess` 的 `on()` 是**分事件重载**的（'message' / 'exit' / 'spawn' 各自独立签名，
  // 且已声明的事件集合随 Electron 版本变动）。这里退到 EventEmitter 视图上挂，
  // 事件名由我们的 `HostProcessHandle` 契约（'message' | 'exit' | 'error'）收口。
  const emitter = child as unknown as { on(ev: string, h: (...a: unknown[]) => void): void }
  return {
    postMessage: (m) => child.postMessage(m),
    on: (ev, h) => emitter.on(ev, h as (...a: unknown[]) => void),
    kill: () => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    },
    get pid() {
      return child.pid
    },
  }
}

/* ============================================================
 * 会话
 * ============================================================ */
interface PendingCall {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer?: unknown
  method: string
}

interface Session {
  id: string
  dir: string
  manifest: Record<string, unknown>
  permissions: PluginPermission[]
  child: HostProcessHandle
  phase: PluginRuntimePhase
  activationMs?: number
  lastError?: string
  hostPid?: number
  pending: Map<number, PendingCall>
  nextId: number
  /** 最近一次收到心跳的时刻（ms） */
  lastBeatAt: number
  /** 最近一次发生调用的时刻（空闲回收用） */
  lastUsedAt: number
  /** 销毁已发出（用于区分「正常退出」与「崩溃」） */
  disposeRequested: boolean
  killed: boolean
  /**
   * 是否**曾经**成功激活过（与 `phase` 解耦）。
   *
   * 为什么要单独一个标志：`phase` 是**健康度**（'active' / 'error' …），
   * 而「这个插件到底有没有装载成功」是**事实**。运行期一次未捕获异常会把
   * `phase` 打成 'error'（§6.4 要求），但那时插件是活的、它的插槽与工具也都
   * 还在 —— 若让 registry 依据 phase 决定「产不产插槽」，一次瞬时异常就会
   * 让用户的面板凭空消失。事实与健康度必须分开。
   */
  activatedOnce: boolean
  /** 连续运行期错误计数（≥2 次即 kill，见 §6.4；一次成功调用即清零） */
  errorCount: number
}

export interface SupervisorOptions {
  /** `out/main/plugin-host.js` 的绝对路径 */
  entryPath: string
  /**
   * 能力网关（host→main 的反向调用）。
   * 由 M8 gateway 提供；缺失时一律回 `E_PERMISSION_DENIED`（默认拒绝）。
   */
  handleInvoke?: (pluginId: string, cap: ArkCap | string, params: unknown) => Promise<unknown>
  /** 阶段变化广播（IPC `plugin:runtime-status` 推送用） */
  onPhaseChange?: (status: PluginRuntimeStatus) => void
  spawn?: SpawnHostFn
  timeouts?: Partial<Record<keyof typeof RPC_TIMEOUTS, number>>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

export interface ActivateInput {
  id: string
  dir: string
  manifest: Record<string, unknown>
  permissions: PluginPermission[]
}

/* ============================================================
 * Supervisor
 * ============================================================ */
export class PluginSupervisor {
  private readonly sessions = new Map<string, Session>()
  private readonly opts: Required<Pick<SupervisorOptions, 'entryPath'>> & SupervisorOptions
  private readonly timeouts: Record<string, number>
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void
  private readonly spawn: SpawnHostFn

  constructor(opts: SupervisorOptions) {
    this.opts = opts
    this.spawn = opts.spawn ?? spawnUtilityProcess
    this.timeouts = { ...RPC_TIMEOUTS, ...(opts.timeouts as Record<string, number> | undefined) }
    this.now = opts.now ?? (() => Date.now())
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown)
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /* ---------- 查询 ---------- */

  statusOf(id: string): PluginRuntimeStatus | undefined {
    const s = this.sessions.get(id)
    if (!s) return undefined
    return this.toStatus(s)
  }

  allStatuses(): PluginRuntimeStatus[] {
    return Array.from(this.sessions.values()).map((s) => this.toStatus(s))
  }

  isActive(id: string): boolean {
    const s = this.sessions.get(id)
    return !!s && !s.killed && s.activatedOnce
  }

  /** 现在能不能调用它（激活过、进程还活着、且不是「从没成功过」的失败态） */
  private isCallable(s: Session | undefined): s is Session {
    return !!s && !s.killed && s.activatedOnce && s.phase !== 'activation-failed'
  }

  /** 运行中的 Host 半数量（诊断 / 泄漏体检） */
  liveCount(): number {
    return Array.from(this.sessions.values()).filter((s) => !s.killed).length
  }

  private toStatus(s: Session): PluginRuntimeStatus {
    return {
      id: s.id,
      phase: s.phase,
      ...(s.activationMs === undefined ? {} : { activationMs: s.activationMs }),
      ...(s.lastError === undefined ? {} : { lastError: s.lastError }),
      permissions: [...s.permissions],
      ...(s.hostPid === undefined ? {} : { hostPid: s.hostPid }),
    }
  }

  private setPhase(s: Session, phase: PluginRuntimePhase, lastError?: string): void {
    s.phase = phase
    if (lastError !== undefined) s.lastError = lastError
    try {
      this.opts.onPhaseChange?.(this.toStatus(s))
    } catch (err) {
      logger.warn('System', `[plugin:${s.id}] phase 广播失败：${String(err)}`)
    }
  }

  /* ---------- 激活 ---------- */

  /**
   * 确保插件处于 active。
   *
   * 幂等：已 active 直接返回现状；已 `activation-failed` 的**允许重试一次**
   * （作者改完插件点「重载」不应需要重启应用）。
   */
  async activate(input: ActivateInput): Promise<PluginRuntimeStatus> {
    const existing = this.sessions.get(input.id)
    if (existing && existing.phase === 'active' && !existing.killed) {
      return this.toStatus(existing)
    }
    if (existing) await this.dispose(input.id)

    const s: Session = {
      id: input.id,
      dir: input.dir,
      manifest: input.manifest,
      permissions: input.permissions,
      child: undefined as unknown as HostProcessHandle,
      phase: 'activating',
      pending: new Map(),
      nextId: 1,
      lastBeatAt: this.now(),
      lastUsedAt: this.now(),
      disposeRequested: false,
      killed: false,
      activatedOnce: false,
      errorCount: 0,
    }
    this.sessions.set(input.id, s)
    this.setPhase(s, 'activating')

    const t0 = this.now()
    try {
      const child = this.spawn({ entryPath: this.opts.entryPath, pluginId: input.id })
      s.child = child
      s.hostPid = child.pid
      child.on('message', (...args: unknown[]) => {
        const m = args[0]
        if (m && typeof m === 'object') this.onHostMessage(s, m as WireMessage)
      })
      child.on('exit', (...args: unknown[]) => this.onHostExit(s, args[0]))
      child.on('error', (...args: unknown[]) => {
        const err = args[0]
        this.setPhase(s, 'error', `Host 半进程错误：${err instanceof Error ? err.message : String(err)}`)
      })

      // ① prepare：装载插件模块（5s）
      await this.request(s, 'host/prepare', { pluginId: input.id, dir: input.dir, manifest: input.manifest, permissions: input.permissions }, this.timeouts.prepareMs)
      // ② activate：跑 apply(ctx)（5s）
      const res = (await this.request(s, 'host/activate', undefined, this.timeouts.activateMs)) as
        | { activated?: boolean }
        | undefined
      s.activationMs = this.now() - t0
      if (res?.activated === false) {
        // 纯 UI/声明式插件（无宿主半实现）：合法，但不算「跑起来了」
        this.setPhase(s, 'registered')
        return this.toStatus(s)
      }
      s.activatedOnce = true
      this.setPhase(s, 'active')
      logger.info('System', `[plugin:${input.id}] 已激活（${s.activationMs}ms，pid=${s.hostPid ?? '?'}）`)
      return this.toStatus(s)
    } catch (err) {
      const payload = toErrorPayload(err)
      s.activationMs = this.now() - t0
      this.setPhase(s, 'activation-failed', `${payload.code}: ${payload.message}`)
      logger.warn('System', `[plugin:${input.id}] 激活失败：${payload.code} ${payload.message}`)
      // 绝不半注册：失败即销毁进程（进程内可能已有半截注册）
      await this.dispose(input.id, { keepPhase: true })
      return this.statusOf(input.id) ?? this.toStatus(s)
    }
  }

  /* ---------- 调用 ---------- */

  /** 模型工具调用落到插件（30s 超时） */
  async callTool(id: string, name: string, input: unknown): Promise<unknown> {
    const s = this.sessions.get(id)
    if (!this.isCallable(s)) {
      throw new RpcError(RPC_ERROR.E_HOST_DEAD, `插件 ${id} 未激活，无法调用工具 ${name}`)
    }
    s.lastUsedAt = this.now()
    const result = await this.request(s, 'host/tool-call', { name, input }, this.timeouts.toolCallMs)
    // ★ 一次成功调用即证明插件活着：清零「连续错误」计数，并把健康度复位。
    //   与 §6.4 的「连续 2 次」口径一致 —— 只数**连续**的。
    if (s.errorCount !== 0) {
      s.errorCount = 0
      this.setPhase(s, 'active')
    }
    return result
  }

  /** 向 Host 半推宿主事件（`ctx.on` 的消费者）；失败**不抛**（事件是尽力而为） */
  async emit(id: string, event: string, payload: unknown): Promise<number> {
    const s = this.sessions.get(id)
    if (!this.isCallable(s)) return 0
    try {
      s.lastUsedAt = this.now()
      const r = (await this.request(s, 'host/emit', { event, payload }, this.timeouts.invokeMs)) as
        | { delivered?: number }
        | undefined
      return r?.delivered ?? 0
    } catch (err) {
      logger.warn('System', `[plugin:${id}] 事件 ${event} 投递失败：${String(err)}`)
      return 0
    }
  }

  /* ---------- 销毁 ---------- */

  /**
   * 销毁一个 Host 半。
   *
   * 顺序（§6.3）：先请插件**自己**逆序跑 effect（3s 预算），再杀进程。
   * 插件不响应时直接杀 —— 宁可留一点进程内未清的尾巴，也不能让宿主退出被拖住。
   *
   * @param keepPhase true 时不把 phase 改回 'registered'（失败路径保留失败态给诊断看）
   */
  async dispose(id: string, opts: { keepPhase?: boolean } = {}): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    if (s.killed) {
      this.sessions.delete(id)
      return
    }
    s.disposeRequested = true
    try {
      if (s.child && !s.killed) {
        await this.request(s, 'host/dispose', undefined, this.timeouts.disposeMs)
      }
    } catch {
      /* 超时 / 崩溃：继续走 kill，这是**设计内**路径 */
    }
    for (const [, p] of s.pending) {
      if (p.timer !== undefined) this.clearTimer(p.timer)
      p.reject(new RpcError(RPC_ERROR.E_HOST_DEAD, `插件 ${id} 已停止`))
    }
    s.pending.clear()
    this.kill(s)
    if (!opts.keepPhase) this.setPhase(s, 'registered')
    this.sessions.delete(id)
  }

  /** 应用退出时的同步收尾（不能 await —— 退出流程给不了时间） */
  killAll(): void {
    for (const [, s] of this.sessions) {
      s.disposeRequested = true
      this.kill(s)
    }
    this.sessions.clear()
  }

  async disposeAll(): Promise<void> {
    for (const id of Array.from(this.sessions.keys())) await this.dispose(id)
  }

  private kill(s: Session): void {
    if (s.killed) return
    s.killed = true
    try {
      s.child?.kill()
    } catch {
      /* 已死 */
    }
  }

  /**
   * 空闲回收（§9 性能）：超过 `idleRecycleMs` 没被用到的会话销毁 ——
   * 再次激活即重建（激活成本已由懒激活摊薄）。
   *
   * 为什么做成显式方法而不是内部定时器：定时器在测试里是 flake 之源；
   * 生产由 `startIdleSweeper()` 驱动，测试直接调本方法并注入 `now`。
   */
  async sweepIdle(): Promise<string[]> {
    const t = this.now()
    const dead: string[] = []
    for (const [id, s] of this.sessions) {
      if (s.pending.size > 0) continue
      if (t - s.lastUsedAt >= this.timeouts.idleRecycleMs) dead.push(id)
    }
    for (const id of dead) await this.dispose(id)
    if (dead.length > 0) logger.info('System', `[plugin] 空闲回收 ${dead.length} 个插件进程：${dead.join(', ')}`)
    return dead
  }

  private idleTimer?: unknown
  /** 生产用：周期扫空闲（间隔取 idleRecycleMs 的一半，粒度足够且开销可忽略） */
  startIdleSweeper(): void {
    if (this.idleTimer !== undefined) return
    const every = Math.max(30_000, Math.floor(this.timeouts.idleRecycleMs / 2))
    this.idleTimer = this.setTimer(() => {
      void this.sweepIdle()
      this.startIdleSweeper()
    }, every)
    ;(this.idleTimer as { unref?: () => void })?.unref?.()
  }

  /* ---------- 报文处理 ---------- */

  private onHostMessage(s: Session, msg: WireMessage): void {
    if (msg.kind === 'reply') {
      const p = s.pending.get(msg.id)
      if (!p) return
      s.pending.delete(msg.id)
      if (p.timer !== undefined) this.clearTimer(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new RpcError(msg.error?.code ?? RPC_ERROR.E_INTERNAL, msg.error?.message ?? '未知错误', msg.error?.data))
      return
    }
    if (msg.kind === 'notify') {
      if (msg.method === 'host/heartbeat') {
        s.lastBeatAt = this.now()
        return
      }
      if (msg.method === 'host/log') {
        const p = (msg.params ?? {}) as { level?: string; msg?: string }
        const line = `[plugin:${s.id}] ${p.msg ?? ''}`
        if (p.level === 'error') logger.error('System', line)
        else if (p.level === 'warn') logger.warn('System', line)
        else logger.info('System', line)
        return
      }
      if (msg.method === 'host/error') {
        const payload = (msg.params ?? {}) as { code?: string; message?: string }
        s.errorCount += 1
        const text = `${payload.code ?? RPC_ERROR.E_INTERNAL}: ${payload.message ?? '未捕获异常'}`
        if (s.errorCount >= 2) {
          // §6.4：连续 2 次未捕获异常即 kill（第一次保留进程，给一次重试机会）
          this.setPhase(s, 'error', `连续 ${s.errorCount} 次未捕获异常：${text}`)
          this.kill(s)
        } else {
          this.setPhase(s, 'error', text)
        }
        logger.warn('System', `[plugin:${s.id}] 运行期异常（第 ${s.errorCount} 次）：${text}`)
        return
      }
      return
    }
    if (msg.kind === 'invoke') {
      // 反向能力调用：由网关判定权限与实现
      const handler = this.opts.handleInvoke
      void (async () => {
        try {
          if (!handler) {
            throw new RpcError(RPC_ERROR.E_PERMISSION_DENIED, '宿主未配置能力网关（默认拒绝）')
          }
          const result = await handler(s.id, msg.cap, msg.params)
          s.child.postMessage({ kind: 'reply', id: msg.id, ok: true, result })
        } catch (err) {
          s.child.postMessage({ kind: 'reply', id: msg.id, ok: false, error: toErrorPayload(err) })
        }
      })()
      return
    }
  }

  private onHostExit(s: Session, code: unknown): void {
    s.killed = true
    for (const [, p] of s.pending) {
      if (p.timer !== undefined) this.clearTimer(p.timer)
      p.reject(new RpcError(RPC_ERROR.E_HOST_DEAD, `插件 ${s.id} 的 Host 半进程已退出`))
    }
    s.pending.clear()
    if (s.disposeRequested) return // 正常销毁：phase 已由 dispose 决定
    this.setPhase(s, 'error', `Host 半进程意外退出（code ${String(code)}）`)
    logger.warn('System', `[plugin:${s.id}] Host 半进程意外退出，code=${String(code)}`)
    this.sessions.delete(s.id)
  }

  /* ---------- 单次请求（带超时） ---------- */
  private request(s: Session, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = s.nextId++
    return new Promise((resolve, reject) => {
      if (s.killed) {
        reject(new RpcError(RPC_ERROR.E_HOST_DEAD, `插件 ${s.id} 的进程已停止`))
        return
      }
      const timer =
        timeoutMs > 0
          ? this.setTimer(() => {
              s.pending.delete(id)
              reject(
                new RpcError(RPC_ERROR.E_TIMEOUT, `插件 ${s.id} 的 ${method} 超时（${timeoutMs}ms）`, {
                  method,
                  timeoutMs,
                }),
              )
            }, timeoutMs)
          : undefined
      s.pending.set(id, { resolve, reject, timer, method })
      try {
        s.child.postMessage(rpcRequest(id, method, params))
      } catch (err) {
        s.pending.delete(id)
        if (timer !== undefined) this.clearTimer(timer)
        reject(new RpcError(RPC_ERROR.E_HOST_DEAD, `向插件 ${s.id} 投递 ${method} 失败：${String(err)}`))
      }
    })
  }

  /* ---------- 心跳看门狗 ---------- */
  private beatTimer?: unknown

  /**
   * 启动看门狗。
   *
   * ★ D78-c 加固：**有在途调用时跳过判死**。理由见文件头③ —— 插件正跑一次
   * 合法的长调用时心跳必然停，照判就是误杀。（文档 §6.4 的表格没考虑到这一点。）
   */
  startWatchdog(): void {
    if (this.beatTimer !== undefined) return
    const every = this.timeouts.heartbeatMs
    const tick = (): void => {
      const t = this.now()
      for (const [, s] of this.sessions) {
        if (s.killed || !s.activatedOnce) continue
        if (s.pending.size > 0) {
          s.lastBeatAt = t // 忙时暂停判死
          continue
        }
        if (t - s.lastBeatAt > every * this.timeouts.heartbeatMissLimit) {
          this.setPhase(s, 'error', `心跳连续 ${this.timeouts.heartbeatMissLimit} 次缺失，判定为无响应`)
          logger.warn('System', `[plugin:${s.id}] 心跳缺失，已判死并回收进程`)
          this.kill(s)
          this.sessions.delete(s.id)
        }
      }
      this.beatTimer = this.setTimer(tick, every)
      ;(this.beatTimer as { unref?: () => void })?.unref?.()
    }
    this.beatTimer = this.setTimer(tick, every)
    ;(this.beatTimer as { unref?: () => void })?.unref?.()
  }

  stopWatchdog(): void {
    if (this.beatTimer !== undefined) {
      this.clearTimer(this.beatTimer)
      this.beatTimer = undefined
    }
    if (this.idleTimer !== undefined) {
      this.clearTimer(this.idleTimer)
      this.idleTimer = undefined
    }
  }
}

/* ============================================================
 * 全局单例（主进程内一份；由启动时序装配 entryPath 与网关）
 * ============================================================ */
let singleton: PluginSupervisor | null = null

export function initPluginSupervisor(opts: SupervisorOptions): PluginSupervisor {
  singleton?.stopWatchdog()
  singleton = new PluginSupervisor(opts)
  return singleton
}

export function getPluginSupervisor(): PluginSupervisor | null {
  return singleton
}

/** 测试收尾 / 应用退出 */
export function resetPluginSupervisor(): void {
  singleton?.killAll()
  singleton?.stopWatchdog()
  singleton = null
}
