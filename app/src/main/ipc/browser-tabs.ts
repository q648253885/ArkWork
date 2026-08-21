/* ============================================================
 * ArkWork — IPC: Browser Tabs (v0.25.0 F2 / 设计文档 §4.4)
 *
 * 把 WebContentsView Tab 化路由暴露给 renderer；
 * 复用 browser:load 协议（push browser:load 触发 renderer 激活 Tab 加载 URL）。
 * ============================================================ */
import { ipcMain } from 'electron'
import {
  createTab,
  closeTab,
  activateTab,
  setTabBounds,
  navigateTab,
  listTabs,
  getTabView,
  setAgentDriven,
  closeAllTabs,
  detachTab,
  attachTab,
} from '../browser/view-manager.js'
import type { BrowserTabMeta } from '@shared/types/ipc'
import { logger } from '../system/logger.js'

export interface CreateTabArgs {
  url?: string
  newTab?: boolean
}

export interface NavigateArgs {
  tabId: string
  url: string
}

export interface SetBoundsArgs {
  tabId: string
  rect: { x: number; y: number; width: number; height: number }
}

export function registerBrowserTabHandlers(): void {
  ipcMain.handle('browser:tabs:create', (_e, args: CreateTabArgs = {}): { tabId: string } => {
    const tab = createTab({ url: args.url })
    if (args.newTab) activateTab(tab.tabId)
    return { tabId: tab.tabId }
  })

  ipcMain.handle('browser:tabs:close', (_e, args: { tabId: string }) => {
    closeTab(args.tabId)
    return true
  })

  ipcMain.handle('browser:tabs:activate', (_e, args: { tabId: string }) => {
    activateTab(args.tabId)
    return true
  })

  ipcMain.handle('browser:tabs:navigate', async (_e, args: NavigateArgs) => {
    return navigateTab(args.tabId, args.url)
  })

  ipcMain.handle('browser:tabs:set-bounds', (_e, args: SetBoundsArgs) => {
    setTabBounds(args.tabId, args.rect)
    return true
  })

  ipcMain.handle('browser:tabs:list', (): BrowserTabMeta[] => listTabs())

  ipcMain.handle('browser:tabs:set-agent-driven', (_e, args: { tabId: string; agentDriven: boolean }) => {
    setAgentDriven(args.tabId, args.agentDriven)
    return true
  })

  // 调试用：暴露给 controller / 测试
  ipcMain.handle('browser:tabs:get-view-id', (_e, _args: { tabId: string }) => {
    const view = getTabView(_args.tabId)
    return view?.webContents.id ?? null
  })

  // v0.25.0 F2 P1：dock ↔ window Tab 迁移（解决 dock 切标签丢 webContents / 浮窗浏览器不可用 bug）
  ipcMain.handle('browser:tabs:detach', (_e, args: { tabId: string; bounds?: { x: number; y: number; width: number; height: number } }) => {
    return detachTab(args.tabId, args.bounds)
  })
  ipcMain.handle('browser:tabs:attach', (_e, args: { tabId: string }) => {
    attachTab(args.tabId)
    return true
  })

  logger.info('System', 'browser:tabs IPC handlers registered')
}

export { closeAllTabs }