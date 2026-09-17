/* ============================================================
 * ArkWork — Main Window
 * 设计文档 §8.3 — 主窗口（三栏布局）
 * ============================================================ */
import { app, BrowserWindow, Menu, shell, nativeTheme, session } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { reconcileOrphanRunning } from './agent/runner.js'
import { getUiLocale, tFor } from './i18n/messages.js'
import { logger } from './system/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// v0.31.1：GPU / 性能模式判定 —— 低配机器（如双路 Xeon 工作站）上 Chromium
// 常因驱动评分低静默回退 SwiftShader 软件渲染，此时连续动画会持续全屏重绘，
// 表现为「运行非常卡」。这里在窗口加载完成后读取真实 GPU 状态：
//   ① 始终写一行 `gpu status` 日志（诊断用，用户回报日志即可判定渲染后端）；
//   ② 软件渲染（或 ARK_PERF_LITE=1）→ 给 <html> 注入 .perf-lite，
//      由 globals.css 抑制全部连续动画/过渡（见该处注释）。
// 注入走 executeJavaScript 而非 IPC：避免为一次性降级改动 preload 契约。
async function applyPerformanceMode(win: BrowserWindow): Promise<void> {
  try {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>
    const softwareRendering =
      /software/i.test(status['gpu_compositing'] ?? '') ||
      /software/i.test(status['gl'] ?? '') ||
      /disabled/i.test(status['gpu_compositing'] ?? '')
    const forceLite = process.env.ARK_PERF_LITE === '1'
    logger.info(
      'System',
      `gpu status ${JSON.stringify({
        gpu_compositing: status['gpu_compositing'],
        gl: status['gl'],
        gl_renderer: status['gl_renderer'],
        video_decode: status['video_decode'],
        softwareRendering,
        perfLite: softwareRendering || forceLite,
        source: forceLite ? 'env' : softwareRendering ? 'auto' : 'none',
      })}`,
    )
    if (softwareRendering || forceLite) {
      await win.webContents.executeJavaScript(
        "document.documentElement.classList.add('perf-lite')",
      )
    }
  } catch (err) {
    // 性能降级是「尽力而为」，任何异常都不得影响启动
    logger.warn('System', `performance mode detection failed: ${String(err)}`)
  }
}

/**
 * Task 13：解析应用图标资源。
 * - macOS 打包后 Info.plist 的 CFBundleIconFile 由 electron-builder 从
 *   build-resources/icon.icns 注入；运行时通过 app.dock.setIcon 在开发态
 *   与热重载期间也能保持标准 Dock 图标。
 * - Windows / Linux 使用 256×256 PNG 作为 BrowserWindow icon。
 */
function resolveAppIcon(): { icns?: string; png?: string } {
  const buildResources = resolve(__dirname, '../../build-resources')
  const icns = resolve(buildResources, 'icon.icns')
  const png256 = resolve(buildResources, 'icon-256.png')
  const png1024 = resolve(buildResources, 'icon.png')
  return {
    icns: existsSync(icns) ? icns : undefined,
    png: existsSync(png256) ? png256 : existsSync(png1024) ? png1024 : undefined,
  }
}

const APP_ICONS = resolveAppIcon()

/* v0.9.1：内嵌浏览器（BrowserPanel / PreviewWindow URL）修复
 * 大量站点通过 X-Frame-Options / CSP frame-ancestors 禁止被 iframe 嵌入，
 * 导致内嵌浏览器大面积白屏。Electron 桌面场景下剥离这两个响应头，
 * 仅作用于子框架（subFrame）请求，主窗口导航不受影响。 */
function setupEmbedFriendlySession(): void {
  const ses = session.defaultSession
  ses.webRequest.onHeadersReceived(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders }
      if (details.resourceType === 'subFrame') {
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase()
          if (lower === 'x-frame-options') {
            delete headers[key]
          } else if (lower === 'content-security-policy') {
            // 仅移除 frame-ancestors 指令，保留其余 CSP 规则
            const filtered = headers[key].map((v) =>
              v
                .split(';')
                .filter((dir) => !/^\s*frame-ancestors/i.test(dir))
                .join(';'),
            )
            if (filtered.some((v) => v.trim())) headers[key] = filtered
            else delete headers[key]
          }
        }
      }
      callback({ responseHeaders: headers })
    },
  )
}

// 开发环境通过 Vite dev server 加载，生产环境加载打包后的 index.html
const isDev = !app.isPackaged
const RENDERER_URL = isDev
  ? process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5174'
  : undefined

let mainWindow: BrowserWindow | null = null

// v0.31.1：Windows 原生窗口控件覆盖（WCO）配色 —— 创建与运行时主题切换共用，
// 避免「创建时定死、切换后漂移」两处颜色各自维护。
export const TITLEBAR_OVERLAY_HEIGHT = 40

export function titleBarOverlayColors(resolved: 'dark' | 'light'): {
  color: string
  symbolColor: string
} {
  return resolved === 'dark'
    ? { color: '#16181D', symbolColor: '#A6ABB5' }
    : { color: '#FFFFFF', symbolColor: '#A6ABB5' }
}

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'
  setupEmbedFriendlySession()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'ArkWork',
    // Task 13：BrowserWindow 使用标准图标资源。
    // macOS 上 Info.plist 的 CFBundleIconFile 已由 electron-builder
    // 从 build-resources/icon.icns 注入；此处显式声明是为了
    // dev/hot-reload 与 Linux/Windows 场景下与 macOS 大小一致。
    ...(APP_ICONS.png ? { icon: APP_ICONS.png } : {}),
    // v0.4.0：backgroundColor 随主题切换（浅色白底，深色黑底）
    // v0.9.1：深色底随新 token 更新（#0E1014 → #16181D）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181D' : '#FFFFFF',
    // 跨平台无框标题栏：mac 用 hiddenInset（系统交通灯在左），
    // Windows 用 hidden + titleBarOverlay（原生控件在右），Linux 保留 default
    titleBarStyle: isMac ? 'hiddenInset' : isWin ? 'hidden' : 'default',
    // Win11 原生窗口控件覆盖（右上角），尺寸与系统一致；
    // 运行时主题切换由 ipc/theme.ts 的 onSystemChange 回调接续更新（v0.31.1）
    ...(isWin
      ? {
          titleBarOverlay: {
            ...titleBarOverlayColors(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
            height: TITLEBAR_OVERLAY_HEIGHT,
          },
        }
      : {}),
    // macOS 交通灯位置（左上角）
    ...(isMac ? { trafficLightPosition: { x: 14, y: 16 } } : {}),
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // v0.27.0 F12：webviewTag 已移除（默认 false）——内嵌浏览器统一走
      // 主进程 WebContentsView（view-manager），不再有 <webview> 渲染层轨道。
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // v0.31.1：编辑器/输入区原生右键菜单（Windows 用户实测：编辑器右键无菜单，
  // 无法复制粘贴）。CM6 的 contenteditable 与各输入框命中 params.isEditable；
  // 只读渲染区有选中文本时给「复制」。纯浏览区（无选区、不可编辑）不弹菜单，
  // 保持页面自身可能存在的右键行为（如文件树自定义菜单）不被抢占。
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const editable = params.isEditable
    const hasSelection = params.selectionText.trim().length > 0
    if (!editable && !hasSelection) return
    const locale = getUiLocale()
    const template: MenuItemConstructorOptions[] = [
      { role: 'cut', label: tFor(locale, 'contextmenu.cut'), visible: editable && hasSelection },
      { role: 'copy', label: tFor(locale, 'contextmenu.copy'), visible: hasSelection },
      { role: 'paste', label: tFor(locale, 'contextmenu.paste'), visible: editable },
      { type: 'separator' },
      { role: 'selectAll', label: tFor(locale, 'contextmenu.selectAll'), visible: editable },
    ]
    Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined })
  })

  if (isDev && RENDERER_URL) {
    mainWindow.loadURL(RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(resolve(__dirname, '../renderer/index.html'))
  }

  // v0.31.1：DOM 就绪后判定 GPU 后端并（必要时）注入性能降级模式。
  // 放在 did-finish-load 而非 ready-to-show：前者保证 documentElement 已存在，
  // 注入 class 不会被后续导航/重载丢弃。
  mainWindow.webContents.once('did-finish-load', () => {
    const win = mainWindow
    if (win) void applyPerformanceMode(win)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Task 13：macOS Dock 图标显式设置为标准资源，确保开发态、Cmd+Tab、
  // Dock 缩放都使用与打包产物一致的图标资源。
  // 优先使用 1024×1024 PNG：Electron 的 nativeImage.createFromPath 对 PNG
  // 行为确定（单一完整尺寸表示，由系统按 Dock 当前尺寸正确缩放）；
  // .icns 的多分辨率表示（ic04..ic14）在部分 Electron/系统组合下可能被
  // Dock 取到非最佳尺寸后放大渲染，表现为"图标比其它应用大一圈"。
  // 因此 Dock 运行时以 PNG 为准，.icns 仅作为打包产物（CFBundleIconFile）与回退。
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = APP_ICONS.png ?? APP_ICONS.icns
    if (dockIcon) app.dock.setIcon(dockIcon)
  }

  // v0.15.1 启动 reconcile：扫所有 status='running' 任务，孤儿任务修正为 failed
  void reconcileOrphanRunning()

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/** 向所有窗口的 renderer 广播事件 */
export function broadcast(channel: string, payload: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
