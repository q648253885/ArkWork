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

/* v0.31.1：编辑器右键原生菜单（window.ts context-menu）——Menu 空壳 */
export const Menu = {
  buildFromTemplate: () => ({ popup: () => {} }),
}

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

/* 测试内可直接调用已注册的 handler（v0.30.0 详测：graph:* 频道的行为验证）。
 * 行为兼容：handle 原为 no-op，现在只是顺手记下 —— 不注册时不影响任何既有套件。 */
const ipcHandlerRegistry = new Map()

export const ipcMain = {
  handle: (channel, fn) => {
    ipcHandlerRegistry.set(channel, fn)
  },
  on: () => {},
  removeHandler: (channel) => {
    ipcHandlerRegistry.delete(channel)
  },
}

/** 测试辅助：取出已注册的 IPC handler（未注册返回 undefined） */
export function __invokeIpc(channel, ...args) {
  const fn = ipcHandlerRegistry.get(channel)
  if (!fn) throw new Error(`no ipc handler registered for '${channel}'`)
  return fn(undefined, ...args)
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showMessageBox: async () => ({ response: 0 }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
}

export default { app, BrowserWindow, WebContentsView, nativeTheme, shell, session, ipcMain, dialog }
