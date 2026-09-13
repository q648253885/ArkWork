/**
 * v0.30.0 详测 — planItem ↔ graph 唯一桥（缺陷 D9 回归）
 *
 * 对应文档：docs/versions/v0.30.0/04-system-design.md §4.7 / §4.8 / §10.6
 *          docs/versions/v0.30.0/testcases/00-cumulative-matrix.md §四 D9
 *
 * 缺陷 D9：v0.29 遗留 8 类直接写 `Task.planItems` 的路径，绕过 `graph.json`（唯一真相），
 * 导致「交互区任务清单已全部完成，但右侧侧边栏状态不对应」。修复方式为在
 * `graph/plan-sync.ts` 收敛出唯一桥：**写图 → 由图重算镜像 → 补广播**。
 *
 * 本套件分两层：
 *  A. 运行时行为（TC-D9-001…010）：走真实临时工作区，验证桥的每个导出原语
 *     真正改写 `graph.json` 并同步 `Task.planItems` 镜像（与 graph-store-ipc.test.ts 同 harness）。
 *  B. 源码契约（TC-D9-SRC）：断言 8 个绕过点已全部改调桥、`saveGraph` 已接入
 *     `mirrorWrittenHook`、`installPlanSync` 已在启动链接线（防回归）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/graph/__tests__/plan-sync.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/* ---------------- 模块引入（先于 setWorkspaceDir，纯加载无副作用） --------------- */

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, updateTask, getTask } = await import('../../../store/tasks.js')
const { loadGraph, saveGraph, registerMirrorWrittenHook } = await import('../store.js')
const { putGraphCache } = await import('../sync.js')
const {
  applyPlanItemStatus,
  applyStageGateAdvance,
  applyPlanItemStatuses,
  markPlanItemInProgress,
  markRunningFailed,
  cancelIncomplete,
  installPlanSync,
} = await import('../plan-sync.js')

import {
  GRAPH_SCHEMA_VERSION,
  defaultPolicy,
  defaultVerification,
  generateGraphId,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'

/* ---------------- 工作区构造 --------------- */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-plan-sync-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

/* ---------------- 图构造器（与 graph-store-ipc.test.ts 对齐，减少心智差） --------------- */

function node(over: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.id}`,
    intent: 'D9 回归用意图',
    status: 'ready',
    assignee: { kind: 'system' },
    priority: 'p1',
    children: [],
    dependsOn: [],
    acceptance: [],
    evidence: [],
    verification: defaultVerification(),
    contextRefs: [],
    tokensUsed: 0,
    attempts: 0,
    sessionIds: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...over,
  }
}

function graph(nodes: TaskNode[], over: Partial<TaskGraph> = {}): TaskGraph {
  const map: Record<string, TaskNode> = {}
  for (const n of nodes) map[n.id] = n
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    id: generateGraphId(),
    title: 'D9 详测图',
    goal: '验证 planItem ↔ graph 唯一桥的写图 + 镜像同步',
    status: 'in_progress',
    graphRevision: 1,
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      acceptance: [],
      contextRefs: [],
    },
    nodes: map,
    rootIds: nodes.filter((n) => n.parentId === null).map((n) => n.id),
    policy: defaultPolicy(),
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** 建一个真实任务（空 text → 不触发 L1 写入链）并挂上图 */
async function taskWithGraph(g: TaskGraph): Promise<string> {
  const task = await createTask({ title: `D9 详测任务 ${g.id}`, text: '', agentId: 'coder', modelId: 'test-model' })
  await updateTask(task.id, { graphId: g.id })
  putGraphCache(g)
  return task.id
}

/* ============================================================
 * A. 运行时行为
 * ============================================================ */

test('TC-D9-001 applyPlanItemStatus(force=true) 把 done 直接落为 completed，通道 A 镜像同步', async () => {
  const g = graph([node({ id: 't_d9a001', key: 'T-01', title: '用户点完成', status: 'ready' })])
  const taskId = await taskWithGraph(g)

  const res = await applyPlanItemStatus(
    { taskId, graphId: g.id },
    't_d9a001',
    'done',
    'user-mark-done',
    '用户手动完成',
  )
  assert.equal(res.ok, true)
  assert.equal(res.effectiveStatus, 'done', 'effectiveStatus 由图重算')

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9a001'].status, 'completed', 'force=true 绕过 I2，直接 completed')

  const task = await getTask(taskId)
  const item = task?.planItems?.find((p) => p.id === 't_d9a001')
  assert.equal(item?.status, 'done', '通道 A（task.planItems）镜像随图同步为 done')
})

test('TC-D9-002 force=false 走状态机 + I2 降级：in_progress → completed 被降为 verifying', async () => {
  const g = graph([node({ id: 't_d9a002', key: 'T-02', status: 'in_progress' })])
  const taskId = await taskWithGraph(g)

  const res = await applyPlanItemStatus(
    { taskId, graphId: g.id },
    't_d9a002',
    'done',
    'todo-update',
    '模型自称完成',
    false,
  )
  assert.equal(res.ok, true, 'I2 是降级不是拒绝')
  assert.equal(res.effectiveStatus, 'running', 'completed 被降级为 verifying → 镜像 running')

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9a002'].status, 'verifying', '门禁把 completed 降级为 verifying')
})

test('TC-D9-003 running 目标解析为 ready（重试语义），不伪造 in_progress', async () => {
  const g = graph([node({ id: 't_d9a003', key: 'T-03', status: 'in_progress' })])
  const taskId = await taskWithGraph(g)

  const res = await applyPlanItemStatus(
    { taskId, graphId: g.id },
    't_d9a003',
    'running',
    'user-retry',
    '重试该步',
  )
  assert.equal(res.ok, true)
  assert.equal(res.effectiveStatus, 'pending', 'ready → 镜像 pending（可再次运行）')

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9a003'].status, 'ready', '重试不伪造 in_progress')
})

test('TC-D9-004 NOT_FOUND：图不存在 / 节点不存在 均返回 { ok:false, error.NOT_FOUND } 且不抛错', async () => {
  const missingGraph = await applyPlanItemStatus(
    { taskId: 'task_x', graphId: 'g_missing' },
    'n1',
    'done',
    'user-mark-done',
  )
  assert.equal(missingGraph.ok, false)
  assert.equal(missingGraph.error?.code, 'NOT_FOUND')

  const g = graph([node({ id: 't_d9a004', key: 'T-04', status: 'ready' })])
  const taskId = await taskWithGraph(g)
  const missingNode = await applyPlanItemStatus(
    { taskId, graphId: g.id },
    't_nope',
    'done',
    'user-mark-done',
  )
  assert.equal(missingNode.ok, false)
  assert.equal(missingNode.error?.code, 'NOT_FOUND')
})

test('TC-D9-005 applyStageGateAdvance：命中项 → completed，下一项 → in_progress', async () => {
  const g = graph([
    node({ id: 't_d9a005', key: 'T-05', status: 'in_progress' }),
    node({ id: 't_d9a006', key: 'T-06', status: 'ready' }),
  ])
  const taskId = await taskWithGraph(g)

  const res = await applyStageGateAdvance({ taskId, graphId: g.id }, 't_d9a005', 't_d9a006')
  assert.equal(res.ok, true)

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9a005'].status, 'completed', 'stage-gate 命中项完成')
  assert.equal(disk!.nodes['t_d9a006'].status, 'in_progress', '推进下一项进入执行')
})

test('TC-D9-006 applyPlanItemStatuses：批量 6→11 态映射（done/failed/skipped）', async () => {
  const g = graph([
    node({ id: 't_d9a007', key: 'T-07', status: 'ready' }),
    node({ id: 't_d9a008', key: 'T-08', status: 'in_progress' }),
    node({ id: 't_d9a009', key: 'T-09', status: 'ready' }),
  ])
  const taskId = await taskWithGraph(g)

  const res = await applyPlanItemStatuses(
    { taskId, graphId: g.id },
    [
      { planItemId: 't_d9a007', to: 'done' },
      { planItemId: 't_d9a008', to: 'failed' },
      { planItemId: 't_d9a009', to: 'skipped' },
    ],
    'todo-update',
    '清单回写',
  )
  assert.equal(res.ok, true)

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9a007'].status, 'completed', 'done → completed')
  assert.equal(disk!.nodes['t_d9a008'].status, 'failed', 'failed → failed')
  assert.equal(disk!.nodes['t_d9a009'].status, 'cancelled', 'skipped → cancelled')
})

test('TC-D9-007 markPlanItemInProgress 写入真实 in_progress（区别于 running→ready）', async () => {
  const g = graph([node({ id: 't_d9b000', key: 'T-10', status: 'ready' })])
  const taskId = await taskWithGraph(g)

  const res = await markPlanItemInProgress({ taskId, graphId: g.id, iteration: 1 }, 't_d9b000')
  assert.equal(res.ok, true)

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9b000'].status, 'in_progress', '引擎首轮推进必须真进 in_progress，否则 D9 复现')
})

test('TC-D9-008 markRunningFailed：所有 in_progress → failed，其余不动', async () => {
  const g = graph([
    node({ id: 't_d9b001', key: 'T-11', status: 'in_progress' }),
    node({ id: 't_d9b002', key: 'T-12', status: 'in_progress' }),
    node({ id: 't_d9b003', key: 'T-13', status: 'ready' }),
  ])
  const taskId = await taskWithGraph(g)

  const res = await markRunningFailed({ taskId, graphId: g.id }, '任务失败')
  assert.equal(res.ok, true)

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9b001'].status, 'failed')
  assert.equal(disk!.nodes['t_d9b002'].status, 'failed')
  assert.equal(disk!.nodes['t_d9b003'].status, 'ready', '未运行项不受影响')
})

test('TC-D9-009 cancelIncomplete：非终态非 goal → cancelled；goal 与终态保留', async () => {
  const g = graph([
    node({ id: 't_d9b004', key: 'G-01', layer: 'goal', status: 'in_progress' }),
    node({ id: 't_d9b005', key: 'T-14', status: 'ready' }),
    node({ id: 't_d9b006', key: 'T-15', status: 'completed' }),
    node({ id: 't_d9b007', key: 'T-16', status: 'cancelled' }),
  ])
  const taskId = await taskWithGraph(g)

  const res = await cancelIncomplete({ taskId, graphId: g.id }, '用户取消任务')
  assert.equal(res.ok, true)

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_d9b004'].status, 'in_progress', 'goal 层不入 victims')
  assert.equal(disk!.nodes['t_d9b005'].status, 'cancelled', '非终态项被丢弃')
  assert.equal(disk!.nodes['t_d9b006'].status, 'completed', '终态 completed 保留')
  assert.equal(disk!.nodes['t_d9b007'].status, 'cancelled', '已是 cancelled 保持')
})

test('TC-D9-010 commitStatuses 幂等：重复写同一目标态不落盘、不推进 graphRevision', async () => {
  const g = graph([node({ id: 't_d9b008', key: 'T-17', status: 'ready' })])
  const taskId = await taskWithGraph(g)
  const ctx = { taskId, graphId: g.id }

  await applyPlanItemStatus(ctx, 't_d9b008', 'done', 'user-mark-done', '第一次')
  const afterFirst = await loadGraph(g.id)

  const again = await applyPlanItemStatus(ctx, 't_d9b008', 'done', 'user-mark-done', '重复')
  assert.equal(again.ok, true)

  const afterSecond = await loadGraph(g.id)
  assert.equal(afterSecond!.graphRevision, afterFirst!.graphRevision, '无实际变更 → 不产生新 revision')
  assert.equal(afterSecond!.nodes['t_d9b008'].status, 'completed')
})

test('TC-D9-011 saveGraph(taskId) 触发镜像写入 hook；installPlanSync 幂等', async () => {
  const g = graph([node({ id: 't_d9b009', key: 'T-18', status: 'in_progress' })])
  const taskId = await taskWithGraph(g)

  const seen: Array<{ taskId: string; count: number }> = []
  registerMirrorWrittenHook((tid, items) => seen.push({ taskId: tid, count: items.length }))
  await saveGraph(g, { taskId })
  assert.equal(seen.length, 1, '镜像写入处显式补发一次 hook（通道 A ←→ B 同帧一致）')
  assert.equal(seen[0]!.taskId, taskId)
  assert.equal(seen[0]!.count, 1, '非 goal 节点进入镜像清单')

  // 还原默认 no-op，随后 installPlanSync 重复调用必须安全（模块级幂等）
  registerMirrorWrittenHook(null)
  installPlanSync()
  installPlanSync()
  await saveGraph(g, { taskId }) // hook 已装（广播到空窗口列表 → 无副作用）
})

/* ============================================================
 * B. 源码契约（防回归：绕过点不得复活）
 * ============================================================ */

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const AGENT = '../../' // src/main/agent/
const MAIN = '../../../' // src/main/

test('TC-D9-SRC-001 桥模块导出全部原语，且 installPlanSync 接线 mirrorWrittenHook → 快照广播', () => {
  const src = read('../plan-sync.ts')
  for (const fn of [
    'applyPlanItemStatus',
    'applyStageGateAdvance',
    'applyPlanItemStatuses',
    'markPlanItemInProgress',
    'markRunningFailed',
    'cancelIncomplete',
    'installPlanSync',
  ]) {
    assert.match(src, new RegExp(`export (async )?function ${fn}\\(`), `桥应导出 ${fn}`)
  }
  assert.match(src, /registerMirrorWrittenHook\(/, 'installPlanSync 应向 store 注册镜像 hook')
  assert.match(src, /broadcastPlanListSnapshot\(/, 'hook 应补发 task:plan-list-snapshot（通道 A）')
})

test('TC-D9-SRC-002 store.saveGraph 在图写镜像后显式调用 mirrorWrittenHook', () => {
  const src = read('../store.ts')
  assert.match(src, /mirrorWrittenHook\?\.\(options\.taskId, planItems\)/, 'saveGraph 镜像写入处必须补发 hook')
  assert.match(src, /export function registerMirrorWrittenHook\(/, 'store 暴露注册口（依赖倒置）')
})

test('TC-D9-SRC-003 8 个绕过点已全部改调桥（有图任务写图，无图任务保持 v0.29 直写）', () => {
  // ① IPC 用户手动切状态
  assert.match(read(`${MAIN}ipc/plan-items.ts`), /applyPlanItemStatus\(/, 'ipc/plan-items 应调桥')
  // ② stage-gate 推进
  assert.match(read(`${AGENT}engine/loop.ts`), /applyStageGateAdvance\(/, 'engine/loop 应调桥')
  // ③ todo_update 回写
  assert.match(read(`${AGENT}engine/act.ts`), /applyPlanItemStatuses\(/, 'engine/act 应调桥')
  // ④ 推理阶段推进首项
  assert.match(read(`${AGENT}engine/reason-phase.ts`), /markPlanItemInProgress\(/, 'engine/reason-phase 应调桥')
  // ⑤/#6 失败与丢弃
  const gates = read(`${AGENT}engine/gates.ts`)
  assert.match(gates, /markRunningFailed\(/, 'engine/gates 失败应调桥')
  assert.match(gates, /cancelIncomplete\(/, 'engine/gates 丢弃应调桥')
  // ⑦ pause/manager 恢复
  assert.match(read(`${MAIN}pause/manager.ts`), /applyPlanItemStatuses\(/, 'pause/manager 应调桥')
  // ⑧ 启动链安装
  assert.match(read(`${MAIN}ipc/index.ts`), /installPlanSync\(\)/, '启动链应安装桥的镜像广播 hook')
})

test('TC-D9-SRC-004 无图任务仍走 v0.29 直写（桥只在 task.graphId 存在时介入）', () => {
  const gates = read(`${AGENT}engine/gates.ts`)
  // 调用点应带 task.graphId 守卫（有图才走桥）
  assert.match(gates, /if \(task\.graphId\)/, 'engine/gates 调用桥前应有 graphId 守卫')
  const reason = read(`${AGENT}engine/reason-phase.ts`)
  assert.match(reason, /if \(task\.graphId\)/, 'engine/reason-phase 调用桥前应有 graphId 守卫')
})
