/* ============================================================
 * ArkWork — Main Process Entry
 * 设计文档 §8.1
 * ============================================================ */
import { app, BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { createMainWindow, getMainWindow } from './window.js'
import { registerIpcHandlers } from './ipc/index.js'
import { initStore } from './store/db.js'
import { reconcileStaleTasks } from './store/tasks.js'
import { ensureWorkspace } from './fs/workspace.js'
import { seedDefaults } from './store/seed.js'
import { seedBuiltinSkillsToFolders } from './agent/registry.js'
import { startAutomationScheduler, stopAutomationScheduler } from './automation/scheduler.js'
import { scheduleCleanup } from './fs/cleanup.js'
import { logger } from './system/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 开发环境使用项目内的 .dev-data 目录作为 userData，避免 macOS TCC 限制
// 在 ~/Library/Application Support/Chromium 下创建 SingletonLock 时的 EPERM 错误
if (!app.isPackaged) {
  const devDataDir = resolve(__dirname, '../../.dev-data')
  try {
    mkdirSync(devDataDir, { recursive: true })
  } catch {
    // ignore
  }
  app.setPath('userData', devDataDir)
  // 开发环境禁用 sandbox，避免 macOS TCC 导致 GPU/network 子进程反复崩溃
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  // 开发验证：ARK_DEV_CDP_PORT 开启远程调试（agent-browser 截图验证 UI 用）
  if (process.env.ARK_DEV_CDP_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.ARK_DEV_CDP_PORT)
  }
} else {
  app.setName('ArkWork')
  // 调试：存在 {userData}/.debug-cdp 标志文件时开启远程调试端口 9222
  // （供 agent-browser 等自动化工具连接验证 UI；生产默认不创建该文件即不开启）
  try {
    if (existsSync(join(app.getPath('userData'), '.debug-cdp'))) {
      app.commandLine.appendSwitch('remote-debugging-port', '9222')
    }
  } catch {
    // ignore
  }
}

// 单实例锁（开发环境非致命：拿不到锁也继续，避免 TCC 误杀）
const hasLock = app.requestSingleInstanceLock()
if (!hasLock && !app.isPackaged) {
  // eslint-disable-next-line no-console
  console.warn('[ArkWork] single-instance lock not acquired, continuing in dev mode')
} else if (!hasLock) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  const win = getMainWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  logger.info('System', `ArkWork v${app.getVersion()} starting…`)

  // 初始化存储与工作区
  await initStore()
  await ensureWorkspace()
  // v0.8.0：回收上次意外退出遗留的 running/paused 任务 → cancelled，避免前端卡在暂停/中止
  await reconcileStaleTasks()
  // v0.4.0：写入种子数据（agents/skills/settings）——writeIfMissing 不会覆盖已有文件
  await seedDefaults()
  // v0.6.2：同步内置 skill 元数据到文件夹存储（覆盖更新 description/inputSchema 等）
  await seedBuiltinSkillsToFolders()

  // 注册所有 IPC handlers
  registerIpcHandlers()

  // v0.9.1：启动自动化 cron 调度器（30s tick，命中分钟触发）
  startAutomationScheduler()

  // 注册 .arkwork 临时文件定时清理（每 24h 一次，保守策略仅清理 temp/cache/logs 子目录）
  scheduleCleanup()

  // 创建主窗口
  createMainWindow()

  // v0.27.0 F12：initBrowserController 已删除（webview 旧轨移除），
  // 浏览器统一由 view-manager 单轨承载。

  logger.info('System', 'ArkWork ready')
})

app.on('window-all-closed', () => {
  // macOS 上保留进程，其余平台直接退出
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})

// 安全：阻止创建额外的 webview 与 new-window
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    // 外链一律用系统浏览器打开
    shell.openExternal(url)
    return { action: 'deny' }
  })
})

// v0.6.0（F8）：应用退出前断开所有 MCP 子进程连接，避免僵尸进程
app.on('before-quit', () => {
  // v0.9.1：停止自动化调度器
  stopAutomationScheduler()
  // v0.14.0 Task 9：退出前优雅暂停所有运行中任务——落盘 pause checkpoint 并置
  // paused，重启后 reconcileStaleTasks 保留 paused（可恢复续跑），而不是清成 cancelled。
  void (async () => {
    try {
      const { pauseAll } = await import('./pause/manager.js')
      await pauseAll()
    } catch {
      // 退出时忽略错误（未能落盘的 running 任务由重启 reconcile 兜底为 cancelled）
    }
  })()
  void (async () => {
    try {
      const { disconnectAllMcp } = await import('./mcp/client.js')
      await disconnectAllMcp()
    } catch {
      // 退出时忽略错误
    }
  })()
})
