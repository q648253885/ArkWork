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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 测试进程独占的 userData 根（D98）。
 *
 * 为什么不能再用固定 `/tmp/arkwork-test-userData`：`node --test` **按文件并行**
 * ——每个测试文件是独立进程，却共用同一个固定路径。于是任何一个套件
 * `rm -rf` 这个根（如 skills-zip-export 的 after）或清某个子目录，都会把
 * **同时段运行的另一个套件**的夹具抽走，报 `ENOENT`：单跑全绿、全量偶红。
 *
 * 现在默认每个进程 `mkdtempSync` 一个专属根，退出时自清 —— 跨套件零耦合。
 * 需要固定/跨进程复用路径时，设 `ARKWORK_TEST_USERDATA` 覆盖（设了就不自清）。
 */
const TEST_USERDATA_ROOT =
  process.env.ARKWORK_TEST_USERDATA || mkdtempSync(join(tmpdir(), 'arkwork-test-userData-'))
if (!process.env.ARKWORK_TEST_USERDATA) {
  process.on('exit', () => {
    try {
      rmSync(TEST_USERDATA_ROOT, { recursive: true, force: true })
    } catch {
      /* 退出清理失败不影响测试结论 */
    }
  })
}

export const app = {
  getPath: (name) => (name === 'userData' ? TEST_USERDATA_ROOT : `/tmp/arkwork-test-${name}`),
  isPackaged: false,
  dock: undefined,
  whenReady: async () => {},
  on: () => {},
  quit: () => {},
  /* v0.35.0：registry 的 VP8 engines 判定与 pack 版本对账要读宿主版本 */
  getVersion: () => '0.35.0',
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

/* v0.34.2（D56-a）：net 模块 —— 面板取数通道（ipc/panel.ts）优先用 `net.fetch`
 * （Chromium 栈 → 遵循系统代理/PAC）。单测环境**刻意不提供 fetch**，
 * 让 `pickFetch()` 回落到全局 fetch —— 生产该走哪条栈由 panel-fetch 用例
 * 用注入的假 net 显式断言，而不是靠此桩的存在与否。 */
export const net = {
  fetch: undefined,
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

/* v0.35.0：插件 Host 半进程（runtime/supervisor.ts spawnUtilityProcess）。
 * 单测**不真起进程** —— supervisor 的 spawn 是注入的，用例用假句柄驱动；
 * 这里提供空壳只是为了让 `import { utilityProcess } from 'electron'` 能解析。 */
export const utilityProcess = {
  fork: (_entryPath, _args, _opts) => ({
    postMessage: () => {},
    on: () => {},
    kill: () => {},
    pid: 0,
    stdout: { on: () => {} },
    stderr: { on: () => {} },
  }),
}

/* v0.35.0：`arkwork-plugin://` 自定义协议（main/plugins/protocol.ts）。
 * 空壳注册表 —— 用例只断言「注册了什么 scheme」，不真跑 Chromium 协议栈。 */
const protocolHandlers = new Map()
export const protocol = {
  handle: (scheme, handler) => {
    protocolHandlers.set(scheme, handler)
  },
  unhandle: (scheme) => {
    protocolHandlers.delete(scheme)
  },
  isProtocolHandled: (scheme) => protocolHandlers.has(scheme),
}
export function __getProtocolHandler(scheme) {
  return protocolHandlers.get(scheme)
}

export default { app, BrowserWindow, WebContentsView, nativeTheme, shell, net, session, ipcMain, dialog, utilityProcess, protocol }
