/* ============================================================
 * ArkWork — 面板取数通道（v0.34.1）
 * 设计文档：docs/versions/v0.34.1/04-system-design.md §5（股票插件范例）
 *
 * 为什么必须有这条通道，而不是让渲染层直接 `fetch()`：
 *  ① **同源策略**：渲染层是 Chromium，跨域请求会被 CORS 拦；公开行情接口
 *     不保证返回 `Access-Control-Allow-Origin`，插件作者无从补救。主进程是
 *     Node，**没有同源策略**，取数天然可达。
 *  ② **权限边界**：插件是磁盘上的 JSON，宿主只允许它「声明 URL」，不允许
 *     它执行代码。把取数收进主进程 = 请求行为可被审计、可被限流。
 *  ③ **超时可控**：由宿主统一夹取超时，避免面板卡在网络上把 UI 拖死。
 *
 * 三条硬约束（与既有 fs 通道同款纪律）：
 *  ① 只支持 http/https —— 不允许 file:// / 内网任意协议探测；
 *  ② 响应体有大小上限（2MB），防超大响应把内存吃穿；
 *  ③ 失败**如实返回原因**，绝不回落假数据（「永不静默半死」）。
 * ============================================================ */
import { ipcMain } from 'electron'
import { logger } from '../system/logger.js'

/** 响应体大小上限（字节）—— 面板数据是给人看的，2MB 绰绰有余 */
const MAX_BYTES = 2 * 1024 * 1024
/** 默认超时（ms） */
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 30_000

export interface PanelFetchRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** 期望的解析方式；json 解析失败时**回传 text**，由调用方决定 */
  response?: 'json' | 'text'
  timeoutMs?: number
}

export interface PanelFetchResult {
  ok: boolean
  status?: number
  /** response=json 且解析成功时的值 */
  json?: unknown
  /** 原始文本（text 模式必给；json 模式解析失败时也给，便于诊断） */
  text?: string
  error?: string
}

/** 协议白名单：只允许明文 HTTP(S) —— 宿主不为插件开任意协议探测 */
function assertSafeUrl(raw: string): URL {
  const u = new URL(raw)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只允许 http/https，收到 ${u.protocol}`)
  }
  return u
}

export async function panelFetch(req: PanelFetchRequest): Promise<PanelFetchResult> {
  try {
    const u = assertSafeUrl(req.url)
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, req.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
      const res = await fetch(u.toString(), {
        method: req.method ?? 'GET',
        headers: req.headers ?? {},
        signal: ctrl.signal,
        redirect: 'follow',
      })
      const text = await res.text()
      if (text.length > MAX_BYTES) {
        return { ok: false, status: res.status, error: `响应体超过 ${MAX_BYTES} 字节上限（实际 ${text.length}）` }
      }
      if (!res.ok) {
        return { ok: false, status: res.status, text, error: `HTTP ${res.status}` }
      }
      if (req.response === 'text') return { ok: true, status: res.status, text }
      try {
        return { ok: true, status: res.status, json: JSON.parse(text) as unknown, text }
      } catch {
        // 声明要 json 但拿到非 json —— 如实说明并把文本交出去，不静默吞掉
        return {
          ok: false,
          status: res.status,
          text,
          error: `响应不是合法 JSON（前 80 字：${text.slice(0, 80)}）`,
        }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const aborted = /abort/i.test(msg)
    return { ok: false, error: aborted ? `请求超时（${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）` : msg }
  }
}

export function registerPanelHandlers(): void {
  ipcMain.handle('panel:fetch', async (_e, req: PanelFetchRequest) => {
    try {
      return await panelFetch(req ?? ({} as PanelFetchRequest))
    } catch (err) {
      // 兜底：handler 永不向渲染层抛（否则 preload 只会拿到一串无意义的序列化错误）
      logger.warn('System', `[panel] fetch 通道异常：${(err as Error).message}`)
      return { ok: false, error: (err as Error).message } satisfies PanelFetchResult
    }
  })
}
