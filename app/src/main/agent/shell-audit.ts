/* ============================================================
 * ArkWork — Shell 命令审计日志（Task 5）
 *
 * 写入 {workspaceDir}/.arkwork/logs/shell-audit.jsonl（JSON Lines，
 * 每行一条）。中低危命令默认放行时仅记录审计；高危 / 越界 / 重复
 * 命令的确认与拒绝也一并落盘，便于事后追溯。
 *
 *  - logShellAudit：追加一条审计记录
 *  - 文件大小超过阈值时自动轮转（保留 N 份历史）
 *  - cleanOldAuditLogs：清理超过 maxAgeDays 的记录
 * ============================================================ */
import { join } from 'node:path'
import { appendFile, mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'
import type { RiskLevel } from './shell-risk.js'

export interface ShellAuditEntry {
  command: string
  cwd?: string
  riskLevel: RiskLevel
  targetPath?: string
  result: 'success' | 'failed' | 'denied'
  timestamp: number
  durationMs?: number
  /** 拒绝 / 确认原因（可选，便于追溯） */
  reason?: string
}

const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5MB 触发轮转
const MAX_ROTATED = 3 // 保留 3 份轮转历史
const DEFAULT_MAX_AGE_DAYS = 30

/** 审计日志文件路径（workspace 级别） */
export function auditLogPath(workspaceDir?: string): string {
  const ws = workspaceDir ?? getWorkspaceDir()
  return join(ws, '.arkwork', 'logs', 'shell-audit.jsonl')
}

/**
 * 追加一条 shell 审计日志。失败时仅记录 warning，不阻塞主流程。
 * @param entry 审计条目
 * @param workspaceDir 工作区目录（缺省取 getWorkspaceDir()）
 */
export async function logShellAudit(
  entry: ShellAuditEntry,
  workspaceDir?: string,
): Promise<void> {
  const path = auditLogPath(workspaceDir)
  try {
    await mkdir(join(path, '..'), { recursive: true })
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8')
    await rotateIfNeeded(path)
  } catch (err) {
    logger.warn('Tool', `shell-audit: 写入失败 ${(err as Error).message}`)
  }
}

/** 文件过大时轮转：file → file.1 → file.2 → file.3（丢弃最旧） */
async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const s = await stat(path)
    if (s.size < MAX_LOG_SIZE) return
    // 丢弃最旧一份
    const oldest = `${path}.${MAX_ROTATED}`
    if (existsSync(oldest)) {
      await unlink(oldest).catch(() => {})
    }
    // 自后向前依次后移
    for (let i = MAX_ROTATED - 1; i >= 1; i--) {
      const from = `${path}.${i}`
      const to = `${path}.${i + 1}`
      if (existsSync(from)) {
        await rename(from, to).catch(() => {})
      }
    }
    // 当前文件 → .1
    await rename(path, `${path}.1`).catch(() => {})
  } catch {
    // 轮转失败不影响主流程
  }
}

/**
 * 清理超过 maxAgeDays 的审计记录。
 * 主文件按行过滤后重写；轮转文件按修改时间整体删除（过旧则删）。
 * @returns 清理掉的条目数（主文件）
 */
export async function cleanOldAuditLogs(
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
  workspaceDir?: string,
): Promise<number> {
  const path = auditLogPath(workspaceDir)
  let removed = 0
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

  // 1. 主文件：按行过滤重写
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8')
      const lines = raw.split('\n')
      const kept: string[] = []
      for (const line of lines) {
        if (!line) continue
        try {
          const entry = JSON.parse(line) as ShellAuditEntry
          if (entry.timestamp && entry.timestamp < cutoff) {
            removed++
            continue
          }
        } catch {
          // 解析失败的行保留，避免误删
        }
        kept.push(line)
      }
      await writeFile(path, kept.length ? kept.join('\n') + '\n' : '', 'utf-8')
    } catch (err) {
      logger.warn('Tool', `shell-audit: 清理主文件失败 ${(err as Error).message}`)
    }
  }

  // 2. 轮转文件：整体过旧则删除
  for (let i = 1; i <= MAX_ROTATED; i++) {
    const rotated = `${path}.${i}`
    if (!existsSync(rotated)) continue
    try {
      const s = await stat(rotated)
      if (s.mtimeMs < cutoff) {
        await unlink(rotated).catch(() => {})
      }
    } catch {
      // ignore
    }
  }

  return removed
}

/* 启动时定期清理过期审计日志（每 6 小时一次，unref 不阻止退出） */
let cleanupTimer: NodeJS.Timeout | null = null
export function startAuditLogCleanup(intervalMs = 6 * 60 * 60 * 1000): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    void cleanOldAuditLogs(DEFAULT_MAX_AGE_DAYS).catch(() => {})
  }, intervalMs)
  cleanupTimer.unref?.()
}

startAuditLogCleanup()
