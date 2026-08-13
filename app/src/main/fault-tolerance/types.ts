/* ============================================================
 * v0.14.0 Task 5 — 容错分级共享类型
 * 统一在 types.ts 导出，避免循环依赖
 * ============================================================ */
import type { PlanItem } from '@shared/types/task'
import type { Skill } from '@shared/types/agent'

/** 错误归类（4 档） */
export type FaultKind = 'retryable-tool' | 'non-retryable-tool' | 'llm-fatal' | 'unknown'

/** 工具上下文（决定 alternative 匹配范围） */
export interface FaultToolCall {
  /** skill id（注册表唯一标识），或 tool name（LLM 视角） */
  toolName: string
  /** 工具调用参数（用于 inputSchema 兼容性判定） */
  args?: Record<string, unknown>
}

/** 归一化 FaultError（覆盖 4 档 FaultKind + 原始信息） */
export interface FaultError {
  /** 错误代号（如 'llm-5xx' / 'perm-denied' / 'retries-exhausted'） */
  code: string
  /** 错误展示文案（renderer 可直接渲染） */
  message: string
  /** 归类结果 */
  originalKind: FaultKind
  /** 工具上下文（仅工具错误存在） */
  toolName?: string
  /** LLM 提供方（仅 llm-fatal 存在） */
  llmProvider?: string
  /** HTTP 状态码（如可识别） */
  httpStatus?: number
  /** 原始异常（仅 debug 用，一般不渲染） */
  cause?: unknown
}

/** 单次尝试记录（给 retry 编排器用） */
export interface RetryAttemptRecord {
  /** 第 N 次（1-based） */
  n: number
  /** 是否成功 */
  ok: boolean
  /** 失败时的 FaultError（成功时缺省） */
  error?: FaultError
  /** 本次尝试时间戳（毫秒） */
  ts: number
}

/** 一次重试运行的最终结果 */
export interface RetryResult<T> {
  value: T
  /** 已记录的全部尝试（成功那次也包含在内） */
  attempts: RetryAttemptRecord[]
}

/** 选项：重试编排 */
export interface RetryOptions {
  /** 最多尝试次数（默认 3） */
  maxAttempts?: number
  /** 退避序列（毫秒），第 N 次失败后等待 backoffMs[N-1] */
  backoffMs?: number[]
  /** 每次尝试回调（含失败的） */
  onAttempt?: (n: number, err: FaultError) => void
  /** 显式外部 signal（被中止时退出） */
  signal?: AbortSignal
}

/** 替代方案匹配条目 */
export interface SkillMatch {
  /** 候选 skill id */
  skillId: string
  /** 候选 skill 展示名 */
  name: string
  /** 兼容度评分 0~1（越高越接近 toolName） */
  score: number
  /** 评分细节（category / schema / desc 各自的贡献） */
  reasons: {
    category: number
    schema: number
    description: number
  }
}

/** 影响分析结果 */
export interface ImpactAnalysis {
  /** 是否阻断后续 PlanItem */
  blocksFollowers: boolean
  /** 人类可读的解释 */
  reason: string
  /** 实际耗时（毫秒） */
  latencyMs: number
}

/** 通知 payload（推到 renderer） */
export interface FaultNotificationPayload {
  fault: FaultError
  impact: { blocksFollowers: boolean; reason: string }
  /** 唯一 id（renderer 用于回传决策） */
  cardId: string
  /** 用户可选的决策按钮 */
  decisions: Array<{ id: 'retry' | 'ignore' | 'cancel-following'; label: string }>
  /** 任务上下文（renderer 显示） */
  taskId?: string
  planItemId?: string
}

/** 5 档链路输入：调用方提供的内容 */
export interface FaultTolerantCtx {
  /** 任务 id（用于事件总线 / 审计） */
  taskId?: string
  /** 计划项 id（用于 markFailed） */
  planItemId?: string
  /** 完整的 PlanItem，便于编排器写入状态 */
  planItem?: PlanItem
  /** 后续 PlanItem 列表（用于影响判断） */
  followingPlanItems?: PlanItem[]
  /** 工具调用快照（含 toolName + args） */
  toolCall: FaultToolCall
  /** 当前是否处于 chat 路径（chat 路径影响弹卡策略） */
  isChat?: boolean
  /** 外部 AbortSignal（用户主动暂停等） */
  signal?: AbortSignal
  /** 5 档链路结果回调（影响后续 / 替代成功等都通过这里回流） */
  onDecision?: (decision: FaultDecisionOutcome) => void
}

/** Skill 注册表：抽象成最小接口，便于单测注入桩 */
export interface SkillRegistry {
  list(): Promise<Skill[]> | Skill[]
  /** 按 id 拿到 */
  get(id: string): Promise<Skill | null> | Skill | null
}

/** 5 档链路结果：编排器交给调用方的最终结果 */
export interface FaultDecisionOutcome {
  /** Final outcome label */
  outcome:
    | 'retry-succeeded'
    | 'alternative-succeeded'
    | 'alternative-completed'
    | 'impacts-followers'
    | 'no-impact'
    | 'llm-fatal'
    | 'exhausted'
    | 'cancelled'
  /** 实际返回值（若成功） */
  value?: unknown
  /** 备注（例如「经由 <替代 Skill> 完成」） */
  note?: string
  /** 携带的 FaultError（若失败） */
  fault?: FaultError
  /** 替代 skill id（若走了替代） */
  alternativeSkillId?: string
}
