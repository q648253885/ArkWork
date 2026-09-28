/* ============================================================
 * ArkWork — 清单审计与归档（v0.39.0 · F9 / D187）
 * 设计文档：docs/versions/v0.39.0/04-system-design.md §3.6
 *
 * 为什么要有这一层：
 *   `LedgerFile.log` 是**环形**缓冲（上限 50）—— 它的职责是"给模型回看最近
 *   发生了什么"，不是"给用户追溯全程"。v0.39.0 之前没有任何永久留痕，也
 *   没有归档：任务结束后，清单演化过程只存在于一串被广播过的事件里，
 *   重开任务就什么都不剩（D187）。
 *
 * 双写策略：
 *   · `log[]`      —— 内存 + 账本文件，环形 50 条（**不变**，模型消费）
 *   · `ledger.log.jsonl` —— 永久追加，每行一条 `LedgerLogEntry`（用户追溯）
 *   · `ledger.archive.json` —— 任务终态快照（items + resume + 完整 log）
 *
 * 铁律：**审计不得拖垮主链路** —— 任何写失败都只 logger.warn 并返回 false。
 * ============================================================ */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getLedgerDir } from '../../store/db.js'
import { logger } from '../../system/logger.js'
import type { LedgerFile, LedgerLogEntry } from './types.js'

export const LEDGER_AUDIT_VERSION = 1

export interface LedgerArchiveSnapshot {
  schemaVersion: number
  auditVersion: number
  taskId: string
  archivedAt: number
  outcome: 'completed' | 'failed' | 'cancelled'
  reason: string
  revision: number
  goal: string
  mode: LedgerFile['mode']
  items: LedgerFile['items']
  resume: LedgerFile['resume']
  log: LedgerLogEntry[]
}

/** 永久审计日志路径：{workspace}/.arkwork/ledger/{taskId}.log.jsonl */
export function auditLogPathOf(taskId: string): string {
  return join(getLedgerDir(), `${taskId}.log.jsonl`)
}

/** 归档快照路径：{workspace}/.arkwork/ledger/{taskId}.archive.json */
export function archivePathOf(taskId: string): string {
  return join(getLedgerDir(), `${taskId}.archive.json`)
}

function ensureDir(file: string): boolean {
  try {
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return true
  } catch (err) {
    logger.warn('Agent', `审计目录创建失败（不影响任务）：${(err as Error).message}`)
    return false
  }
}

/**
 * 追加永久审计日志（同步写，行追加）。
 * 失败只告警 —— 审计层不能成为主链路的单点故障（业界同旨：
 * "a recording layer that can take down the system it records is worse than no recording layer"）。
 */
export function appendAuditLog(input: { taskId: string; entries: readonly LedgerLogEntry[] }): boolean {
  if (input.entries.length === 0) return true
  const path = auditLogPathOf(input.taskId)
  if (!ensureDir(path)) return false
  try {
    const chunk = input.entries.map((e) => `${JSON.stringify(e)}\n`).join('')
    appendFileSync(path, chunk, 'utf-8')
    return true
  } catch (err) {
    logger.warn('Agent', `清单审计日志写入失败（不影响任务）：${(err as Error).message}`, input.taskId)
    return false
  }
}

/** 倒序读取最近 limit 条（最新在前）；无文件返回空数组 */
export function readAuditLog(taskId: string, limit: number = 50): LedgerLogEntry[] {
  const path = auditLogPathOf(taskId)
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    const out: LedgerLogEntry[] = []
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as LedgerLogEntry)
      } catch {
        // 单行损坏不拖垮整体读取（环形日志与永久日志都可能被外部工具碰过）
      }
    }
    return out.slice(-Math.max(1, limit)).reverse()
  } catch (err) {
    logger.warn('Agent', `清单审计日志读取失败：${(err as Error).message}`, taskId)
    return []
  }
}

/**
 * 任务终态归档（幂等：同 revision 不重复写）。
 * 归档内容 = 完整 items + resume + **尽可能完整的 log**（环形 50 条 + 永久日志补足）。
 */
export function archiveLedger(
  taskId: string,
  ledger: LedgerFile,
  outcome: 'completed' | 'failed' | 'cancelled',
  reason: string,
): boolean {
  const path = archivePathOf(taskId)
  if (!ensureDir(path)) return false
  try {
    if (existsSync(path)) {
      const prev = readLedgerArchive(taskId)
      if (prev && prev.revision === ledger.revision && prev.outcome === outcome) return true
    }
    // 永久日志可能比环形 log 更全（长任务的早期变更已被环形淘汰）
    const permanent = readAuditLog(taskId, 100000)
    const merged =
      permanent.length >= ledger.log.length ? permanent.slice().reverse() : ledger.log.slice()
    const snap: LedgerArchiveSnapshot = {
      schemaVersion: ledger.schemaVersion,
      auditVersion: LEDGER_AUDIT_VERSION,
      taskId,
      archivedAt: Date.now(),
      outcome,
      reason,
      revision: ledger.revision,
      goal: ledger.goal,
      mode: ledger.mode,
      items: ledger.items,
      resume: ledger.resume,
      log: merged,
    }
    writeFileSync(path, JSON.stringify(snap, null, 2), 'utf-8')
    return true
  } catch (err) {
    logger.warn('Agent', `清单归档失败（不影响任务终局）：${(err as Error).message}`, taskId)
    return false
  }
}

export function readLedgerArchive(taskId: string): LedgerArchiveSnapshot | null {
  const path = archivePathOf(taskId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LedgerArchiveSnapshot
  } catch (err) {
    logger.warn('Agent', `清单归档读取失败：${(err as Error).message}`, taskId)
    return null
  }
}
