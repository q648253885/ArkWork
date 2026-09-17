/* ============================================================
 * ArkWork — Shared Types: Task
 * 设计文档 §10.2
 * ============================================================ */

import type { GateState } from './agent.js'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'

/**
 * v0.14.0 Task 1 — PlanItem 六态状态机。
 * 把 v0.13.1 的 done/failed 两态扩展为 pending / running / done / failed / cancelled / skipped 六态。
 * 注意：与 {@link TaskStatus}（任务级）独立，本枚举描述的是 PlanItem 步骤级状态。
 */
export type PlanItemStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped'

/** v0.14.0 Task 1：v0.13.1 PlanItem 仅有两态 — 旧 done/failed 值映射到新枚举 */
export type LegacyPlanItemStatus = 'done' | 'failed'

/**
 * v0.14.0 Task 1 — PlanItem（任务级计划项）。
 * 旧版 PlanItem 仅含 `text`；新版显式引入 `status` 六态字段，旧字段保持可选以兼容 v0.13.1 数据。
 */
/**
 * v0.18.0：planItem 状态变更的来源标记。
 * Main 端唯一写入，Renderer 不可注入（IPC 入口拒绝 source 字段）。
 *  - engine-decide  / engine-fail：引擎独立判断（act 成功/失败）
 *  - todo-update：LLM 主动调 todo_update 工具
 *  - user-cancel / user-retry / user-mark-done：用户在 TodoPanel 行手动切状态
 *  - plan-regen：plan 全量重新生成（snapshot 兜底）
 */
export type PlanItemSource =
  | 'engine-decide'
  | 'engine-fail'
  | 'todo-update'
  | 'user-cancel'
  | 'user-retry'
  | 'user-mark-done'
  | 'plan-regen'
  | 'plan-fallback'
  /** v0.21.0：续聊时旧清单全完成后，引擎自动追加的「新需求承接项」 */
  | 'continuation'

export interface PlanItem {
  /** 计划项 ID（v0.14.0 新增；旧数据缺失时由迁移层补齐） */
  id: string
  /** 计划项文本（旧字段，v0.13.1 兼容保留） */
  text: string
  /** v0.14.0 新增：六态状态机 */
  status: PlanItemStatus
  /** 旧字段：v0.13.1 仅支持 done/failed；新版兼容旧值（迁移层负责规范化） */
  legacyStatus?: LegacyPlanItemStatus
  /** 计划项创建时间（毫秒）；v0.14.0 新增，旧数据缺失时由迁移层补齐 */
  createdAt: number
  /** 计划项最近一次状态变更时间（毫秒） */
  updatedAt: number
  /** 完成时间（仅当 status === 'done' / 'failed' / 'cancelled' / 'skipped' 时存在） */
  completedAt?: number
  /** v0.18.0 新增：该项状态来源（用于三视图与"引擎"/"推断"徽标） */
  source?: PlanItemSource
}

export interface TaskInput {
  /** 用户的原始输入文本 */
  text: string
  /** 引用的文件路径（@file） */
  files?: string[]
  /** 引用的任务（@task:ID） */
  taskRefs?: string[]
  /** 引用的知识库（@kb:name） */
  kbRefs?: string[]
}

export interface TaskConfig {
  temperature?: number
  maxTokens?: number
  maxIterations?: number
  /**
   * v0.28.0（F9）：ReAct 引擎预算配置化（与 main/agent/settings-loader.ts 的
   * AgentBudgetSettings 同构，双文件同步定义）。未配置时使用 loop.ts 内置常量。
   */
  budget?: {
    /** 单任务最大迭代轮数（默认 200） */
    maxIterations?: number
    /** 同一「工具+参数签名」最大调用次数（默认 5） */
    maxPerSignature?: number
    /** 非只读类工具的类别总预算（默认 400） */
    maxPerToolDefault?: number
    /** 只读类工具的类别总预算（默认 600） */
    maxPerToolReadonly?: number
  }
  stop?: string[]
  /**
   * v0.18.0 新增：是否每轮 Reason 之前注入 kind='plan_status' 的 user 消息。
   * 默认 true；单步任务（planItems 为空）由 seed 层自动设 false。
   */
  injectPlanStatus?: boolean
}

export interface Task {
  id: string                    // T-20260727-0042
  workspaceId: string
  title: string
  /**
   * v0.31.0 C2：标题来源标记（标题生成竞态协调的单一事实源）。
   *  - undefined：占位「未命名任务」或机械截断产物，可被 LLM 生成升级
   *  - 'user'：用户手动命名（renameTask 置入），锁定后 LLM 不再覆盖
   *  - 'llm'：模型已生成标题，后续 run 不再重生成
   */
  titleSource?: 'user' | 'llm'
  status: TaskStatus
  agentId: string
  skillIds: string[]
  mcpIds: string[]
  /** v0.8.0：任务级知识库启用集合（kbIds 为 null 时继承面板 enabled 集合） */
  kbIds?: string[]
  /** Task 8：会话级知识库开关（缺省 true）。关闭后 kb_query 不再注入上下文。 */
  kbEnabled?: boolean
  modelId: string
  input: TaskInput
  config: TaskConfig
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
  parentTaskId: string | null   // 用于分叉
  tags: string[]
  starred?: boolean
  /** 由自动化触发的任务，用于侧边栏标识来源 */
  automationId?: string
  /**
   * v0.30.0：关联的 TaskGraph id（`tg_...`）。
   *
   * 存在 graphId 时，**图的 nodes 是任务的唯一真相**，
   * 下面的 {@link Task.planItems} 降级为由图重算出的**只读镜像**
   * （唯一写入点是 `main/agent/graph/store.ts` 的 `mirrorPlanItems`）。
   * tier 0/1 任务不建图，此字段为 undefined，走轻量模式。
   */
  graphId?: string
  /**
   * v0.30.0：图版本号（乐观锁）。与 `TaskGraph.graphRevision` 同步，
   * 用于检测"面板拿到的快照是否已过期"。
   */
  graphRevision?: number
  /**
   * v0.14.0 Task 1：任务关联的 PlanItem 六态列表。
   *
   * v0.30.0 起语义变更：**不再是真相源，而是 TaskGraph 的派生镜像**
   * （见 graphId 字段说明）。既有消费方（StepList / 三视图 / 筛选器）
   * 仍可零改动读取；但**不允许再直接写它**。
   */
  planItems?: PlanItem[]
  /**
   * v0.25.0 F1：门禁状态机（run 启动时从 always-on / 已激活技能的 frontmatter
   * gates 初始化；ask_user 确认后写回）。持久化于 tasks.json，续聊可恢复。
   */
  gateStates?: GateState[]
  /**
   * v0.25.0 F1：被门禁拦截的待确认项（todo_update 标 done 被 gate 阻塞时写入；
   * 下一次 ask_user 完成后消费并清空）。
   */
  pendingGateBlock?: { gateId: string }
  /**
   * v0.30.2 D12：ask_user 暂停标记（引擎 ask_user 暂停时写入；下一次 run 开始时消费并清空）。
   * 语义：该标记存在 = 本轮最新 user_message 是对提问的**答复**而非新指令，
   * 续聊不触发清单重评/重建（见 run-setup.ts isReplyContinuation）。
   * 写入点：turn-end.pauseViaAskUser + loop.ts 预算中断/计划闸门/阶段门禁/迭代上限；
   * 用户手动暂停（abort.ts）不写 —— 手动暂停后的首条输入就是新指令。
   */
  pendingAskUser?: { question: string; askedAt: number }
  /** 任务失败时的错误信息摘要 */
  errorMessage?: string
}

/** 短显示 ID：T-...42 */
export function shortTaskId(id: string): string {
  const parts = id.split('-')
  if (parts.length < 3) return id
  const tail = parts[parts.length - 1].slice(-2)
  return `T-...${tail}`
}

/**
 * 生成新任务 ID：T-YYYYMMDD-RRRRRR
 *
 * v0.4.0-rev2：改为日期 + 6 位 base36 随机后缀。
 * 旧版用 `seq = existing.length + 1` 生成 `T-YYYYMMDD-NNNN`，删除任务后 seq 会重复，
 * 导致 upsert 覆盖已有任务（表现为"新建任务来回改名"）。
 * 新版用 Web Crypto 随机数（前后端通用），36^6 ≈ 22 亿，同日冲突概率可忽略。
 */
export function generateTaskId(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  // 4 字节随机 → 转 base36 → 取 6 位
  const arr = new Uint8Array(4)
  // 优先用 Web Crypto（前后端通用）；老版本 Node 无 globalThis.crypto 时 fallback Math.random
  const g = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto : undefined
  if (g?.getRandomValues) {
    g.getRandomValues(arr)
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
  }
  const rand = Array.from(arr, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6)
  return `T-${ymd}-${rand}`
}
