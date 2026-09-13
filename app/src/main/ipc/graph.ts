/**
 * ArkWork — IPC: TaskGraph 任务面板（v0.30.0 新增，13 个频道）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §5.1
 *       docs/versions/v0.30.0/03-interaction.md（页面 P1–P8 的交互契约）
 *
 * 统一约定：
 *  - 响应包络 `GraphResult<T>`：`{ ok, data }` / `{ ok, error }`。
 *    `error.hint` 是**写给人的修复指引**（与给模型的同源，来自 invariants.ts），
 *    渲染层直接显示它，不自己拼文案。
 *  - 所有写操作最终都走 `graph/gate.applyStatusChange` 或 `graph/replan.applyPatch`
 *    —— **不允许绕过不变量校验**。
 *  - 落盘统一走 `graph/sync.persist`（它负责快照 / 校验 / 原子写 / 重算 md 与镜像 / 广播）。
 *
 * 通道命名沿用既有习惯 `{domain}:{action}`，domain 用 `graph`。
 */
import { ipcMain } from 'electron'
import type {
  GraphAnswerPayload,
  GraphConvergePayload,
  GraphNodeCreatePayload,
  GraphNodeDeletePayload,
  GraphNodeUpdatePayload,
  GraphPlanDecisionPayload,
  GraphReplanDecisionPayload,
  GraphResult,
  GraphSetStatusPayload,
  GraphSnapshot,
  GraphUpdatePayload,
  MetricsSnapshot,
} from '@shared/types/ipc'
import type {
  AcceptanceCriterion,
  GraphWriteError,
  NodeChange,
  NodeStatus,
  PlanApproval,
  ReplanOp,
  ReplanPatch,
  TaskGraph,
  TaskNode,
  Tier,
} from '@shared/types/graph'
import { generateNodeId, defaultVerification, defaultPolicy, REPLAN_EVENT_LABEL } from '@shared/types/graph'
import { buildSnapshot, listSnapshots, parsePlanMarkdown, renderGraphMd, restoreSnapshot, getGraphMdPath } from '../agent/graph/store.js'
import { getGraphById, persist, putGraphCache, syncConverge } from '../agent/graph/sync.js'
import { applyStatusChange } from '../agent/graph/gate.js'
import { patchNode, updateNodeFields } from '../agent/graph/write.js'
import { applyPatch, buildPatch } from '../agent/graph/replan.js'
import { renderGraphErrorForModel } from '../agent/graph/invariants.js'
import { getMetricsSnapshot, recordMetric } from '../agent/graph/metrics.js'
import { getPendingPatch, listPendingPatches, markPatchDecided, decidePlanApproval, getPlanApproval, updatePlanApproval } from '../agent/graph/pending.js'
import { getTask, appendUserMessage } from '../store/tasks.js'
import { broadcastReActEvent } from '../agent/events.js'
import { logger } from '../system/logger.js'

/* ============================================================
 * 辅助
 * ============================================================ */

/** 成功响应 */
function ok<T>(data: T): GraphResult<T> {
  return { ok: true, data }
}

/** 失败响应（结构化错误） */
function fail(error: GraphWriteError): GraphResult<never> {
  return { ok: false, error }
}

/** 构造一个通用错误 */
function err(
  code: GraphWriteError['code'],
  message: string,
  hint: string,
  violatedBy?: GraphWriteError['violatedBy'],
): GraphWriteError {
  return { code, message, hint, violatedBy }
}

/** 取任务与图；任一步失败返回错误响应 */
async function load(
  taskId: string,
): Promise<{ task: NonNullable<Awaited<ReturnType<typeof getTask>>>; graph: TaskGraph } | GraphWriteError> {
  const task = await getTask(taskId)
  if (!task) {
    return err('NOT_FOUND', `任务不存在：${taskId}`, '任务可能已被删除，请刷新任务列表。')
  }
  if (!task.graphId) {
    return err(
      'NOT_FOUND',
      '该任务没有任务图',
      '该任务处于轻量模式（Tier 0/1），没有任务图可操作。轻量任务只在对话区显示内联清单。',
    )
  }
  const graph = await getGraphById(task.graphId)
  if (!graph) {
    return err(
      'SCHEMA_INVALID',
      `任务图加载失败：${task.graphId}`,
      'graph.json 可能被外部编辑器破坏。请用「恢复上次可用快照」入口，或以只读模式打开。',
    )
  }
  return { task, graph }
}

/** 判断 load 的返回是错误还是成功 */
function isErr(v: unknown): v is GraphWriteError {
  return !!v && typeof v === 'object' && 'code' in (v as Record<string, unknown>) && 'hint' in (v as Record<string, unknown>)
}

/** commit 的可选项 */
interface CommitOptions {
  reason?: string
  source?: string
  /** 增量行变更（用于 graph_patch 广播） */
  changes?: NodeChange[]
  /** 图内已自行写过 Revision 时置 true，避免重复追加 */
  skipRevision?: boolean
}

/** 写完之后统一：落盘 + 广播 + 回快照 */
async function commit(
  taskId: string,
  graph: TaskGraph,
  opts: CommitOptions = {},
): Promise<GraphResult<GraphSnapshot>> {
  const saved = await persist(
    { taskId, graphId: graph.id, iteration: 0 },
    graph,
    {
      changes: opts.changes,
      reason: opts.reason,
      source: opts.source ?? 'ipc',
      ...(opts.skipRevision ? { skipRevision: true } : {}),
    } as Parameters<typeof persist>[2],
  )
  return ok(buildSnapshot(saved, taskId))
}

/**
 * 生成下一个人类可读 key（T-01…）。
 *
 * 与 `graph/tools.ts` 的同名工具保持一致的口径（`T-` / `G-` 前缀统一编号），
 * 但**不共用函数** —— tools.ts 属于 Agent 侧，本文件属于人机交互侧，
 * 两者共享同一编号空间靠的是"都扫描全图现有 key"，不是共享代码。
 */
function nextKey(graph: TaskGraph): string {
  let max = 0
  for (const node of Object.values(graph.nodes)) {
    const m = /^[TG]-(\d+)$/.exec(node.key ?? '')
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `T-${String(max + 1).padStart(2, '0')}`
}

/* ============================================================
 * P8 · 计划闸门辅助
 * ============================================================ */

/** 广播计划闸门增量（对话流内联卡 `PlanApprovalCard` 订阅 `graph:update` kind='plan'） */
function broadcastPlanGate(taskId: string, plan: PlanApproval): void {
  broadcastReActEvent({ type: 'graph_plan_gate', taskId, graphId: plan.graphId ?? '', plan })
}

/** 覆盖率检查：未被任何节点覆盖的 AC id 列表（设计稿 §5.1 / I7） */
function uncoveredAcs(graph: TaskGraph): string[] {
  return graph.spec.acceptance.filter((ac) => ac.coveredBy.length === 0).map((ac) => ac.id)
}

/**
 * P8「编辑为 Markdown」出口：把反向解析出的**安全子集**合并回图。
 *
 * 只覆盖 goal / scopeIn / scopeOut / Spec 层 AC 的 statement 与 verify.command；
 * `coveredBy` / `status` / `type` / 审计字段一律以 graph.json 原值为准 ——
 * 这正是"反向解析不是双向编辑器"的边界（02-prd.md Scope Out 9）。
 */
function mergeParsedPlan(
  graph: TaskGraph,
  parsed: {
    goal?: string
    scopeIn?: string[]
    scopeOut?: string[]
    acceptance?: { id: string; statement: string; verifyCommand?: string }[]
  },
): TaskGraph {
  const acceptance: AcceptanceCriterion[] = graph.spec.acceptance.map((ac) => {
    const edited = parsed.acceptance?.find((a) => a.id === ac.id)
    if (!edited) return ac
    return {
      ...ac,
      statement: edited.statement,
      verify: edited.verifyCommand ? { ...ac.verify, command: edited.verifyCommand } : ac.verify,
    }
  })
  return {
    ...graph,
    goal: parsed.goal ?? graph.goal,
    spec: {
      ...graph.spec,
      scopeIn: parsed.scopeIn ?? graph.spec.scopeIn,
      scopeOut: parsed.scopeOut ?? graph.spec.scopeOut,
      acceptance,
    },
    updatedAt: Date.now(),
  }
}

/* ============================================================
 * 注册
 * ============================================================ */

export function registerGraphHandlers(): void {
  /* ------------------------------------------------------------
   * 读：完整图 / 面板快照 / 指标
   * ---------------------------------------------------------- */

  ipcMain.handle('graph:get', async (_e, taskId: string): Promise<GraphResult<TaskGraph | null>> => {
    const task = await getTask(taskId)
    if (!task) return fail(err('NOT_FOUND', `任务不存在：${taskId}`, '请刷新任务列表。'))
    if (!task.graphId) return ok(null) // 轻量模式：不是错误，是"没有图"
    const graph = await getGraphById(task.graphId)
    if (!graph) {
      return fail(
        err(
          'SCHEMA_INVALID',
          `任务图加载失败：${task.graphId}`,
          'graph.json 可能已损坏。请用「恢复上次可用快照」入口。',
        ),
      )
    }
    return ok(graph)
  })

  ipcMain.handle('graph:snapshot', async (_e, taskId: string): Promise<GraphResult<GraphSnapshot | null>> => {
    const task = await getTask(taskId)
    if (!task) return fail(err('NOT_FOUND', `任务不存在：${taskId}`, '请刷新任务列表。'))
    if (!task.graphId) return ok(null)
    const graph = await getGraphById(task.graphId)
    if (!graph) return ok(null) // 交由渲染层显示"图损坏"降级态（F20）
    return ok(buildSnapshot(graph, taskId))
  })

  ipcMain.handle('graph:metrics', async (): Promise<MetricsSnapshot> => getMetricsSnapshot())

  /* ------------------------------------------------------------
   * 写：节点字段 / 新建 / 删除 / 状态 / 回答 / 决定 / 收敛 / tier / 导出
   * ---------------------------------------------------------- */

  ipcMain.handle('graph:update-node', async (_e, p: GraphNodeUpdatePayload): Promise<GraphResult<GraphSnapshot>> => {
    const loaded = await load(p.taskId)
    if (isErr(loaded)) return fail(loaded)
    const { graph } = loaded
    if (!graph.nodes[p.nodeId]) {
      return fail(err('NOT_FOUND', `节点不存在：${p.nodeId}`, '图可能已被其他操作修改，请刷新面板。'))
    }
    // notes 是追加语义（新内容接在旧内容后），其余字段覆盖
    const patch = { ...p.patch }
    if (typeof patch.notes === 'string') {
      patch.notes = [graph.nodes[p.nodeId].notes, patch.notes].filter(Boolean).join('\n')
    }
    const next = updateNodeFields(graph, p.nodeId, patch)
    recordMetric('sync_action', { op: 'ipc-update-node' })
    return commit(p.taskId, next, { reason: '用户编辑节点', source: 'ipc-update-node' })
  })

  ipcMain.handle('graph:create-node', async (_e, p: GraphNodeCreatePayload): Promise<GraphResult<GraphSnapshot>> => {
    const loaded = await load(p.taskId)
    if (isErr(loaded)) return fail(loaded)
    const { graph } = loaded
    const title = p.title?.trim()
    if (!title) {
      return fail(err('SCHEMA_INVALID', '标题不能为空', '请填写节点标题（≤80 字的动宾短语）。'))
    }
    const parentId = p.parentId ?? null
    if (parentId && !graph.nodes[parentId]) {
      return fail(err('NOT_FOUND', `父节点不存在：${parentId}`, '请刷新面板后重试。'))
    }
    const node: TaskNode = {
      id: generateNodeId(),
      key: nextKey(graph),
      parentId,
      layer: p.layer ?? 'task',
      title: title.slice(0, 80),
      intent: p.intent,
      // 人手写的任务：I7 用它满足"有来路"
      derivedFrom: ['manual:user'],
      status: 'ready',
      assignee: { kind: 'human', id: 'user' },
      priority: 'p1',
      children: [],
      dependsOn: [],
      acceptance: [],
      evidence: [],
      verification: defaultVerification({ required: false }),
      contextRefs: [],
      tokensUsed: 0,
      attempts: 0,
      sessionIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    }
    const op: ReplanOp = { op: 'add', node, after: p.after }
    const built = buildPatch(graph, {
      triggerEvent: 'E5',
      reason: `用户在面板上追加任务：${node.title}`,
      ops: [op],
      by: { kind: 'human', id: 'user' },
    })
    if (!built.patch) return fail(built.error!)
    const res = applyPatch(graph, built.patch, true)
    if (res.error) return fail(res.error)
    recordMetric('sync_action', { op: 'ipc-create-node' })
    return commit(p.taskId, res.graph, {
      reason: built.patch.reason,
      source: 'ipc-create-node',
      changes: res.changes,
    })
  })

  ipcMain.handle('graph:delete-node', async (_e, p: GraphNodeDeletePayload): Promise<GraphResult<GraphSnapshot>> => {
    const loaded = await load(p.taskId)
    if (isErr(loaded)) return fail(loaded)
    const { graph } = loaded
    if (!graph.nodes[p.nodeId]) {
      return fail(err('NOT_FOUND', `节点不存在：${p.nodeId}`, '请刷新面板后重试。'))
    }
    if (!p.reason?.trim()) {
      return fail(
        err(
          'FORBIDDEN',
          '删除节点必须填写原因',
          '图内删除不等于"取消"——请说明为什么这个节点不再需要（会记入修订历史，供后续追溯）。',
        ),
      )
    }
    const built = buildPatch(graph, {
      triggerEvent: 'E5',
      reason: p.reason.trim(),
      ops: [{ op: 'remove', id: p.nodeId, reason: p.reason.trim() }],
      by: { kind: 'human', id: 'user' },
    })
    if (!built.patch) return fail(built.error!)
    // 人手删除视同已批准（本人在操作）
    const res = applyPatch(graph, built.patch, true)
    if (res.error) return fail(res.error)
    recordMetric('sync_action', { op: 'ipc-delete-node' })
    return commit(p.taskId, res.graph, {
      reason: built.patch.reason,
      source: 'ipc-delete-node',
      changes: res.changes,
    })
  })

  ipcMain.handle('graph:set-status', async (_e, p: GraphSetStatusPayload): Promise<GraphResult<GraphSnapshot>> => {
    const loaded = await load(p.taskId)
    if (isErr(loaded)) return fail(loaded)
    const { graph } = loaded
    const node = graph.nodes[p.nodeId]
    if (!node) return fail(err('NOT_FOUND', `节点不存在：${p.nodeId}`, '请刷新面板后重试。'))

    if (p.force) {
      // 强制改状态：绕过不变量，但必须写 reason（设计稿 §④ Override 的"二次确认 + 记 revisions"）
      if (!p.reason?.trim()) {
        return fail(
          err(
            'FORBIDDEN',
            '强制改状态必须填写原因',
            '强制跳转绕过了不变量校验（I1–I7），必须留下理由，否则后续没人能解释这个状态是怎么来的。',
          ),
        )
      }
      const next = patchNode(graph, p.nodeId, (n) => ({
        ...n,
        status: p.status as NodeStatus,
        revision: n.revision + 1,
      }))
      recordMetric('sync_action', { op: 'ipc-force-status' })
      logger.warn('Agent', `graph: 用户强制改状态 ${p.nodeId} → ${p.status}（${p.reason}）`, p.taskId)
      return commit(p.taskId, next, {
        reason: `强制改状态：${node.status} → ${p.status}（${p.reason.trim()}）`,
        source: 'ipc-force-status',
        changes: [{ nodeId: p.nodeId, from: node.status, to: p.status, source: 'user-force', reason: p.reason.trim() }],
      })
    }

    const res = applyStatusChange(graph, p.nodeId, p.status, 'user', graph)
    if (res.error) {
      // I2 被降级时不是错误，但要让用户知道
      return fail(res.error)
    }
    recordMetric('sync_action', { op: 'ipc-set-status' })
    return commit(p.taskId, res.graph, {
      reason: p.reason ?? '用户在面板上修改状态',
      source: 'ipc-set-status',
      changes: [
        { nodeId: p.nodeId, from: node.status, to: res.graph.nodes[p.nodeId].status, source: 'user', reason: p.reason },
      ],
    })
  })

  ipcMain.handle('graph:answer-block', async (_e, p: GraphAnswerPayload): Promise<GraphResult<GraphSnapshot>> => {
    const loaded = await load(p.taskId)
    if (isErr(loaded)) return fail(loaded)
    const { graph } = loaded
    const node = graph.nodes[p.nodeId]
    if (!node) return fail(err('NOT_FOUND', `节点不存在：${p.nodeId}`, '请刷新面板后重试。'))
    if (node.status !== 'needs_human') {
      return fail(
        err(
          'TRANSITION_DENIED',
          `节点当前状态是 ${node.status}，不是 needs_human`,
          '它可能已被回答过（面板会实时刷新）。请刷新后再看。',
        ),
      )
    }

    if (p.action === 'cancel-all') {
      // 取消整个任务：所有未完成节点 → cancelled
      let next = graph
      const changes: { nodeId: string; from: NodeStatus; to: NodeStatus; source: string; reason?: string }[] = []
      for (const n of Object.values(graph.nodes)) {
        if (n.status === 'completed' || n.status === 'cancelled') continue
        const r = applyStatusChange(next, n.id, 'cancelled', 'user', graph)
        if (!r.error) {
          next = r.graph
          changes.push({ nodeId: n.id, from: n.status, to: 'cancelled', source: 'user', reason: '用户取消整个任务' })
        }
      }
      return commit(p.taskId, { ...next, status: 'cancelled' }, {
        reason: '用户取消整个任务',
        source: 'ipc-cancel-all',
        changes,
      })
    }

    // submit / skip：写 notes + 补 evidence(human) → 回 ready
    const answerText =
      p.action === 'skip'
        ? '（用户选择跳过此项，先推进其它任务）'
        : (p.answer?.trim() || '（用户未填写具体答案）')
    let next = patchNode(graph, p.nodeId, (n) => ({
      ...n,
      notes: [n.notes, `用户回答：${answerText}`, p.note ? `补充说明：${p.note}` : '']
        .filter(Boolean)
        .join('\n'),
      evidence:
        p.action === 'submit'
          ? [
              ...n.evidence,
              {
                kind: 'human' as const,
                summary: `人工决策：${answerText.slice(0, 120)}`,
                at: Date.now(),
                by: { kind: 'human' as const, id: 'user' },
              },
            ]
          : n.evidence,
      // 清掉阻塞字段（I6 只要求 needs_human 时存在）
      blockingQuestion: undefined,
      blockingOptions: undefined,
      blockingSince: undefined,
      revision: n.revision + 1,
    }))
    const res = applyStatusChange(next, p.nodeId, 'ready', 'user', graph)
    if (res.error) return fail(res.error)
    next = res.graph
    recordMetric('sync_action', { op: 'ipc-answer-block' })
    return commit(p.taskId, next, {
      reason: p.action === 'skip' ? '用户跳过该项' : '用户回答待答问题',
      source: 'ipc-answer-block',
      changes: [{ nodeId: p.nodeId, from: 'needs_human', to: 'ready', source: 'user-human' }],
    })
  })

  ipcMain.handle(
    'graph:decide-replan',
    async (_e, p: GraphReplanDecisionPayload): Promise<GraphResult<GraphSnapshot>> => {
      const loaded = await load(p.taskId)
      if (isErr(loaded)) return fail(loaded)
      const { graph } = loaded
      const patch = getPendingPatch(graph.id, p.patchId)
      if (!patch) {
        return fail(
          err(
            'NOT_FOUND',
            '该计划变更已不存在',
            '待批准的补丁是瞬时状态，重启后需要 Agent 重新发起。若面板仍显示该卡片，请刷新。',
          ),
        )
      }
      if (patch.state !== 'pending') {
        return fail(err('CONFLICT', `该补丁已处理（${patch.state}）`, '刷新面板即可看到最新状态。'))
      }

      if (p.decision === 'reject') {
        markPatchDecided(graph.id, p.patchId, 'rejected', p.userNote)
        recordMetric('sync_action', { op: 'ipc-reject-replan' })
        logger.info('Agent', `replan: 用户拒绝补丁 ${p.patchId}（${p.userNote ?? '未说明'}）`, p.taskId)
        // 广播让面板重拉 pendingPatches（onUpdate 收到任意 kind 都会 load(true)）
        broadcastReActEvent({
          type: 'graph_notice',
          taskId: p.taskId,
          graphId: graph.id,
          notice: {
            kind: 'replan',
            severity: 'info',
            text: `计划变更已打回（${patch.ops.length} 项变更未应用）`,
            refId: patch.id,
            dismissible: true,
          },
          patchId: patch.id,
        })
        return ok(buildSnapshot(graph, p.taskId))
      }
      // edit：语义 =「打回并附修改意见」（真正的在线编辑补丁属 Scope Out S2）。
      // 与 reject 的区别：edit 必须携带 userNote，写入 Revision.reason 并把意见注入
      // 对话流，驱动 Agent 据此重新生成补丁。
      if (p.decision === 'edit') {
        const note = (p.userNote ?? '').trim()
        if (!note) {
          return fail(
            err(
              'SCHEMA_INVALID',
              '修改意见为空',
              '「打回并附修改意见」需要填写你希望怎样调整这次计划变更。',
            ),
          )
        }
        const next: TaskGraph = {
          ...graph,
          updatedAt: Date.now(),
          revisions: [
            ...graph.revisions,
            {
              seq: (graph.revisions.at(-1)?.seq ?? 0) + 1,
              at: Date.now(),
              by: { kind: 'human', id: 'user' },
              op: 'update',
              targetId: graph.id,
              before: { patchId: patch.id, patchState: patch.state },
              after: { patchDecision: 'rejected', rework: true },
              reason: `user-rework-replan: ${note}`,
            },
          ],
        }
        markPatchDecided(graph.id, p.patchId, 'rejected', note)
        recordMetric('sync_action', { op: 'ipc-rework-replan' })
        logger.info('Agent', `replan: 用户打回并附修改意见 ${p.patchId}（${note.slice(0, 40)}）`, p.taskId)
        const out = await commit(p.taskId, next, {
          reason: `用户打回计划变更并附修改意见：${note}`,
          source: 'ipc-rework-replan',
          skipRevision: true,
        })
        broadcastReActEvent({
          type: 'graph_notice',
          taskId: p.taskId,
          graphId: graph.id,
          notice: {
            kind: 'replan',
            severity: 'warn',
            text: '计划变更已打回，已把你的意见交给 Agent 重新规划',
            refId: patch.id,
            dismissible: true,
          },
          patchId: patch.id,
        })
        // 意见作为 user message 注入 → appendUserMessage 内部重启 ReAct，Agent 重新规划
        await appendUserMessage(
          p.taskId,
          `我打回了你提交的计划变更（补丁 ${patch.id}），请据此重新规划。\n\n我的意见：${note}`,
        )
        return out
      }

      // accept：应用（带批准）
      const res = applyPatch(graph, patch, true)
      if (res.error) {
        markPatchDecided(graph.id, p.patchId, 'rolled-back', p.userNote)
        return fail(res.error)
      }
      markPatchDecided(graph.id, p.patchId, 'applied', p.userNote)
      recordMetric('sync_action', { op: 'ipc-accept-replan' })
      const out = await commit(p.taskId, res.graph, {
        reason: patch.reason,
        source: 'replan',
        changes: res.changes,
      })
      broadcastReActEvent({
        type: 'graph_notice',
        taskId: p.taskId,
        graphId: graph.id,
        notice: {
          kind: 'auto-applied',
          severity: 'success',
          text: `计划已更新（${patch.ops.length} 项变更）`,
          refId: patch.id,
          dismissible: true,
        },
        patchId: patch.id,
      })
      return out
    },
  )

  ipcMain.handle(
    'graph:resolve-converge',
    async (_e, p: GraphConvergePayload): Promise<GraphResult<GraphSnapshot>> => {
      const loaded = await load(p.taskId)
      if (isErr(loaded)) return fail(loaded)
      const { graph } = loaded
      const report = graph.spec.driftReport

      if (p.action === 'dismiss') {
        // 忽略并标记已审：把报告从 spec 上摘掉（不再作为通知条出现），保留在 revisions 里
        const next: TaskGraph = { ...graph, spec: { ...graph.spec, driftReport: undefined }, updatedAt: Date.now() }
        recordMetric('sync_action', { op: 'ipc-dismiss-converge' })
        return commit(p.taskId, next, { reason: '用户忽略本次收敛发现并标记已审', source: 'ipc-dismiss-converge' })
      }
      if (!report || report.unmodeledWork.length === 0) {
        return fail(
          err('NOT_FOUND', '没有可加入的收敛发现', '本次收敛没有发现未建模的工作（或已被处理）。'),
        )
      }

      const picked =
        p.action === 'accept-all'
          ? report.unmodeledWork
          : report.unmodeledWork.filter((_, i) => (p.indices ?? []).includes(i))
      if (picked.length === 0) {
        return fail(err('SCHEMA_INVALID', '未选择任何条目', '请至少勾选一条要加入任务图的未建模工作。'))
      }

      // 批量追加（走一次 ReplanPatch：仅追加 → 第 1 级自动应用）
      const ops: ReplanOp[] = picked.map((w) => ({
        op: 'add',
        node: {
          id: generateNodeId(),
          key: undefined,
          parentId: graph.rootIds[0] ?? null,
          layer: 'task',
          title: (w.suggestedTask.title ?? w.description).slice(0, 80),
          intent: w.suggestedTask.intent ?? '收敛检查发现的未建模工作',
          derivedFrom: ['converge'],
          status: 'ready',
          assignee: { kind: 'agent', id: 'agent' },
          priority: 'p2',
          children: [],
          dependsOn: [],
          acceptance: [],
          evidence: [],
          verification: defaultVerification({ required: false }),
          contextRefs: w.suggestedTask.contextRefs ?? [],
          tokensUsed: 0,
          attempts: 0,
          sessionIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: 1,
        } as TaskNode,
      }))
      const built = buildPatch(graph, {
        triggerEvent: 'E9',
        reason: `收敛检查发现 ${picked.length} 项未建模工作，用户确认加入任务图`,
        ops,
        by: { kind: 'human', id: 'user' },
      })
      if (!built.patch) return fail(built.error!)
      const res = applyPatch(graph, built.patch, true)
      if (res.error) return fail(res.error)
      // 加入后把报告标为已处理（保留 invalidAssumptions 供 Spec 修订流程用）
      const next: TaskGraph = {
        ...res.graph,
        spec: {
          ...res.graph.spec,
          driftReport: { ...report, unmodeledWork: [], appendedTaskIds: ops.map((o) => (o.op === 'add' ? o.node.id : '')) },
        },
      }
      recordMetric('sync_action', { op: 'ipc-accept-converge', count: picked.length })
      return commit(p.taskId, next, {
        reason: built.patch.reason,
        source: 'ipc-accept-converge',
        changes: res.changes,
      })
    },
  )

  ipcMain.handle(
    'graph:set-tier',
    async (_e, p: { taskId: string; tier: Tier }): Promise<GraphResult<GraphSnapshot>> => {
      const loaded = await load(p.taskId)
      if (isErr(loaded)) return fail(loaded)
      const { graph } = loaded
      const from = graph.policy.tier
      if (from === p.tier) return ok(buildSnapshot(graph, p.taskId))

      // 启发性兜底：用户把 tier 降到 0/1 但图里已有多个节点时给提示（不阻断）
      const nodeCount = Object.values(graph.nodes).filter((n) => n.layer !== 'goal').length
      const warning =
        p.tier <= 1 && nodeCount >= 5
          ? `注意：当前图有 ${nodeCount} 个节点，降到 T${p.tier} 表示"轻量模式"，但已建成的图不会自动删除。`
          : undefined

      const next: TaskGraph = {
        ...graph,
        policy: { ...graph.policy, tier: p.tier, tierReason: '用户手动覆盖' },
        updatedAt: Date.now(),
        revisions: [
          ...graph.revisions,
          {
            seq: (graph.revisions.at(-1)?.seq ?? 0) + 1,
            at: Date.now(),
            by: { kind: 'human', id: 'user' },
            op: 'update',
            targetId: graph.id,
            before: { tier: from },
            after: { tier: p.tier },
            // 用户的显式覆盖记入 revisions —— 作为后续模型判定的 few-shot（设计稿 §6.1）
            reason: `用户覆盖复杂度分级 T${from} → T${p.tier}`,
          },
        ],
      }
      recordMetric('tier_decided', { tier: p.tier, source: 'user-override' })
      const out = await commit(p.taskId, next, {
        reason: `用户覆盖复杂度分级 T${from} → T${p.tier}`,
        source: 'ipc-set-tier',
        skipRevision: true,
      })
      if (warning && out.ok) {
        broadcastReActEvent({
          type: 'graph_notice',
          taskId: p.taskId,
          graphId: graph.id,
          notice: { kind: 'auto-applied', severity: 'info', text: warning, dismissible: true },
        })
      }
      return out
    },
  )

  ipcMain.handle(
    'graph:export-md',
    async (_e, taskId: string): Promise<GraphResult<{ path: string }>> => {
      const loaded = await load(taskId)
      if (isErr(loaded)) return fail(loaded)
      const { graph } = loaded
      // graph.md 在每次 saveGraph 时已重算；这里只保证内容最新并回路径
      try {
        const { writeFile, mkdir } = await import('node:fs/promises')
        const { dirname } = await import('node:path')
        // D7：图可能只在缓存里（尚未 saveGraph 落盘），specs 目录不存在时
        // 直接 writeFile 会 ENOENT —— 先递归建目录再写。
        await mkdir(dirname(getGraphMdPath(graph.id)), { recursive: true })
        await writeFile(getGraphMdPath(graph.id), renderGraphMd(graph), 'utf-8')
      } catch (e) {
        return fail(
          err('IO_ERROR', `写出 graph.md 失败：${(e as Error).message}`, '请检查工作区目录的写权限后重试。'),
        )
      }
      return ok({ path: getGraphMdPath(graph.id) })
    },
  )

  ipcMain.handle(
    'graph:restore-snapshot',
    async (_e, p: { taskId: string; stamp: string }): Promise<GraphResult<GraphSnapshot>> => {
      const loaded = await load(p.taskId)
      if (isErr(loaded)) return fail(loaded)
      const { graph } = loaded
      const stamps = await listSnapshots(graph.id)
      if (stamps.length === 0) {
        return fail(
          err(
            'NOT_FOUND',
            '没有可用快照',
            '本图还没有写入过快照（快照在每次写入前自动生成）。可以删除 graph.json 让引擎按当前清单重建。',
          ),
        )
      }
      const restored = await restoreSnapshot(graph.id, p.stamp)
      if (!restored) {
        return fail(
          err(
            'SCHEMA_INVALID',
            `快照 ${p.stamp} 不可用（已损坏或校验失败）`,
            `可用快照：${stamps.join(', ')}。请换一个时间点重试。`,
          ),
        )
      }
      putGraphCache(restored)
      recordMetric('sync_action', { op: 'ipc-restore-snapshot' })
      return ok(buildSnapshot(restored, p.taskId))
    },
  )

  /* ------------------------------------------------------------
   * 收敛检查（用户主动触发）
   * ---------------------------------------------------------- */
  ipcMain.handle(
    'graph:run-converge',
    async (_e, taskId: string): Promise<GraphResult<GraphSnapshot>> => {
      const loaded = await load(taskId)
      if (isErr(loaded)) return fail(loaded)
      const res = await syncConverge({ taskId, graphId: loaded.graph.id, iteration: 0 }, { deep: true })
      const graph = res.graph ?? loaded.graph
      return ok(buildSnapshot(graph, taskId))
    },
  )

  /* ------------------------------------------------------------
   * 待决补丁快照（面板刷新时用）
   * ---------------------------------------------------------- */
  ipcMain.handle('graph:pending-patches', async (_e, taskId: string): Promise<ReplanPatch[]> => {
    const task = await getTask(taskId)
    if (!task?.graphId) return []
    return listPendingPatches(task.graphId)
  })

  /* ------------------------------------------------------------
   * P8 · 计划闸门（Plan Approval）—— 对话流内联卡
   *
   * 三个出口（交互文档 §P8）：
   *  - approve：`spec.state='approved'` + `frozenTests` 快照（I3 生效）→ 放行执行；
   *  - reject ：追加 `Revision(reason='user-rejected')` + 把意见作为 user 消息注入 → Planner 重规划；
   *  - edit   ：graph.md 反向解析 + schema 校验，通过则合并进 spec（仍待批准）。
   * ---------------------------------------------------------- */

  ipcMain.handle('graph:pending-plan', async (_e, taskId: string): Promise<PlanApproval | null> => {
    const plan = getPlanApproval(taskId)
    if (!plan) return null
    // 有图时以图为准重算覆盖率 —— 节点/AC 可能在上一次读取后变化，
    // 「批准执行」的禁用判定必须与当前图一致（I7）。
    const graph = plan.graphId ? await getGraphById(plan.graphId) : null
    return graph ? { ...plan, uncovered: uncoveredAcs(graph) } : plan
  })

  ipcMain.handle(
    'graph:decide-plan',
    async (_e, p: GraphPlanDecisionPayload): Promise<GraphResult<GraphSnapshot | null>> => {
      const plan = getPlanApproval(p.taskId)
      if (!plan) {
        return fail(
          err(
            'NOT_FOUND',
            '该计划闸门已不存在',
            '计划闸门是瞬时状态，重启后需要 Agent 重新发起。若卡片仍显示，请刷新任务。',
          ),
        )
      }
      if (plan.state !== 'pending') {
        return fail(
          err('CONFLICT', `该计划闸门当前不可决策（${plan.state}）`, '刷新任务即可看到最新状态。'),
        )
      }

      /* ---- 出口 1：打回并说明 ---- */
      if (p.decision === 'reject') {
        const note = (p.userNote ?? '').trim()
        if (!note) {
          return fail(
            err('SCHEMA_INVALID', '打回必须填写说明', '请说明哪些地方需要重新规划 —— Planner 会据此重来。'),
          )
        }
        const task = await getTask(p.taskId)
        let out: GraphResult<GraphSnapshot | null> = ok(null)
        if (task?.graphId) {
          const graph = await getGraphById(task.graphId)
          if (graph) {
            // 「打回」不新增第 12 个 NodeStatus，只留一条审计记录（系统设计 §4.4 / V4）
            const next: TaskGraph = {
              ...graph,
              updatedAt: Date.now(),
              revisions: [
                ...graph.revisions,
                {
                  seq: (graph.revisions.at(-1)?.seq ?? 0) + 1,
                  at: Date.now(),
                  by: { kind: 'human', id: 'user' },
                  op: 'update',
                  targetId: graph.id,
                  before: { specState: graph.spec.state },
                  after: { planApproval: 'rejected' },
                  reason: 'user-rejected',
                },
              ],
            }
            out = await commit(p.taskId, next, {
              reason: `用户打回计划：${note}`,
              source: 'ipc-reject-plan',
              skipRevision: true,
            })
          }
        }
        decidePlanApproval(p.taskId, 'rejected', note)
        broadcastPlanGate(p.taskId, getPlanApproval(p.taskId)!)
        recordMetric('sync_action', { op: 'plan-rejected' })
        logger.info('Agent', `P8: 用户打回计划（${note.slice(0, 40)}）`, p.taskId)
        // 意见作为 user message 注入 → appendUserMessage 内部重启 ReAct，Planner 重新规划
        await appendUserMessage(p.taskId, `我打回了你的计划，请据此重新规划。\n\n我的意见：${note}`)
        return out
      }

      /* ---- 出口 2：编辑为 Markdown ---- */
      if (p.decision === 'edit') {
        const md = (p.markdown ?? '').trim()
        if (!md) {
          return fail(err('SCHEMA_INVALID', 'Markdown 内容为空', '请提交修改后的计划 Markdown。'))
        }
        const loaded = await load(p.taskId)
        if (isErr(loaded)) return fail(loaded)
        const { graph } = loaded
        // 反向解析 + schema 校验：失败则**拒绝合并** + 高亮字段 + 保留原 JSON
        //（Cursor 2.2「静默写坏结构化产物」血案的直接对策：宁拒绝，不猜测）
        const parsed = parsePlanMarkdown(md)
        if (!parsed.ok) return fail(parsed.error)
        const next = mergeParsedPlan(graph, parsed.data)
        const out = await commit(p.taskId, next, {
          reason: '用户编辑计划 Markdown 并合并',
          source: 'ipc-edit-plan',
        })
        // 编辑后仍**待批准**：以新图重算覆盖率，决定「批准执行」是否禁用
        updatePlanApproval(p.taskId, { uncovered: uncoveredAcs(next) })
        broadcastPlanGate(p.taskId, getPlanApproval(p.taskId)!)
        recordMetric('sync_action', { op: 'plan-edited' })
        return out
      }

      /* ---- 出口 3（主）：批准执行 ---- */
      const loaded = await load(p.taskId)
      if (isErr(loaded)) return fail(loaded)
      const { graph } = loaded
      // 覆盖率服务端兜底校验（前端已禁用按钮，但并发/竞态下仍需拒 —— I7）
      const uncovered = uncoveredAcs(graph)
      if (uncovered.length > 0) {
        return fail(
          err(
            'INVARIANT_VIOLATION',
            `验收条件无任务覆盖：${uncovered.join(', ')}`,
            `请先补充覆盖 ${uncovered.join(' / ')} 的任务，或把对应 AC 标为 waived，再批准执行。`,
            { field: 'acceptance.coveredBy' },
          ),
        )
      }
      // Immutable Tests：批准即快照测试标识（本版只快照 + 运行时警告 —— Scope Out S7）
      const frozenTests = [
        ...new Set(
          graph.spec.acceptance.flatMap((ac) => [
            ...(ac.verify?.testIds ?? []),
            ...(ac.verify?.command ? [ac.verify.command] : []),
          ]),
        ),
      ]
      const next: TaskGraph = {
        ...graph,
        spec: { ...graph.spec, state: 'approved' },
        frozenTests,
        updatedAt: Date.now(),
        revisions: [
          ...graph.revisions,
          {
            seq: (graph.revisions.at(-1)?.seq ?? 0) + 1,
            at: Date.now(),
            by: { kind: 'human', id: 'user' },
            op: 'update',
            targetId: graph.id,
            before: { specState: graph.spec.state },
            after: { specState: 'approved', frozenTests },
            reason: 'plan-approved',
          },
        ],
      }
      const out = await commit(p.taskId, next, {
        reason: '用户批准计划：验收条件冻结，切换身份为 builder 开始执行',
        source: 'ipc-approve-plan',
        skipRevision: true,
      })
      if (!out.ok) return out
      decidePlanApproval(p.taskId, 'approved')
      broadcastPlanGate(p.taskId, getPlanApproval(p.taskId)!)
      recordMetric('sync_action', { op: 'plan-approved' })
      logger.info('Agent', `P8: 用户批准计划，AC 已冻结（${frozenTests.length} 条测试标识）`, p.taskId)
      // 放行执行：注入合成 user 消息续跑（引擎续跑时按 spec.state='approved' 以 builder 身份执行）
      await appendUserMessage(p.taskId, '我已批准计划，验收条件已冻结，请开始执行。')
      return out
    },
  )

  /* ------------------------------------------------------------
   * 轻量模式下的"降级读取"：无图时返回默认 policy 供面板展示
   * ---------------------------------------------------------- */
  ipcMain.handle('graph:default-policy', async (): Promise<ReturnType<typeof defaultPolicy>> => defaultPolicy())
}
