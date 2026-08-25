/* ============================================================
 * ArkWork — Browser Controller (v0.26.0 P1)
 *
 * agent 可自主驱动的内嵌浏览器控制器（借鉴 opencode / deepseek harness
 * 的 browser 工具模型）。
 *
 * v0.26.0 P1（内置浏览器重设计 §3-§4）：在 open/eval/snapshot/console/
 * screenshot/close 之上补齐「先看后动」交互原语：
 *   - waitForLoad：did-finish-load + did-navigate-in-page 双结算 + 超时兜底
 *   - navigate/back/forward/reload/stop：复用 waitForLoad，back/forward 先查历史
 *   - snapshot：可交互元素树（ref=e<N>），主进程 ref→selectorPath 注册表，
 *     导航/reload 即失效；上限 200 元素
 *   - click/type/select：ref > selector > text 定位；注入脚本路线；
 *     type/select 用原生 setter + input/change 事件（React 受控组件兼容）
 *   - press/scroll/wait：sendInputEvent 按键 / 窗口滚动 / 等 selector 或毫秒
 *   - screenshot：落盘 .arkwork/browser-shots/ + returnImage 回传 base64
 *   - tabs：list/new/select/close（复用 view-manager 导出）
 *   - 归属仲裁：交互原语执行前检查 agentDriven，用户接管中返回明确错误
 *
 * v0.27.0 F12：删除 webview 旧轨（did-attach-webview / browser:load-done /
 * LEGACY_TAB_ID fallback）——浏览器收敛为 view-manager 单轨。
 * ============================================================ */
import type { WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { getMainWindow } from '../window.js'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'
// v0.25.0 F2：view-manager 提供 Tab 化的 WebContentsView；controller 优先用它
// v0.26.0 P1：tabs 原语复用 listTabs/activateTab/closeTab/setAgentDriven（只 import 不修改）
import {
  getAgentActiveTab,
  createTab as vmCreateTab,
  activateTab,
  closeTab as vmCloseTab,
  listTabs,
  setAgentDriven,
} from './view-manager.js'
import type { BrowserTabMeta } from '@shared/types/ipc'

const CONSOLE_CAP = 200
const OPEN_TIMEOUT_MS = 20_000
const SETTLE_MS = 300
const SNAPSHOT_ELEMENT_CAP = 200
const INTERACTIVE_SELECTOR =
  'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[onclick],[contenteditable]'

export type BrowserConsoleEntry = { level: string; message: string; line: number }

interface BrowserSession {
  consoleLogs: BrowserConsoleEntry[]
  currentUrl: string
}

const session: BrowserSession = {
  consoleLogs: [],
  currentUrl: '',
}

/** tabId → (ref → selectorPath)。snapshot 重建，导航/reload 清空。 */
const refRegistry = new Map<string, Map<string, string>>()
/** agent 已接管过的 tabId：用于区分「初始未占用」与「用户接管中」。 */
const agentOwnedTabs = new Set<string>()
/** 已挂过 console/navigation 钩子的 webContents（每 wc 一次）。 */
const hookedWebContents = new WeakSet<WebContents>()

function pushConsoleLog(level: unknown, message: unknown, line: unknown): void {
  session.consoleLogs.push({ level: String(level), message: String(message).slice(0, 1000), line: Number(line) })
  if (session.consoleLogs.length > CONSOLE_CAP) {
    session.consoleLogs.splice(0, session.consoleLogs.length - CONSOLE_CAP)
  }
}

function clearRefs(tabId: string): void {
  refRegistry.delete(tabId)
}

/** 每 wc 一次性挂 console 捕获 + 导航清 ref 注册表钩子。 */
function ensureTabHooks(wc: WebContents, tabId: string): void {
  if (hookedWebContents.has(wc)) return
  hookedWebContents.add(wc)
  wc.on('console-message', (_e, level, message, line) => {
    pushConsoleLog(level, message, line)
  })
  wc.on('did-navigate', (_e, url) => {
    clearRefs(tabId)
    session.currentUrl = url
  })
  wc.on('did-navigate-in-page', (_e, url) => {
    session.currentUrl = url
  })
  wc.on('destroyed', () => {
    clearRefs(tabId)
  })
}

function resolveTarget(): { tabId: string; wc: WebContents } | null {
  const tab = getAgentActiveTab()
  if (tab && !tab.view.webContents.isDestroyed()) {
    ensureTabHooks(tab.view.webContents, tab.tabId)
    return { tabId: tab.tabId, wc: tab.view.webContents }
  }
  // v0.27.0 F12：LEGACY_TAB_ID fallback 已随 webview 旧轨删除，仅认 view-manager Tab
  return null
}

function mustTarget(): { tabId: string; wc: WebContents } {
  const t = resolveTarget()
  if (!t) {
    throw new Error('浏览器尚未打开：请先调用 browser open 打开 URL 或本地 HTML 文件')
  }
  return t
}

/**
 * 归属仲裁：agent 已接管过的 Tab 若 agentDriven 被翻回 false，说明用户已点击内容区
 * 接管 —— 返回明确错误而不是抢回来。从未接管的 Tab（初始态或用户新建）视为空闲可接管。
 */
function claimTabId(tabId: string, agentDriven: boolean): void {
  if (!agentDriven && agentOwnedTabs.has(tabId)) {
    throw new Error('用户正在操作浏览器：该标签页已被用户接管，请等待用户交还控制权后再试')
  }
  agentOwnedTabs.add(tabId)
  setAgentDriven(tabId, true)
}

/** 交互原语入口：解析目标 Tab 并做归属仲裁。 */
function requireAgentControl(): { tabId: string; wc: WebContents } {
  const tab = getAgentActiveTab()
  if (!tab || tab.view.webContents.isDestroyed()) {
    throw new Error('浏览器尚未打开：请先调用 browser open 打开 URL 或本地 HTML 文件')
  }
  claimTabId(tab.tabId, tab.agentDriven)
  ensureTabHooks(tab.view.webContents, tab.tabId)
  return { tabId: tab.tabId, wc: tab.view.webContents }
}

/**
 * waitForLoad：pending 单请求模型的泛化。
 * did-finish-load 与 did-navigate-in-page 任一先到即结算（SPA 页内跳转不触发
 * finish-load），did-fail-load 拒绝（ERR_ABORTED 视为被取代/主动停止不算失败），
 * 超时兜底拒绝。必须在触发导航**之前**创建本 Promise。
 */
function waitForLoad(wc: WebContents, timeoutMs = OPEN_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false
    const finish = (err: Error | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      wc.removeListener('did-finish-load', onFinish)
      wc.removeListener('did-navigate-in-page', onPageNav)
      wc.removeListener('did-fail-load', onFail)
      if (err) reject(err)
      else resolve(wc.getURL())
    }
    const timer = setTimeout(() => finish(new Error(`页面加载超时（${timeoutMs}ms）`)), timeoutMs)
    const onFinish = () => finish(null)
    const onPageNav = (_e: Electron.Event, _url: string, isMainFrame?: boolean) => {
      if (isMainFrame === false) return
      finish(null)
    }
    const onFail = (_e: Electron.Event, code: number, desc: string, _url?: string, isMainFrame?: boolean) => {
      if (isMainFrame === false) return
      if (code === -3) return finish(null)
      finish(new Error(`加载失败（${code}）：${desc}`))
    }
    wc.on('did-finish-load', onFinish)
    wc.on('did-navigate-in-page', onPageNav)
    wc.on('did-fail-load', onFail)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function safeStringify(v: unknown): string {
  try {
    if (typeof v === 'string') return v
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

async function execJs(wc: WebContents, js: string): Promise<string> {
  try {
    const value = await wc.executeJavaScript(js, true)
    return safeStringify(value)
  } catch (err) {
    throw new Error(`页面脚本执行失败：${(err as Error).message ?? String(err)}`)
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

function targetToUrl(target: BrowserTarget): string {
  let src: string
  if (target.kind === 'file') {
    const abs = isAbsolute(target.path ?? '') ? (target.path ?? '') : resolve(getWorkspaceDir(), target.path ?? '')
    src = pathToFileURL(abs).href
  } else {
    src = target.url ?? ''
  }
  if (!src) throw new Error('browser.open：缺少 url 或 path')
  return src
}

/** 打开 URL 或本地文件（本地文件转 file://）。无可用 Tab 时自动新建并接管。 */
export async function browserOpen(target: BrowserTarget, timeoutMs = OPEN_TIMEOUT_MS): Promise<{ url: string }> {
  const win = getMainWindow()
  if (!win) throw new Error('主窗口未就绪')
  const src = targetToUrl(target)

  let tab = getAgentActiveTab()
  if (!tab || tab.view.webContents.isDestroyed()) {
    tab = vmCreateTab()
  }
  claimTabId(tab.tabId, tab.agentDriven)
  const wc = tab.view.webContents
  ensureTabHooks(wc, tab.tabId)
  clearRefs(tab.tabId)

  // v0.27.0 F11/F12：通知 renderer（BrowserChrome dock 模式直听此通道同步地址栏/激活 Tab；
  // BrowserPanel 订阅仅用于切到 Browser 标签），不再等待回传——结算由上方 waitForLoad 负责。
  const requestId = `bl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  win.webContents.send('browser:load', { requestId, url: src })

  const pending = waitForLoad(wc, timeoutMs)
  try {
    await wc.loadURL(src)
  } catch {
    /* 结算以 waitForLoad 为准（重定向等场景 loadURL 会 ERR_ABORTED） */
  }
  const finalUrl = await pending
  session.currentUrl = finalUrl
  return { url: finalUrl }
}

/** 页内导航到新 URL（保留历史，复用 waitForLoad）。 */
export async function browserNavigate(url: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<{ url: string }> {
  const src = resolveBrowserUrl(url)
  if (!src) throw new Error('browser.navigate：缺少 url')
  const { wc, tabId } = requireAgentControl()
  clearRefs(tabId)
  const pending = waitForLoad(wc, timeoutMs)
  try {
    await wc.loadURL(src)
  } catch {
    /* 结算以 waitForLoad 为准 */
  }
  const finalUrl = await pending
  session.currentUrl = finalUrl
  return { url: finalUrl }
}

type NavHistory = { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void }

function navOf(wc: WebContents): NavHistory {
  const nav = (wc as unknown as { navigationHistory?: NavHistory }).navigationHistory
  if (nav) return nav
  return {
    canGoBack: () => wc.canGoBack(),
    canGoForward: () => wc.canGoForward(),
    goBack: () => wc.goBack(),
    goForward: () => wc.goForward(),
  }
}

async function goBy(wc: WebContents, tabId: string, dir: 'back' | 'forward', timeoutMs: number): Promise<string> {
  const nav = navOf(wc)
  const can = dir === 'back' ? nav.canGoBack() : nav.canGoForward()
  if (!can) throw new Error(`没有可${dir === 'back' ? '后退' : '前进'}的历史`)
  clearRefs(tabId)
  const pending = waitForLoad(wc, timeoutMs)
  if (dir === 'back') nav.goBack()
  else nav.goForward()
  const finalUrl = await pending
  session.currentUrl = finalUrl
  return finalUrl
}

export async function browserGoBack(timeoutMs = OPEN_TIMEOUT_MS): Promise<{ url: string }> {
  const { wc, tabId } = requireAgentControl()
  return { url: await goBy(wc, tabId, 'back', timeoutMs) }
}

export async function browserGoForward(timeoutMs = OPEN_TIMEOUT_MS): Promise<{ url: string }> {
  const { wc, tabId } = requireAgentControl()
  return { url: await goBy(wc, tabId, 'forward', timeoutMs) }
}

export async function browserReload(timeoutMs = OPEN_TIMEOUT_MS): Promise<{ url: string }> {
  const { wc, tabId } = requireAgentControl()
  clearRefs(tabId)
  const pending = waitForLoad(wc, timeoutMs)
  wc.reload()
  const finalUrl = await pending
  session.currentUrl = finalUrl
  return { url: finalUrl }
}

export function browserStop(): { stopped: boolean; url: string } {
  const { wc } = requireAgentControl()
  wc.stop()
  return { stopped: true, url: wc.getURL() }
}

/* ---- snapshot：可交互元素树 + ref 注册表 ---- */

const SNAPSHOT_ENUM_JS = `(() => {
  const SEL = '${INTERACTIVE_SELECTOR}';
  const CAP = ${SNAPSHOT_ELEMENT_CAP};
  const trim = (s, n) => {
    s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = String(el.type || 'text').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return t;
  };
  const nameOf = (el) => {
    let s = el.getAttribute('aria-label');
    if (!s) {
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const l = document.getElementById(by);
        if (l) s = l.innerText;
      }
    }
    if (!s && el.labels && el.labels.length > 0) s = el.labels[0].innerText;
    if (!s && el.tagName === 'INPUT' && el.placeholder) s = el.placeholder;
    if (!s) s = el.innerText || el.value || '';
    return trim(s, 40);
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 6; depth++) {
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const out = [];
  let total = 0;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    total++;
    if (out.length >= CAP) continue;
    const item = { ref: 'e' + (out.length + 1), role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), path: pathOf(el) };
    const ty = String(el.type || '').toLowerCase();
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder) item.placeholder = trim(el.placeholder, 40);
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && ty !== 'password' && ty !== 'checkbox' && ty !== 'radio' && ty !== 'file') item.value = trim(el.value, 40);
    if (el.tagName === 'A' && el.getAttribute('href')) item.href = el.getAttribute('href');
    if (el.disabled) item.disabled = true;
    out.push(item);
  }
  return JSON.stringify({ title: document.title, url: location.href, total, elements: out });
})()`

export interface SnapshotResult {
  title: string
  url: string
  /** 可见可交互元素总数（可能超过返回的 lines 数——受 200 上限截断） */
  total: number
  /** 紧凑行式文本：`- ref=e12 button "提交订单"` */
  lines: string[]
}

function formatElementLine(el: Record<string, unknown>): string {
  let line = `- ref=${String(el.ref)} ${String(el.role)} "${String(el.name ?? '')}"`
  if (el.value) line += ` value="${String(el.value)}"`
  if (el.placeholder) line += ` placeholder="${String(el.placeholder)}"`
  if (el.href) line += ` → ${String(el.href).slice(0, 60)}`
  if (el.disabled) line += ' [disabled]'
  return line
}

/** 可交互元素树快照：注入枚举脚本，重建 ref 注册表并输出紧凑行式文本。 */
export async function browserSnapshotElements(): Promise<SnapshotResult> {
  const { wc, tabId } = mustTarget()
  const raw = await execJs(wc, SNAPSHOT_ENUM_JS)
  let parsed: { title?: string; url?: string; total?: number; elements?: Array<Record<string, unknown>> }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`快照解析失败：${raw.slice(0, 200)}`)
  }
  const registry = new Map<string, string>()
  const lines: string[] = []
  for (const el of parsed.elements ?? []) {
    if (typeof el.ref === 'string' && typeof el.path === 'string') registry.set(el.ref, el.path)
    lines.push(formatElementLine(el))
  }
  refRegistry.set(tabId, registry)
  return {
    title: parsed.title ?? '',
    url: parsed.url ?? '',
    total: parsed.total ?? lines.length,
    lines,
  }
}

/* ---- click / type / select：ref > selector > text 定位 ---- */

export interface LocateArgs {
  ref?: string
  selector?: string
  text?: string
}

/** 生成页面内定位表达式。ref 走主进程注册表换 selectorPath。 */
function locateSnippet(args: LocateArgs, tabId: string): string {
  if (args.ref) {
    const path = refRegistry.get(tabId)?.get(args.ref)
    if (!path) throw new Error(`ref「${args.ref}」不存在或已失效（页面导航后请重新 snapshot）`)
    return `document.querySelector(${JSON.stringify(path)})`
  }
  if (args.selector) return `document.querySelector(${JSON.stringify(args.selector)})`
  if (args.text) {
    const lit = JSON.stringify(args.text.replace(/\s+/g, ' ').trim())
    return (
      `(function(){var t=${lit};` +
      `var els=document.querySelectorAll('${INTERACTIVE_SELECTOR}');` +
      `var norm=function(s){return String(s||'').replace(/\\s+/g,' ').trim()};` +
      `for(var i=0;i<els.length;i++){if(norm(els[i].innerText)===t)return els[i]}` +
      `for(var j=0;j<els.length;j++){var s2=norm(els[j].innerText);if(s2&&s2.indexOf(t)>=0)return els[j]}` +
      `return null})()`
    )
  }
  throw new Error('需要 ref / selector / text 之一来定位元素')
}

function parseOutcome(raw: string): Record<string, unknown> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error(`页面脚本返回异常：${raw.slice(0, 200)}`)
  }
  if (!parsed.ok) {
    const code = String(parsed.error ?? 'unknown-error')
    if (code === 'element-not-found') throw new Error('未找到目标元素：请重新 snapshot 后用最新 ref 重试')
    if (code === 'option-not-found') {
      throw new Error(`选项不存在：${String(parsed.value ?? '')}（可选值：${String(parsed.options ?? '')}）`)
    }
    throw new Error(`操作失败：${code}`)
  }
  return parsed
}

export async function browserClick(args: LocateArgs): Promise<{ clicked: boolean; tag: string }> {
  const { wc, tabId } = requireAgentControl()
  const el = locateSnippet(args, tabId)
  const script = `(() => {
    const el = ${el};
    if (!el) return JSON.stringify({ ok: false, error: 'element-not-found' });
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.click();
    return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase() });
  })()`
  const parsed = parseOutcome(await execJs(wc, script))
  await sleep(SETTLE_MS)
  return { clicked: true, tag: String(parsed.tag ?? '') }
}

export async function browserType(args: LocateArgs, value: string): Promise<{ typed: boolean; value: string }> {
  const { wc, tabId } = requireAgentControl()
  const el = locateSnippet(args, tabId)
  const script = `(() => {
    const el = ${el};
    if (!el) return JSON.stringify({ ok: false, error: 'element-not-found' });
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const v = ${JSON.stringify(value)};
    if (el.isContentEditable) {
      el.textContent = v;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      if (el.readOnly) return JSON.stringify({ ok: false, error: 'element-readonly' });
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.tagName === 'SELECT') {
      return JSON.stringify({ ok: false, error: 'use-select-action' });
    } else {
      return JSON.stringify({ ok: false, error: 'element-not-editable' });
    }
    return JSON.stringify({ ok: true, value: String(el.value == null ? '' : el.value).slice(0, 80) });
  })()`
  const parsed = parseOutcome(await execJs(wc, script))
  await sleep(SETTLE_MS)
  return { typed: true, value: String(parsed.value ?? '') }
}

export async function browserSelect(args: LocateArgs, value: string): Promise<{ selected: boolean; value: string }> {
  const { wc, tabId } = requireAgentControl()
  const el = locateSnippet(args, tabId)
  const script = `(() => {
    const el = ${el};
    if (!el) return JSON.stringify({ ok: false, error: 'element-not-found' });
    if (el.tagName !== 'SELECT') return JSON.stringify({ ok: false, error: 'not-a-select' });
    el.scrollIntoView({ block: 'center' });
    el.focus();
    const v = ${JSON.stringify(value)};
    const opts = Array.from(el.options);
    const opt = opts.find((o) => o.value === v) || opts.find((o) => String(o.label || o.innerText || '').trim() === v);
    if (!opt) {
      return JSON.stringify({ ok: false, error: 'option-not-found', value: v, options: opts.slice(0, 20).map((o) => o.value).join(', ') });
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, value: opt.value });
  })()`
  const parsed = parseOutcome(await execJs(wc, script))
  await sleep(SETTLE_MS)
  return { selected: true, value: String(parsed.value ?? '') }
}

/* ---- press / scroll / wait ---- */

const KEY_CODE_MAP: Record<string, string> = {
  Enter: 'Return',
  Escape: 'Esc',
  Esc: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
}

export async function browserPress(key: string): Promise<{ pressed: string }> {
  const { wc } = requireAgentControl()
  const raw = key.trim()
  if (!raw) throw new Error('browser.press：key 不能为空')
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean)
  const keyName = parts[parts.length - 1]
  const modifiers: Array<'control' | 'alt' | 'meta' | 'shift'> = []
  for (const m of parts.slice(0, -1)) {
    const lm = m.toLowerCase()
    if (lm === 'ctrl' || lm === 'control') modifiers.push('control')
    else if (lm === 'alt' || lm === 'option') modifiers.push('alt')
    else if (lm === 'cmd' || lm === 'meta' || lm === 'command') modifiers.push('meta')
    else if (lm === 'shift') modifiers.push('shift')
  }
  const code = KEY_CODE_MAP[keyName] ?? keyName
  wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
  await sleep(SETTLE_MS)
  return { pressed: raw }
}

export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom'

export async function browserScroll(
  direction: ScrollDirection,
  amount = 400,
): Promise<{ y: number; max: number }> {
  const { wc } = requireAgentControl()
  const amt = Math.max(50, Math.min(Math.round(amount), 5000))
  const script = `(() => {
    const d = document.scrollingElement || document.documentElement;
    const a = ${amt};
    switch ('${direction}') {
      case 'up': d.scrollBy(0, -a); break;
      case 'down': d.scrollBy(0, a); break;
      case 'top': d.scrollTo(0, 0); break;
      case 'bottom': d.scrollTo(0, d.scrollHeight); break;
    }
    return JSON.stringify({ ok: true, y: Math.round(d.scrollTop), max: Math.round(d.scrollHeight) });
  })()`
  const parsed = parseOutcome(await execJs(wc, script))
  await sleep(SETTLE_MS)
  return { y: Number(parsed.y ?? 0), max: Number(parsed.max ?? 0) }
}

export async function browserWait(opts: {
  selector?: string
  timeoutMs?: number
}): Promise<{ waitedMs: number; timedOut: boolean }> {
  const { wc } = requireAgentControl()
  const timeout = Math.max(100, Math.min(Math.round(opts.timeoutMs ?? 5000), 60_000))
  const start = Date.now()
  if (opts.selector) {
    const probe = `!!document.querySelector(${JSON.stringify(opts.selector)})`
    while (Date.now() - start < timeout) {
      const found = await wc.executeJavaScript(probe, true).catch(() => false)
      if (found === true) return { waitedMs: Date.now() - start, timedOut: false }
      await sleep(200)
    }
    return { waitedMs: Date.now() - start, timedOut: true }
  }
  await sleep(timeout)
  return { waitedMs: Date.now() - start, timedOut: false }
}

/* ---- eval / console / screenshot / tabs / close ---- */

/** 在页面内执行 JS，返回结果（字符串或序列化 JSON）。 */
export async function browserEval(js: string): Promise<string> {
  const { wc } = mustTarget()
  if (!js.trim()) throw new Error('browser.eval：js 不能为空')
  return execJs(wc, js)
}

/** 读取页面 console 输出（含 JS 错误；最近 CONSOLE_CAP 条）。 */
export function browserConsoleLogs(limit = 100): BrowserConsoleEntry[] {
  return session.consoleLogs.slice(-limit)
}

/** 截图保存 PNG；file 省略时存 {workspace}/.arkwork/browser-shots/shot-<ts>.png；
 * returnImage=true 时附带 base64（多模态回传）。 */
export async function browserScreenshot(
  file?: string,
  returnImage = false,
): Promise<{ path: string; bytes: number; base64?: string }> {
  const { wc } = mustTarget()
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
  return { path: target, bytes: png.length, base64: returnImage ? png.toString('base64') : undefined }
}

export interface TabsActionResult {
  subcommand: 'list' | 'new' | 'select' | 'close'
  tabs?: BrowserTabMeta[]
  tabId?: string
  url?: string
}

/** tabs 子命令：list / new / select / close（复用 view-manager 导出）。 */
export async function browserTabsAction(
  subcommand: 'list' | 'new' | 'select' | 'close',
  opts: { url?: string; tabId?: string },
): Promise<TabsActionResult> {
  switch (subcommand) {
    case 'list':
      return { subcommand, tabs: listTabs() }

    case 'new': {
      const tab = vmCreateTab()
      claimTabId(tab.tabId, tab.agentDriven)
      ensureTabHooks(tab.view.webContents, tab.tabId)
      let finalUrl = ''
      if (opts.url) {
        const src = resolveBrowserUrl(opts.url)
        if (!src) throw new Error('browser.tabs new：url 不能为空字符串')
        clearRefs(tab.tabId)
        const pending = waitForLoad(tab.view.webContents)
        try {
          await tab.view.webContents.loadURL(src)
        } catch {
          /* 结算以 waitForLoad 为准 */
        }
        finalUrl = await pending
      }
      activateTab(tab.tabId)
      session.currentUrl = finalUrl || tab.view.webContents.getURL()
      return { subcommand, tabId: tab.tabId, url: session.currentUrl }
    }

    case 'select': {
      if (!opts.tabId) throw new Error('browser.tabs select：需要 tabId')
      const meta = listTabs().find((t) => t.tabId === opts.tabId)
      if (!meta) throw new Error(`tab 不存在：${opts.tabId}`)
      claimTabId(meta.tabId, meta.agentDriven)
      activateTab(meta.tabId)
      session.currentUrl = meta.url
      return { subcommand, tabId: meta.tabId, url: meta.url }
    }

    case 'close': {
      if (!opts.tabId) throw new Error('browser.tabs close：需要 tabId')
      const meta = listTabs().find((t) => t.tabId === opts.tabId)
      if (!meta) throw new Error(`tab 不存在：${opts.tabId}`)
      if (!meta.agentDriven && agentOwnedTabs.has(meta.tabId)) {
        throw new Error('用户正在操作浏览器：该标签页已被用户接管，不能由 agent 关闭')
      }
      vmCloseTab(meta.tabId)
      agentOwnedTabs.delete(meta.tabId)
      clearRefs(meta.tabId)
      return { subcommand, tabId: meta.tabId }
    }
  }
}

/** 结束当前浏览器会话：清空 console 缓冲、ref 注册表与 agent 接管记录。 */
export function browserClose(): { closed: boolean } {
  // v0.27.0 F12：failPending 已随 webview 旧轨删除（加载结算由 waitForLoad 本地 Promise 负责）
  session.consoleLogs = []
  session.currentUrl = ''
  refRegistry.clear()
  agentOwnedTabs.clear()
  return { closed: true }
}

export function browserSessionInfo(): { opened: boolean; url: string; consoleCount: number } {
  const tab = getAgentActiveTab()
  return {
    opened: !!tab && !tab.view.webContents.isDestroyed(),
    url: session.currentUrl,
    consoleCount: session.consoleLogs.length,
  }
}
