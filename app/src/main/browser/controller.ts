/* ============================================================
 * ArkWork — Browser Controller (v0.24.1)
 *
 * agent 可自主驱动的内嵌浏览器控制器（借鉴 opencode / deepseek harness
 * 的 browser 工具模型：open / snapshot / eval / console / screenshot）。
 *
 * 承载：右栏 Inspector 的 BrowserPanel 使用 <webview>（真实 Chromium 内核），
 * 本模块在主进程捕获该 webview 的 WebContents，提供：
 *   - open(urlOrLocalPath)  —— 导航（本地 HTML 转 file://，相对资源可加载）
 *   - eval(js)               —— 在页面内执行任意 JS 并取回结果
 *   - snapshot()             —— 页面标题 / URL / 文本 / 画布等状态
 *   - consoleLogs()          —— 读取页面 console 输出（找 JS 错误）
 *   - screenshot(path?)      —— 截图保存 PNG（默认 .arkwork/browser-shots/）
 *   - close()                —— 清空会话
 *
 * 时序：open 时通过 IPC 通知 renderer 展示 Browser 标签并加载 webview，
 * renderer 在 did-finish-load / did-fail-load 后回传 browser:load-done。
 * 单请求模型：同一时刻只允许一个挂起加载（agent 串行调用）。
 * ============================================================ */
import type { WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getMainWindow } from '../window.js'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'

const CONSOLE_CAP = 200
const OPEN_TIMEOUT_MS = 20_000
const SNAPSHOT_JS = `JSON.stringify((() => {
  const canvas = document.querySelector('canvas');
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    bodyText: (document.body && document.body.innerText || '').slice(0, 3000),
    hasCanvas: !!canvas,
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
  };
})())`

export type BrowserConsoleEntry = { level: string; message: string; line: number }

interface PendingLoad {
  requestId: string
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface BrowserSession {
  wc: WebContents | null
  pending: PendingLoad | null
  consoleLogs: BrowserConsoleEntry[]
  currentUrl: string
}

const session: BrowserSession = {
  wc: null,
  pending: null,
  consoleLogs: [],
  currentUrl: '',
}

function failPending(err: Error): void {
  if (session.pending) {
    clearTimeout(session.pending.timer)
    const p = session.pending
    session.pending = null
    p.reject(err)
  }
}

function settlePending(requestId: string | null, error?: string): void {
  if (session.pending && (requestId === null || session.pending.requestId === requestId)) {
    clearTimeout(session.pending.timer)
    const p = session.pending
    session.pending = null
    if (error) p.reject(new Error(error))
    else p.resolve()
  }
}

/** 主窗口创建后调用：捕获 webview 的 WebContents 并挂载事件。 */
export function initBrowserController(): void {
  const win = getMainWindow()
  if (!win) return
  win.webContents.on('did-attach-webview', (_event, wc: WebContents) => {
    session.wc = wc
    session.currentUrl = wc.getURL()
    wc.on('did-finish-load', () => {
      session.currentUrl = wc.getURL()
      settlePending(null)
    })
    wc.on('did-fail-load', (_e, code, desc) => {
      session.currentUrl = wc.getURL()
      settlePending(null, `加载失败（${code}）：${desc}`)
    })
    wc.on('console-message', (_e, level, message, line) => {
      session.consoleLogs.push({ level: String(level), message: String(message).slice(0, 1000), line: Number(line) })
      if (session.consoleLogs.length > CONSOLE_CAP) {
        session.consoleLogs.splice(0, session.consoleLogs.length - CONSOLE_CAP)
      }
    })
    wc.on('destroyed', () => {
      session.wc = null
    })
    logger.info('System', 'webview attached')
  })
}

/** renderer 回传 browser:load-done。 */
export function resolveBrowserLoad(requestId: string, error?: string): void {
  settlePending(requestId, error)
}

function mustWebContents(): WebContents {
  if (!session.wc || session.wc.isDestroyed()) {
    throw new Error('浏览器尚未打开：请先调用 browser.open 打开 URL 或本地 HTML 文件')
  }
  return session.wc
}

function safeStringify(v: unknown): string {
  try {
    if (typeof v === 'string') return v
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export interface BrowserTarget {
  kind: 'url' | 'file'
  url?: string
  path?: string
}

/** 把地址栏输入解析为完整 URL：http(s)/file:// 原样返回；其余视为本地路径 → file://。 */
export function resolveBrowserUrl(input: string): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return ''
  if (/^(https?:\/\/|file:\/\/)/i.test(trimmed)) return trimmed
  const abs = isAbsolute(trimmed) ? trimmed : resolve(getWorkspaceDir(), trimmed)
  return pathToFileURL(abs).href
}

/** 打开 URL 或本地文件（本地文件转 file://，相对资源可正常加载）。 */
export async function browserOpen(target: BrowserTarget, timeoutMs = OPEN_TIMEOUT_MS): Promise<{ url: string }> {
  const win = getMainWindow()
  if (!win) throw new Error('主窗口未就绪')
  if (session.pending) throw new Error('已有正在加载的页面，请等待完成或先 browser.close')

  let src: string
  if (target.kind === 'file') {
    const abs = isAbsolute(target.path ?? '') ? (target.path ?? '') : resolve(getWorkspaceDir(), target.path ?? '')
    src = pathToFileURL(abs).href
  } else {
    src = target.url ?? ''
  }
  if (!src) throw new Error('browser.open：缺少 url 或 path')

  const requestId = `bl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const result = await new Promise<{ url: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (session.pending?.requestId === requestId) {
        session.pending = null
        reject(new Error(`browser.open 超时（${timeoutMs}ms）：${src}`))
      }
    }, timeoutMs)
    session.pending = { requestId, resolve: () => resolve({ url: src }), reject, timer }
    win.webContents.send('browser:load', { requestId, url: src })
  })
  session.currentUrl = src
  return result
}

/** 在页面内执行 JS，返回结果（字符串或序列化 JSON）。 */
export async function browserEval(js: string): Promise<string> {
  const wc = mustWebContents()
  if (!js.trim()) throw new Error('browser.eval：js 不能为空')
  try {
    const value = await wc.executeJavaScript(js, true)
    return safeStringify(value)
  } catch (err) {
    throw new Error(`browser.eval 执行失败：${(err as Error).message ?? String(err)}`)
  }
}

/** 页面快照：标题 / URL / 文本 / 画布状态。 */
export async function browserSnapshot(): Promise<Record<string, unknown>> {
  const wc = mustWebContents()
  try {
    const raw = (await wc.executeJavaScript(SNAPSHOT_JS, true)) as string
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return { ok: true, ...parsed }
  } catch (err) {
    return { ok: false, error: `快照失败：${(err as Error).message ?? String(err)}`, url: session.currentUrl }
  }
}

/** 读取页面 console 输出（含 JS 错误；最近 CONSOLE_CAP 条）。 */
export function browserConsoleLogs(limit = 100): BrowserConsoleEntry[] {
  return session.consoleLogs.slice(-limit)
}

/** 截图保存 PNG；file 省略时存 {workspace}/.arkwork/browser-shots/shot-<ts>.png。 */
export async function browserScreenshot(file?: string): Promise<{ path: string; bytes: number }> {
  const wc = mustWebContents()
  const image = await wc.capturePage()
  let target: string
  if (file) {
    target = isAbsolute(file) ? file : resolve(getWorkspaceDir(), file)
  } else {
    const dir = join(getWorkspaceDir(), '.arkwork', 'browser-shots')
    target = join(dir, `shot-${Date.now()}.png`)
  }
  mkdirSync(dirname(target), { recursive: true })
  const png = image.toPNG()
  writeFileSync(target, png)
  return { path: target, bytes: png.length }
}

/** 结束当前浏览器会话：清空 console 缓冲。 */
export function browserClose(): { closed: boolean } {
  failPending(new Error('browser.close 中断了加载'))
  session.consoleLogs = []
  session.currentUrl = ''
  return { closed: true }
}

export function browserSessionInfo(): { opened: boolean; url: string; consoleCount: number } {
  return {
    opened: !!session.wc && !session.wc.isDestroyed(),
    url: session.currentUrl,
    consoleCount: session.consoleLogs.length,
  }
}
