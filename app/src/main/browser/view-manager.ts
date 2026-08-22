/* ============================================================
 * ArkWork — Browser View Manager (v0.25.0 F2 / 设计文档 §4.2)
 *
 * 目标：让 WebContentsView 由主进程全权持有；renderer 只渲染 Tab 条/工具栏/占位区。
 * 可见性 = view.setVisible(bool) + setBounds；除关闭 Tab 外不销毁 webContents。
 *
 * 数据模型（与设计文档 §4.3 对齐）：
 *  - BrowserTab.tabId: string
 *  - BrowserTab.view: WebContentsView（不通过 IPC 暴露）
 *  - BrowserTabMeta（IPC 镜像）：tabId / url / title / favicon / host / agentDriven
 *
 * 多 Tab 设计文档 §4.2 标记的扩展点都已实现：
 *  - attachTo / setBounds / activate / navigate / detach / attach
 *  - 主窗口关闭 → 全部 view 随窗口销毁（不主动管理生命周期）
 *
 * v0.26.0 P0（浮窗 UI 根治）：浮窗不再加载落盘的内联 HTML，改为加载
 * renderer 构建产物 browser-toolbar.html（独立 Vite 入口 + BrowserChrome 组件）。
 * ============================================================ */
import { BrowserWindow, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { logger } from '../system/logger.js'
import type { BrowserTabMeta } from '@shared/types/ipc'

/** ESM 下无原生 __dirname（package.json "type":"module"），沿用 window.ts 惯例自建 */
const __dirname = dirname(fileURLToPath(import.meta.url))

/** Tab 完整状态（含 view，main 进程私有）。 */
export interface BrowserTab {
  tabId: string
  view: WebContentsView
  url: string
  title: string
  favicon?: string
  /** dock = 主窗口占位区；window = 独立窗口 */
  host: { kind: 'dock' } | { kind: 'window'; windowId: number }
  agentDriven: boolean
  createdAt: number
}

/** IPC 镜像（不含 view）。类型定义在 @shared/types/ipc，便于 renderer 共享。 */
export type { BrowserTabMeta } from '@shared/types/ipc'

const tabs = new Map<string, BrowserTab>()
/** 当前激活的 dock tabId（用于 activate 逻辑：dock 内互斥显示）。 */
let activeDockTabId: string | null = null

function toMeta(tab: BrowserTab): BrowserTabMeta {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    host: tab.host.kind,
    agentDriven: tab.agentDriven,
  }
}

function getOwnerWindow(host: BrowserTab['host']): BrowserWindow | null {
  if (host.kind === 'dock') {
    const wins = BrowserWindow.getAllWindows()
    return wins[0] ?? null
  }
  // 通过 windowId 查找（Electron 30+ 提供 fromId）
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (BrowserWindow as any).fromId(host.windowId) as BrowserWindow | null
  } catch {
    return null
  }
}

/** 创建新 Tab（不激活；不挂载到窗口 —— 等首次 setBounds 时再挂，避免漂浮）。
 * v0.25.0 F2 P1 修复：原 createTab 立即 addChildView + setVisible(false) 会让 view 在
 * contentView 默认位置 (0,0,fullW,fullH)；后 setBounds 时需立刻修正，但若 setBounds 跨帧
 * 触发，view 会先瞬间在错误位置显示。改为：先建 view + 记录 tab，**不调 addChildView**
 * —— 等 setTabBounds 首次调用时再 addChildView + setBounds + setVisible(true)。 */
export function createTab(opts?: { url?: string }): BrowserTab {
  const tabId = randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  view.setVisible(false)
  const tab: BrowserTab = {
    tabId,
    view,
    url: opts?.url ?? '',
    title: 'New Tab',
    host: { kind: 'dock' },
    agentDriven: false,
    createdAt: Date.now(),
    /** v0.25.0 F2 P1：是否已挂载到 contentView（首次 setBounds 时挂载） */
    _attached: false,
  } as BrowserTab & { _attached: boolean }
  // 监听元数据更新
  view.webContents.on('page-title-updated', (_e, title) => {
    tab.title = title || tab.title
  })
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    if (favicons.length > 0) tab.favicon = favicons[0]
  })
  view.webContents.on('did-navigate', (_e, url) => {
    tab.url = url
  })
  view.webContents.on('did-navigate-in-page', (_e, url) => {
    tab.url = url
  })
  if (opts?.url) {
    void view.webContents.loadURL(opts.url)
    tab.url = opts.url
  }
  tabs.set(tabId, tab)
  logger.info('Tool', `view-manager: created tab ${tabId}${opts?.url ? ` (${opts.url})` : ''}`)
  return tab
}

/** 关闭并销毁 Tab。v0.26.0 fix：宿主为浮窗时连带关闭该窗口（否则留下无内容僵尸工具栏）。 */
export function closeTab(tabId: string): void {
  const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
  if (!tab) return
  let floatWin: BrowserWindow | null = null
  if (tab.host.kind === 'window') {
    const w = (BrowserWindow as any).fromId(tab.host.windowId) as BrowserWindow | null
    if (w && !w.isDestroyed()) floatWin = w
  }
  try {
    const win = getOwnerWindow(tab.host)
    if (win && tab._attached) {
      win.contentView.removeChildView(tab.view)
    }
  } catch (err) {
    logger.warn('Tool', `view-manager: removeChildView failed for ${tabId}: ${(err as Error).message}`)
  }
  try {
    tab.view.webContents.close()
  } catch (err) {
    logger.warn('Tool', `view-manager: webContents.close failed for ${tabId}: ${(err as Error).message}`)
  }
  tabs.delete(tabId)
  if (activeDockTabId === tabId) activeDockTabId = null
  // 先出注册表再关窗：closed 回调的 tabs.has 守卫会直接返回，不会误触发 attachTab
  if (floatWin) {
    try {
      floatWin.close()
    } catch (err) {
      logger.warn('Tool', `view-manager: close owner floating window failed for ${tabId}: ${(err as Error).message}`)
    }
  }
  logger.info('Tool', `view-manager: closed tab ${tabId}`)
}

/** 激活 dock Tab（互斥：dock 内只显示一个）。host = window 时只打开可见性。
 * v0.25.0 F2 P1 简化：所有可见性由 setTabBounds / detachTab 显式管理；
 * activateTab 仅记录 activeDockTabId，不再触发 setVisible（避免 bounds 未同步就显示）。 */
export function activateTab(tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`view-manager: tab not found: ${tabId}`)
  if (tab.host.kind === 'dock') {
    // dock 互斥：其他 dock Tab 全部隐藏
    for (const [otherId, other] of tabs) {
      if (otherId === tabId) continue
      if (other.host.kind !== 'dock') continue
      try {
        other.view.setVisible(false)
      } catch { /* ignore */ }
    }
    activeDockTabId = tabId
    // v0.25.0 F2 P1 简化：activate 不再 setVisible(true)。
    // 显式可见性规则：
    //  - dock 显示：setTabBounds 在 activeDockTabId 匹配 + w/h > 0 时 setVisible(true)
    //  - dock 隐藏：setTabBounds w/h = 0 时 setVisible(false)；activate 其他 dock Tab 时也 setVisible(false)
    //  - window 显示：detachTab 内 setVisible(true)
    // 此处不主动调 setVisible —— view 已经被 addChildView，bounds 默认 (0,0)，
    // 若立即 setVisible 会瞬间漂浮在窗口左上角。
  } else {
    // window 模式：bounds 由窗口 resize 同步，可见性在 detachTab 内设过
    try {
      tab.view.setVisible(true)
    } catch (err) {
      logger.warn('Tool', `view-manager: setVisible failed for ${tabId}: ${(err as Error).message}`)
    }
  }
}

/** 检查指定 Tab 是否 dock 上当前激活。 */
export function isDockTabActive(tabId: string): boolean {
  return activeDockTabId === tabId
}

/** 同步占位区 DOMRect 到指定 Tab（host=dock 时有效）。
 * rect.x/y 由 renderer 传入的是 viewport-relative 坐标（DOMRect.getBoundingClientRect）；
 * WebContentsView.setBounds 要求的是 BrowserWindow contentView 局部坐标，
 * 因此需要减去主窗口 contentView 在 viewport 中的偏移。 */
  export function setTabBounds(
    tabId: string,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
    if (!tab) return
    if (tab.host.kind !== 'dock') return // host=window 时 view 恒铺满窗口
    // 过滤：width/height = 0 不调 setBounds（panel 折叠中 → 避免 Electron 抛错或显示残影）
    const w = Math.max(0, Math.round(rect.width))
    const h = Math.max(0, Math.round(rect.height))
    if (w === 0 || h === 0) {
      // 折叠中：setVisible(false) 隐藏即可，不更新 bounds
      try { tab.view.setVisible(false) } catch { /* ignore */ }
      return
    }
    // v0.25.0 F2 P1 bug-fix：renderer 的 getBoundingClientRect 返回的是 viewport 坐标，
    // 其原点（视口左上角）与 BrowserWindow.contentView 局部坐标原点一致（都是"主内容区左上角"）。
    // 因此直接使用即可，无需再减 getContentBounds（那是"屏幕绝对坐标"，减了反而错位，导致
    // 浏览器视图向左/向上偏移遮挡中间会话区）。修复"侧栏浏览器遮挡内容"。
    const mainWin = BrowserWindow.getAllWindows()[0]
    const localX = Math.round(rect.x)
    const localY = Math.round(rect.y)
    try {
      // v0.25.0 F2 P1：首次 setBounds 时挂载到 contentView（先 setBounds 再 addChildView，
      // 避免 view 在 contentView 默认 (0,0,fullW,fullH) 位置瞬间显示）
      if (!tab._attached) {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.contentView.addChildView(tab.view)
          tab._attached = true
        }
      }
      tab.view.setBounds({
        x: localX,
        y: localY,
        width: w,
        height: h,
      })
      // active dock tab 才显示
      if (activeDockTabId === tabId) {
        try { tab.view.setVisible(true) } catch { /* ignore */ }
      }
    } catch (err) {
      logger.warn('Tool', `view-manager: setBounds failed for ${tabId}: ${(err as Error).message}`)
    }
  }

/** 在指定 Tab 加载 URL。 */
export async function navigateTab(tabId: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const tab = tabs.get(tabId)
  if (!tab) return { ok: false, error: `tab not found: ${tabId}` }
  try {
    await tab.view.webContents.loadURL(url)
    tab.url = url
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 列出全部 Tab 元数据。 */
export function listTabs(): BrowserTabMeta[] {
  return Array.from(tabs.values()).map(toMeta)
}

/** 取指定 Tab 的 WebContentsView（供 controller 等需要 CDP 的模块）。 */
export function getTabView(tabId: string): WebContentsView | null {
  return tabs.get(tabId)?.view ?? null
}

/** 取当前激活的 dock Tab；无则返回 null。 */
export function getActiveDockTab(): BrowserTab | null {
  if (!activeDockTabId) return null
  return tabs.get(activeDockTabId) ?? null
}

/**
 * 取 agent 当前应操作的「目标 Tab」（不限 dock / window —— v0.25.2 修复 controller 与
 * vm 割裂：agent 浏览器不再依赖 <webview>，而是直接操作 view-manager 的 Tab）。
 * 优先级：
 *   1) 标记为 agentDriven=true 的最近 Tab（含浮窗），保证 agent 持续操作同一会话；
 *   2) 回退到当前 dock 激活 Tab；
 *   3) 无则取最近创建的 dock Tab；
 *   4) 都没有返回 null。
 */
export function getAgentActiveTab(): BrowserTab | null {
  const all = Array.from(tabs.values())
  if (all.length === 0) return null
  const driven = all
    .filter((t) => t.agentDriven)
    .sort((a, b) => b.createdAt - a.createdAt)
  if (driven.length > 0) return driven[0]
  if (activeDockTabId) {
    const active = tabs.get(activeDockTabId)
    if (active) return active
  }
  const dock = all.filter((t) => t.host.kind === 'dock').sort((a, b) => b.createdAt - a.createdAt)
  return dock[0] ?? all[all.length - 1]
}

/** 取 agent 目标 Tab 的 WebContents（供 controller 操作）。 */
export function getAgentTargetWebContents(): import('electron').WebContents | null {
  const tab = getAgentActiveTab()
  if (!tab || tab.view.webContents.isDestroyed()) return null
  return tab.view.webContents
}

/** 标记 agent 驱动状态（影响 UI 标签徽标）。 */
export function setAgentDriven(tabId: string, agentDriven: boolean): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.agentDriven = agentDriven
}

/** 关闭全部 Tab（主窗口关闭时由主进程调用，兜底）。 */
export function closeAllTabs(): void {
  for (const tabId of [...tabs.keys()]) closeTab(tabId)
}

/* ============================================================
 * v0.25.0 F2 P1：dock ↔ window Tab 迁移（设计文档 §4.2 §4.5）
 *
 * 背景：当前 BrowserPanel 切走即丢 webContents，浮窗 PreviewWindow 浏览器是另一套
 * `<webview>`，与 dock 完全无共享。两边要支持切换互斥：把 Tab 从 dock 迁到独立窗口、
 * 或从独立窗口迁回 dock。webContents 在迁移过程中**保持存活**，state/history 完整保留。
 *
 * detachTab(tabId, bounds?)：dock → window
 *   - 创建 BrowserWindow（独立、与 dock 同宽比例）
 *   - 把 view 从主窗口 contentView 移除，挂在新窗口
 *   - 新窗口的 contentView.addChildView(view) + view.setBounds(0, 0, w, h)
 *   - 关闭时（用户关浮窗或程序触发）→ 自动 attach 回 dock（如 dock 已不存在则保留为 orphan）
 *
 * attachTab(tabId)：window → dock
 *   - 把 view 从浮窗 contentView 移除，挂回主窗口
 *   - 关闭浮窗（已没有 view）
 *   - 标记 host 为 dock
 *
 * 注意：view 迁移通过 webContentsView.reparent...Electron 没有原生 reparent API，
 * 但 contentView.removeChildView + addChildView 即可在同一 WebContentsView 实例上
 * 完成切换（WebContentsView 的 webContents 是稳定的，跨窗口持有）。
 * ============================================================ */

/** 创建独立浮窗（承载 BrowserTab 的 WebContentsView）。bounds 缺省按主窗口 60% 居中。
 *
 * v0.26.0 P0（浮窗 UI 根治）：
 *  - 浮窗不再加载落盘的内联 HTML（v0.25.3 方案），改为加载 renderer 构建产物
 *    browser-toolbar.html（独立 Vite 入口，见 electron.vite.config renderer input），
 *    与主窗口共享同一套 Tailwind token / React 体系；形态由 URL ?mode=float|dock 决定。
 *  - dev：ELECTRON_RENDERER_URL 存在时拼接 /browser-toolbar.html（HMR 生效）；
 *    prod：pathToFileURL(out/renderer/browser-toolbar.html)，启动前 existsSync 自检。
 *  - 加载后 executeJavaScript 自检 [data-browser-chrome]，未接线则 reload 重试。
 *  - WebContentsView 从 y = FLOATING_TOOLBAR_HEIGHT 起叠加，chrome 永远可见可点。
 */
/** 浮窗顶部 chrome 高度（px）—— 与 BrowserChrome float 模式单行导航条 h-10 精确一致 */
const FLOATING_TOOLBAR_HEIGHT = 40

let floatingToolbarUrl: string | null = null
function resolveFloatingToolbarUrl(): string {
  if (floatingToolbarUrl) return floatingToolbarUrl
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    floatingToolbarUrl = `${devUrl.replace(/\/+$/, '')}/browser-toolbar.html`
    return floatingToolbarUrl
  }
  const file = join(__dirname, '../renderer/browser-toolbar.html')
  if (!existsSync(file)) {
    logger.warn(
      'Tool',
      `view-manager: browser-toolbar.html missing at ${file} — check electron.vite.config renderer input / build output`,
    )
  }
  floatingToolbarUrl = pathToFileURL(file).href
  return floatingToolbarUrl
}

function createFloatingWindow(bounds?: { x: number; y: number; width: number; height: number }): BrowserWindow {
  const mainWin = BrowserWindow.getAllWindows()[0]
  const defaultBounds = mainWin
    ? {
        x: Math.round(mainWin.getBounds().x + mainWin.getBounds().width * 0.2),
        y: Math.round(mainWin.getBounds().y + mainWin.getBounds().height * 0.15),
        width: Math.round(mainWin.getBounds().width * 0.6),
        height: Math.round(mainWin.getBounds().height * 0.7),
      }
    : { x: 100, y: 100, width: 1024, height: 720 }
  const finalBounds = bounds ?? defaultBounds
  // v0.25.0 F2 P1：浮窗复用主窗口的 preload 脚本（共享 ark.* IPC + 监听器）。
  // dist 产物：out/main/browser/view-manager.js → out/main/preload/index.mjs（相对 ../preload/index.mjs）
  const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url))
  const win = new BrowserWindow({
    x: finalBounds.x,
    y: finalBounds.y,
    width: Math.max(480, finalBounds.width),
    height: Math.max(320, finalBounds.height),
    minWidth: 480,
    minHeight: 320,
    title: 'ArkWork Browser',
    autoHideMenuBar: true,
    webPreferences: {
      // 浮窗 sandbox 必须关闭（preload 需访问 ipcRenderer）
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  })
  // v0.26.0 P0：React 渲染完成后根节点带 data-browser-chrome；
  // 未接线（脚本未执行 / 产物缺失）则 reload 重试。
  const verifyToolbarWired = (): Promise<boolean> =>
    win.webContents
      .executeJavaScript("!!document.querySelector('[data-browser-chrome]')")
      .then((ok) => ok === true)
      .catch(() => false)

  void win
    .loadURL(resolveFloatingToolbarUrl())
    .then(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (win.isDestroyed()) return
        if (await verifyToolbarWired()) return
        logger.warn('Tool', `view-manager: floating toolbar not wired (attempt ${attempt + 1}), reloading`)
        win.webContents.reload()
        await new Promise((r) => setTimeout(r, 400))
      }
    })
    .catch((err) => {
      logger.warn('Tool', `view-manager: floating toolbar load failed: ${(err as Error).message}`)
    })
  return win
}

/** dock → window：把指定 Tab 从主窗口迁到新建 BrowserWindow。已是 window 则幂等返回。 */
export function detachTab(tabId: string, bounds?: { x: number; y: number; width: number; height: number }): { windowId: number } {
  const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
  if (!tab) throw new Error(`view-manager: tab not found: ${tabId}`)
  if (tab.host.kind === 'window') return { windowId: tab.host.windowId }

  // 从主窗口移除（仅在已挂载时）
  const mainWin = BrowserWindow.getAllWindows()[0]
  if (mainWin && tab._attached) {
    try {
      mainWin.contentView.removeChildView(tab.view)
    } catch (err) {
      logger.warn('Tool', `view-manager: removeChildView (dock) failed: ${(err as Error).message}`)
    }
  }

  // 新建浮窗 + 挂载
  const win = createFloatingWindow(bounds)
  tab.host = { kind: 'window', windowId: win.id }
  win.contentView.addChildView(tab.view)
  tab._attached = true // window 上已挂载
  // v0.25.2 fix：view 从工具栏下方开始，避免铺满全窗盖住浮窗工具栏按钮
  // v0.25.3 fix：用 getContentSize()（不含标题栏）计算，避免内容区超出可视区
  const size0 = win.getContentSize()
  tab.view.setBounds({
    x: 0,
    y: FLOATING_TOOLBAR_HEIGHT,
    width: Math.max(0, size0[0]),
    height: Math.max(0, size0[1] - FLOATING_TOOLBAR_HEIGHT),
  })
  tab.view.setVisible(true)
  activeDockTabId = null

  // 浮窗 resize/move 时主动同步 bounds
  const syncBounds = () => {
    if (tab.host.kind !== 'window') return
    if (tab.host.windowId !== win.id) return
    if (win.isDestroyed()) return
    try {
      const size = win.getContentSize()
      tab.view.setBounds({
        x: 0,
        y: FLOATING_TOOLBAR_HEIGHT,
        width: Math.max(0, size[0]),
        height: Math.max(0, size[1] - FLOATING_TOOLBAR_HEIGHT),
      })
    } catch (err) {
      logger.debug('Tool', `view-manager: window resize sync failed: ${(err as Error).message}`)
    }
  }
  win.on('resize', syncBounds)
  win.on('move', syncBounds)

  // v0.26.x fix：浮窗「销毁前」（close 事件）先把 view 摘下迁回 dock。
  // 原逻辑只挂 closed（窗口销毁后）→ 届时 webContents 可能已随窗口一起销毁，
  // 或从已销毁窗口 reparent 失败，表现为"关浮窗后侧栏浏览器不恢复"。
  // 此处 attachTab 内部会调 win.close()，但此时宿主已改为 dock，
  // close/closed 二次进入均被守卫拦截，无递归风险。closed 回调保留作安全网。
  win.on('close', () => {
    const cur = tabs.get(tabId)
    if (!cur || cur.host.kind !== 'window') return
    if (cur.host.windowId !== win.id) return
    try {
      const mainWinNow = BrowserWindow.getAllWindows()[0]
      if (mainWinNow && !mainWinNow.isDestroyed()) {
        attachTab(tabId)
      } else {
        // 主窗口已关 → 销毁 view 兜底
        closeTab(tabId)
      }
    } catch (err) {
      logger.warn('Tool', `view-manager: window close attach failed: ${(err as Error).message}`)
    }
  })

  // 浮窗关闭 → 自动 attach 回 dock（如 dock 仍存在）。v0.26.x 起为安全网：
  // 正常路径已在上方 close 事件完成迁移（host 已是 dock，这里直接返回）
  win.on('closed', () => {
    if (!tabs.has(tabId)) return
    const cur = tabs.get(tabId)
    if (!cur || cur.host.kind !== 'window') return
    if (cur.host.windowId !== win.id) return
    // 尝试 attach 回 dock
    try {
      const mainWinNow = BrowserWindow.getAllWindows()[0]
      if (mainWinNow && !mainWinNow.isDestroyed()) {
        attachTab(tabId)
      } else {
        // 主窗口已关 → 销毁 view 兜底
        closeTab(tabId)
      }
    } catch (err) {
      logger.warn('Tool', `view-manager: window closed attach failed: ${(err as Error).message}`)
    }
  })

  logger.info('Tool', `view-manager: detached ${tabId} to window ${win.id}`)
  return { windowId: win.id }
}

/** window → dock：把指定 Tab 从浮窗迁回主窗口 dock。已是 dock 则幂等返回。 */
export function attachTab(tabId: string): void {
  const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
  if (!tab) throw new Error(`view-manager: tab not found: ${tabId}`)
  if (tab.host.kind === 'dock') return

  const win = getOwnerWindow(tab.host)
  if (win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(tab.view)
    } catch (err) {
      logger.warn('Tool', `view-manager: removeChildView (window) failed: ${(err as Error).message}`)
    }
  }

  const mainWin = BrowserWindow.getAllWindows()[0]
  if (!mainWin || mainWin.isDestroyed()) {
    throw new Error('view-manager: no main window to attach to')
  }
  mainWin.contentView.addChildView(tab.view)
  tab._attached = true
  tab.host = { kind: 'dock' }
  // 关闭浮窗（view 已迁走，安全关）—— 异步；closed 回调里可能再触发 attachTab，
  // 但 tab.host 已改为 dock，二次调会被守卫拦截
  if (win && !win.isDestroyed()) {
    try {
      win.close()
    } catch (err) {
      logger.warn('Tool', `view-manager: close floating window failed: ${(err as Error).message}`)
    }
  }
  // attach 完成后立即把此 Tab 标为 activeDock —— BrowserPanel 收到事件
  // 重新计算 placeholder bounds 推给主进程，触发 view 显示
  activeDockTabId = tabId
  try { tab.view.setVisible(false) } catch { /* ignore */ }
  pushHostChanged(tabId, 'dock')
  logger.info('Tool', `view-manager: attached ${tabId} back to dock`)
}

/** v0.25.0 F2 P1：Tab host 变化后 push 事件给 renderer（让 BrowserPanel 主动 setBounds） */
function pushHostChanged(tabId: string, host: 'dock' | 'window'): void {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (w.isDestroyed()) continue
    w.webContents.send('browser:tab-host-changed', { tabId, host })
  }
}
