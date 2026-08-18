/* ============================================================
 * ArkWork — IPC: Browser (v0.24.1)
 * 处理 renderer 回传的 webview 加载结果（browser:load-done）。
 * 加载请求由主进程 browser/controller 主动 push 到 renderer（browser:load）。
 * ============================================================ */
import { ipcMain } from 'electron'
import { resolveBrowserLoad, resolveBrowserUrl } from '../browser/controller.js'
import { logger } from '../system/logger.js'

export function registerBrowserHandlers(): void {
  ipcMain.handle('browser:load-done', (_e, payload: { requestId: string; error?: string }) => {
    resolveBrowserLoad(payload.requestId, payload.error)
    return true
  })
  // 地址栏 / BrowserPanel 输入 → 完整 URL（本地路径转 file://）
  ipcMain.handle('browser:resolve', (_e, input: string) => {
    return resolveBrowserUrl(input)
  })
  logger.info('System', 'browser IPC handlers registered')
}
