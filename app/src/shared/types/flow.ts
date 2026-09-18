/* ============================================================
 * ArkWork — Shared Types: 交互区展示模型（v0.31.0 B3）
 * 设计文档：docs/agent_learn/interaction-display-v1.0/07 §2.1（全量签名照引）·
 * 本仓库 docs/versions/v0.31.0/04-system-design.md §4.1 / §5.4.2。
 * 本文件是渲染层与主进程共用的展示层契约；不改变落盘真源
 * （steps.jsonl / session.jsonl / tasks.json）。
 * ============================================================ */
import type { PlanContent } from './react.js'
import type { PlanItemStatus } from './task.js'
import type { ToolCallView, ToolResultView, ToolCallKind } from './tool-present.js'

export type { ToolCallView, ToolResultView, ToolCallKind }

/** 视图模式（03 §六 I15） */
export type FlowViewMode = 'compact' | 'standard' | 'verbose'

/** Turn 级状态（面向展示，非 ReAct 内核状态） */
export type TurnStatus = 'running' | 'done' | 'failed' | 'paused' | 'cancelled'

/** Turn 级计量（06 §7.2 L16） */
export interface TurnMetrics {
  tokensIn: number
  tokensOut: number
  /** 思考 token（原生思考通道可得；来源见 04 §2.2 G3） */
  reasoningTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/** Turn 头（03 §7.1 I16） */
export interface TurnHeaderInfo {
  /** 1-based 轮序号，显示为 #N */
  index: number
  /** 触发者：用户 / 自动化 / steering 追加 */
  trigger: 'user' | 'automation' | 'steering'
  agentId: string
  agentName: string
  agentAvatarColor: string
  startedAt: number
  durationMs: number
  status: TurnStatus
  metrics: TurnMetrics
  /** 轮级错误（06 §7.1 的 ErrorBlock 内容来源） */
  errorMessage?: string
}

/** Turn 尾（03 §7.2 I17）：折叠摘要的唯一载体 */
export interface TurnSummary {
  /** 思考累计耗时（ms） */
  thinkingMs: number
  /** 工具调用统计：ToolCallKind → 次数 */
  toolCounts: Partial<Record<ToolCallKind, number>>
  toolTotal: number
  metrics: TurnMetrics
  /** 失败时指向首个失败块，供点击跳转 */
  firstFailedBlockId?: string
}

/* ---------- Block 判别联合（03 §三 I4–I12） ---------- */

/** 思考来源（04 §三 G4） */
export type ReasoningSource = 'native' | 'content' | 'none'

export interface UserBlock {
  kind: 'user'
  id: string
  turn: number
  /** outerBlock 恒 0（TurnView 以 step>0 分组进 StepView，§三 I4） */
  step: number
  text: string
  ts: number
  tsLabel: string
}

/** 模型显式产出的「结论 + 下一步」（03 §三 I5 / 04 §5.3） */
export interface SayBlock {
  kind: 'say'
  id: string
  turn: number
  step: number
  text: string
  status: 'streaming' | 'settled'
  /** summary 优先来源，见 04 §5.3 的取值链 */
  isSummarySource: boolean
  ts: number
}

export interface ReasoningBlock {
  kind: 'reasoning'
  id: string
  turn: number
  step: number
  seq: number
  source: ReasoningSource
  text: string
  summary: string
  /** 04 §六 G9：权威文本短于流式累计时置 true */
  truncated?: boolean
  startedAt: number
  durationMs: number
  reasoningTokens?: number
  status: 'pending' | 'streaming' | 'settled' | 'failed'
  errorMessage?: string
  /** 05 §八 T17：子调用预留 */
  children?: ToolBlock[]
}

export interface ToolBlock {
  kind: 'tool'
  id: string
  turn: number
  step: number
  /** 同一步内并发的分组键；单元素时为 undefined（05 §五 T12） */
  parallelGroupId?: string
  call: ToolCallView
  /** 落定后的结果视图；运行中为 undefined */
  result?: ToolResultView
  status: ToolStatus
  startedAt: number
  durationMs: number
  /** 失败时的错误文本（status === 'failed' 时必有） */
  errorMessage?: string
  /** 行动意图（ReActStep.intent / intentKey+intentParams 的展示投影） */
  intent?: string
  /** L2 大结果入口（ReActStep.rawL2Path） */
  rawL2Path?: string
  /** 子调用（05 §八 T17，本期渲染为缩进列表） */
  children?: ToolBlock[]
}

/** 六态状态机（05 §二 T1） */
export type ToolStatus = 'pending' | 'running' | 'success' | 'failed' | 'guarded' | 'cancelled'

export interface PlanBlock {
  kind: 'plan'
  id: string
  turn: number
  step: number
  goal: string
  items: string[]
  states: PlanItemStatus[]
  /** 来自 task.planItems 的聚合状态徽标（沿用 utils/plan-status.ts） */
  aggregate: PlanItemStatus | null
  collapsed: boolean
  ts: number
}

export interface ApprovalBlock {
  kind: 'approval'
  id: string
  turn: number
  /** outerBlock 恒 0 */
  step: number
  /** 沿用 v0.30.0 三类：needs-human / replan / converge */
  cardKind: 'needs-human' | 'replan' | 'converge'
  /** 关联的业务 id（nodeId / patchId），供 ActionCards 取数 */
  refId?: string
  ts: number
}

export type NoticeKind =
  | 'context-inject'          // @file / @skill / @memory 注入
  | 'compaction'              // 上下文压缩（06 §7.1 L15）
  | 'context-overflow-retry'  // 上下文超限重试
  | 'budget-retry'            // 思考耗尽预算重试
  | 'gate-blocked'            // 门禁拦截
  | 'soft-fail'               // 软失败汇总

export interface NoticeBlock {
  kind: 'notice'
  id: string
  turn: number
  step: number
  noticeKind: NoticeKind
  /** 一行文案（默认可见） */
  text: string
  /** 详情（折叠） */
  detail?: string
  level: 'info' | 'warning'
  ts: number
}

export interface AnswerBlock {
  kind: 'answer'
  id: string
  turn: number
  /** outerBlock 恒 0 */
  step: number
  /** 只来自模型显式答复；禁止回落 thought（03 §三 / 阻断 RC-5） */
  text: string
  /** 来源：task_complete 的 summary / ask_user 的 question / 无 action 的 content */
  origin: 'task-complete' | 'ask-user' | 'plain'
  streaming: boolean
  ts: number
  tsLabel: string
}

export interface ErrorBlock {
  kind: 'error'
  id: string
  turn: number
  /** outerBlock 恒 0 */
  step: number
  text: string
  detail?: string
  /** 可重试 / 可重跑 */
  actions: Array<'retry' | 'rerun'>
  ts: number
}

/** Block 判别联合（唯一有序数组，顺序 = 真实发生顺序） */
export type FlowBlock =
  | UserBlock | SayBlock | ReasoningBlock | ToolBlock
  | PlanBlock | ApprovalBlock | NoticeBlock | AnswerBlock | ErrorBlock

/* ---------- Step / Turn ---------- */

export interface FlowStep {
  /** ReAct iteration */
  index: number
  /** 步级摘要（Step 折叠时显示） */
  summary: string
  status: 'running' | 'done' | 'failed' | 'guarded'
  collapsed: boolean
  durationMs: number
  blocks: FlowBlock[]
}

export interface FlowTurn {
  id: string
  header: TurnHeaderInfo
  steps: FlowStep[]
  /** 不走 iteration 的块（用户消息 / 终答 / 轮级错误）挂在这里，按 ts 合并进渲染序列 */
  outerBlocks: FlowBlock[]
  summary: TurnSummary
  collapsed: boolean
}

/* ---------- v0.32.0 进程折叠（04-system-design §1.3–1.5） ----------
 * 折叠是**渲染投影**：不动 projectConversation 的块列表（等价性基线冻结），
 * 只把块的线性序列按「连续性」切成 主展示块 / 进程 run 交替的渲染段。
 */

/** 可折叠的进程域：思考 / 工具（技能与 MCP 调用同归 tool） */
export type FoldScope = 'reasoning' | 'tool'

/** 一段连续的同类进程块（按连续性分组，kind 变化即断组） */
export interface FlowFoldRun {
  /** run id = 该 run 首个块的 id（投影层块 id 确定性生成，故 run id 稳定可持久化） */
  id: string
  scope: FoldScope
  blocks: FlowBlock[]
  startedAt: number
  /** run 内块时长之和（思考与工具各自 durationMs） */
  durationMs: number
  /** 含 failed / guarded —— 折叠行改用语义色并（standard 及以上）自动展开 */
  hasFailure: boolean
  /** 含 running / pending / streaming —— 折叠行追加「进行中」 */
  hasRunning: boolean
}

/** 渲染段：主展示块（永不折叠）或进程 run（可折叠） */
export type FlowSegment =
  | { type: 'block'; key: string; block: FlowBlock }
  | { type: 'fold'; key: string; run: FlowFoldRun }
