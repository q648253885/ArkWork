/* ============================================================
 * ArkWork — Git 操作审计（v0.36.0 · B3 / F3.5）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.5 / §5（安全）
 *
 * 写入 {workspaceDir}/.arkwork/logs/git-audit.jsonl（JSON Lines）。
 * 所有**写类** op（add/commit/push/…）逐条落盘，读类不记（量太大且无风险）。
 * 轮转策略与 shell-audit 完全一致：5MB 触发，保留 3 份历史。
 * ============================================================ */
import { join } from 'node:path'
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'

export interface GitAuditEntry {
  /** 触发者：插件 id（宿主面板/命令同样经插件层进来） */
  pluginId: string
  op: string
  args?: unknown
  root: string
  result: 'success' | 'failed' | 'denied'
  /** denied 时的人话原因；failed 时带 stderr 摘要 */
  reason?: string
  timestamp: number
  durationMs?: number
}

const MAX_LOG_SIZE = 5 * 1024 * 1024 // 5MB 触发轮转
const MAX_ROTATED = 3 // 保留 3 份轮转历史

/** 审计日志文件路径（workspace 级别，与 shell-audit 同目录） */
export function gitAuditLogPath(workspaceDir?: string): string {
  const ws = workspaceDir ?? getWorkspaceDir()
  return join(ws, '.arkwork', 'logs', 'git-audit.jsonl')
}

/** 追加一条 git 审计。失败只 warn，不阻塞主流程。 */
export async function logGitAudit(entry: GitAuditEntry, workspaceDir?: string): Promise<void> {
  const path = gitAuditLogPath(workspaceDir)
  try {
    await mkdir(join(path, '..'), { recursive: true })
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8')
    await rotateIfNeeded(path)
  } catch (err) {
    logger.warn('System', `git-audit: 写入失败 ${(err as Error).message}`)
  }
}

/** 文件过大时轮转：file → file.1 → file.2 → file.3（丢弃最旧） */
async function rotateIfNeeded(path: string): Promise<void> {
  try {
    const s = await stat(path)
    if (s.size < MAX_LOG_SIZE) return
    const oldest = `${path}.${MAX_ROTATED}`
    if (existsSync(oldest)) await unlink(oldest).catch(() => {})
    for (let i = MAX_ROTATED - 1; i >= 1; i--) {
      const from = `${path}.${i}`
      if (existsSync(from)) await rename(from, `${path}.${i + 1}`).catch(() => {})
    }
    await rename(path, `${path}.1`).catch(() => {})
  } catch {
    // 轮转失败不影响主流程
  }
}
