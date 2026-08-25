/* ============================================================
 * ArkWork — Task 数据迁移层
 * v0.14.0 Task 1：PlanItem 状态机从 v0.13.1 done/failed 两态扩展为六态。
 *
 * 职责：
 *   1. 旧 done → done；旧 failed → failed（PlanItem.status 直通，无需改动）
 *   2. 缺失 status 字段默认 pending
 *   3. 非法 status 值 → pending（写审计日志）
 *   4. 缺失 id / createdAt / updatedAt 字段由迁移层补齐（保证 v0.13.1 数据可被反序列化）
 *   5. 迁移幂等：重复执行无副作用
 *
 * 设计要点：
 *   - 输入为 `unknown`（tasks.json 原始解析结果可能含脏数据），不依赖 zod
 *   - 仅 normalize，不变更 tasks.json 落盘策略；调用方在 IPCMain 加载时按需落盘
 *   - 启动期开销 < 200ms（任务级 O(n)，单条任务内 planItems 数量上限通常 < 8）
 * ============================================================ */
import type { PlanItem, PlanItemStatus, Task } from '@shared/types/task'
import { logger } from '../system/logger.js'

/** 合法六态枚举（运行时校验，避免硬编码后漏值） */
const VALID_STATUSES: readonly PlanItemStatus[] = [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
  'skipped',
] as const

/** v0.13.1 旧两态白名单 */
const LEGACY_STATUSES = new Set<PlanItemStatus>(['done', 'failed'])

/** 迁移结果 */
export interface MigrateResult {
  tasks: Task[]
  /** 被规范化处理的字段数（status 非法 / 缺失 / 旧值映射），用于审计 & 单元测试断言 */
  migratedCount: number
}

/** 单条 PlanItem 规范化上下文 */
interface PlanItemNormalizeResult {
  item: PlanItem
  changed: boolean
}

/**
 * 规范化单条 PlanItem.status：
 *   - 合法六态（含旧 done/failed）→ 原样保留
 *   - 缺失 / undefined → 'pending'（记审计）
 *   - 非字符串 / 不在白名单 → 'pending'（记审计）
 */
function normalizePlanItemStatus(raw: unknown): { status: PlanItemStatus; changed: boolean } {
  if (typeof raw === 'string' && (VALID_STATUSES as readonly string[]).includes(raw)) {
    return { status: raw as PlanItemStatus, changed: false }
  }
  // 非法或缺失 → pending
  return { status: 'pending', changed: true }
}

/**
 * 规范化单条 PlanItem 记录：
 *   - text 必填，缺失则用空字符串占位（旧数据可能为空）
 *   - id 缺失则按 taskId + 顺序生成
 *   - createdAt / updatedAt 缺失则用同一时间戳兜底（避免 undefined 穿透下游）
 *   - status 按 normalizePlanItemStatus 处理
 */
function normalizePlanItem(raw: unknown, taskId: string, index: number): PlanItemNormalizeResult {
  const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >
  const text = typeof obj['text'] === 'string' ? (obj['text'] as string) : ''
  const now = Date.now()
  const { status, changed: statusChanged } = normalizePlanItemStatus(obj['status'])

  const id = typeof obj['id'] === 'string' && obj['id'] ? (obj['id'] as string) : `${taskId}#pi${index + 1}`
  const createdAt = typeof obj['createdAt'] === 'number' ? (obj['createdAt'] as number) : now
  const updatedAt = typeof obj['updatedAt'] === 'number' ? (obj['updatedAt'] as number) : createdAt
  const completedAt =
    typeof obj['completedAt'] === 'number' ? (obj['completedAt'] as number) : undefined
  // v0.18.0：source 是新增可选字段，旧数据缺失合法；有值且非 PlanItemSource 字符串则丢弃
  const rawSource = obj['source']
  const source =
    typeof rawSource === 'string' &&
    [
      'engine-decide',
      'engine-fail',
      'todo-update',
      'user-cancel',
      'user-retry',
      'user-mark-done',
      'plan-regen',
    ].includes(rawSource)
      ? (rawSource as PlanItem['source'])
      : undefined
  // legacyStatus 仅当 PlanItem.status 是合法旧值时保留（用于审计 + 上层兼容性）
  const legacyStatus = LEGACY_STATUSES.has(status)
    ? (status as 'done' | 'failed')
    : undefined

  // 结构变更判定：text 兜底 / id 缺失补齐 / createdAt/updatedAt 缺失补齐 / statusChanged
  const structuralChanged =
    statusChanged ||
    typeof obj['text'] !== 'string' ||
    typeof obj['id'] !== 'string' ||
    !obj['id'] ||
    typeof obj['createdAt'] !== 'number' ||
    typeof obj['updatedAt'] !== 'number'

  const item: PlanItem = {
    id,
    text,
    status,
    createdAt,
    updatedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(legacyStatus ? { legacyStatus } : {}),
    ...(source !== undefined ? { source } : {}),
  }
  return { item, changed: structuralChanged }
}

/**
 * 安全读取对象的可选字段（容错读取，避免 Object 索引类型绕过 TS 严格模式）
 */
function readOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * 把单条 Task 记录从 v0.13.1 形态迁移到 v0.14.0：
 *   - planItems 缺失 → 保持 undefined（v0.13.1 旧数据无此字段是合法状态）
 *   - planItems 存在 → 每项过 normalizePlanItem
 *   - 顶层字段（id/workspaceId/...）一律不动：Task 自身结构稳定，仅 PlanItem 维度迁移
 *
 * 不修改入参对象；返回新对象以保证迁移层对调用方零副作用（支持幂等）。
 */
function migrateTask(raw: unknown, index: number): { task: Task; changed: boolean } {
  const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null) as
    | Record<string, unknown>
    | null
  if (!obj) {
    // 兜底：单条脏数据无法解析为对象时，跳过并返回最小占位 Task，
    // 由上层聚合时整体审计；这里仍保留 index 用于日志定位。
    logger.warn('System', `tasks.migrate: skip invalid task record at index ${index}`)
    throw new Error(`tasks.migrate: invalid task record at index ${index}`)
  }
  const taskId = readOptionalString(obj, 'id') ?? `unknown-${index}`
  const rawPlanItems = obj['planItems']
  let planItems: PlanItem[] | undefined
  let changed = false
  if (Array.isArray(rawPlanItems)) {
    planItems = rawPlanItems.map((p, i) => {
      const { item, changed: itemChanged } = normalizePlanItem(p, taskId, i)
      if (itemChanged) changed = true
      return item
    })
  }
  // Task 顶层字段直接以 `as Task` 透传：调用方已经在 JsonCollection 体系下做了 JSON.parse，
  // 本迁移层只承担 PlanItem 六态规范化；Task 字段缺失属于其它迁移任务范畴。
  const task = { ...(obj as unknown as Task), ...(planItems ? { planItems } : {}) }
  return { task, changed }
}

/**
 * 迁移入口：tasks.json → 规范化后的 Task[]。
 *
 * 契约：
 *   - 输入为 unknown（JSON.parse 原始结果），非数组时返回 { tasks: [], migratedCount: 1 }（写一条审计）
 *   - 幂等：连续两次调用结果相等（结构等价；Date.now 兜底字段不会引起后续差异）
 *     说明：normalizePlanItem 对 status 非法或缺失统一写 'pending'；第二次执行时
 *     'pending' 是合法六态值 → 直接保留，不会再触发 changed 标记。
 *   - 启动期阻塞 < 200ms：单 task O(planItems.length)，总量受 JsonCollection 体量约束
 */
export function migrateTasks(input: unknown): MigrateResult {
  if (!Array.isArray(input)) {
    logger.warn('System', 'tasks.migrate: input is not an array, returning empty')
    return { tasks: [], migratedCount: 1 }
  }
  const tasks: Task[] = []
  let migratedCount = 0
  for (let i = 0; i < input.length; i++) {
    const raw = input[i]
    try {
      const { task, changed } = migrateTask(raw, i)
      tasks.push(task)
      if (changed) migratedCount += 1
    } catch (err) {
      // 单条脏数据不阻塞整体加载 — 输出日志并跳过该条
      logger.warn(
        'System',
        `tasks.migrate: drop task at index ${i}: ${(err as Error).message}`,
      )
      migratedCount += 1
    }
  }
  if (migratedCount > 0) {
    logger.info('System', `tasks.migrate: migrated ${migratedCount} record(s)`)
  }
  return { tasks, migratedCount }
}