/* ============================================================
 * ArkWork — IPC Handlers
 * 设计文档 §8.4 — 注册所有 domain handler
 * v0.6.0：拆分为 agent / skill / mcp / market / model 独立 handler
 * ============================================================ */
import { ipcMain } from 'electron'
import { registerTaskHandlers } from './task.js'
import { registerAgentHandlers } from './agent.js'
import { registerSkillHandlers } from './skill.js'
import { registerMcpHandlers } from './mcp.js'
import { registerMarketHandlers } from './market.js'
import { registerModelHandlers } from './model.js'
import { registerMemoryHandlers } from './memory.js'
import { registerFsHandlers } from './fs.js'
import { registerSettingsHandlers } from './settings.js'
import { registerLogHandlers } from './log.js'
import { registerWindowHandlers } from './window.js'
import { registerThemeHandlers } from './theme.js'
import { registerAutomationHandlers } from './automation.js'
import { registerKnowledgeHandlers } from './knowledge.js'
import { registerToolHandlers } from './tool.js'
import { registerRouterHandlers } from './router.js'
import { registerBugfixHandlers } from './bugfix.js'
import { registerPermissionHandlers } from './permission.js'
import { registerContextHandlers } from './context.js'
import { registerProgressHandlers } from './progress.js'
import { registerPlanItemHandlers } from './plan-items.js'
// v0.25.0 F2：WebContentsView Tab 化路由
// v0.27.0 F12：browser:resolve 并入 browser-tabs.js，ipc/browser.js 已删除
import { registerBrowserTabHandlers } from './browser-tabs.js'
import { logger } from '../system/logger.js'

export function registerIpcHandlers(): void {
  logger.info('System', 'registering IPC handlers…')

  registerTaskHandlers()
  registerAgentHandlers()
  registerSkillHandlers()
  registerMcpHandlers()
  registerMarketHandlers()
  registerModelHandlers()
  registerMemoryHandlers()
  registerFsHandlers()
  registerSettingsHandlers()
  registerLogHandlers()
  registerWindowHandlers()
  registerThemeHandlers()
  registerAutomationHandlers()
  registerKnowledgeHandlers()
  registerToolHandlers()
  // v0.14.0 Task 2：chat/task 分流判定
  registerRouterHandlers()
  // v0.14.0 Task 11：bugfix 续跑模式切换
  registerBugfixHandlers()
  // v0.15.0：权限模型
  registerPermissionHandlers()
  // v0.15.x：上下文真实用量按需估算
  registerContextHandlers()
  // Task 9：任务侧边栏进度摘要持久化
  registerProgressHandlers()

  // v0.18.0：planItem 用户手动切状态 + planItems 快照兜底
  registerPlanItemHandlers()

  // v0.25.0 F2：WebContentsView Tab 化路由（view-manager）
  // v0.27.0 F12：registerBrowserHandlers 已删除（webview 旧轨），browser:resolve 并入 browser-tabs.js
  registerBrowserTabHandlers()

  logger.info('System', 'IPC handlers registered')
}

export { ipcMain }
