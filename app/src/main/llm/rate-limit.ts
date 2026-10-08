/* ============================================================
 * ArkWork — 模型级调用频率限制（v0.48.0）
 * 设计文档：docs/versions/v0.48.0/04-system-design.md §二
 *
 * 背景：公司内网端点对请求频率敏感。引擎多通道并发（主循环 / 规划通道 /
 * PlanOps / 标题生成 / 记忆巩固 / 子 agent…）同时打到同一端点时，会收到
 * 429 频率过快异常。业界共识（OpenCode / Claude Code / Cline）= 三层：
 *   ① 客户端主动节流（排队 + 最小间隔 / 并发上限）—— 本模块
 *   ② 429 尊重 Retry-After —— error-classify.ts extractRetryAfterMs
 *   ③ 退避重试兜底 —— 既有 retryCore
 *
 * 设计约束：
 *   · 默认关闭：rateLimit 未配置 / 两值均无效 → wrapWithRateLimit **原样返回
 *     adapter**（零包装、零开销），既有模型行为逐字节不变；
 *   · 挂接点在 registry.buildAdapter（18 个 getAdapter 调用点的唯一汇聚处，
 *     调用点零改动全覆盖）；模型配置更新已有 adapters.delete → 重建即生效；
 *   · 纯 Node 逻辑与 IO 分离：ModelRateLimiter 不依赖 electron，可独立单测。
 * ============================================================ */
import type { LlmAdapter } from './adapter.js'
import type { LlmModel } from '@shared/types/agent'

/** 节流参数（已归一化：两值均 > 0 才生效） */
export interface RateLimitParams {
  minIntervalMs: number
  maxConcurrent: number
}

/**
 * 从模型配置提取有效节流参数；未配置或值无效（<= 0）视为不限制。
 * 纯函数，UI 保存侧与包装层共用同一判据（单一事实源）。
 */
export function effectiveRateLimit(model: Pick<LlmModel, 'rateLimit'>): RateLimitParams | null {
  const rl = model.rateLimit
  if (!rl) return null
  const minIntervalMs = typeof rl.minIntervalMs === 'number' && rl.minIntervalMs > 0 ? rl.minIntervalMs : 0
  const maxConcurrent = typeof rl.maxConcurrent === 'number' && rl.maxConcurrent > 0 ? Math.floor(rl.maxConcurrent) : 0
  if (minIntervalMs === 0 && maxConcurrent === 0) return null
  return { minIntervalMs, maxConcurrent }
}

/**
 * 每模型节流器：FIFO 队列 + 两个闸门。
 *
 *  · 间隔闸：记录上次请求**开始**时刻（不是结束——长请求不该拖慢下一发的起步），
 *    不足 minIntervalMs 则等待到点；
 *  · 并发闸：信号量，在途请求满 maxConcurrent 时排队。
 *
 * 中止语义：signal 在排队等待期间中止 → 立即以该错误拒绝（不占用队列位置），
 * 与 retryCore 的 sleep(signal) 同款。
 */
export class ModelRateLimiter {
  private readonly minIntervalMs: number
  private readonly maxConcurrent: number
  /** 上次放行的请求开始时刻（epoch ms） */
  private lastStartAt = 0
  /** 当前在途请求数 */
  private inFlight = 0
  /** 等待放行的队尾通知器（FIFO 由 Promise 链天然保证） */
  private tail: Promise<void> = Promise.resolve()

  constructor(params: RateLimitParams) {
    this.minIntervalMs = Math.max(0, params.minIntervalMs)
    this.maxConcurrent = Math.max(1, params.maxConcurrent || Number.POSITIVE_INFINITY)
  }

  /** 当前排队 + 在途总数（诊断用） */
  get pending(): number {
    return this.inFlight
  }

  /**
   * 排队执行 fn：先在 FIFO 链上等待「入场资格」（并发闸 + 间隔闸），放行后
   * **脱离链条独立执行**——链条只约束入场顺序，不约束执行时长，否则
   * maxConcurrent > 1 会被隐性串行化。
   * 中止语义：signal 在排队等待期间中止 → 立即拒绝（不占执行位）。
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const admit = this.tail.then(async () => {
      // —— 调用前短路：signal 已中止 → 立即拒绝（与 retryCore 的中止语义一致）——
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      // —— 并发闸：在途满员时等待释放（轮询 25ms；释放由执行侧 finally 驱动）——
      while (this.inFlight >= this.maxConcurrent) {
        await sleepInterruptible(25, signal)
      }
      // —— 间隔闸：距上次请求开始不足 minIntervalMs 则等到点 ——
      const now = Date.now()
      const wait = this.lastStartAt > 0 ? this.lastStartAt + this.minIntervalMs - now : 0
      if (wait > 0) await sleepInterruptible(wait, signal)
      // —— 放行 ——
      this.lastStartAt = Date.now()
      this.inFlight += 1
    })
    // 下一个请求的入场资格只等本请求**获得放行**，不等它执行完
    this.tail = admit.then(
      () => undefined,
      () => undefined,
    )
    return admit.then(
      () => fn().finally(() => {
        this.inFlight -= 1
      }),
      (err) => {
        throw err
      },
    )
  }
}

/** 可中断 sleep：signal 中止时抛出（排队等待让位于用户停止任务） */
function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = setTimeout(finish, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(signal?.reason ?? new Error('aborted'))
    }
    function finish(): void {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t)
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 日志注入（保持本模块零静态依赖，与 llm-call.ts 同款惰性策略） */
export type RateLimitLogger = (message: string) => void

/**
 * 包装 adapter：按模型配置套节流；未配置 → 原样返回（零开销直通）。
 *
 * 包装覆盖 complete / completeStream 两个入口（completeWithStream 内部回退
 * complete 的路径同样经此节流，不会绕过）；name / provider 直通。
 */
export function wrapWithRateLimit(
  adapter: LlmAdapter,
  model: Pick<LlmModel, 'id' | 'rateLimit'>,
  log?: RateLimitLogger,
): LlmAdapter {
  const params = effectiveRateLimit(model)
  if (!params) return adapter
  const limiter = new ModelRateLimiter(params)
  const label = `model=${model.id} interval=${params.minIntervalMs}ms conc=${params.maxConcurrent}`
  log?.(`rate limit enabled: ${label}`)
  const wrapped: LlmAdapter = {
    name: adapter.name,
    provider: adapter.provider,
    complete: (req) =>
      limiter.run(() => {
        log?.(`rate limit: dispatching request (${limiter.pending} in flight, ${label})`)
        return adapter.complete(req)
      }, req.signal),
  }
  if (adapter.completeStream) {
    const stream = adapter.completeStream.bind(adapter)
    wrapped.completeStream = (req, handlers) =>
      limiter.run(() => {
        log?.(`rate limit: dispatching stream request (${limiter.pending} in flight, ${label})`)
        return stream(req, handlers)
      }, req.signal)
  }
  return wrapped
}
