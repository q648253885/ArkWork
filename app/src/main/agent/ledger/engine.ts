/* ============================================================
 * ArkWork — TaskLedger 引擎（唯一变更入口）
 * 设计文档 §3.1 / §3.2
 *
 * 为什么不许别处直接改清单：诊断 §2 的四条根因里，L2（镜像回写盖回真相）
 * 与 L3（并行写 last-writer-wins）**都是"写入口不止一个"的必然结果**。
 * 补多少校验都堵不住第二个写入者 —— 只能收敛入口。
 *
 * `mutate()` 保证：
 *  ① 串行：同一 taskId 的读-改-写在同一临界区（Promise 链锁）
 *  ② 校验：不变量 I1–I8，任一 op 被拒则整个事务回滚（磁盘与缓存不动）
 *  ③ 原子：tmp + rename，kill -9 也只会得到旧完整版或新完整版
 *  ④ 留痕：每次变更写 log + 广播，退化路径必带人话 note
 * ============================================================ */
import { getTask, updateTask } from '../../store/tasks.js'
import { logger } from '../../system/logger.js'
import { broadcast } from '../../window.js'
import { broadcastPlanListSnapshot } from '../events.js'
import type { Task } from '@shared/types/task'
import type { LedgerSnapshotPayload, LedgerSnapshotView } from '@shared/types/ipc'
import {
  type LedgerFile,
  type LedgerItemStatus,
  type LedgerMode,
  type LedgerError,
  LEDGER_SCHEMA_VERSION,
} from './types.js'
import { readLedgerFile, writeLedgerFile, cloneLedger, invalidateLedgerCache, ledgerPathOf } from './file.js'
import { appendAuditLog, archiveLedger } from './audit.js'
import { applyOp, type LedgerOp, type OpResult } from './ops.js'
import { toPlanItems, toSnapshotView } from './project.js'
import { hasResumePoint } from './resume.js'

/* ---------------- per-task 串行锁 ---------------- */

const taskLocks = new Map<string, Promise<unknown>>()

function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskLocks.get(taskId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  taskLocks.set(taskId, tail)
  void tail.then(() => {
    if (taskLocks.get(taskId) === tail) taskLocks.delete(taskId)
  })
  return next
}

/** ledger 版本号（广播用，单调递增） */
const ledgerVersionByTask = new Map<string, number>()

/* ---------------- 读 ---------------- */

/** 只读账本；无则返回 null（**不创建**） */
export async function loadLedger(taskId: string): Promise<LedgerFile | null> {
  return readLedgerFile(taskId)
}

/**
 * 确保账本存在。
 *
 * **这是"续聊不重做"的第一道保险（验收 A5 / TC-LED-017）**：
 * 一旦账本文件存在（revision ≥ 0 且 items 非空），**绝不重建、绝不整表替换**。
 * 旧行为（v0.36.x）在 tasks.json 丢 graphId 时会用「过期全 pending 清单」重建第二张图，
 * 模型照单重做已完成的任务 —— 那是用户实测到的"重复执行"直接来源。
 */
export async function ensureLedger(
  task: Task,
  opts?: { goal?: string; mode?: LedgerMode; seedFromPlanItems?: boolean },
): Promise<LedgerFile> {
  const existing = await readLedgerFile(task.id)
  if (existing && existing.items.length > 0) return existing

  const seed = opts?.seedFromPlanItems ?? true
  const sources = seed ? (task.planItems ?? []) : []
  const now = Date.now()
  const goal = opts?.goal ?? (task.input?.text || task.title || '').split('\n')[0]!.slice(0, 200)

  if (existing) {
    // 文件在但 items 为空：只补 items，不清空已有 mode/resume（可能已由模型声明）
    const res = await mutateInternal(
      task.id,
      {
        kind: 'replace-all',
        items: sources.map((p) => ({ text: p.text })),
        reason: '账本项为空，从既有清单补齐',
      },
      'ensureLedger',
      { allowCreate: true, goal, mode: opts?.mode },
    )
    return res.ledger
  }

  const draft: LedgerFile = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    taskId: task.id,
    goal,
    mode: opts?.mode ?? inferMode(sources.length),
    modeReason: opts?.mode ? '引擎按任务规模预设' : `引擎兜底推导（清单 ${sources.length} 项）`,
    modeBy: 'engine',
    revision: 0,
    updatedAt: now,
    items: sources.map((p, i) => ({
      id: p.id || `li_${i}_${now}`,
      text: p.text,
      status: (p.status === 'done'
        ? 'done'
        : p.status === 'running'
          ? 'running'
          : p.status === 'cancelled' || p.status === 'skipped' || p.status === 'failed'
            ? (p.status as LedgerItemStatus)
            : 'pending') as LedgerItemStatus,
      parentId: null,
      dependsOn: [],
      acceptance: [],
      createdAt: p.createdAt ?? now,
      updatedAt: p.updatedAt ?? now,
      completedAt: p.completedAt,
      source: p.source ?? 'migrate',
      note: p.source ? undefined : '自 v0.36 扁平清单迁移',
      attempts: p.status === 'running' ? 1 : 0,
      nodeId: p.id,
    })),
    resume: {},
    log: [{ at: now, op: 'create', by: 'ensureLedger', note: `自 tasks.json 迁移（${sources.length} 项）` }],
  }
  await writeLedgerFile(draft)
  await syncProjections(task.id, draft, 'ensureLedger')
  return draft
}

/** 引擎兜底的模式推导（模型未声明时） */
export function inferMode(itemCount: number): LedgerMode {
  if (itemCount === 0) return 'chat'
  if (itemCount <= 6) return 'plan'
  return 'spec'
}

/* ---------------- 写 ---------------- */

export interface MutateResult {
  ok: boolean
  revision: number
  ledger: LedgerFile
  error?: LedgerError
  /** 实际生效的项（可能已被 I2 降级） */
  effective?: Array<{ itemId: string; status: LedgerItemStatus }>
}

/**
 * **唯一变更入口**。任何通道（模型工具 / 引擎记账 / 用户点击）都必须经此。
 *
 * @param ops 单个算子或算子数组（数组在同一事务内按序应用，全成功才落盘）
 * @param opts.actor 变更来源（进 log 与广播，诊断用）
 */
export function mutate(taskId: string, ops: LedgerOp | LedgerOp[], opts?: { actor?: string }): Promise<MutateResult> {
  return withTaskLock(taskId, () => mutateInternal(taskId, ops, opts?.actor ?? 'unknown'))
}

async function mutateInternal(
  taskId: string,
  ops: LedgerOp | LedgerOp[],
  actor: string,
  opts?: { allowCreate?: boolean; goal?: string; mode?: LedgerMode },
): Promise<MutateResult> {
  const list = Array.isArray(ops) ? ops : [ops]
  let base = await readLedgerFile(taskId)
  if (!base) {
    if (!opts?.allowCreate) {
      return {
        ok: false,
        revision: 0,
        ledger: emptyLedger(taskId, opts?.goal ?? ''),
        error: {
          code: 'NOT_FOUND',
          message: `任务 ${taskId} 尚无任务清单账本`,
          hint: '请先调用 ensureLedger()（引擎在 run 入口自动调用）。',
        },
      }
    }
    base = emptyLedger(taskId, opts?.goal ?? '')
  }

  const draft = cloneLedger(base)
  /**
   * v0.39.0（D187）：审计双写 —— 用「对象引用差集」识别本次事务新增的日志条目。
   * 为什么不用「长度差」：环形缓冲会淘汰旧条目，长度差不可靠；引用身份不受淘汰影响。
   * 且只在**落盘成功后**才写永久日志 —— 被拒绝的事务不该留下痕迹（事务语义）。
   */
  const knownLogEntries = new Set<unknown>(draft.log)
  const effective: Array<{ itemId: string; status: LedgerItemStatus }> = []

  for (const op of list) {
    let res: OpResult
    try {
      res = await applyOp(draft, op)
    } catch (err) {
      return {
        ok: false,
        revision: base.revision,
        ledger: base,
        error: { code: 'IO', message: `算子 ${op.kind} 执行异常：${(err as Error).message}` },
      }
    }
    if (!res.ok) {
      logger.warn('Agent', `ledger mutate 被拒（${op.kind}）：${res.error?.message}`, taskId)
      return { ok: false, revision: base.revision, ledger: base, error: res.error }
    }
    for (const c of res.changed) effective.push({ itemId: c.itemId, status: c.to })
  }

  draft.revision = base.revision + 1
  draft.updatedAt = Date.now()

  try {
    await writeLedgerFile(draft, base.revision)
  } catch (err) {
    // 落盘失败：绝不更新内存缓存（缓存即真相），只告警
    invalidateLedgerCache(taskId)
    logger.warn('Agent', `ledger 落盘失败（内存未提交）：${(err as Error).message}`, taskId)
    return {
      ok: false,
      revision: base.revision,
      ledger: base,
      error: { code: (err as NodeJS.ErrnoException & { code?: string }).code === 'CONFLICT' ? 'CONFLICT' : 'IO', message: `账本落盘失败：${(err as Error).message}` },
    }
  }

  // 永久审计（失败只告警，不回滚已成功的事务）
  appendAuditLog({
    taskId,
    entries: draft.log.filter((e) => !knownLogEntries.has(e)),
  })

  await syncProjections(taskId, draft, actor)
  return { ok: true, revision: draft.revision, ledger: draft, effective }
}

function emptyLedger(taskId: string, goal: string): LedgerFile {
  const now = Date.now()
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    taskId,
    goal,
    mode: 'plan',
    modeReason: '',
    modeBy: 'engine',
    revision: 0,
    updatedAt: now,
    items: [],
    resume: {},
    log: [],
  }
}

/* ---------------- 投影与广播（单向，ledger → 出口） ---------------- */

/**
 * 把账本投影到既有出口：
 *  ① `Task.planItems`（**唯一写入者** —— 其他任何地方写 planItems 都是缺陷）
 *  ② `task:plan-list-snapshot` 广播（既有 UI 通道）
 *  ③ `task:ledger-changed` 广播（v0.37 新通道，含模式徽标与恢复点）
 *
 * 失败一律只告警：投影失败不该牵连任务本身（沿用既有 persist 纪律）。
 */
async function syncProjections(taskId: string, ledger: LedgerFile, actor: string): Promise<void> {
  try {
    const planItems = toPlanItems(ledger)
    await updateTask(taskId, { planItems })
  } catch (err) {
    logger.warn('Agent', `ledger → planItems 投影失败：${(err as Error).message}`, taskId)
  }
  try {
    broadcastPlanListSnapshot(taskId, toPlanItems(ledger), 'ledger-sync')
  } catch (err) {
    logger.warn('Agent', `ledger 快照广播失败：${(err as Error).message}`, taskId)
  }
  try {
    const version = (ledgerVersionByTask.get(taskId) ?? 0) + 1
    ledgerVersionByTask.set(taskId, version)
    const payload: LedgerSnapshotPayload = {
      taskId,
      snapshot: toSnapshotView(ledger),
      version,
      ts: Date.now(),
    }
    broadcast('task:ledger-changed', payload)
  } catch (err) {
    logger.warn('Agent', `ledger-changed 广播失败：${(err as Error).message}`, taskId)
  }
  logger.debug('Agent', `ledger r${ledger.revision} by=${actor} items=${ledger.items.length}`, taskId)
}

/* ---------------- 便利包装（供接线层调用，语义自解释） ---------------- */

export async function setMode(
  taskId: string,
  mode: LedgerMode,
  by: 'model' | 'engine',
  reason?: string,
): Promise<MutateResult> {
  return mutate(taskId, { kind: 'set-mode', mode, by, reason }, { actor: `set-mode:${by}` })
}

/** 中断保留（用户停止 / Esc）—— D131 修复核心 */
export async function parkLedger(taskId: string, reason: string): Promise<MutateResult> {
  return mutate(taskId, { kind: 'park', reason }, { actor: 'park' })
}

/** 明确取消 */
export async function discardLedger(taskId: string, reason: string): Promise<MutateResult> {
  return mutate(taskId, { kind: 'discard', reason }, { actor: 'discard' })
}

/** 恢复点判定（产出物为准） */
export async function resumeLedger(taskId: string, reason: string): Promise<MutateResult> {
  return mutate(taskId, { kind: 'resume', reason }, { actor: 'resume' })
}

/** 过期巡检 */
export async function sweepStale(taskId: string, maxIdleMs: number, reason: string): Promise<MutateResult> {
  return mutate(taskId, { kind: 'sweep-stale', maxIdleMs, reason }, { actor: 'sweep-stale' })
}

/**
 * 回合收口（任务终态）。
 *
 * v0.39.0（D187）：**封口即归档** —— 收口是"任务已经结束"的唯一时刻，归档放在这里
 * 才能保证四条终态路径（最终答复 / task_complete / 失败 / 取消）**无一遗漏**。
 * 此前 `archiveLedger` 定义了却没有任何调用点（D78/D79 同型：函数全对、接线缺失），
 * 于是任务结束后清单演化过程只存在于被淘汰的环形日志里。
 *
 * 归档是**纯附加**：失败只告警、不影响 seal 的结果（审计层不得成为主链路单点）。
 */
export async function sealLedger(
  taskId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
  reason: string,
): Promise<MutateResult> {
  const res = await mutate(taskId, { kind: 'seal', outcome, reason }, { actor: `seal:${outcome}` })
  try {
    const fresh = await readLedgerFile(taskId)
    if (fresh) archiveLedger(taskId, fresh, outcome, reason)
  } catch (err) {
    logger.warn('Agent', `终态归档失败（不影响收口）：${(err as Error).message}`, taskId)
  }
  return res
}

/** 记录"本轮已同步清单"（清欠账） */
export async function touchSync(taskId: string): Promise<MutateResult> {
  return mutate(taskId, { kind: 'touch-sync' }, { actor: 'touch-sync' })
}

/** 读取快照视图（供 IPC 与提示词） */
export async function getSnapshotView(taskId: string): Promise<LedgerSnapshotView | null> {
  const l = await readLedgerFile(taskId)
  if (!l) return null
  return toSnapshotView(l)
}

/** 诊断用：账本文件路径 */
export function ledgerFileOf(taskId: string): string {
  return ledgerPathOf(taskId)
}
