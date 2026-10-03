/* ============================================================
 * ArkWork — Main Process Entry
 * 设计文档 §8.1
 * ============================================================ */
import { app, BrowserWindow, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { createMainWindow, getMainWindow } from './window.js'
import { registerIpcHandlers, bootstrapIpcSideEffects } from './ipc/index.js'
import { initStore } from './store/db.js'
import { reconcileStaleTasks } from './store/tasks.js'
import { ensureWorkspace } from './fs/workspace.js'
import { seedDefaults } from './store/seed.js'
import { migrateAgentSpace, seedWorkspaceMemoryFromAgentSpace } from './memory/agent-space.js'
import { seedBuiltinSkillsToFolders } from './agent/registry.js'
import { startAutomationScheduler, stopAutomationScheduler } from './automation/scheduler.js'
import { scheduleCleanup } from './fs/cleanup.js'
// ★ v0.35.0：插件运行时（代码化插件 · 双端 · 进程隔离）
//   `registerPluginSchemePrivileges` 必须在 app ready **之前**调用 ——
//   `standard: true` 的协议特权注册只被 Electron 在 ready 前接受，之后调用静默无效。
import { registerPluginSchemePrivileges } from './plugins/protocol.js'
import { bootstrapPluginRuntime, shutdownPluginRuntime } from './plugins/bootstrap.js'
import { setHostVersion } from './plugins/registry.js'
import { logger } from './system/logger.js'
// v0.46.0（PERF-2 W14）：低配档 ready 前决策（纯模块，无 electron 依赖）
import {
  readPerfCache,
  readPerfModeFileSync,
  decidePreReadyLowSpec,
  LOW_SPEC_MAX_OLD_SPACE_MB,
} from './system/perf-mode.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// v0.31.1：ARK_CDP_PORT 环境变量开启远程调试（launchctl setenv ARK_CDP_PORT 9223
// 后 open 生效）——供自动化工具连接实测 UI；不设置则完全不开启。
// 必须在任何 window 创建之前、app ready 之前调用 appendSwitch。
if (process.env.ARK_CDP_PORT && /^\d{2,5}$/.test(process.env.ARK_CDP_PORT)) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ARK_CDP_PORT)
}

// v0.31.1：低配机器性能开关（打包版可用，命令行/环境变量二选一）
//   ARK_FORCE_GPU=1 —— 强制启用被 Chromium 拉黑的 GPU 与光栅化。
//     适用：机器**有**可用独显/核显，但驱动评分低被 Chromium 判为不可用，
//     从而静默回退 SwiftShader 软件渲染（低配 Windows 卡顿的常见首因）。
//     副作用：驱动质量差时可能花屏/闪退，异常即去掉该变量。
//   ARK_PERF_LITE=1 —— 强制性能降级模式（抑制全部连续动画，见 globals.css）。
//     适用：只想立刻降低渲染开销，或 GPU 状态检测未命中但实际仍卡的场景。
if (process.env.ARK_FORCE_GPU === '1') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
}

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
  // 调试：存在 {userData}/.debug-cdp 标志文件时开启远程调试端口
  // （供 agent-browser 等自动化工具连接验证 UI；生产默认不创建该文件即不开启）。
  // v0.31.1：文件内容为端口号（空/非法 → 9223）；默认端口避开 9222
  // （本机 Chrome 扩展服务常驻占用 9222，曾导致 CDP 永远连不上 ArkWork）。
  try {
    const flagPath = join(app.getPath('userData'), '.debug-cdp')
    if (existsSync(flagPath)) {
      const raw = readFileSync(flagPath, 'utf-8').trim()
      const port = /^\d{2,5}$/.test(raw) ? raw : '9223'
      app.commandLine.appendSwitch('remote-debugging-port', port)
    }
  } catch {
    // ignore
  }
}

// v0.46.0（PERF-2 W14）：低配档 ready 前决策 —— `app.disableHardwareAcceleration()`
// 与 js-flags 堆上限**只能在 app ready 之前**生效，而 GPU 判定在 ready 后才可用，
// 因此用上一轮启动的判定结果（perf-cache.json 粘滞）在本轮决策：
//   perfMode=on ／ ARK_PERF_LITE=1 ／ auto 且上轮判中软件渲染 → 关硬件加速 +
//   全进程 V8 old-space 上限（低配 VM 上防单 renderer 堆无界膨胀）。
// 首轮无缓存：本轮仅 perf-lite（既有行为），判定后写缓存 → 次轮拿全量收益。
// ARK_FORCE_GPU=1 时跳过（用户显式要 GPU）。任何异常静默跳过，不影响启动。
try {
  if (process.env.ARK_FORCE_GPU !== '1') {
    const arkworkDir = join(app.getPath('userData'), 'arkwork-data')
    const perfMode = readPerfModeFileSync(join(arkworkDir, 'settings.json'))
    const cache = readPerfCache(arkworkDir)
    const verdict = decidePreReadyLowSpec(
      perfMode,
      cache.gpuSoftwareLastRun,
      process.env.ARK_PERF_LITE === '1',
    )
    if (verdict.lowSpec) {
      app.disableHardwareAcceleration()
      app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${LOW_SPEC_MAX_OLD_SPACE_MB}`)
      logger.info(
        'System',
        `low-spec pre-ready mode ON (source=${verdict.source}): hardware acceleration disabled, V8 old-space <= ${LOW_SPEC_MAX_OLD_SPACE_MB}MB`,
      )
    }
  }
} catch (err) {
  logger.warn('System', `pre-ready low-spec decision failed (ignored): ${String(err)}`)
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

// ★ v0.35.0：注册 `arkwork-plugin://` 的协议特权（standard / secure / 允许 fetch）。
// **必须在 `app.whenReady()` 之前** —— ready 之后注册会被静默忽略，
// 于是插件的 iframe 拿不到独立源、它自己的 fetch 也会被 CORS 挡掉（无报错，只是不工作）。
registerPluginSchemePrivileges()

app.whenReady().then(async () => {
  logger.info('System', `ArkWork v${app.getVersion()} starting…`)

  // ★ v0.36.0（D84）：宿主版本必须**先于一切插件扫描**注入。
  //   profile 挂载（下方 bootstrapIpcSideEffects）会触发插件索引刷新，
  //   而 bootstrapPluginRuntime 的 setHostVersion 在它之后 —— 早扫描看到的是
  //   占位版本 0.0.0，任何声明了 engines 的插件都被误判「版本不满足」而跳过
  //   （实机冒烟：ark.test.hostsmoke 连续 3 次「0.0.0 不满足」后才被后续扫描救回）。
  setHostVersion(app.getVersion())

  // 初始化存储与工作区
  await initStore()
  await ensureWorkspace()

  // ★ v0.36.0（F1.1 / 决策 D1）：记忆分层归位 —— L1/L2 留在工作区，
  //   L3a 策展记忆与 L4a 用户画像迁入 Agent 空间（跨工作区公共）。
  //   幂等：只在首次（无 .migrated 标记）真正搬文件；失败不阻断启动（下次重试）。
  try {
    const r = await migrateAgentSpace(app.getVersion())
    if (r.moved.length > 0) {
      logger.info('System', `[agent-space] 记忆已迁入公共空间：${r.moved.join(', ')}`)
    }
    // ★ v0.36.3：memory.md 回迁工作区（项目偏好/规则属于项目）。
    //   幂等 + 不覆盖 + 不删源：老版本迁进 Agent 空间的那份复制回工作区。
    const seed = await seedWorkspaceMemoryFromAgentSpace()
    if (seed.copied) logger.info('System', `[l3a] 项目记忆已回迁：${seed.to}`)
  } catch (err) {
    logger.warn('System', `[agent-space] 迁移跳过（不阻断启动）：${String(err)}`)
  }

  // v0.8.0：回收上次意外退出遗留的 running/paused 任务 → cancelled，避免前端卡在暂停/中止
  await reconcileStaleTasks()
  // v0.4.0：写入种子数据（agents/skills/settings）——writeIfMissing 不会覆盖已有文件
  await seedDefaults()
  // v0.6.2：同步内置 skill 元数据到文件夹存储（覆盖更新 description/inputSchema 等）
  await seedBuiltinSkillsToFolders()

  // 注册所有 IPC handlers
  registerIpcHandlers()

  // v0.32.0：挂载持久化的 Workbench Profile（插槽注册 + 快照补写）
  //   —— 必须在窗口创建之前，否则首屏渲染出的 DocK/首页模块会是未装配形态
  await bootstrapIpcSideEffects()

  // ★ v0.35.0：装配插件运行时（协议 → 宿主服务 → 拔插连通 → 扫描/索引 → 常驻激活）
  // 放在 profile 之后：它要读「工作区级插件目录」，而工作区路径由上面那步确定。
  // 出问题也只 warn（单个坏插件绝不能拦住整个 App 启动）
  try {
    await bootstrapPluginRuntime({ mainDir: __dirname })
  } catch (err) {
    logger.warn('System', `[plugin] 运行时装配失败：${String(err)}`)
  }

  // v0.9.1：启动自动化 cron 调度器（30s tick，命中分钟触发）
  startAutomationScheduler()

  // 注册 .arkwork 临时文件定时清理（每 24h 一次，保守策略仅清理 temp/cache/logs 子目录）
  scheduleCleanup()

  // 创建主窗口
  createMainWindow()

  // v0.27.0 F12：initBrowserController 已删除（webview 旧轨移除），
  // 浏览器统一由 view-manager 单轨承载。

  logger.info('System', 'ArkWork ready')

  // v0.36.0 B2 实机冒烟（dev-only）：ARKWORK_B2_SMOKE=1 时跑插件生命周期门槛
  // 「zip 安装 → 启用 → 命令触发 → 卸载无残留」，结果落 .arkwork/b2-smoke/result.json 后退出
  if (process.env.ARKWORK_B2_SMOKE === '1') {
    void import('./dev/b2-smoke.js').then((m) => m.maybeRunB2Smoke())
  }
  // v0.36.0 B3 实机冒烟（dev-only）：ARKWORK_B3_SMOKE=1 时跑 git 门槛
  // 「真仓 → 真插件激活 → 真桥 status/write → 审计落盘」，结果落 .arkwork/b3-smoke/result.json 后退出
  // ⚠️ 会把工作区切到冒烟仓库，必须配 --user-data-dir 独立数据目录运行
  if (process.env.ARKWORK_B3_SMOKE === '1') {
    void import('./dev/b3-smoke.js').then((m) => m.maybeRunB3Smoke())
  }
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
  // ★ v0.35.0：插件运行时 —— 先让每个插件的 Host 半跑完自己的 effect 清理
  // （`host/dispose`，3s 超时后 kill），再退出。顺序在 MCP 断开之前：
  // 插件工具可能正持有 MCP 连接，反过来会让插件的 cleanup 拿到已断开的会话。
  shutdownPluginRuntime()
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
