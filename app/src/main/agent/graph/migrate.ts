/**
 * ArkWork — v0.29 `planItems` → v0.30 `TaskGraph` 迁移
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.3
 *
 * 三条设计原则（改动前先读）：
 *  1. **幂等**：已迁移（Task.graphId 存在且有 graph.json）时直接返回，重复执行无副作用。
 *  2. **纯函数**：`migrateToGraph` 不读盘、不写盘、不广播 —— 便于单测，且让"迁移"这件事
 *     在测试里可以对着真实的 v0.28.1 tasks.json 样本反复跑。
 *  3. **不丢信息**：v0.29 的 `PlanItemSource`（8 种来源标记）是"状态是谁改的"的留痕，
 *     迁移时映射进 `Revision.by` + `reason`，而不是当作无用字段丢掉
 *     （见 01-research.md §2.3 新增结论 N2）。
 *
 * 一个关键取舍：**迁移出的节点一律 `verification.required = false`**。
 * 理由：老任务的清单项从来没有"验收命令"的概念，若迁移时给它们设 required=true，
 * 用户下次打开任务会看到一堆节点卡在 verifying —— 这是"迁移制造的新问题"，
 * 不可接受。老节点走 `completed` + 一条 human 来源的合成证据。
 */
import {
  GRAPH_SCHEMA_VERSION,
  generateGraphId,
  generateNodeId,
  defaultPolicy,
  defaultVerification,
  type Evidence,
  type NodeStatus,
  type Revision,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import type { PlanItem, PlanItemSource, Task } from '@shared/types/task'

/** 迁移来源标记（写进每个节点的 derivedFrom，便于后续收敛检查识别"这是老数据"） */
export const MIGRATION_SOURCE = 'migrate:v0.29'

/** v0.29 六态 → v0.30 十一态 */
export function mapPlanItemStatusToNodeStatus(status: PlanItem['status']): NodeStatus {
  switch (status) {
    case 'done':
      return 'completed'
    case 'running':
      return 'in_progress'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'skipped':
      // 十一态里没有 skipped：设计稿 §4.1 的状态机也没有。
      // 语义上 skipped ≡ "主动不做"，与 cancelled 一致；原始语义写进 notes 保留。
      return 'cancelled'
    case 'pending':
    default:
      return 'ready' // 迁移后即可调度（老任务的 pending 项本来就是排队中）
  }
}

/** `PlanItemSource`（8 种）→ `Revision.by` + `reason` 的映射表（系统设计 §6.3） */
export function mapSourceToRevisionFields(source: PlanItemSource | undefined): {
  by: Revision['by']
  reason: string
} {
  switch (source) {
    case 'engine-decide':
      return { by: { kind: 'system' }, reason: '引擎推断：工具调用成功' }
    case 'engine-fail':
      return { by: { kind: 'system' }, reason: '引擎推断：执行失败' }
    case 'todo-update':
      return { by: { kind: 'agent', id: 'agent' }, reason: '模型显式写回' }
    case 'user-cancel':
      return { by: { kind: 'human', id: 'user' }, reason: '用户手动取消' }
    case 'user-retry':
      return { by: { kind: 'human', id: 'user' }, reason: '用户手动重试' }
    case 'user-mark-done':
      return { by: { kind: 'human', id: 'user' }, reason: '用户手动标完成' }
    case 'plan-regen':
      return { by: { kind: 'system' }, reason: '计划全量重新生成' }
    case 'plan-fallback':
      return { by: { kind: 'system' }, reason: '计划生成失败，降级为精简清单' }
    case 'continuation':
      return { by: { kind: 'agent', id: 'agent' }, reason: '续聊时引擎追加的承接项' }
    default:
      return { by: { kind: 'system' }, reason: '未标记来源（v0.29 缺省）' }
  }
}

/** 迁移输入 */
export interface MigrateInput {
  taskId: string
  /** 任务标题（graph.title） */
  title: string
  /** 目标陈述（graph.goal），通常取 task.input.text 的首行/摘要 */
  goal: string
  planItems: PlanItem[]
  /** 时间戳（便于单测注入固定值） */
  now?: number
  /** 复用已有 graphId（重跑迁移时用） */
  graphId?: string
}

/**
 * 迁移判定：该任务是否需要建图。
 *
 * 返回 false 的两种情况：
 *  - 已迁移（graphId 存在）—— 幂等
 *  - 无 planItems —— tier 0/1 轻量模式，**不建图**（F20）
 */
export function needsGraphMigration(task: Pick<Task, 'graphId' | 'planItems'>): boolean {
  if (task.graphId) return false
  return (task.planItems?.length ?? 0) > 0
}

/**
 * 把 v0.29 的扁平清单迁移成一棵最小可信的任务图。
 *
 * 结构：`goal` 节点（1 个） → 每个 planItem 一个 `task` 层节点（保序，key = T-01…）
 *
 * 幂等性说明：本函数是纯函数，调用方负责判定"是否已迁移"（用 needsGraphMigration）。
 *
 * @returns 迁移后的图；`planItems` 为空时返回 `null`（表示该任务走轻量模式，不该建图）
 */
export function migrateToGraph(input: MigrateInput): TaskGraph | null {
  const { taskId, title, goal, planItems } = input
  const now = input.now ?? Date.now()
  if (planItems.length === 0) return null

  const graphId = input.graphId ?? generateGraphId()
  const goalNodeId = generateNodeId()

  // ---- 1. 逐个 planItem → TaskNode ----
  const nodes: Record<string, TaskNode> = {}
  const childIds: string[] = []
  const revisions: Revision[] = []
  let seq = 1
  // I1 校正：v0.29 理论上只有一个 running，但历史数据可能因为 bug 有多个。
  // 只保留第一个为 in_progress，其余降级为 ready 并留痕（否则 I1 会拒绝加载整张图）。
  let sawRunning = false
  let correctedRunningCount = 0

  for (const [i, item] of planItems.entries()) {
    let status = mapPlanItemStatusToNodeStatus(item.status)
    let note: string | undefined
    if (status === 'in_progress') {
      if (sawRunning) {
        status = 'ready'
        correctedRunningCount += 1
        note = '迁移校正：v0.29 存在多个 running 项，本项已降级为 ready（不变量 I1）'
      } else {
        sawRunning = true
      }
    }
    if (item.status === 'skipped') {
      note = [note, '迁移自 v0.29 的 skipped（语义等同 cancelled）'].filter(Boolean).join('；')
    }

    // 合成证据：让 completed 节点满足 I2（至少一条充分证据）。
    // kind 用 'human'（可信度最高、语义最贴切："这是 v0.29 时代人为/引擎推进的结果"）
    const evidence: Evidence[] = []
    if (status === 'completed') {
      evidence.push({
        kind: 'human',
        summary: '迁移自 v0.29 已完成清单项（无原始验证证据）',
        at: item.completedAt ?? item.updatedAt ?? now,
        by: { kind: 'system' },
      })
    }

    const node: TaskNode = {
      id: generateNodeId(),
      key: `T-${String(i + 1).padStart(2, '0')}`,
      parentId: goalNodeId,
      layer: 'task',
      title: item.text.slice(0, 80),
      // I7：迁移节点没有 derivedFrom 的 AC（v0.29 无 AC 概念），用 intent 满足
      // v0.30.2 D13-F：intent 直接用原清单项文本 —— 此前的「迁移自 v0.29 清单项：」
      // 机器前缀会污染 UI（漂移告警渲染「（目的：迁移自…）」用户看不懂）与语义信号取词。
      intent: item.text,
      status,
      assignee: { kind: 'system' },
      priority: 'p1',
      children: [],
      dependsOn: [],
      derivedFrom: [MIGRATION_SOURCE],
      acceptance: [],
      evidence,
      // ★ 迁移节点一律 required=false（见文件头说明）
      verification: defaultVerification({ required: false, allowSelfAttest: false }),
      contextRefs: [],
      tokensUsed: 0,
      attempts: status === 'failed' ? 1 : 0,
      sessionIds: [],
      notes: note,
      createdAt: item.createdAt ?? now,
      updatedAt: item.updatedAt ?? now,
      revision: 1,
    }
    nodes[node.id] = node
    childIds.push(node.id)

    // 把 v0.29 的 source 留痕迁进 revisions（不丢信息）
    if (item.source) {
      const { by, reason } = mapSourceToRevisionFields(item.source)
      revisions.push({
        seq: seq++,
        at: item.updatedAt ?? now,
        by,
        op: 'status',
        targetId: node.id,
        after: { status },
        reason: `${reason}（v0.29 source=${item.source}）`,
      })
    }
  }

  // ---- 2. goal 节点 ----
  //
  // ★ status 取 'ready' 而不是 'in_progress'：I1 要求全局最多一个 in_progress，
  //   而这个位置必须留给"真正在做的那一项"。goal 节点的状态与图级 `status`
  //   是两件事 —— 图级 status 表达"整个任务在跑"，goal 节点只是这棵树的总结点。
  //   （该缺陷由 TC-SYNC-004 捕获：3 个 running 项 + goal 全标 in_progress 会让
  //   迁移产物直接违反 I1，导致图无法加载。）
  const goalNode: TaskNode = {
    id: goalNodeId,
    key: 'G-00',
    parentId: null,
    layer: 'goal',
    title: title.slice(0, 80) || '未命名任务',
    intent: goal.slice(0, 200) || title,
    status: 'ready',
    assignee: { kind: 'system' },
    priority: 'p0',
    children: childIds,
    dependsOn: [],
    acceptance: [],
    evidence: [],
    // goal 节点不设 verifying：它是个汇总节点，凭子节点完成
    verification: defaultVerification({ required: false }),
    contextRefs: [],
    tokensUsed: 0,
    attempts: 0,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
  nodes[goalNodeId] = goalNode

  // ---- 3. 迁移审计 ----
  revisions.push({
    seq: seq++,
    at: now,
    by: { kind: 'system' },
    op: 'migrate',
    targetId: graphId,
    after: { nodeCount: childIds.length + 1, correctedRunningCount },
    reason: `v0.28.x planItems（${planItems.length} 项）→ TaskGraph。taskId=${taskId}`,
  })

  const graph: TaskGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    id: graphId,
    title: title.slice(0, 80) || '未命名任务',
    goal: goal.slice(0, 200) || title,
    status: 'in_progress',
    graphRevision: 1,
    spec: {
      // 迁移出来的 spec 是 `none`：老任务没有验收契约，
      // 引擎不应凭迁移就认为"已经有 spec 了"（否则覆盖率检查会对空集合放行）
      state: 'none',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      acceptance: [],
      contextRefs: [],
    },
    nodes,
    rootIds: [goalNodeId],
    policy: defaultPolicy({
      // 迁移任务不强制 Plan 闸门（老任务已经在跑了，再弹一次闸门是骚扰）
      tier: 2,
      tierReason: '迁移自 v0.29（无 tier 判定，按既有清单规模取 T2）',
      requirePlanApproval: false,
    }),
    revisions,
    createdAt: now,
    updatedAt: now,
  }
  return graph
}

/**
 * 任务失败/取消时，把图中所有在途节点收敛到终态。
 *
 * 对应 v0.29 的 `markRunningPlanItemFailed` + `discardIncompletePlanItems`，
 * 但改为操作图（镜像由 saveGraph 自动重算）。
 *
 * @param graph   当前图（不修改入参）
 * @param outcome 'failed' 只处理在途节点；'cancelled' 同理，区别只在目标状态
 * @returns 变更后的图 + 被改动的节点 id 列表
 */
export function sealGraphAtTurnEnd(
  graph: TaskGraph,
  outcome: 'failed' | 'cancelled',
  reason: string,
): { graph: TaskGraph; changedIds: string[] } {
  const nodes: Record<string, TaskNode> = {}
  const changedIds: string[] = []
  const now = Date.now()

  for (const [id, node] of Object.entries(graph.nodes)) {
    const inFlight = node.status === 'in_progress' || node.status === 'verifying'
    const waiting = node.status === 'needs_human' || node.status === 'ready' || node.status === 'blocked'
    if (outcome === 'failed' ? inFlight : inFlight || waiting) {
      nodes[id] = {
        ...node,
        status: outcome,
        updatedAt: now,
        revision: node.revision + 1,
        lastError: outcome === 'failed' ? reason : node.lastError,
        notes: [node.notes, `任务${outcome === 'failed' ? '失败' : '取消'}：${reason}`]
          .filter(Boolean)
          .join('\n'),
        blockingQuestion: undefined,
        blockingOptions: undefined,
        blockingSince: undefined,
      }
      changedIds.push(id)
    } else {
      nodes[id] = node
    }
  }

  if (changedIds.length === 0) return { graph, changedIds }
  return {
    graph: { ...graph, nodes, status: outcome, updatedAt: now, graphRevision: graph.graphRevision + 1 },
    changedIds,
  }
}
