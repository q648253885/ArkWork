/* electron 模块桩 — 提供测试期间用到的最小 API 表面。
 * 仅用于单测环境，让依赖 electron 的模块链（logger → db → electron）能加载成功。
 *
 * 已知用到以下导出的源文件：
 *  - app.getPath('userData') → db.ts
 *  - ipcMain.handle          → ipc/*.ts（store/skills → ipc/skill）
 *  - dialog.showOpenDialog   → ipc/skill.ts
 *  - dialog.showMessageBox   → registry.ts（makeNativeConfirm，仅 main 进程）
 */
export const app = {
  getPath: (name) => `/tmp/arkwork-test-userData`,
  isPackaged: false,
  dock: undefined,
  whenReady: async () => {},
  on: () => {},
  quit: () => {},
}

export class BrowserWindow {
  static getAllWindows() {
    return []
  }
}

/* v0.26.x：view-manager / skills-zip-export 等模块从 'electron' 具名导入
 * WebContentsView，桩缺该导出会导致整条传递依赖链的测试加载即炸。
 * 测试仅需模块可加载，这里提供空壳类即可（方法按需再补）。 */
export class WebContentsView {}

export const nativeTheme = {
  shouldUseDarkColors: false,
}

export const shell = {
  openExternal: async () => true,
}

export const session = {
  defaultSession: {
    webRequest: {
      onHeadersReceived: () => {},
    },
  },
}

export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 0 }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
}

export default { app, BrowserWindow, nativeTheme, shell, session, ipcMain, dialog }