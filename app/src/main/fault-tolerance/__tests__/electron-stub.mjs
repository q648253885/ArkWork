/* electron 模块桩 — 满足 fault-tolerance 模块传递依赖所需最小 API */
export const app = {
  getPath: (name) => `/tmp/arkwork-test-${name}`,
  isPackaged: false,
  dock: undefined,
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

/** engine 依赖链（fs/workspace.ts → dialog.showMessageBox）所需 */
export const dialog = {
  showMessageBox: async () => ({ response: 0 }),
}

/** engine 依赖链（ipc/* → ipcMain）所需 */
export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
}

export default { app, BrowserWindow, nativeTheme, shell, session, dialog, ipcMain }
