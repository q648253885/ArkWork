/* ============================================================
 * v0.14.0 Task 5.5 — 异常卡片通知（pushFaultCard）
 *
 * 推送通道：
 *  - 'notify:danger' toast（renderer 渲染 danger 级别）
 *  - 'fault:card'  异常卡片（renderer 渲染 Card + 决策按钮）
 *
 * 事件总线：使用 window.broadcast(channel, payload) — 与既有 task:step / task:progress 同源
 * 审计：用户决策写入 audit/fault.log（与 router-eval.ts 同源 / 隔离文件）
 * ============================================================ */

import { mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { broadcast } from '../window.js'
import { getArkworkDir } from '../store/db.js'
import type { FaultError, FaultNotificationPayload } from './types.js'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

export interface FaultCardDecision {
  onRetry?: () => void
  onIgnore?: () => void
  onCancelFollowing?: () => void
}

/**
 * 推送异常卡片到 renderer。
 * 同时落审计 fault.log（决策记录由 logFaultDecision 单独调用）。
 */
export function pushFaultCard(
  fault: FaultError,
  impact: { blocksFollowers: boolean; reason: string },
  decision: FaultCardDecision = {},
  context: { taskId?: string; planItemId?: string } = {},
): FaultNotificationPayload {
  const cardId = randomUUID()
  // v0.29.0 F6：主进程文案随 UI 语言（settings.json language）切换
  const locale = getUiLocale()
  const payload: FaultNotificationPayload = {
    fault,
    impact,
    cardId,
    decisions: [
      { id: 'retry', label: tFor(locale, 'fault.retryLabel') },
      { id: 'ignore', label: tFor(locale, 'fault.ignoreLabel') },
      { id: 'cancel-following', label: tFor(locale, 'fault.cancelFollowingLabel') },
    ],
    taskId: context.taskId,
    planItemId: context.planItemId,
  }
  // 1. 推 toast（danger 级别）
  broadcast('notify:danger', {
    type: 'fault',
    message: tFor(locale, 'fault.toolFailedMessage', { tool: fault.toolName ?? '', message: fault.message }),
    cardId,
    severity: fault.originalKind === 'llm-fatal' ? 'critical' : 'high',
  })
  // 2. 推 fault:card（renderer 渲染卡片 + 决策按钮）
  broadcast('fault:card', payload)
  // 3. alarm log（不要阻塞；fire-and-forget）
  void logFaultAudit({
    cardId,
    type: 'pushed',
    fault,
    impact,
    taskId: context.taskId,
    planItemId: context.planItemId,
  })
  // 4. 将决策回调挂到全局注册表（renderer 通过 fault:decision:respond 通道回传）
  registerDecision(cardId, decision)
  return payload
}

/**
 * 用户决策回调注册表。
 * 渲染层通过 IPC 推 'fault:decision:respond' {cardId, decision}
 * main 进程从该 Map 取出回调并执行。
 */
const decisionRegistry = new Map<string, FaultCardDecision>()

export function registerDecision(cardId: string, decision: FaultCardDecision): void {
  decisionRegistry.set(cardId, decision)
  // 30 分钟自动清理（避免泄漏）
  setTimeout(() => decisionRegistry.delete(cardId), 30 * 60 * 1000).unref()
}

/** 渲染层回传决策时调用（IPC 入口可调用） */
export function respondFaultDecision(
  cardId: string,
  decision: 'retry' | 'ignore' | 'cancel-following',
): boolean {
  const entry = decisionRegistry.get(cardId)
  if (!entry) return false
  decisionRegistry.delete(cardId)
  if (decision === 'retry' && entry.onRetry) entry.onRetry()
  else if (decision === 'ignore' && entry.onIgnore) entry.onIgnore()
  else if (decision === 'cancel-following' && entry.onCancelFollowing) entry.onCancelFollowing()
  // 写审计
  void logFaultAudit({
    cardId,
    type: 'decision',
    decision,
    at: Date.now(),
  })
  return true
}

/**
 * 写 fault.log 审计（独立 path，避免污染 router-eval）
 */
async function logFaultAudit(record: Record<string, unknown>): Promise<void> {
  try {
    const file = join(getArkworkDir(), 'audit', 'fault.log')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(
      file,
      JSON.stringify({ ...record, ts: Date.now() }) + '\n',
      'utf8',
    )
  } catch (err) {
    logger.warn('System', `fault-tolerance: failed to write fault.log: ${(err as Error).message}`)
  }
}

/** 显式导出：其它模块（编排器）可独立调用决策审计（不通过 IPC） */
export async function logFaultDecision(record: {
  cardId?: string
  fault?: FaultError
  decision?: 'retry' | 'ignore' | 'cancel-following' | 'auto'
  note?: string
}): Promise<void> {
  await logFaultAudit({ ...record, type: 'decision' })
}
