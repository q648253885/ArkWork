/* ============================================================
 * ArkWork — Bugfix Skill: progress (v0.14.0 Task 11.7)
 * bugfix:progress 进度事件：
 *   goal-defined → fixing → verifying → achieved / not-achieved
 * 经事件总线（window.broadcast）推送，
 * Inspector 操作岛台（BugfixIsland）订阅实时刷新。
 * ============================================================ */
import type { BugfixProgressEvent } from '@shared/types/ipc'
import { broadcast } from '../../../window.js'
import { logger } from '../../../system/logger.js'

export type BugfixPhase = BugfixProgressEvent['phase']

export function emitBugfixProgress(payload: Omit<BugfixProgressEvent, 'ts'>): void {
  const event: BugfixProgressEvent = { ...payload, ts: Date.now() }
  broadcast('bugfix:progress', event)
  logger.info(
    'Tool',
    `bugfix:progress phase=${event.phase} round=${event.round} attempt=${event.attempt}`,
    event.taskId,
  )
}
