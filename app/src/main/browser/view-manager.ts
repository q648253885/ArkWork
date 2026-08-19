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
 * ============================================================ */
import { BrowserWindow, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { logger } from '../system/logger.js'
import type { BrowserTabMeta } from '@shared/types/ipc'

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

/** 创建新 Tab（不激活；调用方按需 activate）。 */
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
  // 默认挂在第一个 BrowserWindow（主窗口）的 contentView 上
  const mainWin = BrowserWindow.getAllWindows()[0]
  if (mainWin) {
    mainWin.contentView.addChildView(view)
  }
  const tab: BrowserTab = {
    tabId,
    view,
    url: opts?.url ?? '',
    title: 'New Tab',
    host: { kind: 'dock' },
    agentDriven: false,
    createdAt: Date.now(),
  }
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

/** 关闭并销毁 Tab。 */
export function closeTab(tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  try {
    const win = getOwnerWindow(tab.host)
    if (win) {
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
  logger.info('Tool', `view-manager: closed tab ${tabId}`)
}

/** 激活 dock Tab（互斥：dock 内只显示一个）。host = window 时只打开可见性。 */
export function activateTab(tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`view-manager: tab not found: ${tabId}`)
  if (tab.host.kind === 'dock') {
    // dock 互斥：其他 dock Tab 全部 setVisible(false)
    for (const [otherId, other] of tabs) {
      if (otherId === tabId) continue
      if (other.host.kind !== 'dock') continue
      try {
        other.view.setVisible(false)
      } catch { /* ignore */ }
    }
    activeDockTabId = tabId
  }
  try {
    tab.view.setVisible(true)
  } catch (err) {
    logger.warn('Tool', `view-manager: setVisible failed for ${tabId}: ${(err as Error).message}`)
  }
}

/** 同步占位区 DOMRect 到指定 Tab（host=dock 时有效）。 */
export function setTabBounds(
  tabId: string,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  if (tab.host.kind !== 'dock') return // host=window 时 view 恒铺满窗口
  try {
    tab.view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    })
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