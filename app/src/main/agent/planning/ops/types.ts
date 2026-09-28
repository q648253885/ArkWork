/* ============================================================
 * ArkWork — 清单操作通道（PlanOps）类型层（v0.40.0）
 * 设计文档：docs/versions/v0.40.0/04-system-design.md §三
 *
 * 为什么在「规划通道」之外再开一条：
 *   v0.39.0 的规划通道只解决了「清单怎么**生成**」。而清单的
 *   修改 / 完成确认 / 取消 / 重新规划，仍然只能靠模型在主 ReAct 循环里
 *   顺手发起一个 `task_plan` 原生 tool_call —— 一旦模型的 tool_call 能力
 *   不可用（弱模型实测：21 轮空转 / 连续空响应），清单就**永久停摆**
 *   （缺陷 D200 / D201）。
 *
 *   PlanOps 让这四类操作各自成为**一次独立的、不带工具的、短上下文**的
 *   LLM 调用：模型一次只需要回答一个窄问题，输出走既有的五层降级解析器，
 *   不依赖 function calling。
 *
 * 依赖方向铁律：planning → ledger（类型）；**不得**反向依赖 engine。
 * ============================================================ */
import type { PlanDraftItem } from '../../ledger/plan-diff.js'
import type { PlanParseVia, PlannerSkipReason } from '../types.js'

/**
 * 五类清单操作 —— **唯一事实源**（纪律⑧）：类型由本数组推导。
 *
 * 为什么用数组推导而不是「union + 数组」两份：
 *   两份手工同步的枚举必然漂移（D188 的教训，同一形态的病）。
 *   数组推导后，「加了类型忘了加数组」在类型层就不可能发生。
 */
export const PLAN_OPS_KINDS = ['create', 'update', 'complete', 'cancel', 'replan'] as const

export type PlanOpsKind = (typeof PLAN_OPS_KINDS)[number]

/** 守卫：白名单 / 枚举全仓只许调本函数（纪律⑧） */
export function isPlanOpsKind(v: unknown): v is PlanOpsKind {
  return typeof v === 'string' && (PLAN_OPS_KINDS as readonly string[]).includes(v)
}

/**
 * 一次 PlanOps 请求的输入 —— 刻意只有三件事（研究 R2）。
 *
 * 「窄问题单独问」是本版最大的收益来源：实测弱模型在一边干活一边维护
 * `task_plan` 的完整 schema 时，会把**代码**当成任务文本写进 `text`
 * （`evidence/04` §3.1）。把维护这件事单独拎出来问，答案质量显著提升。
 */
export interface PlanOpsRequest {
  kind: PlanOpsKind
  taskId: string
  /** 任务目标（graph.goal 或首条用户消息） */
  goal: string
  /** 当前清单快照（含状态与层级，已渲染成文本） */
  snapshot: string
  /** 刚发生的一件事（工具结果摘要 / 失败摘要 / 用户新指令 / 取消原因） */
  event: string
  /** 输出项数上限，默认 PLAN_OPS_MAX_ITEMS */
  maxItems?: number
}

export type PlanOpsSkipReason = PlannerSkipReason

/**
 * 一次 run 内的清单操作预算状态（纯数据，由 `policy.ts` 的纯函数推进）。
 *
 * 为什么状态放在调用方而不是 runner 里：runner 是**无状态**的一次调用出口，
 * 预算必须跟「一次 run」绑定，而 run 的生命周期在 loop 手里。
 */
export interface PlanOpsState {
  /** 本 run 已发生的清单操作调用次数 */
  passes: number
  /** 每个 kind 上次触发的轮次 */
  lastRound: Partial<Record<PlanOpsKind, number>>
  /** 上次产出的清单指纹（用于 `update` 幂等判定） */
  lastFingerprint?: string
}

export interface PlanOpsResult {
  ok: boolean
  kind: PlanOpsKind
  /** 解析出的清单草案（ok=false 时为空数组） */
  draft: PlanDraftItem[]
  /** 解析通道；`'none'` = 未产出 */
  via: PlanParseVia | 'none'
  /** 人话摘要，可直接进 turn_note / 日志 */
  summary: string
  attempts: number
  skipped?: PlanOpsSkipReason
}

/* ---------------- 阈值（唯一事实源） ---------------- */

/** 一次 run 内 PlanOps 调用总上限（预算耗尽即停，**不回落重试** —— PRD K4） */
export const MAX_PLAN_OPS_PER_RUN = 10

/** 距上次同类操作的最小轮间隔（create / cancel 豁免） */
export const PLAN_OPS_MIN_ROUND_GAP = 3

/** 单次调用超时（ms） */
export const PLAN_OPS_BUDGET_MS = 20_000

/** 开局 create 放宽（首次调用含冷启动） */
export const PLAN_OPS_CREATE_BUDGET_MS = 45_000

/** 单次输出清单项上限 */
export const PLAN_OPS_MAX_ITEMS = 12

/** 连续失败达几次触发 replan（与 W2 的 PLANNER_FAILURE_THRESHOLD 同判据） */
export const PLAN_OPS_FAILURE_THRESHOLD = 2

/** 陈旧阈值：距上次触碰清单的轮数 */
export const PLAN_OPS_STALE_ROUNDS = 10
