/* ============================================================
 * ArkWork — 面板取数通道（v0.34.1 建，v0.34.2 修）
 * 设计文档：docs/versions/v0.34.1/04-system-design.md §5（股票插件范例）
 *          docs/versions/v0.34.2/04-system-design.md §D56-a（选栈修复）
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
 *
 * ⚠️ v0.34.2 修复（D56-a，用户实测「插件打开失败」）：
 *   （注：本条修复**不在**已打标签的 v0.34.1 内 —— v0.34.1 的 panel.ts 仍走全局 fetch）
 *   取数**必须走 Electron `net.fetch`**（Chromium 网络栈），不能用 Node 全局
 *   `fetch`（undici）—— 后者**完全不读系统代理/PAC**。实测证据（本机）：
 *     · `push2.eastmoney.com` 直连 → `curl http=000` / undici `UND_ERR_SOCKET`
 *     · 同一 URL 经系统代理（`scutil --proxy` 显示 HTTPProxy=127.0.0.1:7890）
 *       → `curl -x … http=200`
 *   Electron/Chromium 默认遵循系统代理，undici 只认 `NODE_PROXY` 类环境变量，
 *   而 GUI 应用从 Dock 启动时**没有 shell 环境变量** —— 于是「浏览器能开、
 *   面板打不开」。选栈由 `pickFetch()` 决定，方向用单测钉死（TC-PFCH 组）。
 * ============================================================ */
import { ipcMain, net } from 'electron'
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

/** 取数函数签名（便于注入与单测） */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * 选一条取数栈。
 *
 * **必须优先 `net.fetch`**：它走 Chromium 网络栈 → 遵循系统代理 / PAC / 证书策略；
 * 全局 fetch 走 Node undici → **不读系统代理**（见文件头实测证据）。
 * 只在 Electron net 不可用时（如纯 Node 单测）才回落。
 *
 * @param netModule 注入点（缺省取真实 `electron.net`），单测用它断言选栈方向
 */
export function pickFetch(netModule?: { fetch?: unknown }): { impl: FetchLike; via: 'net' | 'global' } {
  const holder = netModule ?? (net as unknown as { fetch?: unknown } | undefined)
  const candidate = holder?.fetch
  if (typeof candidate === 'function') {
    // 绑定到 holder：net.fetch 依赖内部 session 上下文，脱离对象调用会丢上下文
    return { impl: (candidate as FetchLike).bind(holder) as FetchLike, via: 'net' }
  }
  return { impl: fetch as unknown as FetchLike, via: 'global' }
}

/**
 * 把底层网络错误翻译成**用户能行动**的话。
 *
 * 为什么要翻译：`fetch failed` / `UND_ERR_SOCKET` 直接甩给用户等于没提示 ——
 * 面板四态纪律要求「降级必须可见且给人话原因」。
 */
export function humanizeFetchError(raw: string): string {
  const msg = raw || '未知网络错误'
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(msg)) return '域名解析失败（DNS）—— 请检查网络或 DNS 设置'
  if (/ERR_PROXY|ERR_TUNNEL|ECONNREFUSED_PROXY/i.test(msg)) return '代理连接失败 —— 代理未启动或端口不对'
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(msg)) return '连接被拒绝 —— 目标服务未响应或端口不对'
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ECONNRESET|UND_ERR_SOCKET|fetch failed/i.test(msg)) {
    return '连接被重置（`fetch failed` 的底层形态）—— 该地址很可能需要代理才能访问，请检查系统代理设置'
  }
  if (/ERR_(CONNECTION_)?TIMED_OUT|ETIMEDOUT|timed out/i.test(msg)) return '网络超时 —— 网络不通或需要代理'
  if (/ERR_CERT|CERT_|UNABLE_TO_VERIFY/i.test(msg)) return '证书校验失败 —— 不建议为面板数据源关闭证书校验'
  if (/ERR_INTERNET_DISCONNECTED/i.test(msg)) return '系统网络已断开'
  return msg
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
    // 选栈留痕（debug）：排查「用户能上网但面板打不开」时，第一件要确认的就是
    // 走的是不是 net 栈 —— 走 global 就必然不认系统代理。
    const { impl, via } = pickFetch()
    logger.debug('System', `[panel] fetch via ${via}: ${u.origin}`)
    try {
      const res = await impl(u.toString(), {
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
    if (/abort/i.test(msg)) {
      return { ok: false, error: `请求超时（${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）` }
    }
    const human = humanizeFetchError(msg)
    // 失败要留痕：面板错误只在渲染层可见，主进程不留日志会让「用户报障 → 无从诊断」
    logger.warn('System', `[panel] fetch 失败 ${String(req.url ?? '').slice(0, 120)} → ${human}`)
    return { ok: false, error: human }
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
