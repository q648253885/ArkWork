/* ============================================================
 * ArkWork — 规划通道类型层（v0.39.0 · F1）
 * 设计文档：docs/versions/v0.39.0/04-system-design.md §3.1
 *
 * 为什么要有这个模块：
 *   v0.39.0 之前，任务清单只在 `run-setup.ts` 的 `startIter === 0` 处被专门
 *   生成一次；此后每一次「修订」都必须由模型在「一边看工具结果一边干活」的同一
 *   轮里顺手提出 —— 清单与实际工作脱节的根因在此。
 *   规划通道（Planner Pass）是一条**独立的、不带工具的、短上下文**的 LLM 调用，
 *   只做一件事：推演「现在该做什么，按什么顺序做」。
 *
 * 依赖方向铁律：planning → ledger（类型）/**不得**反向依赖 engine。
 * ============================================================ */
import type { PlanDraftItem } from '../ledger/plan-diff.js'

/**
 * 规划通道的触发源 —— **唯一事实源**：类型由本数组推导。
 *
 * v0.39.0（D190）：此前这里是「一个 union 类型 + 一个内容相同的数组」两份。
 * 两份手工同步的枚举必然漂移（加了 union 成员忘了加数组 → 数组再也不代表全集，
 * 而它正是给穷举用例/运行时校验用的那份）。改为数组推导类型后，"漏同步"在
 * 类型层就不可能发生。
 */
export const PLANNER_TRIGGERS = [
  'run-start', // W1：开局订计划
  'failure', // W2：工具失败 / 项失败后的重排
  'stale', // W3：≥10 轮未触碰清单
  'new-instruction', // W4：用户实质性新指令
  'model-revision', // 预留：模型主动请求修订（本版不接）
] as const

export type PlannerTrigger = (typeof PLANNER_TRIGGERS)[number]

/** 解析器命中层级 —— 诊断用；`via` 的分布是「模型有多配合」的可靠信号 */
export type PlanParseVia =
  | 'json-strict'
  | 'json-fence'
  | 'json-repair'
  | 'checklist'
  | 'outline'

/** 喂给规划模型的最小上下文 —— 刻意不含对话历史与工具结果全文 */
export interface PlannerRequest {
  taskId: string
  trigger: PlannerTrigger
  /** 用户目标（一句话，≤120 字） */
  goal: string
  /** 当前清单（含层级） */
  items: PlannerRequestItem[]
  /** 最近失败摘要（结构化；人话渲染在 digest.ts） */
  failures: PlannerFailureDigest[]
  /** 已知约束（用户裁决 / 硬性要求） */
  constraints?: string[]
  /** 期望项数上限，默认 PLANNER_MAX_ITEMS */
  maxItems?: number
}

export interface PlannerRequestItem {
  id: string
  text: string
  /** 对外 5 态（todo / doing / done / skipped / blocked） */
  status: string
  parentId?: string | null
}

/** 一条失败的结构化摘要 —— 比「某个工具报错了」更有信息量 */
export interface PlannerFailureDigest {
  itemId?: string
  tool?: string
  code?: string
  /** 一句话说清发生了什么（人话，不是堆栈） */
  message: string
  /** 该失败已尝试次数 */
  attempts: number
}

export interface PlannerDraft {
  items: PlanDraftItem[]
  summary?: string
}

/**
 * 未产出计划的原因（诊断通道用，不是用户文案 —— 用户看 `PlannerResult.summary`）。
 *
 * D195：`unparsable` 与 `aborted` 必须分开。此前解析失败借用 `'aborted'`，
 * 读日志的人会以为是「用户取消/调用中止」，而事实是**模型回了、只是不成清单形态** ——
 * 这两种情况的下一步动作完全相反（一个是别再问，一个是去改 prompt）。
 */
export type PlannerSkipReason =
  | 'disabled'
  | 'budget'
  | 'cooldown'
  | 'duplicate'
  | 'aborted'
  | 'unparsable'

export interface PlannerResult {
  ok: boolean
  draft: PlanDraftItem[]
  via: PlanParseVia | 'none'
  /** 人话摘要（UI / turn_note 可直接展示） */
  summary: string
  attempts: number
  skipped?: PlannerSkipReason
  errorMessage?: string
}

/* ---------------- 阈值（唯一事实源） ---------------- */

/** 单 run 最多几次规划调用（超预算回落既有路径，不无限烧 token） */
export const MAX_PLANNER_PASSES_PER_RUN = 5

/** 规划模型被要求的清单项数上限 */
export const PLANNER_MAX_ITEMS = 12

/** 同一 trigger 的冷却窗口（failure 不受冷却约束） */
export const PLANNER_COOLDOWN_MS = 15_000

/** 单次规划调用的超时上限 */
export const PLANNER_BUDGET_MS = 20_000

/** 连满几次失败才触发重排（W2） */
export const PLANNER_FAILURE_THRESHOLD = 2

/** 每 run 最多由「文本解析回退」代为落库几次（D179/D182） */
export const MAX_REGEX_COMMITS_PER_RUN = 3

/* 注：子任务层级上限（父 + 子）**不在这里** —— 它属于账本侧的不变量，
 * 唯一执法点在 `ledger/ops.ts` 的 plan-commit（②b′），提示文案 PLAN_PARENT_HINT 同源。
 * 曾在此定义 MAX_PLAN_DEPTH = 2 但零引用 = 假的事实源，会让人误以为改这里能改层级上限。 */

/** 解析器噪声上限：超过即整体拒绝（宁缺毋滥） */
export const PARSE_MAX_ITEMS = 20

/** 单项文本截断长度 */
export const PARSE_MAX_TEXT = 80
