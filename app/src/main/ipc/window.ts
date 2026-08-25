/* ============================================================
 * ArkWork — Window Control IPC Handlers (v0.3.0)
 * 跨平台窗口控制：最小化 / 最大化切换 / 关闭
 * 供 Renderer 自定义标题栏按钮调用
 * ============================================================ */
import { ipcMain, BrowserWindow } from 'electron'

export function registerWindowHandlers(): void {
  const getWin = (e: Electron.IpcMainInvokeEvent) => {
    return BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
  }

  ipcMain.handle('window:minimize', (e) => {
    getWin(e)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = getWin(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (e) => {
    getWin(e)?.close()
  })
  ipcMain.handle('window:is-maximized', (e) => {
    return getWin(e)?.isMaximized() ?? false
  })
}
