/* ============================================================
 * ArkWork — TaskLedger 类型层
 * 设计文档：docs/versions/v0.37.0/04-system-design.md §2
 *
 * TaskLedger 是任务清单的**唯一真相源**：
 *  - 唯一写入口：`engine.ts` 的 `mutate()`（串行锁 + 乐观锁 + 原子落盘）
 *  - 唯一读出口：`project.ts` 的投影（UI / 提示词 / planItems 镜像）
 *
 * 与 TaskGraph 的关系：图（tier≥2）承载验收契约与证据等富语义，
 * 但**清单状态以 ledger 为准**，图侧只接受 ledger 的单向下推。
 * ============================================================ */

export const LEDGER_SCHEMA_VERSION = 1

/** 任务模式 —— **由模型自选**（PRD F7），UI 只做只读展示，不提供选择入口 */
export type LedgerMode = 'chat' | 'plan' | 'spec'

/**
 * 清单项状态（9 态）。
 * 相对 `PlanItemStatus`（6 态）新增三个：
 *  - `paused`    中断保留态 —— 「可恢复的暂停」不再被当成 cancelled（D131）
 *  - `blocked`   阻塞在外部依赖（等人 / 等权限）
 *  - `verifying` 做完了但证据不足（I2 降级目标，反自证）
 */
export type LedgerItemStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export const LEDGER_STATUSES: readonly LedgerItemStatus[] = [
  'pending',
  'running',
  'paused',
  'blocked',
  'verifying',
  'done',
  'failed',
  'cancelled',
  'skipped',
]

/** 终态：进入后不可逆（不变量 I8） */
export const LEDGER_TERMINAL_STATUSES: readonly LedgerItemStatus[] = [
  'done',
  'failed',
  'cancelled',
  'skipped',
]

/** 在途态：任务收尾时需要被收口的状态 */
export const LEDGER_OPEN_STATUSES: readonly LedgerItemStatus[] = [
  'pending',
  'running',
  'paused',
  'blocked',
  'verifying',
]

export function isLedgerTerminal(s: LedgerItemStatus): boolean {
  return LEDGER_TERMINAL_STATUSES.includes(s)
}

export function isLedgerOpen(s: LedgerItemStatus): boolean {
  return LEDGER_OPEN_STATUSES.includes(s)
}

/** 显式状态转换表。缺省即不允许（白名单而非黑名单） */
/**
 * 说明：`pending → done` 与 `paused → done` **必须放行**。
 * 现实里模型经常"顺手把下一项也做了"却没先标 running，若按教科书状态机拒绝，
 * 模型会收到一条它无法理解的硬错误并原地打转（真机会表现为反复重试）。
 * 防"没做就标完成"靠的是 I2（规模式缺验收契约 → 降级 verifying），不是靠拦转换。
 */
export const ALLOWED_LEDGER_TRANSITIONS: Readonly<Record<LedgerItemStatus, readonly LedgerItemStatus[]>> = {
  pending: ['running', 'done', 'cancelled', 'skipped'],
  running: ['done', 'failed', 'paused', 'blocked', 'verifying', 'cancelled', 'skipped'],
  paused: ['running', 'done', 'cancelled', 'skipped'],
  blocked: ['running', 'cancelled', 'skipped'],
  verifying: ['done', 'failed', 'running'],
  done: [],
  failed: [],
  cancelled: [],
  skipped: [],
}

export function canLedgerTransition(from: LedgerItemStatus, to: LedgerItemStatus): boolean {
  if (from === to) return true
  return ALLOWED_LEDGER_TRANSITIONS[from].includes(to)
}

/** 非法输入归一化：未知值一律回落 pending，绝不抛（静默失败比崩溃更危险是对的吗？——不，这里记 note） */
export function normalizeLedgerStatus(v: unknown, fallback: LedgerItemStatus = 'pending'): LedgerItemStatus {
  return typeof v === 'string' && (LEDGER_STATUSES as readonly string[]).includes(v)
    ? (v as LedgerItemStatus)
    : fallback
}

/** 产出物 —— 恢复点判定的依据（业界定论：判定依据是产出物而非状态本身） */
export interface LedgerArtifact {
  /** 路径（相对 workspace） */
  path: string
  kind: 'file' | 'dir' | 'command'
  /** 完整性校验命令；为空表示只判存在 */
  check?: string
}

export interface LedgerItem {
  id: string
  text: string
  status: LedgerItemStatus
  parentId: string | null
  dependsOn: string[]
  /** 验收契约（tier≥2 由模型声明） */
  acceptance: string[]
  artifact?: LedgerArtifact
  createdAt: number
  updatedAt: number
  completedAt?: number
  /** 最近一次进入 running 的时间 —— 过期巡检依据 */
  startedAt?: number
  /** 最近一次变更来源：todo-update / engine-decide / user-cancel / park / resume / replan … */
  source: string
  /** 最近一次变更的人话理由（纪律⑨：静默退化必须留人话） */
  note?: string
  /** 尝试次数 */
  attempts: number
  /** 该节点对应的图节点 id（有图任务），用于 ledger → 图单向下推 */
  nodeId?: string
  /** 所属任务轮次（v0.43.0 · R4）：新建时 = 当时账本轮次；沿用项保留原值；旧数据归一 1 */
  round?: number
}

/**
 * 恢复点 —— 跨 run 持久，是「续聊不重做」的物理载体。
 * `hint` 必须写人话：模型续聊第一眼看到的就是它。
 */
export interface LedgerResume {
  at?: number
  itemId?: string | null
  reason?: string
  hint?: string
  /**
   * 完成门禁已拒绝次数（跨 run 持久；上限见 MAX_LEDGER_REFUSALS）。
   *
   * v0.38.0（D151）：**唯一**的拒绝计数落点。此前的 `pendingSync` 字段（由
   * `startIter > 0 && !isReplyContinuation && graphId` 推出）已删除 —— 它只写不读，
   * 却让读者以为"清单待同步"是个门禁条件，而真正的判据已改为客观事实
   * （本 run 实际工具调用 + 是否写过清单，见 engine/ledger-guard.ts）。
   */
  refusals?: number
}

export interface LedgerLogEntry {
  at: number
  op: string
  itemId?: string
  from?: string
  to?: string
  by: string
  note?: string
}

export interface LedgerFile {
  schemaVersion: number
  taskId: string
  goal: string
  mode: LedgerMode
  modeReason: string
  /** 'model' = 模型声明；'engine' = 引擎兜底推导 */
  modeBy: 'model' | 'engine'
  /** 单调递增；写入时校验 baseRevision，冲突则重试 */
  revision: number
  updatedAt: number
  items: LedgerItem[]
  resume: LedgerResume
  log: LedgerLogEntry[]
  /**
   * 当前任务轮次（v0.43.0 · R4）：plan-commit 含新建项时 +1。
   * 「本轮任务」Tab 唯一判据 = item.round === file.round；旧账本缺省归一为 1。
   */
  round?: number
}

/** 日志环形缓冲上限（防止长任务文件无限膨胀） */
export const LEDGER_LOG_LIMIT = 50

/**
 * 完成门禁拒绝上限（v0.38.0：2 → 3）。
 * D151 教训：此前 D128 通道另有一套 run 局部计数（每 run 归零、不写账本），
 * 与账本上限叠加后单 run 稳定产出 3 次拒绝且无法解释 —— 现收敛为**唯一**计数落点
 * （`ledger.resume.refusals`），上限即此处。清零点唯一：ops.ts 的 `touch-sync`。
 */
export const MAX_LEDGER_REFUSALS = 3

/** 过期巡检默认阈值：running 项超过 8 轮（约 8 次 Act）无进展 → paused */
export const DEFAULT_STALE_MAX_IDLE_MS = 8 * 60_000

export interface LedgerError {
  code: 'NOT_FOUND' | 'INVARIANT' | 'CONFLICT' | 'INVALID_OP' | 'IO'
  message: string
  hint?: string
}
