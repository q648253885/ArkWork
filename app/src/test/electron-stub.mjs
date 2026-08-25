/* ============================================================
 * ArkWork — 统一 electron 模块桩（单份真源，v0.27.0 R0）
 * 仅用于单测环境，让依赖 electron 的模块链能加载成功。
 * 由 src/test/electron-mock-loader.mjs 在 resolve 阶段替换 'electron'。
 *
 * 已知消费方（超集合并自原 store/__tests__ 与 fault-tolerance/__tests__ 两份漂移桩）：
 *  - app.getPath(name)          → db.ts / 各 store 模块
 *  - app.whenReady/on/quit      → main 入口链
 *  - ipcMain.handle/on/removeHandler → ipc/*.ts
 *  - dialog.showOpenDialog/MessageBox/SaveDialog → ipc/skill.ts、registry.ts、fs/workspace.ts
 *  - BrowserWindow.webContents.send   → window.ts 广播链
 *  - WebContentsView（空壳类）        → view-manager / skills-zip-export 具名导入
 *  ============================================================ */

export const app = {
  getPath: (name) => `/tmp/arkwork-test-${name}`,
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
  constructor() {
    this.webContents = { send: () => {} }
  }
  isDestroyed() {
    return false
  }
}

/* 测试仅需模块可加载，这里提供空壳类即可（方法按需再补）。 */
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

export default { app, BrowserWindow, WebContentsView, nativeTheme, shell, session, ipcMain, dialog }
