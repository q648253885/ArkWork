/* ============================================================
 * ArkWork — Shared Types: TaskGraph（v0.30.0 新增）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §4
 *       agent-design-v1.0/03-统一任务模型TaskGraph.md §3/§4/§5
 *
 * 一句话定义：
 *   TaskGraph = 一棵带依赖拓扑、带验收契约、带执行状态、带证据链、
 *               可持久化、可 diff 的任务树。
 *   Spec 是它上层的验收锚点，Plan 是它中层的路径拓扑，Task 是它下层的执行状态。
 *
 * 与设计稿的 5 处有意差异（详见系统设计 §4.3/§4.6 差异点汇总）：
 *   1. 时间戳统一为 number（毫秒），与既有 Task.createdAt 一致，不用 ISO string
 *   2. spec.assumptions 由 string[] 升级为带 id/invalidated 的对象数组，以承载 UI 的"假设失效"展示
 *   3. blockingQuestion/blockingOptions/blockingSince/timeoutAction 直接挂在 TaskNode 上
 *   4. 不新增第 12 态 rejected，"打回"表达为 cancelled + Revision.reason='user-rejected'
 *   5. 新增 tokensUsed，供活跃窗口投影的 [BUDGET] 行使用
 * ============================================================ */

/* ============================================================
 * 一、状态机：11 态
 * ============================================================ */

/**
 * 节点状态（十一态）。
 *
 * 与 v0.29 的 `PlanItemStatus`（六态）相比，新增两个一等状态：
 *  - `verifying`：做完了但**没验证** —— 对抗 F3 自评失明（设计稿 §4.2）
 *  - `needs_human`：阻塞在**等人**（信息/决策/权限）—— 业界普遍缺失的协作态
 */
export type NodeStatus =
  | 'draft' // 已创建但未成型（Agent 还在想）
  | 'proposed' // 提议中，等待人批准（Plan 闸门）
  | 'approved' // 已批准，可以执行
  | 'ready' // 依赖已满足，等待调度
  | 'in_progress' // 正在执行【I1：全局唯一，除非显式并行】
  | 'verifying' // 【新增】做完了，正在验证
  | 'blocked' // 被依赖阻塞
  | 'needs_human' // 【新增】阻塞在等人
  | 'completed' // 验证通过 + 有证据
  | 'cancelled' // 主动取消（不是失败）
  | 'failed' // 尝试超限或不可恢复

/** 全部状态的稳定顺序（UI 分组、统计、测试断言共用；禁止在别处再写一遍字面量数组） */
export const NODE_STATUSES: readonly NodeStatus[] = [
  'draft',
  'proposed',
  'approved',
  'ready',
  'in_progress',
  'verifying',
  'blocked',
  'needs_human',
  'completed',
  'cancelled',
  'failed',
] as const

/** 终态集合：到达后不再参与调度（改写需显式 reopen 动作并记 Revision） */
export const TERMINAL_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'completed',
  'cancelled',
])

/**
 * 状态转换表（写入前查表，非法转换返回 TRANSITION_DENIED）。
 *
 * 说明：
 *  - `completed` 是终态，但 allowSelfAttest 场景下可由 failed 重试进入
 *  - `needs_human` 只能回到 ready / cancelled / failed —— 不允许直接回 in_progress，
 *    否则"绕过提问继续跑"会绕过 I6 的语义
 */
export const ALLOWED_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  draft: ['proposed', 'cancelled'],
  proposed: ['approved', 'cancelled', 'failed'],
  approved: ['ready', 'blocked', 'cancelled'],
  ready: ['in_progress', 'blocked', 'needs_human', 'cancelled'],
  in_progress: ['verifying', 'blocked', 'needs_human', 'failed', 'cancelled', 'completed'],
  verifying: ['completed', 'failed', 'needs_human'],
  blocked: ['ready', 'cancelled'],
  needs_human: ['ready', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: ['ready', 'cancelled'],
}

/** 判断状态转换是否合法（供 gate.ts 与单测共用） */
export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  if (from === to) return true // 幂等：同状态写入视为无操作
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/* ============================================================
 * 二、验收 · 证据 · 验证策略
 * ============================================================ */

/** 验收条件的验证方式（type=test/command 时 verify 必填） */
export interface AcceptanceVerify {
  /** 机器可执行命令，如 "npm test -- auth" */
  command?: string
  /** 测试用例标识，如 ["test_auth_login_success"] */
  testIds?: string[]
  /** 期望退出码，默认 0 */
  expectExitCode?: number
}

export type AcceptanceType = 'test' | 'command' | 'manual' | 'checklist' | 'invariant'
export type AcceptanceStatus = 'pending' | 'passing' | 'failing' | 'waived'

/**
 * 验收条件（AC）。
 *
 * 【不可变性 I3】一旦 Spec 被 approved，`statement` 与 `verify` 不得修改，
 * 只能新增 AC 或把已有 AC 标 `waived`。理由（设计稿 §5.4）：
 * 不能让 Agent 修改自己的成功标准，否则它会通过弱化标准来"通过"测试。
 */
export interface AcceptanceCriterion {
  /** AC-01（同 graph 内唯一） */
  id: string
  /** 人类可读陈述：WHEN x THE SYSTEM SHALL y */
  statement: string
  type: AcceptanceType
  /** 机器可执行的验证方式（type=test/command 时必填） */
  verify?: AcceptanceVerify
  status: AcceptanceStatus
  /** 覆盖该 AC 的节点 id 列表 */
  coveredBy: string[]
  lastResult?: {
    at: number
    exitCode: number
    /** 输出摘录（≤ 2000 字符，完整输出外置到 evidence/） */
    excerpt: string
  }
}

/** 证据类型（7 种）。`human` 可信度最高，`diff` 最低 */
export type EvidenceKind = 'test' | 'command' | 'diff' | 'screenshot' | 'human' | 'artifact' | 'lsp'

/**
 * 证据可信度分级（数值越高越可信）。
 *
 * 关键规则（设计稿 §5.2）：**`diff` 单独不能作为 `completed` 的充分证据**
 * —— 它只能证明"改了"，不能证明"对了"。落实为：
 * `completed` 的充分证据必须包含至少一条 `trust >= EVIDENCE_TRUST.command` 的非 diff 证据。
 */
export const EVIDENCE_TRUST: Record<EvidenceKind, number> = {
  human: 5,
  test: 4,
  command: 3,
  lsp: 3,
  diff: 2,
  artifact: 2,
  screenshot: 2,
}

/** 充分证据的最低可信度门槛（见 EVIDENCE_TRUST 说明） */
export const SUFFICIENT_EVIDENCE_TRUST = EVIDENCE_TRUST.command

/** UI 上展示为"仅证明改动，不证明正确"的证据类型 */
export const WEAK_EVIDENCE_KINDS: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['diff'])

/** 证据条目 */
export interface Evidence {
  kind: EvidenceKind
  /** 一句话摘要 */
  summary: string
  /** 输出文件路径 / commit sha / 图片路径 / session id */
  ref?: string
  exitCode?: number
  at: number
  by: Assignee
}

/**
 * 验证策略。
 *
 * ★ `allowSelfAttest` 默认 false —— 这是 v0.30.0 与 v0.29 的核心哲学分歧所在：
 * v0.29 允许模型调 task_complete 自证完成（F3 自评失明），本版拒绝。
 */
export interface VerificationPolicy {
  /** 是否必须经过 verifying 态（task/step 层且有 acceptance 时默认 true） */
  required: boolean
  /** 验证命令（缺省时回落 acceptance[].verify.command） */
  command?: string
  /** 允许的失败重试次数，超过则 failed 并触发 Replan E1（默认 3） */
  maxAttempts: number
  /** 是否允许 Agent 自证（false 时必须外部验证器或人工） */
  allowSelfAttest: boolean
}

/** 默认验证策略（不给 allowSelfAttest 留任何"顺手为 true"的空间） */
export function defaultVerification(overrides?: Partial<VerificationPolicy>): VerificationPolicy {
  return {
    required: false,
    maxAttempts: 3,
    allowSelfAttest: false,
    ...overrides,
  }
}

/* ============================================================
 * 三、负责人 · 上下文引用
 * ============================================================ */

/** 谁负责这个节点 */
export type Assignee =
  | { kind: 'agent'; id: string; model?: string; sessionId?: string }
  | { kind: 'human'; id: string }
  | { kind: 'external'; system: string; ref: string }
  | { kind: 'system' }

/** Assignee 的短标签（日志与 UI 徽标共用） */
export function assigneeLabel(a: Assignee | undefined): string {
  if (!a) return '—'
  switch (a.kind) {
    case 'agent':
      return a.id
    case 'human':
      return 'human'
    case 'external':
      return `${a.system}:${a.ref}`
    case 'system':
      return 'system'
  }
}

/**
 * 上下文引用 —— **只存指针，不内联内容**（设计稿 §3.1）。
 * 内联内容会让 graph.json 膨胀并把上下文预算吃光。
 */
export interface ContextRef {
  kind: 'file' | 'symbol' | 'memory' | 'url' | 'diff' | 'session' | 'rule'
  /** 路径 / 符号名 / 记忆 ID / URL */
  ref: string
  /** 为什么相关 */
  note?: string
  /** 预估 token，用于投影时的预算控制 */
  estTokens?: number
}

/* ============================================================
 * 四、任务节点
 * ============================================================ */

/** 节点层级：四层同构，同一个 schema，只是 layer 字段不同 */
export type NodeLayer = 'goal' | 'milestone' | 'task' | 'step'

/** 树视图缩进步长（px），交互文档 §0.4 已确认 */
export const LAYER_INDENT: Record<NodeLayer, number> = {
  goal: 0,
  milestone: 14,
  task: 28,
  step: 42,
}

/** 人类可读的层徽章文案 */
export const LAYER_BADGE: Record<NodeLayer, string> = {
  goal: 'GOAL',
  milestone: 'MILESTONE',
  task: 'TASK',
  step: 'STEP',
}

export type NodePriority = 'p0' | 'p1' | 'p2'

/**
 * 任务节点（四层同构）。
 *
 * 一个反直觉但重要的点：**step 层与 task 层用完全相同的字段集**。
 * 好处是 UI 一个组件渲染所有层级（靠 layer 缩进 + 徽章区分）、
 * 状态机与不变量全层统一、溯源天然（derivedFrom 指回父节点）。
 */
export interface TaskNode {
  /** t_<6位随机>（同 graph 内唯一） */
  id: string
  /** 人类可读稳定标识：T-01（可写进文档/PR 回指） */
  key?: string
  parentId: string | null
  layer: NodeLayer

  /** ≤ 80 字 */
  title: string
  /** 为什么做（I7：与 derivedFrom 至少存在一个，不允许"来路不明的任务"） */
  intent?: string
  /** 做什么 */
  description?: string

  status: NodeStatus
  assignee: Assignee
  priority: NodePriority

  // ---- 结构 ----
  /** 有序子节点 */
  children: string[]
  /** 有向边；用于推导并行 wave；I4 校验无环 */
  dependsOn: string[]
  /** 溯源：指回 AC id 或父节点，回答"为什么" */
  derivedFrom?: string[]

  // ---- 验收与证据 ----
  acceptance: AcceptanceCriterion[]
  evidence: Evidence[]
  verification: VerificationPolicy

  // ---- 上下文与预算 ----
  contextRefs: ContextRef[]
  tokenBudget?: number
  /** 已消耗 token（投影的 [BUDGET] 行使用） */
  tokensUsed: number

  // ---- 执行记录 ----
  /** 尝试次数，用于 Replan 触发 E1 */
  attempts: number
  /** 哪些 session 碰过它 */
  sessionIds: string[]
  lastError?: string
  /** 进度笔记。**追加**而非覆盖（needs_human 的回答写这里） */
  notes?: string

  // ---- 协作态（needs_human 专用；I6 要求 blockingQuestion 必填） ----
  /** 需要人回答什么 */
  blockingQuestion?: string
  /** 可选项（把开放式问题变成选择题，降低回答成本） */
  blockingOptions?: BlockingOption[]
  /** 阻塞开始时间戳（UI 用它显示"等待 2m14s"） */
  blockingSince?: number
  /** 超时后的默认动作；**默认 'continue' 即不自动决策** */
  timeoutAction?: 'continue' | 'skip' | 'cancel'

  // ---- 审计 ----
  createdAt: number
  updatedAt: number
  /** per-node 乐观锁（并发写入检测） */
  revision: number
}

/** needs_human 的可选项 */
export interface BlockingOption {
  label: string
  /** 该选项的代价说明（UI 显示在 label 下的次要行） */
  description?: string
}

/* ============================================================
 * 五、Spec / Policy / Revision
 * ============================================================ */

export type SpecState = 'none' | 'draft' | 'approved' | 'amended'

/** 假设条目（相对设计稿的差异点 2：由 string[] 升级为对象数组） */
export interface Assumption {
  id: string
  text: string
  /** 被证伪时写入证据说明（触达 E4 → Spec 修订流程） */
  invalidated?: string
}

/**
 * Spec 块：验收契约。
 * 只有 tier >= 2 才生成完整 spec；tier 0/1 可以只有 goal + acceptance。
 */
export interface SpecBlock {
  state: SpecState
  /** 明确做什么 */
  scopeIn: string[]
  /** 【关键】明确不做什么 —— 防止范围蔓延（投影恒在项） */
  scopeOut: string[]
  assumptions: Assumption[]
  /** 硬约束（性能、兼容性、安全） */
  constraints: string[]
  /** 验收条件的权威定义 */
  acceptance: AcceptanceCriterion[]
  /** 与代码库的绑定（只存指针） */
  contextRefs: ContextRef[]
  lastConvergeAt?: number
  driftReport?: DriftReport
}

/** 复杂度等级（设计稿 §6 / 准则 D2） */
export type Tier = 0 | 1 | 2 | 3

/** tier 的中文短标签（UI 徽章 + 日志共用） */
export const TIER_LABEL: Record<Tier, string> = {
  0: 'T0 · 单步/问答',
  1: 'T1 · 轻量多步',
  2: 'T2 · 多文件有取舍',
  3: 'T3 · 跨模块高风险',
}

/** 执行策略 */
export interface PolicyBlock {
  tier: Tier
  /** 模型给出的一句话理由（UI 展示，F24） */
  tierReason?: string
  /** 并行度。本版恒为 1（Scope Out S4），字段保留以承载未来并行调度 */
  maxParallel: number
  requirePlanApproval: boolean
  requireSpecApproval: boolean
  /** 全局默认 false（设计稿硬要求） */
  allowSelfAttest: boolean
  autoConverge: boolean
  /** 【关键】内置任务清单可关闭（Codex competing-surfaces 教训 / 准则 A4） */
  builtinTaskListEnabled: boolean
  /** 与 Jira/Linear MCP 的同步策略（本版只保留字段，不实现互操作） */
  externalSync?: { system: string; mode: 'mirror' | 'import' | 'disabled' }
}

/** 默认策略 */
export function defaultPolicy(overrides?: Partial<PolicyBlock>): PolicyBlock {
  return {
    tier: 2,
    maxParallel: 1,
    requirePlanApproval: true,
    requireSpecApproval: false,
    allowSelfAttest: false,
    autoConverge: true,
    builtinTaskListEnabled: true,
    ...overrides,
  }
}

export type RevisionOp =
  | 'create'
  | 'update'
  | 'status'
  | 'delete'
  | 'replan'
  | 'converge'
  /** v0.30.0 新增：从 v0.29 的 planItems 迁移而来 */
  | 'migrate'

/**
 * 审计记录。**每次图变更留痕**（可 diff、可追溯"状态是谁改的"）。
 *
 * 本版保留 v0.29 `PlanItemSource`（8 种来源）的全部信息：
 * 迁移时把 source 映射到 `by` + `reason`（见系统设计 §6.3 映射表），不丢弃留痕能力。
 */
export interface Revision {
  seq: number
  at: number
  by: Assignee
  op: RevisionOp
  targetId: string
  before?: unknown
  after?: unknown
  /** 【关键】Replan / scope 变更 / 强制改状态时必须写理由 */
  reason?: string
}

/* ============================================================
 * 六、Replan
 * ============================================================ */

/** Replan 触发事件（设计稿 §4.2） */
export type ReplanEventType =
  | 'E1' // 连续失败
  | 'E2' // 漂移超限
  | 'E3' // 发现新依赖
  | 'E4' // 假设被证伪
  | 'E5' // 用户插入需求
  | 'E6' // 上下文压缩
  | 'E7' // 完成率与验收不匹配
  | 'E8' // 上下文预算压力
  | 'E9' // 定时兜底

/** 事件清单的文案（日志与 UI 共用，避免两处各写一份） */
export const REPLAN_EVENT_LABEL: Record<ReplanEventType, string> = {
  E1: '连续失败',
  E2: '漂移超限',
  E3: '发现新依赖',
  E4: '假设被证伪',
  E5: '用户插入需求',
  E6: '上下文压缩后',
  E7: '完成率与验收不匹配',
  E8: '上下文预算压力',
  E9: '定时兜底',
}

/** 单个补丁操作 */
export type ReplanOp =
  | { op: 'add'; node: TaskNode; after?: string }
  | { op: 'remove'; id: string; reason: string }
  | { op: 'update'; id: string; patch: Partial<TaskNode> }
  | { op: 'reorder'; ids: string[] }
  | { op: 'relink'; id: string; dependsOn: string[] }

/** 影响分析（Replan 通知卡必须展示"代价是什么"） */
export interface ReplanImpact {
  /** 已完成但需要重做的节点 */
  invalidatedTasks: string[]
  /** 受影响的 AC id */
  affectedACs: string[]
  /** 预计额外消耗 token */
  estimatedExtraTokens: number
}

/**
 * 批准级别（设计稿 §4.4）：
 *  - 1：仅追加 / 加边，不 invalidate 已完成 → **自动应用** + UI 提示
 *  - 2：invalidate 已完成，或影响 AC 覆盖 → **需用户批准**
 *  - 3：修改 scopeIn / scopeOut → 需批准 + 视为 Spec 修订
 *  - 4：修改已 approved 的 acceptance → **禁止**，必须走 Spec 修订流程
 */
export type ReplanApprovalLevel = 1 | 2 | 3 | 4

/** Replan 补丁（事务：ops 要么全应用，要么全回滚） */
export interface ReplanPatch {
  id: string
  /** 【必填】为什么 —— 不可解释的重规划会破坏用户对系统的信任 */
  reason: string
  triggerEvent: ReplanEventType
  ops: ReplanOp[]
  impact: ReplanImpact
  approvalLevel: ReplanApprovalLevel
  state: 'pending' | 'applied' | 'rejected' | 'rolled-back'
  createdAt: number
  decidedAt?: number
  /** 用户打回时的说明 */
  userNote?: string
}

/* ============================================================
 * 七、收敛环（Converge）
 * ============================================================ */

/** 收敛报告的降级维度（无 git 时无法做漂移/重复检测） */
export type ConvergeDegradedDim = 'drift' | 'dup'

/** 收敛报告（DriftReport） */
export interface DriftReport {
  at: number
  /** AC 覆盖与通过状态 */
  acCoverage: { acId: string; status: AcceptanceStatus; coveredBy: string[] }[]
  /** 代码里做了但图里没有 → 建议追加 */
  unmodeledWork: {
    description: string
    evidence: string
    suggestedTask: Partial<TaskNode>
    /** 与已有节点疑似重复时，指向那个节点（避免图里长出两个做同一件事的节点） */
    dupOf?: string
  }[]
  /** 图里有但代码已无对应 */
  zombieTasks: { taskId: string; reason: string }[]
  /** 被证伪的假设 */
  invalidAssumptions: { assumptionId: string; assumption: string; contradictedBy: string }[]
  /** 本次收敛追加的节点 id */
  appendedTaskIds: string[]
  /** 【关键】能力不可用的维度。与"检查过且干净"必须区分，否则等于谎报绿灯 */
  degraded?: ConvergeDegradedDim[]
}

/* ============================================================
 * 八、顶层容器
 * ============================================================ */

export const GRAPH_SCHEMA_VERSION = '1.0'

/**
 * 任务图（顶层容器）。
 *
 * 存储：`nodes` 用扁平 Record + `parentId` + `rootIds`，而不是嵌套树。理由：
 *  1. 并发安全：多个 agent 更新不同节点时不冲突（配合 per-node 乐观锁 revision）
 *  2. O(1) 查找：投影、状态查询都是常数时间
 *  3. diff 友好：扁平结构做 JSON diff 更精确
 *  4. 部分加载：可以只把活跃子树序列化进上下文
 */
export interface TaskGraph {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION
  /** tg_<日期>_<6位随机> */
  id: string
  title: string
  /** 【压缩第一优先级】单一目标陈述，≤ 200 字。投影中恒在，不参与裁剪 */
  goal: string
  status: NodeStatus
  /** per-graph 乐观锁（并发写入检测，与 node.revision 配合） */
  graphRevision: number

  spec: SpecBlock
  /** 节点表（扁平存储 + parentId） */
  nodes: Record<string, TaskNode>
  /** 顶层节点顺序 */
  rootIds: string[]

  policy: PolicyBlock
  /** 每次变更留痕（可 diff、可回滚） */
  revisions: Revision[]

  /**
   * approved 时快照的测试标识（Immutable Tests）。
   * 本版只做快照 + 运行时警告（Scope Out S7：不做 git hook 强制）。
   */
  frozenTests?: string[]

  createdAt: number
  updatedAt: number
}

/* ============================================================
 * 九、写入错误（结构化错误 —— 模型的纠错依据，不是裸异常）
 * ============================================================ */

export type GraphErrorCode =
  | 'INVARIANT_VIOLATION'
  | 'SCHEMA_INVALID'
  | 'TRANSITION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'IO_ERROR'

/** 七条不变量（设计稿 §4.4） */
export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7'

/** 不变量的一句话说明（日志、结构化错误、UI tooltip 共用） */
export const INVARIANT_LABEL: Record<InvariantId, string> = {
  I1: '最多一个 in_progress（除非 policy.maxParallel > 1）',
  I2: 'completed 必须经过 verifying + 至少一条充分证据 + AC 全 passing/waived',
  I3: 'approved 后的 acceptance.statement 与 verify 不可变',
  I4: '依赖图中无环',
  I5: '父节点 completed 要求所有非 cancelled 子节点 completed',
  I6: 'needs_human 必须携带 blockingQuestion',
  I7: '每个节点必须有 derivedFrom 或 intent',
}

/**
 * 图写入的结构化错误。
 *
 * 为什么不 throw 裸 Error：设计稿 §S4 要求"返回一个结构化错误给模型
 * （不是简单的'操作失败'），说明违反了哪条、为什么、怎么修"。
 * `hint` 是给模型看的修复指引 —— 这是把"提示词纪律"升级为"运行时契约"的关键。
 */
export interface GraphWriteError {
  code: GraphErrorCode
  invariant?: InvariantId
  /** 一句话：违反了什么 */
  message: string
  /** 一句话：怎么修（写给模型看） */
  hint: string
  violatedBy?: { nodeId?: string; field?: string; value?: unknown }
}

/** 统一的 IPC 响应包络（新频道专用，不改既有频道契约） */
export type GraphResult<T> = { ok: true; data: T } | { ok: false; error: GraphWriteError }

/* ============================================================
 * 十、面板投影（IPC graph:snapshot 的载荷）
 * ============================================================ */

/** 节点在面板上的一行（轻量：不含 evidence 明细，展开时才拉） */
export interface GraphRow {
  id: string
  key?: string
  layer: NodeLayer
  depth: number
  title: string
  status: NodeStatus
  /** 有子节点的节点可折叠 */
  hasChildren: boolean
  childCount: number
  /** 已完成的子节点数（折叠摘要 "✓ 3 个子任务" 用） */
  doneChildCount: number
  tokensUsed?: number
  durationMs?: number
  /** 被依赖阻塞时显示 "blocked by T-04" */
  blockedBy?: string[]
  /** 正在跑的命令（verifying 态显示） */
  runningCommand?: string
  /** 失败且尝试超限（"尝试 3/3 失败"） */
  attemptsLabel?: string
  /** needs_human 的角标数字（未回答数） */
  pendingQuestions?: number
  /** 等待时长（ms），needs_human 专用，UI 侧实时递增 */
  waitingMs?: number
  /** 状态来源（引擎/模型/用户），沿用 v0.18 source 徽标语义 */
  source?: string
}

/** 面板顶部的通知条 */
export interface GraphNotice {
  kind: 'converge' | 'replan' | 'assumption' | 'auto-applied' | 'external-mirror'
  severity: 'info' | 'warn' | 'danger' | 'success'
  text: string
  /** 关联的 patchId（Replan）或 graphId（其他） */
  refId?: string
  dismissible: boolean
}

/** 面板快照（一次 IPC 拿到画面板所需的全部信息） */
export interface GraphSnapshot {
  graphId: string
  taskId: string
  title: string
  goal: string
  status: NodeStatus
  tier: Tier
  tierReason?: string
  spec: {
    state: SpecState
    scopeIn: string[]
    scopeOut: string[]
    acceptance: {
      id: string
      statement: string
      status: AcceptanceStatus
      verifyCommand?: string
      coveredBy: string[]
    }[]
  }
  policy: {
    builtinTaskListEnabled: boolean
    autoConverge: boolean
    allowSelfAttest: boolean
  }
  /** 按显示顺序拍平的可见行（含全部非 goal 节点，折叠交由渲染层 `expandedSet` 决定） */
  rows: GraphRow[]
  counts: Record<NodeStatus, number> & { total: number }
  /**
   * P1 · 面板进度口径（分母不含 `layer === 'goal'`）。
   *
   * 与 `counts` 的区别：goal 节点恒为 `ready`（系统设计 §10.4），若用 `counts.total`
   * 当分母，任务永远差 1 项无法收敛。`done = completed + cancelled`。
   * `counts` 语义保持不变，其它消费方零改动。
   */
  progress: { done: number; total: number }
  budget: { tokensUsed: number; tokenBudget?: number }
  notices: GraphNotice[]
  /** 轻量模式（tier 0/1 或无图） */
  lightweight: boolean
  /** 图数据源（用于 F20 的降级态判定） */
  source: 'graph' | 'planItems-mirror' | 'lightweight' | 'external-mirror'
  /** P8：计划闸门投影。无计划闸门（tier 0/1 或 requirePlanApproval=false）时缺省 */
  planApproval?: PlanApproval
  updatedAt: number
}

/**
 * P8 · 计划闸门（对话流内联卡 `PlanApprovalCard` 的投影）。
 *
 * 依据：交互文档 §P8 / 系统设计 §5.1。这是「Plan 闸门」——**不批准不执行**。
 * 它是一段**瞬时状态**（纯内存，重启即清空），不落盘：理由同 Replan 待决补丁
 * （见 `agent/graph/pending.ts` 头注）——落盘会让每次规划都产生一次 graph.json
 * diff，污染审计流。
 *
 * `state` 四态与原型五态的映射（原型「空态 Tier 0」= 无 PlanApproval，不渲染卡片）：
 *  - `generating`：已 request_plan、正在生成（原型 loading「正在生成计划…」）
 *  - `pending`   ：Planner submit_plan 通过覆盖率校验，等待用户批准（原型默认态）
 *  - `approved`  ：用户点「批准执行」→ spec.state=approved + AC 冻结（原型 success 折叠一行）
 *  - `rejected`  ：用户「打回并说明」→ 折叠为一行，等待 Planner 重新规划
 *
 * 原型 error 态（「计划生成失败，已降级为直接执行」）由 `degraded` 承载，
 * `degraded=true` 时卡片展示三级降级说明 + 「重试规划」。
 */
export interface PlanApproval {
  taskId: string
  /** generating / rejected 阶段可能尚无图（Planner 还在建图） */
  graphId?: string
  state: 'generating' | 'pending' | 'approved' | 'rejected'
  proposedAt: number
  decidedAt?: number
  /** 用户打回时的说明（reject） */
  userNote?: string
  /** 覆盖率检查：未被任何节点覆盖的 AC id（非空时「批准执行」禁用） */
  uncovered: string[]
  /** 规划失败降级（原型的 error 态）；`[重试规划]` 可重新触发 */
  degraded?: boolean
}

/* ============================================================
 * 十一、事件判定（S5）与 Sync 结果
 * ============================================================ */

/** 事件判定结果的动作 */
export type EventAction = 'none' | 'replan' | 'ask' | 'converge'

/** 单条事件判定 */
export interface EventDecision {
  event: ReplanEventType
  action: EventAction
  reason: string
}

/** 节点变更（用于增量广播，沿用 v0.18 patch 策略而非整对象广播） */
export interface NodeChange {
  nodeId: string
  from?: NodeStatus
  to?: NodeStatus
  source: string
  reason?: string
  field?: string
}

/* ============================================================
 * 十一·五、指标快照（IPC graph:metrics 的载荷）
 *
 * 定义放在 shared 而不是 main/agent/graph/metrics.ts：IPC 契约类型必须跨端可见
 * （preload 与 renderer 都要引用），main 侧的实现只负责采集与计算。
 * ============================================================ */

/** 指标快照（红线指标 + 原始计数器） */
export interface MetricsSnapshot {
  /** 幻影完成率：模型宣称完成但被降级为 verifying 的比例。null 表示尚无样本 */
  phantomCompletionRate: number | null
  /** 同步开销率：图维护动作 ÷ 全部工具调用。null 表示尚无样本。红线 < 0.05 */
  syncOverheadRate: number | null
  /** 同步开销是否超红线 */
  syncOverheadRedline: boolean
  raw: MetricsCounters
}

/** 原始计数器（开发期观测用） */
export interface MetricsCounters {
  phantom_completion: number
  model_claim: number
  sync_action: number
  tool_call: number
  gate_reject: number
  projection_tokens: number
  projection_over_budget: number
  projection_trimmed: Record<string, number>
  events: Record<string, number>
  converge_findings: { unmodeled: number; zombies: number; degraded: number; runs: number }
  tier_distribution: Record<string, number>
}

/* ============================================================
 * 十二、ID 生成
 * ============================================================ */

/** 6 位 base36 随机后缀（采用与 generateTaskId 相同的 Web Crypto 策略） */
function randomSuffix(): string {
  const arr = new Uint8Array(4)
  const g =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
      : undefined
  if (g?.getRandomValues) {
    g.getRandomValues(arr)
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(arr, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6)
}

/**
 * 生成 graph id：`tg_<YYYYMMDD>_<6位随机>`。
 *
 * 沿用 v0.4.0-rev2 的教训：**不用递增序号**。旧版用 `existing.length + 1` 生成 id，
 * 删除后序号重复会导致 upsert 覆盖已有记录（表现为"新建任务来回改名"）。
 * 36^6 ≈ 22 亿，同日冲突概率可忽略。
 */
export function generateGraphId(): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `tg_${ymd}_${randomSuffix()}`
}

/** 生成节点 id：`t_<6位随机>` */
export function generateNodeId(): string {
  return `t_${randomSuffix()}`
}

/** 生成 Replan 补丁 id：`rp_<6位随机>` */
export function generatePatchId(): string {
  return `rp_${randomSuffix()}`
}

/** 校验 id 是否符合白名单（用于拼路径前的目录穿越防护） */
export function isValidGraphId(id: string): boolean {
  return /^tg_[A-Za-z0-9_]{1,40}$/.test(id)
}

/** 校验节点 id 是否符合白名单 */
export function isValidNodeId(id: string): boolean {
  return /^t_[A-Za-z0-9_]{1,40}$/.test(id)
}

/* ============================================================
 * 十三、图遍历与查询工具（纯函数，UI 与主进程共用）
 * ============================================================ */

/** 按 rootIds + children 深度优先拍平（保持显示顺序） */
export function flattenGraph(
  graph: TaskGraph,
  opts?: {
    isExpanded?: (nodeId: string) => boolean
    autoFoldDone?: boolean
    /**
     * 排除的层：被排除的节点不产出行，其子节点在同 depth 继续（用于面板投影剔除
     * goal 摘要节点，让 milestone 升为顶层）。默认不排除。
     */
    excludeLayers?: NodeLayer[]
    /** 是否保留 cancelled 节点（面板投影需要；默认 false 保持既有语义） */
    includeCancelled?: boolean
  },
): GraphRow[] {
  const rows: GraphRow[] = []
  const isExpanded = opts?.isExpanded ?? (() => false)
  const autoFoldDone = opts?.autoFoldDone ?? true
  const excludeLayers = opts?.excludeLayers ?? []
  const includeCancelled = opts?.includeCancelled ?? false

  const visibleChildren = (node: TaskNode): string[] =>
    node.children.filter(
      (c) => graph.nodes[c] && (includeCancelled || graph.nodes[c]?.status !== 'cancelled'),
    )

  const visit = (id: string, depth: number): void => {
    const node = graph.nodes[id]
    if (!node) return
    const children = visibleChildren(node)

    // 被排除层（如 goal）：不产出行，子节点在同 depth 继续
    if (excludeLayers.includes(node.layer)) {
      for (const child of children) visit(child, depth)
      return
    }

    const doneChildCount = children.filter((c) => graph.nodes[c]?.status === 'completed').length
    const pendingQuestions = node.status === 'needs_human' ? 1 : 0

    rows.push({
      id: node.id,
      key: node.key,
      layer: node.layer,
      depth,
      title: node.title,
      status: node.status,
      hasChildren: children.length > 0,
      childCount: children.length,
      doneChildCount,
      tokensUsed: node.tokensUsed || undefined,
      blockedBy:
        node.status === 'blocked'
          ? node.dependsOn.filter((d) => graph.nodes[d] && graph.nodes[d].status !== 'completed')
          : undefined,
      runningCommand:
        node.status === 'verifying'
          ? node.verification.command ??
            node.acceptance.find((a) => a.verify?.command)?.verify?.command
          : undefined,
      attemptsLabel:
        node.status === 'failed' && node.attempts >= node.verification.maxAttempts
          ? `尝试 ${node.attempts}/${node.verification.maxAttempts} 失败`
          : undefined,
      pendingQuestions: pendingQuestions || undefined,
      waitingMs: node.blockingSince ? Date.now() - node.blockingSince : undefined,
    })

    // 自动折叠：已完成的子树折叠为一行摘要。
    // 【硬要求】needs_human 与 failed 节点永不自动折叠（交互文档 §P1 边界交互）
    const neverFold = node.status === 'needs_human' || node.status === 'failed'
    const shouldExpand = neverFold || isExpanded(node.id) || (!autoFoldDone ? true : node.status !== 'completed')
    if (!shouldExpand) return
    for (const child of children) visit(child, depth + 1)
  }

  for (const rootId of graph.rootIds) visit(rootId, 0)
  return rows
}

/** 统计各状态数量 */
export function countStatuses(graph: TaskGraph): Record<NodeStatus, number> & { total: number } {
  const counts = Object.fromEntries(NODE_STATUSES.map((s) => [s, 0])) as Record<NodeStatus, number>
  let total = 0
  for (const node of Object.values(graph.nodes)) {
    counts[node.status] += 1
    total += 1
  }
  return { ...counts, total }
}

/**
 * 面板进度口径：分母不含 `layer === 'goal'`。
 *
 * goal 节点恒为 `ready`（系统设计 §10.4），不能计入分母，否则进度永远无法到达 100%。
 * `done = completed + cancelled`（取消同样视为「已结束」）。
 * 仅用于 `GraphSnapshot.progress`；`counts` 语义保持不变。
 */
export function progressCounts(graph: TaskGraph): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const node of Object.values(graph.nodes)) {
    if (node.layer === 'goal') continue
    total += 1
    if (node.status === 'completed' || node.status === 'cancelled') done += 1
  }
  return { done, total }
}

/** 汇总整图已消耗 token */
export function sumTokens(graph: TaskGraph): number {
  let sum = 0
  for (const node of Object.values(graph.nodes)) sum += node.tokensUsed || 0
  return sum
}

/** 当前 in_progress 节点（I1 保证 ≤ 1） */
export function findRunningNode(graph: TaskGraph): TaskNode | undefined {
  return Object.values(graph.nodes).find((n) => n.status === 'in_progress')
}

/** 全部 needs_human 节点，按阻塞时间升序（面板置顶区用） */
export function findBlockedNodes(graph: TaskGraph): TaskNode[] {
  return Object.values(graph.nodes)
    .filter((n) => n.status === 'needs_human')
    .sort((a, b) => (a.blockingSince ?? 0) - (b.blockingSince ?? 0))
}

/**
 * 由 dependsOn 推导并行 wave（依赖拓扑的可视化基础）。
 *
 * wave_0 = dependsOn 为空的节点；wave_n = 所有依赖都落在 wave_0..n-1 的节点。
 * 若存在环则返回 null（调用方应提示走 I4 修复，而不是渲染半张图）。
 */
export function computeWaves(graph: TaskGraph): string[][] | null {
  const ids = Object.keys(graph.nodes)
  const remaining = new Set(ids)
  const done = new Set<string>()
  const waves: string[][] = []
  let guard = 0

  while (remaining.size > 0) {
    if (++guard > ids.length + 1) return null // 环
    const wave = [...remaining].filter((id) =>
      (graph.nodes[id]?.dependsOn ?? []).every((d) => !remaining.has(d) || d === id),
    )
    if (wave.length === 0) return null // 环：无节点可归入本 wave
    // 保持 rootIds + children 顺序，避免渲染抖动
    const ordered = orderByTree(graph, wave)
    waves.push(ordered)
    for (const id of ordered) {
      remaining.delete(id)
      done.add(id)
    }
  }
  return waves
}

/** 把一组 id 按图的自然顺序（DFS 顺序）排序 */
function orderByTree(graph: TaskGraph, ids: string[]): string[] {
  const want = new Set(ids)
  const out: string[] = []
  const visit = (id: string): void => {
    if (want.has(id)) out.push(id)
    for (const c of graph.nodes[id]?.children ?? []) visit(c)
  }
  for (const root of graph.rootIds) visit(root)
  return out
}

/** 节点的所有后代（含自身） */
export function subtreeIds(graph: TaskGraph, rootId: string): string[] {
  const out: string[] = []
  const visit = (id: string): void => {
    out.push(id)
    for (const c of graph.nodes[id]?.children ?? []) visit(c)
  }
  visit(rootId)
  return out
}

/** 判断 a 是否是 b 的祖先（用于 I4 成环检测） */
export function isAncestor(graph: TaskGraph, a: string, b: string): boolean {
  let cur: string | null = graph.nodes[b]?.parentId ?? null
  while (cur) {
    if (cur === a) return true
    cur = graph.nodes[cur]?.parentId ?? null
  }
  return false
}
