/* ============================================================
 * ArkWork — IPC: Bugfix（v0.14.0 Task 11）
 * 通道：
 *  - bugfix:mode:get  读取续跑模式（multi-attempt / single-attempt）
 *  - bugfix:mode:set  切换续跑模式（⌘K CommandPalette 调用）
 * 进度事件不走 IPC invoke，由 main 端 broadcast('bugfix:progress')
 * 推送、preload 订阅（见 preload/index.ts bugfix.onProgress）。
 * ============================================================ */
import { ipcMain } from 'electron'
import { getBugfixMode, setBugfixMode } from '../skills/builtin/bugfix/mode.js'
import type { BugfixMode } from '@shared/types/ipc'
import { logger } from '../system/logger.js'

export function registerBugfixHandlers(): void {
  ipcMain.handle('bugfix:mode:get', (): BugfixMode => getBugfixMode())

  ipcMain.handle(
    'bugfix:mode:set',
    (_e, payload: { mode?: BugfixMode }): BugfixMode => {
      const next = setBugfixMode(payload?.mode ?? 'multi-attempt')
      logger.info('System', `bugfix mode → ${next}`)
      return next
    },
  )
}
