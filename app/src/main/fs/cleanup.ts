/* ============================================================
 * ArkWork — .arkwork 临时文件清理
 * 保守策略：只删除明确的临时目录（temp/ cache/ logs/）中超过 maxAgeDays 的文件。
 * .arkwork 根目录下的 JSON 配置文件（agents.json / skills.json / tasks.json /
 * settings.json / models.json / secrets.json 等）与其它根级文件一律保留。
 * ============================================================ */
import { existsSync } from 'node:fs'
import { readdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'
import { cleanOldAuditLogs } from '../agent/shell-audit.js'

/** 被视为临时目录的子目录名（位于 .arkwork 根下） */
const TEMP_SUBDIRS = ['temp', 'cache', 'logs']

/** 清理结果：被删除的文件列表与因未过期而跳过的文件列表 */
export interface CleanResult {
  cleaned: string[]
  skipped: string[]
}

/**
 * 扫描 .arkwork 下的临时目录（temp/ cache/ logs/），删除超过 maxAgeDays 天的文件。
 * 保守策略：仅处理上述三个子目录内的文件，根目录及其它子目录一律不动。
 */
export async function cleanArkworkTemp(
  maxAgeDays: number = 7,
): Promise<CleanResult> {
  const cleaned: string[] = []
  const skipped: string[] = []
  const arkworkDir = getArkworkDir()
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  const now = Date.now()

  for (const sub of TEMP_SUBDIRS) {
    const subDir = join(arkworkDir, sub)
    if (!existsSync(subDir)) continue
    await walkAndClean(subDir, now, maxAgeMs, cleaned, skipped)
  }

  // Task 5：同步清理工作区内的 shell 审计日志（{workspaceDir}/.arkwork/logs/shell-audit.jsonl）
  try {
    const auditRemoved = await cleanOldAuditLogs(maxAgeDays, getWorkspaceDir())
    if (auditRemoved > 0) {
      logger.info('System', `[cleanup] shell-audit: pruned ${auditRemoved} old entries (maxAge=${maxAgeDays}d)`)
    }
  } catch (err) {
    logger.warn('System', `[cleanup] shell-audit cleanup failed: ${(err as Error).message}`)
  }

  logger.info('System', `[cleanup] cleaned ${cleaned.length} file(s), skipped ${skipped.length} (maxAge=${maxAgeDays}d)`)
  return { cleaned, skipped }
}

/** 递归遍历目录，删除过期文件；空目录顺手清理 */
async function walkAndClean(
  dir: string,
  now: number,
  maxAgeMs: number,
  cleaned: string[],
  skipped: string[],
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    logger.warn('System', `[cleanup] cannot read ${dir}: ${(err as Error).message}`)
    return
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkAndClean(fullPath, now, maxAgeMs, cleaned, skipped)
      // 子目录清理后若已空，则删除空目录（非必须，保持整洁）
      try {
        const remaining = await readdir(fullPath)
        if (remaining.length === 0) await rm(fullPath, { recursive: false, force: true })
      } catch {
        // 忽略：非空或无权限，保留目录
      }
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath)
        const age = now - s.mtimeMs
        if (age >= maxAgeMs) {
          await rm(fullPath, { force: true })
          cleaned.push(fullPath)
        } else {
          skipped.push(fullPath)
        }
      } catch (err) {
        // stat / 删除失败：记录并跳过，不中断整体清理
        logger.warn('System', `[cleanup] cannot process ${fullPath}: ${(err as Error).message}`)
        skipped.push(fullPath)
      }
    }
    // 符号链接等其它类型一律跳过（保守策略）
  }
}

/**
 * 返回 .arkwork 目录总大小（字节）。
 * 递归统计所有常规文件大小，符号链接不计入。
 */
export async function getArkworkSize(): Promise<number> {
  const arkworkDir = getArkworkDir()
  if (!existsSync(arkworkDir)) return 0
  return dirSize(arkworkDir)
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(fullPath)
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath)
        total += s.size
      } catch {
        // 忽略不可访问的文件
      }
    }
  }
  return total
}

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000

/**
 * 注册定时清理：每 24 小时自动清理一次 .arkwork 临时目录。
 * 返回定时器句柄，调用方可在退出时 clearInterval。
 */
export function scheduleCleanup(): NodeJS.Timeout {
  // 启动后立即清理一次过期临时文件，随后每 24h 重复
  const timer = setInterval(() => {
    void cleanArkworkTemp().catch((err) => {
      logger.warn('System', `[cleanup] scheduled cleanup failed: ${(err as Error).message}`)
    })
  }, TWENTY_FOUR_HOURS)
  // setInterval 在 Node 中默认不阻止退出；timer.unref() 确保不阻塞应用退出
  timer.unref()
  return timer
}
