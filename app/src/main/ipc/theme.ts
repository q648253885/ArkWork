/* ============================================================
 * ArkWork — IPC: Theme (v0.4.0)
 * 设计文档 §5.1 / §5.2
 *
 * 注册两个通道：
 *   1. theme:apply（Renderer → Main）：同步原生界面主题
 *   2. theme:system-changed（Main → Renderer）：广播系统主题变化
 *
 * 错误场景：无（ThemeService 为同步 API，不抛错）
 * ============================================================ */
import { ipcMain, BrowserWindow } from 'electron'
import { applyTheme, getSystemTheme, onSystemChange } from '../theme.js'
import type { ThemeMode, ResolvedTheme } from '@shared/types/ipc'

export function registerThemeHandlers(): void {
  // 1. Renderer → Main：应用主题到原生界面
  ipcMain.handle('theme:apply', async (_e, theme: ThemeMode) => {
    applyTheme(theme)
  })

  // 2. Renderer → Main：查询系统当前实际主题
  ipcMain.handle('theme:get-system', async () => {
    return getSystemTheme() satisfies ResolvedTheme
  })

  // 3. Main → Renderer：系统主题变化时广播给所有窗口
  onSystemChange((systemTheme) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:system-changed', systemTheme)
    }
  })
}
