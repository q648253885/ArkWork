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
import { TITLEBAR_OVERLAY_HEIGHT, titleBarOverlayColors } from '../window.js'
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
    // v0.31.1：Windows WCO（titleBarOverlay）跟随主题同步。
    // 修复：overlay 的 color 只在 createMainWindow 时按当时主题定死，
    // 运行时切到暗色后右上角最小化/最大化/关闭按钮区残留白底。
    // 'updated' 在 themeSource（应用内切换）与系统主题变化时都会触发，
    // 此处是两条路径的唯一汇合点。
    if (process.platform === 'win32') {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        try {
          win.setTitleBarOverlay({
            ...titleBarOverlayColors(systemTheme),
            height: TITLEBAR_OVERLAY_HEIGHT,
          })
        } catch {
          // 未启用 WCO 的窗口（如 Browser 浮窗走系统标题栏）不支持
          // setTitleBarOverlay —— 忽略即可，不影响其余窗口。
        }
      }
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:system-changed', systemTheme)
    }
  })
}
