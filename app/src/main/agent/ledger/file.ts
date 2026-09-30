/* ============================================================
 * ArkWork — TaskLedger 文件层（唯一落盘出口）
 * 设计文档 §3.3
 *
 * 三条纪律：
 *  1. **原子写**：全部走 `store/db.ts` 的 `atomicWriteFile`（tmp + rename，
 *     Windows 撞锁退避重试 + 直写兜底）。进程在任意时刻被 kill，磁盘上
 *     要么是旧完整文件要么是新的完整文件，不会出现半截 JSON。
 *  2. **revision 单调**：写入前校验 baseRevision，不匹配说明有并发写者
 *     → 抛 CONFLICT 由 engine 串行锁内重试（正常情况下锁已保证不会冲突，
 *     这里是"锁被绕过"时的最后一道防线）。
 *  3. **缓存即真相**：内存缓存与磁盘严格一致 —— 只有写盘成功后才更新缓存。
 * ============================================================ */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getLedgerPath, getWorkspaceDir, atomicWriteFile } from '../../store/db.js'
import { logger } from '../../system/logger.js'
import {
  LEDGER_SCHEMA_VERSION,
  LEDGER_LOG_LIMIT,
  type LedgerFile,
  type LedgerItem,
  type LedgerItemStatus,
  normalizeLedgerStatus,
} from './types.js'

/** 缓存：workspaceDir::taskId → LedgerFile */
const cache = new Map<string, LedgerFile>()

function cacheKey(taskId: string): string {
  return `${getWorkspaceDir()}::${taskId}`
}

export function invalidateLedgerCache(taskId?: string): void {
  if (taskId) cache.delete(cacheKey(taskId))
  else cache.clear()
}

/* ---------------- 迁移与规范化 ---------------- */

/**
 * 把任意来源（旧盘上数据 / 手写 / 未来 schema）规范化为当前 schema。
 * 幂等；未知字段丢弃，缺失字段补齐。**绝不抛** —— 读到脏文件也要能继续跑。
 */
export function normalizeLedger(raw: unknown, taskId: string): LedgerFile {
  const r = (raw ?? {}) as Partial<LedgerFile> & Record<string, unknown>
  const itemsRaw = Array.isArray(r.items) ? r.items : []
  const now = Date.now()
  const items: LedgerItem[] = itemsRaw.map((it: unknown, i: number) => {
    const o = (it ?? {}) as Partial<LedgerItem> & Record<string, unknown>
    const status = normalizeLedgerStatus(o.status)
    return {
      id: typeof o.id === 'string' && o.id ? o.id : `li_${i}_${now}`,
      text: typeof o.text === 'string' ? o.text : '',
      status,
      parentId: typeof o.parentId === 'string' ? o.parentId : null,
      dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.filter((x): x is string => typeof x === 'string') : [],
      acceptance: Array.isArray(o.acceptance) ? o.acceptance.filter((x): x is string => typeof x === 'string') : [],
      artifact: (o.artifact ?? undefined) as LedgerItem['artifact'],
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now,
      completedAt: typeof o.completedAt === 'number' ? o.completedAt : undefined,
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : undefined,
      source: typeof o.source === 'string' ? o.source : 'migrate',
      note: typeof o.note === 'string' ? o.note : undefined,
      attempts: typeof o.attempts === 'number' ? o.attempts : 0,
      nodeId: typeof o.nodeId === 'string' ? o.nodeId : undefined,
      // v0.43.0（R4）：逐项轮次必须**原样保留**。此前本函数未收录该字段，
      // 于是「读 → 规范化 → 写回」的每一轮 mutate 都会把 round 抹掉（实测 33 项全归 1），
      // 「本轮任务」分区因此恒等于「全部任务」。旧数据无该字段 → 保持 undefined，
      // 由消费端（toSnapshotView / toPlanItems / buildRoundIndex）统一 `?? 1` 归一。
      round: typeof o.round === 'number' && Number.isInteger(o.round) && o.round >= 1 ? o.round : undefined,
    }
  })
  const modeRaw = r.mode
  const mode = modeRaw === 'chat' || modeRaw === 'plan' || modeRaw === 'spec' ? modeRaw : 'plan'
  const log = Array.isArray(r.log) ? r.log.slice(-LEDGER_LOG_LIMIT) : []
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    taskId: typeof r.taskId === 'string' && r.taskId ? r.taskId : taskId,
    goal: typeof r.goal === 'string' ? r.goal : '',
    mode,
    modeReason: typeof r.modeReason === 'string' ? r.modeReason : '',
    modeBy: r.modeBy === 'model' ? 'model' : 'engine',
    revision: typeof r.revision === 'number' && r.revision >= 0 ? r.revision : 0,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
    items,
    // v0.43.0（R4）：当前轮次（旧账本无该字段 → 归一 1，升级容忍）。
    // 与 item.round 同理，漏收会直接把「本轮」判据打回第 1 轮。
    round: typeof r.round === 'number' && Number.isInteger(r.round) && r.round >= 1 ? r.round : 1,
    resume: (r.resume ?? {}) as LedgerFile['resume'],
    log,
  }
}

/* ---------------- 读写 ---------------- */

/** 读：磁盘 → 规范化 → 缓存。文件缺失返回 null（**不创建**）。 */
export async function readLedgerFile(taskId: string): Promise<LedgerFile | null> {
  const key = cacheKey(taskId)
  const hit = cache.get(key)
  if (hit) return hit
  const path = getLedgerPath(taskId)
  try {
    if (!existsSync(path)) return null
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const ledger = normalizeLedger(parsed, taskId)
    cache.set(key, ledger)
    return ledger
  } catch (err) {
    logger.warn('Agent', `ledger 读取失败（按无账本处理）：${(err as Error).message}`, taskId)
    return null
  }
}

/**
 * 写：原子落盘 + 成功后更新缓存。
 * @param baseRevision 期望的当前 revision；不匹配抛 CONFLICT（由调用方重试）
 */
export async function writeLedgerFile(next: LedgerFile, baseRevision?: number): Promise<void> {
  const path = getLedgerPath(next.taskId)
  const current = await readLedgerFile(next.taskId)
  if (typeof baseRevision === 'number' && current && current.revision !== baseRevision) {
    throw Object.assign(
      new Error(`ledger revision 冲突：期望 ${baseRevision}，实际 ${current.revision}`),
      { code: 'CONFLICT' },
    )
  }
  const payload: LedgerFile = {
    ...next,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    revision: next.revision,
    updatedAt: Date.now(),
    log: next.log.slice(-LEDGER_LOG_LIMIT),
  }
  await atomicWriteFile(path, JSON.stringify(payload, null, 2))
  cache.set(cacheKey(next.taskId), payload)
}

/** 深拷贝一份可变副本（ops 只在副本上工作，失败不污染真相） */
export function cloneLedger(l: LedgerFile): LedgerFile {
  return JSON.parse(JSON.stringify(l)) as LedgerFile
}

/** 追加日志（环形） */
export function appendLog(l: LedgerFile, entry: LedgerFile['log'][number]): void {
  l.log.push(entry)
  if (l.log.length > LEDGER_LOG_LIMIT) l.log.splice(0, l.log.length - LEDGER_LOG_LIMIT)
}

/** 落盘路径（供诊断/测试断言用） */
export function ledgerPathOf(taskId: string): string {
  return getLedgerPath(taskId)
}

/** 取状态（供外部只读判定） */
export function statusOf(item: LedgerItem): LedgerItemStatus {
  return item.status
}
