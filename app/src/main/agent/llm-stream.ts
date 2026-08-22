/* ============================================================
 * ArkWork — LLM 流式管道桥（v0.27.0 R1，设计文档 §2.2/§2.3）
 *
 * 职责：
 *  - completeWithStream：adapter 流式调用封装。completeStream 缺失或明确报
 *    「不支持」时静默降级 complete()（R-stream-4，不弹错误打扰）；
 *  - createTextDeltaPump：per-(taskId+scope) 增量泵 —— 首包立即广播，
 *    后续按 40–80ms 自适应窗口攒批（到达密集→80ms 攒批；稀疏→40ms 快发），
 *    seq 单调递增；Renderer 端按 seq 单调追加、乱序丢弃、seq=1 视为重启截断。
 *
 * 纪律：本模块不 import electron / window（保持可密闭单测）；
 *       广播 sender 由调用方注入（engine 侧注入 broadcast('task:text-delta')）。
 * ============================================================ */
import type {
  LlmAdapter,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmStreamHandlers,
} from '../llm/adapter.js'
import type { TaskTextDeltaPayload } from '@shared/types/ipc'

export type TextDeltaScope = TaskTextDeltaPayload['scope']
export type TextDeltaSender = (payload: TaskTextDeltaPayload) => void

/** adapter 明确不支持流式（区别于网络/鉴权等真错误）的报错特征 */
const UNSUPPORTED_STREAM = /not implemented|unsupported|not supported/i

/**
 * v0.27.0 R1：流式优先 + 静默降级的统一调用入口。
 * 返回值与 complete 完全同构（聚合后的完整响应）；增量仅经 handlers 回调。
 */
export async function completeWithStream(
  adapter: LlmAdapter,
  req: LlmCompleteRequest,
  handlers: LlmStreamHandlers,
): Promise<LlmCompleteResponse> {
  if (!adapter.completeStream) return adapter.complete(req)
  try {
    return await adapter.completeStream(req, handlers)
  } catch (err) {
    if (UNSUPPORTED_STREAM.test((err as Error)?.message ?? '')) {
      return adapter.complete(req)
    }
    throw err
  }
}

export interface TextDeltaPump {
  push(delta: string): void
  /** 把攒批中的残余文本立即发出（完整响应返回前调用，保证权威数据前缓冲区已齐） */
  flush(): void
  /** 本次会话累计流出的全部文本（含未 flush 的 pending）；中断部分落盘用 */
  readonly accumulated: string
}

/** 自适应窗口边界（设计文档 §2.3：40–80ms） */
const WINDOW_MIN_MS = 40
const WINDOW_MAX_MS = 80
/** 相邻批次间隔低于该阈值视为「到达密集」→ 用长窗口攒批 */
const DENSE_GAP_MS = 100

/**
 * v0.27.0 R1：流式文本增量泵。
 * @param taskId 任务 id
 * @param scope  'turn'（ReAct Reason）/ 'chat'（runChatOnce）
 * @param send   广播函数（engine 注入 broadcast('task:text-delta')；测试注入收集器）
 */
export function createTextDeltaPump(
  taskId: string,
  scope: TextDeltaScope,
  send: TextDeltaSender,
): TextDeltaPump {
  let seq = 0
  let pending = ''
  let total = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSentAt = 0

  const flushLocked = (): void => {
    timer = null
    if (!pending) return
    seq += 1
    const payload: TaskTextDeltaPayload = { taskId, scope, seq, text: pending }
    pending = ''
    lastSentAt = Date.now()
    try {
      send(payload)
    } catch {
      /* 渲染加速通道失败静默（无窗口 / renderer 关闭） */
    }
  }

  return {
    push(delta: string) {
      if (!delta) return
      pending += delta
      total += delta
      if (seq === 0) {
        // 首包立即发（首字延迟优先）
        flushLocked()
        return
      }
      if (timer) return
      const gap = Date.now() - lastSentAt
      const window = gap < DENSE_GAP_MS ? WINDOW_MAX_MS : WINDOW_MIN_MS
      timer = setTimeout(flushLocked, window)
    },
    flush() {
      if (timer) clearTimeout(timer)
      flushLocked()
    },
    get accumulated(): string {
      return total
    },
  }
}
