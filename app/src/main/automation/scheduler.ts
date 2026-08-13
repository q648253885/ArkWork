/* ============================================================
 * ArkWork — Automation Scheduler (v0.9.1 §Task 6)
 * 轻量 cron 调度器：让 trigger='cron' 的自动化真实按时触发
 *
 * - 30s tick，命中分钟即运行（同一分钟不重复触发）
 * - cron 解析逻辑在 ./cron.ts（纯函数，可单测）
 * - 运行 = runAutomation（创建任务 + 立即启动 ReAct）
 * - 全程失败静默记日志，不影响主进程
 *
 * v0.9.1 修复：
 *  - 启动时立即触发一次 tick（应用启动刚好命中某分钟时不会再等 30s）
 *  - 同分钟去重只在「上一次 fired 的分钟」上有效，跨分钟允许重新触发
 *    （之前 firedThisMinute Set 是无限累积，新版仅维护「每条自动化上次 fired 的分钟」）
 * ============================================================ */
import { listAutomations, runAutomation } from '../store/automations.js'
import { matchesCron } from './cron.js'
import { logger } from '../system/logger.js'

let timer: NodeJS.Timeout | null = null
/**
 * 每条自动化上次触发的分钟键（yyyyMMddHHmm）。
 * 仅保留同分钟的去重，超时（下一分钟）后会自动允许再次触发。
 */
const lastFiredMinute = new Map<string, string>()

function currentMinuteKey(now: Date): string {
  // 6 段足够去重到分钟
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
}
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

async function tick(): Promise<void> {
  try {
    const now = new Date()
    const minuteKey = currentMinuteKey(now)
    const autos = await listAutomations()
    for (const a of autos) {
      if (a.status !== 'active' || a.trigger !== 'cron' || !a.cronExpr) continue
      if (!matchesCron(a.cronExpr, now)) continue
      // 同分钟去重：若该 automation 在当前分钟已经触发过，跳过
      if (lastFiredMinute.get(a.id) === minuteKey) continue
      lastFiredMinute.set(a.id, minuteKey)
      // 防止内存膨胀：清理 1 小时前的旧条目
      const cutoffMs = now.getTime() - 60 * 60 * 1000
      for (const [id, mk] of lastFiredMinute) {
        // 解析 minuteKey → 不易做，保守：每隔若干次清理一次
        if (lastFiredMinute.size > 500 && Math.random() < 0.1) {
          lastFiredMinute.delete(id)
          if (lastFiredMinute.size <= 400) break
        }
        void cutoffMs // 保留以备后续按时间戳比对
      }
      try {
        const { taskId } = await runAutomation(a.id)
        logger.info('System', `cron automation fired: ${a.id} "${a.name}" → task ${taskId}`)
      } catch (err) {
        logger.warn('System', `cron automation failed: ${a.id}: ${(err as Error).message}`)
      }
    }
  } catch (err) {
    logger.warn('System', `automation scheduler tick failed: ${(err as Error).message}`)
  }
}

/** 启动调度器（应用 ready 后调用一次） */
export function startAutomationScheduler(): void {
  if (timer) return
  // 30s tick，容忍系统休眠导致的轻微漂移
  timer = setInterval(() => void tick(), 30_000)
  timer.unref?.()
  // v0.9.1 §Task 6：应用启动后立即触发一次 tick——
  // 若启动时刚好命中某分钟（如 9:00 整应用 crash 后重启），不需要再等 30s。
  void tick()
  logger.info('System', 'automation scheduler started (30s tick, immediate first tick)')
}

/** 停止调度器（退出前调用） */
export function stopAutomationScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  lastFiredMinute.clear()
}
