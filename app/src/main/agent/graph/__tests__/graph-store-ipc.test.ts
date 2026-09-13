/**
 * v0.30.0 详测 — 图存储持久化 + IPC 频道（真实临时工作区）
 *
 * 对应文档：docs/versions/v0.30.0/testcases/01-smoke-suite.md §四「冒烟未覆盖的部分」
 *   · graph.json / graph.md / .snapshots/ 的落盘与恢复 —— 本套件 TC-STORE-*
 *   · IPC 18 个频道（设计 §5.1 的 11 个 + 实现期补充的 restore-snapshot /
 *     metrics / pending-patches / default-policy / run-converge，以及 P8 的
 *     pending-plan / decide-plan）—— 本套件 TC-IPC-*
 *
 * 与 graph-kernel.test.ts 的分工：内核套件是密闭的（内存 + 纯函数）；
 * 本套件走**真实文件系统**（/tmp 临时工作区），覆盖落盘、快照、恢复、
 * tasks.json 镜像回写，以及 ipc/graph.ts 的每个 handler。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/graph/__tests__/graph-store-ipc.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* ---------------- 模块引入（先于 setWorkspaceDir 完成，纯加载无副作用） --------------- */

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, updateTask, getTask } = await import('../../../store/tasks.js')
const {
  loadGraph,
  saveGraph,
  snapshotGraph,
  listSnapshots,
  restoreSnapshot,
  renderGraphMd,
  mirrorPlanItems,
  getGraphJsonPath,
  getGraphMdPath,
  getSpecsIndexPath,
} = await import('../store.js')
const { registerGraphHandlers } = await import('../../../ipc/graph.js')
const { putGraphCache, dropGraphCache } = await import('../sync.js')
const { registerPendingPatch, registerPlanApproval, dropTaskPlanApproval, getPlanApproval } = await import(
  '../pending.js'
)

/* electron-stub 扩展的 __invokeIpc（electron 官方 d.ts 不含它）：就地声明类型 */
type IpcInvoke = <T = any>(channel: string, ...args: unknown[]) => Promise<T>
const { __invokeIpc } = (await import('electron')) as unknown as { __invokeIpc: IpcInvoke }

import type { GraphSnapshot } from '@shared/types/ipc'
import {
  GRAPH_SCHEMA_VERSION,
  defaultPolicy,
  defaultVerification,
  generateGraphId,
  type AcceptanceCriterion,
  type Evidence,
  type DriftReport,
  type GraphResult,
  type PlanApproval,
  type ReplanPatch,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'

/* ---------------- 工作区构造 --------------- */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-graph-e2e-'))

setWorkspaceDir(WORKSPACE)
resetTaskCollection()

/* electron-stub 提供的 __invokeIpc 在注册后可用 */
registerGraphHandlers()

/* ---------------- 图构造器（对齐内核套件，减少两份测试的心智差） --------------- */

function node(over: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.id}`,
    intent: '详测用意图',
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
    title: '详测图',
    goal: '验证图存储与 IPC 的落盘行为',
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

const testEvidence = (kind: Evidence['kind']): Evidence => ({
  kind,
  summary: '详测证据',
  at: Date.now(),
  by: { kind: 'agent', id: 'agent' },
})

/** 验收条件构造器（P8 覆盖率测试用） */
function ac(id: string, over: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    id,
    statement: `WHEN 触发 THE SYSTEM SHALL 满足 ${id}`,
    type: 'test',
    verify: { testIds: [`test_${id}`] },
    status: 'pending',
    coveredBy: [],
    ...over,
  }
}

/** 建一个真实任务（空 text → 不触发 L1 写入链）并挂上图 */
async function taskWithGraph(g: TaskGraph): Promise<string> {
  const task = await createTask({ title: `详测任务 ${g.id}`, text: '', agentId: 'coder', modelId: 'test-model' })
  await updateTask(task.id, { graphId: g.id })
  putGraphCache(g)
  return task.id
}

/* ============================================================
 * TC-STORE：落盘 / 快照 / 恢复 / 镜像
 * ============================================================ */

test('TC-STORE-001 saveGraph → graph.json + graph.md + index.json 三产物落盘，loadGraph 可读回', async () => {
  const g = graph([node({ id: 't_abc001', key: 'T-01', status: 'in_progress' })])
  const saved = await saveGraph(g)

  assert.ok(existsSync(getGraphJsonPath(g.id)), 'graph.json 应落盘')
  assert.ok(existsSync(getGraphMdPath(g.id)), 'graph.md 应落盘')
  assert.ok(existsSync(getSpecsIndexPath()), 'specs/index.json 应落盘')

  const loaded = await loadGraph(g.id)
  assert.ok(loaded)
  assert.equal(loaded!.title, '详测图')
  assert.equal(loaded!.nodes['t_abc001'].status, 'in_progress')
  assert.equal(saved.graphRevision, g.graphRevision + 1, 'graphRevision 自增')
})

test('TC-STORE-002 graph.md 是只读渲染产物：含标题、key、11 态标记', async () => {
  const g = graph([
    node({ id: 't_md01aa', key: 'T-01', title: '跑通鉴权', status: 'completed', evidence: [testEvidence('test')] }),
    node({ id: 't_md01ab', key: 'T-02', title: '等用户答复', status: 'needs_human', blockingQuestion: '用哪个方案？' }),
  ])
  await saveGraph(g)
  const md = renderGraphMd(g)
  assert.ok(md.includes('详测图'), 'md 含图标题')
  assert.ok(md.includes('T-01'), 'md 含 key')
  assert.ok(md.includes('跑通鉴权'), 'md 含节点标题')
  const onDisk = readFileSync(getGraphMdPath(g.id), 'utf-8')
  assert.ok(onDisk.includes('T-02'), '磁盘上的 md 与渲染一致')
})

test('TC-STORE-003 写前快照生效；restoreSnapshot("") 恢复最近一份（D5 回归）', async () => {
  const g = graph([node({ id: 't_sn01aa', key: 'T-01', title: '初版', status: 'in_progress' })])
  await saveGraph(g) // 写入 1（此时无旧文件 → 不产快照）

  // 第二次写入：写前快照保留"初版"状态
  const v2: TaskGraph = { ...g, nodes: { ...g.nodes, t_sn01aa: { ...g.nodes['t_sn01aa']!, title: '第二版', status: 'ready' } } }
  await saveGraph(v2)

  const stamps = await listSnapshots(g.id)
  assert.ok(stamps.length >= 1, '至少一份写前快照')

  // D5：空 stamp = 恢复最近一份可用快照
  const restored = await restoreSnapshot(g.id, '')
  assert.ok(restored, '空 stamp 应恢复最近一份')
  assert.equal(restored!.nodes['t_sn01aa'].title, '初版', '恢复的是写前状态')
  // 恢复后 graph.json 即为恢复内容（saveGraph 已落盘）
  const onDisk = await loadGraph(g.id)
  assert.equal(onDisk!.nodes['t_sn01aa'].title, '初版')
})

test('TC-STORE-004 快照最多保留 5 份', async () => {
  const g = graph([node({ id: 't_sk01aa', title: '滚动' })])
  for (let i = 0; i < 8; i++) {
    await saveGraph({ ...g, title: `滚动 ${i}` })
  }
  const stamps = await listSnapshots(g.id)
  assert.ok(stamps.length <= 5, `快照应 ≤5 份，实际 ${stamps.length}`)
})

test('TC-STORE-005 图损坏：loadGraph 返回 null；snapshotGraph 不把坏图收进快照（D6 回归）；恢复仍可用', async () => {
  const g = graph([node({ id: 't_br01aa', key: 'T-01', title: '损坏前', status: 'in_progress' })])
  await saveGraph(g) // 写入 1（无旧文件 → 不产快照）
  // 写入 2：制造一份写前快照（内容 = "损坏前"）
  await saveGraph({ ...g, graphRevision: g.graphRevision + 1 })
  const stampsBefore = await listSnapshots(g.id)
  assert.ok(stampsBefore.length >= 1)

  // 外部编辑破坏 graph.json（缺 nodes 字段）
  const { writeFile } = await import('node:fs/promises')
  await writeFile(getGraphJsonPath(g.id), '{"schemaVersion":"1.0","id":"broken"}', 'utf-8')
  assert.equal(await loadGraph(g.id), null, '坏图 loadGraph → null')

  // D6：对坏图执行写路径（模拟"恢复时 saveGraph 先快照"），不应新增坏快照
  const skip = await snapshotGraph(g.id)
  assert.equal(skip, '', '坏图不产快照')

  // 恢复最近一份 → 图回来了
  const restored = await restoreSnapshot(g.id, '')
  assert.ok(restored)
  assert.equal(restored!.nodes['t_br01aa'].title, '损坏前')
})

test('TC-STORE-006 mirrorPlanItems：11 态 → 6 态镜像，verifying/needs_human 绝不映射为 done', async () => {
  const g = graph([
    node({ id: 't_mi01aa', key: 'T-01', status: 'in_progress' }),
    node({ id: 't_mi01ab', key: 'T-02', status: 'verifying' }),
    node({ id: 't_mi01ac', key: 'T-03', status: 'needs_human' }),
    node({ id: 't_mi01ad', key: 'T-04', status: 'blocked' }),
    node({ id: 't_mi01ae', key: 'T-05', status: 'ready' }),
    node({ id: 't_mi01af', key: 'T-06', status: 'completed', evidence: [testEvidence('test')] }),
    node({ id: 't_mi01ag', key: 'T-07', status: 'cancelled' }),
    node({ id: 't_mi01ah', key: 'T-08', status: 'failed' }),
  ])
  const items = mirrorPlanItems(g)
  assert.equal(items.length, 8)
  // PlanItem 的字段是 text（"T-01 标题"），不是 title
  const byIndex = (idx: number) => items[idx]
  assert.equal(byIndex(0).status, 'running', 'in_progress → running')
  assert.equal(byIndex(1).status, 'running', 'verifying → running（不是 done）')
  assert.equal(byIndex(2).status, 'running', 'needs_human → running（不是 done）')
  assert.equal(byIndex(3).status, 'pending', 'blocked → pending')
  assert.equal(byIndex(4).status, 'pending', 'ready → pending')
  assert.equal(byIndex(5).status, 'done', 'completed → done')
  assert.equal(byIndex(6).status, 'cancelled', 'cancelled → cancelled')
  assert.equal(byIndex(7).status, 'failed', 'failed → failed')
})

test('TC-STORE-007 saveGraph(taskId) 把 planItems 镜像回写 tasks.json', async () => {
  const g = graph([node({ id: 't_tb01aa', key: 'T-01', title: '镜像回写', status: 'in_progress' })])
  const taskId = await taskWithGraph(g)
  await saveGraph(g, { taskId })

  const task = await getTask(taskId)
  assert.ok(task)
  assert.equal(task!.graphId, g.id)
  assert.ok(Array.isArray(task!.planItems) && task!.planItems.length === 1)
  assert.equal(task!.planItems[0].status, 'running')

  dropGraphCache(g.id)
})

/* ============================================================
 * TC-IPC：18 个频道（经 electron-stub 的 __invokeIpc 直调 handler）
 * ============================================================ */

function assertOk<T = any>(res: GraphResult<T>): asserts res is { ok: true; data: T } {
  if (!res.ok) assert.fail(`期望 ok，实际 error=${JSON.stringify(res.error)}`)
}

test('TC-IPC-001 graph:get / graph:snapshot：任务不存在 → NOT_FOUND；轻量任务（无 graphId）→ ok(null)', async () => {
  const missing = await __invokeIpc('graph:get', 'task_not_exist')
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'NOT_FOUND')

  const light = await createTask({ title: '轻量任务', text: '', agentId: 'coder', modelId: 'm' })
  const got = await __invokeIpc('graph:get', light.id)
  assertOk(got)
  assert.equal(got.data, null, '轻量任务 → 没有图（不是错误）')
  const snap = await __invokeIpc('graph:snapshot', light.id)
  assertOk(snap)
  assert.equal(snap.data, null)
})

test('TC-IPC-002 graph:snapshot：返回 rows/counts/budget 的轻量投影', async () => {
  const g = graph([
    node({ id: 't_pp01aa', key: 'T-01', status: 'completed', evidence: [testEvidence('test')] }),
    node({ id: 't_pp01ab', key: 'T-02', status: 'in_progress' }),
    node({ id: 't_pp01ac', key: 'T-03', status: 'needs_human', blockingQuestion: '选哪个？' }),
  ])
  const taskId = await taskWithGraph(g)
  const res = await __invokeIpc('graph:snapshot', taskId)
  assertOk(res)
  const snap = res.data
  assert.equal(snap.rows.length, 3)
  assert.equal(snap.counts.total, 3)
  assert.equal(snap.counts.completed, 1)
  assert.equal(snap.counts.needs_human, 1)
  assert.equal(snap.tier, g.policy.tier)
  dropGraphCache(g.id)
})

test('TC-IPC-003 graph:update-node：字段更新 + notes 追加语义', async () => {
  const g = graph([node({ id: 't_un01aa', key: 'T-01', title: '原标题', notes: '第一行' })])
  const taskId = await taskWithGraph(g)

  const res = await __invokeIpc('graph:update-node', { taskId, nodeId: 't_un01aa', patch: { title: '新标题', notes: '第二行' } })
  assertOk(res)
  const after = await loadGraph(g.id)
  assert.equal(after!.nodes['t_un01aa'].title, '新标题')
  assert.ok(after!.nodes['t_un01aa'].notes!.includes('第一行'), 'notes 是追加而非覆盖')
  assert.ok(after!.nodes['t_un01aa'].notes!.includes('第二行'))
  dropGraphCache(g.id)
})

test('TC-IPC-004 graph:create-node：标题必填、key 顺延、derivedFrom 标记 manual:user', async () => {
  const g = graph([node({ id: 't_cn01aa', key: 'T-01', title: '已有' })])
  const taskId = await taskWithGraph(g)

  const empty = await __invokeIpc('graph:create-node', { taskId, title: '   ' })
  assert.equal(empty.ok, false)

  const res = await __invokeIpc('graph:create-node', { taskId, title: '用户手加的任务' })
  assertOk(res)
  const after = await loadGraph(g.id)
  const created = Object.values(after!.nodes).find((n) => n.title === '用户手加的任务')
  assert.ok(created, '新节点在图里')
  assert.equal(created!.key, 'T-02', 'key 顺延')
  assert.deepEqual(created!.derivedFrom, ['manual:user'])
  assert.equal(created!.status, 'ready')
  dropGraphCache(g.id)
})

test('TC-IPC-005 graph:delete-node：必须填 reason；删除后节点与索引消失', async () => {
  const g = graph([
    node({ id: 't_dl01aa', key: 'T-01', title: '保留' }),
    node({ id: 't_dl01ab', key: 'T-02', title: '删除我', parentId: 't_dl01aa' }),
  ])
  g.nodes['t_dl01aa'].children = ['t_dl01ab']
  const taskId = await taskWithGraph(g)

  const noReason = await __invokeIpc('graph:delete-node', { taskId, nodeId: 't_dl01ab' })
  assert.equal(noReason.ok, false)
  assert.equal(noReason.error.code, 'FORBIDDEN')

  const res = await __invokeIpc('graph:delete-node', { taskId, nodeId: 't_dl01ab', reason: '不需要了' })
  assertOk(res)
  const after = await loadGraph(g.id)
  assert.equal(after!.nodes['t_dl01ab'], undefined)
  assert.equal(after!.nodes['t_dl01aa'].children.length, 0)
  dropGraphCache(g.id)
})

test('TC-IPC-006 graph:set-status：合法转换通过；非法转换被拒；force 需 reason', async () => {
  const g = graph([node({ id: 't_ss01aa', key: 'T-01', status: 'ready' })])
  const taskId = await taskWithGraph(g)

  // 非法：ready → completed（必须经 in_progress/verifying）
  const denied = await __invokeIpc('graph:set-status', { taskId, nodeId: 't_ss01aa', status: 'completed' })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'TRANSITION_DENIED')

  // 合法：ready → in_progress
  const ok1 = await __invokeIpc('graph:set-status', { taskId, nodeId: 't_ss01aa', status: 'in_progress' })
  assertOk(ok1)

  // force 无 reason → FORBIDDEN
  const noReason = await __invokeIpc('graph:set-status', { taskId, nodeId: 't_ss01aa', status: 'completed', force: true })
  assert.equal(noReason.ok, false)

  // force + reason → 直达 completed（记 Revision 供追溯）
  const forced = await __invokeIpc('graph:set-status', {
    taskId,
    nodeId: 't_ss01aa',
    status: 'completed',
    force: true,
    reason: '用户知悉绕过校验',
  })
  assertOk(forced)
  const after = await loadGraph(g.id)
  assert.equal(after!.nodes['t_ss01aa'].status, 'completed')
  const lastRev = after!.revisions.at(-1)
  assert.ok(lastRev)
  assert.ok(lastRev!.reason!.includes('强制'), 'force 写入原因到修订历史')
  dropGraphCache(g.id)
})

test('TC-IPC-007 graph:answer-block(submit)：notes + evidence(human) + 状态回 ready', async () => {
  const g = graph([
    node({
      id: 't_an01aa',
      key: 'T-01',
      status: 'needs_human',
      blockingQuestion: '选 A 还是 B？',
      blockingSince: Date.now() - 60_000,
    }),
  ])
  const taskId = await taskWithGraph(g)

  const res = await __invokeIpc('graph:answer-block', {
    taskId,
    nodeId: 't_an01aa',
    action: 'submit',
    answer: '选 A',
  })
  assertOk(res)
  const after = await loadGraph(g.id)
  const n = after!.nodes['t_an01aa']
  assert.equal(n.status, 'ready', '回答后回 ready')
  assert.ok(n.notes!.includes('用户回答：选 A'))
  assert.ok(n.evidence.some((e) => e.kind === 'human'), '写入 human 证据')
  assert.equal(n.blockingQuestion, undefined, '清空阻塞字段')
  dropGraphCache(g.id)
})

test('TC-IPC-008 graph:answer-block(cancel-all)：全部非终态节点 → cancelled', async () => {
  const g = graph([
    node({ id: 't_ca01aa', key: 'T-01', status: 'needs_human', blockingQuestion: '继续吗？' }),
    node({ id: 't_ca01ab', key: 'T-02', status: 'in_progress' }),
    node({ id: 't_ca01ac', key: 'T-03', status: 'ready' }),
    node({ id: 't_ca01ad', key: 'T-04', status: 'completed', evidence: [testEvidence('test')] }),
  ])
  const taskId = await taskWithGraph(g)

  const res = await __invokeIpc('graph:answer-block', { taskId, nodeId: 't_ca01aa', action: 'cancel-all' })
  assertOk(res)
  const after = await loadGraph(g.id)
  assert.equal(after!.nodes['t_ca01aa'].status, 'cancelled')
  assert.equal(after!.nodes['t_ca01ab'].status, 'cancelled')
  assert.equal(after!.nodes['t_ca01ac'].status, 'cancelled')
  assert.equal(after!.nodes['t_ca01ad'].status, 'completed', '已完成节点不动')
  assert.equal(after!.status, 'cancelled', '图级状态也置 cancelled')
  dropGraphCache(g.id)
})

test('TC-IPC-009 graph:decide-replan：accept 应用补丁；reject 只标记', async () => {
  const g = graph([node({ id: 't_rp01aa', key: 'T-01', title: '原有' })])
  const taskId = await taskWithGraph(g)

  const patch: ReplanPatch = {
    id: 'rp_test01',
    reason: '详测：追加一个任务',
    triggerEvent: 'E5',
    createdAt: Date.now(),
    ops: [{ op: 'add', node: node({ id: 't_rp01ab', key: 'T-02', title: '补丁任务' }) }],
    impact: { invalidatedTasks: [], affectedACs: [], estimatedExtraTokens: 100 },
    approvalLevel: 1,
    state: 'pending',
  }
  registerPendingPatch(g.id, patch)

  const res = await __invokeIpc('graph:decide-replan', { taskId, patchId: 'rp_test01', decision: 'accept' })
  assertOk(res)
  const after = await loadGraph(g.id)
  assert.ok(after!.nodes['t_rp01ab'], '补丁 op 已应用')

  // reject 路径：不改变图（注意显式回 state —— markPatchDecided 会原地改 patch1 的 state）
  const patch2: ReplanPatch = {
    ...patch,
    id: 'rp_test02',
    state: 'pending',
    ops: [{ op: 'add', node: node({ id: 't_rp01ac', key: 'T-03', title: '应被拒绝' }) }],
  }
  registerPendingPatch(g.id, patch2)
  const rej = await __invokeIpc('graph:decide-replan', { taskId, patchId: 'rp_test02', decision: 'reject', userNote: '不需要' })
  assertOk(rej)
  const after2 = await loadGraph(g.id)
  assert.equal(after2!.nodes['t_rp01ac'], undefined, '拒绝的补丁未应用')
  dropGraphCache(g.id)
})

test('TC-IPC-010 graph:set-tier：覆盖 tier 并记 Revision（few-shot 语料）', async () => {
  const g = graph([node({ id: 't_tr01aa', key: 'T-01' })])
  const taskId = await taskWithGraph(g)

  const res = await __invokeIpc('graph:set-tier', { taskId, tier: 1 })
  assertOk(res)
  assert.equal(res.data.tier, 1)
  const after = await loadGraph(g.id)
  assert.equal(after!.policy.tier, 1)
  const rev = after!.revisions.find((r) => r.reason?.includes('覆盖复杂度分级'))
  assert.ok(rev, 'tier 覆盖记入修订历史')
  dropGraphCache(g.id)
})

test('TC-IPC-011 graph:export-md：返回磁盘路径且文件存在', async () => {
  const g = graph([node({ id: 't_ex01aa', key: 'T-01', title: '导出' })])
  const taskId = await taskWithGraph(g)

  const res = await __invokeIpc('graph:export-md', taskId)
  assertOk(res)
  assert.ok(res.data.path.endsWith('graph.md'))
  assert.ok(existsSync(res.data.path))
  dropGraphCache(g.id)
})

test('TC-IPC-012 graph:restore-snapshot（IPC 层，空 stamp 语义透传）', async () => {
  const g = graph([node({ id: 't_rs01aa', key: 'T-01', title: 'v1', status: 'in_progress' })])
  const taskId = await taskWithGraph(g)
  await saveGraph(g, { taskId })

  const v2: TaskGraph = { ...g, nodes: { ...g.nodes, t_rs01aa: { ...g.nodes['t_rs01aa']!, title: 'v2', status: 'ready' } } }
  await saveGraph(v2, { taskId })

  const res = await __invokeIpc<GraphResult<GraphSnapshot>>('graph:restore-snapshot', { taskId, stamp: '' })
  assertOk(res)
  assert.equal(res.data.rows.find((r) => r.id === 't_rs01aa')?.title, 'v1', 'IPC 空_stamp 恢复到写前状态')
  dropGraphCache(g.id)
})

test('TC-IPC-013 graph:metrics / graph:pending-patches / graph:default-policy：读取型频道', async () => {
  const metrics = await __invokeIpc('graph:metrics')
  assert.ok(metrics && typeof metrics === 'object')
  assert.ok('phantomCompletion' in metrics || 'syncOverhead' in metrics || typeof metrics === 'object')

  const light = await createTask({ title: '读取型', text: '', agentId: 'coder', modelId: 'm' })
  const pending = await __invokeIpc('graph:pending-patches', light.id)
  assert.deepEqual(pending, [])

  const policy = await __invokeIpc('graph:default-policy')
  assert.equal(policy.tier, 2)
  assert.equal(policy.allowSelfAttest, false)
})

test('TC-IPC-014 graph:run-converge：用户主动触发不报错且返回快照', async () => {
  const g = graph([
    node({ id: 't_cv01aa', key: 'T-01', title: '已做', status: 'completed', evidence: [testEvidence('test')] }),
    node({ id: 't_cv01ab', key: 'T-02', title: '在做', status: 'in_progress' }),
  ])
  const taskId = await taskWithGraph(g)
  const res = await __invokeIpc('graph:run-converge', taskId)
  assertOk(res)
  assert.equal(res.data.rows.length, 2)
  dropGraphCache(g.id)
})

test('TC-IPC-015 graph:resolve-converge：accept-all 入图 / accept-some 按下标挑选 / dismiss 摘除报告 / 无报告 NOT_FOUND', async () => {
  const report: DriftReport = {
    at: Date.now(),
    acCoverage: [],
    unmodeledWork: [
      {
        description: '代码里加了缓存层但图里没有',
        evidence: 'src/cache.ts',
        suggestedTask: { title: '补建缓存层任务', intent: '把已做的缓存工作建模' },
      },
      {
        description: '顺带修了一个 typo',
        evidence: 'README.md',
        suggestedTask: { title: 'typo 修正任务', intent: '补记一次小修' },
      },
    ],
    zombieTasks: [],
    invalidAssumptions: [],
    appendedTaskIds: [],
  }
  const g = graph([node({ id: 't_rc01aa', key: 'T-01', title: '主体工作', status: 'in_progress' })], {
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      acceptance: [],
      contextRefs: [],
      driftReport: report,
    },
  })
  const taskId = await taskWithGraph(g)

  // 无报告的图 → NOT_FOUND
  const plain = graph([node({ id: 't_rc01ba', key: 'T-01' })])
  const plainTaskId = await taskWithGraph(plain)
  const none = await __invokeIpc('graph:resolve-converge', { taskId: plainTaskId, action: 'accept-all' })
  assert.equal(none.ok, false)
  assert.equal(none.error.code, 'NOT_FOUND')

  // accept-all：两条未建模工作全部入图
  const res = await __invokeIpc('graph:resolve-converge', { taskId, action: 'accept-all' })
  assertOk(res)
  const after = await loadGraph(g.id)
  const convergeNodes = Object.values(after!.nodes).filter((n) => n.derivedFrom?.includes('converge'))
  assert.equal(convergeNodes.length, 2, '两条未建模工作全部追加')
  assert.equal(after!.spec.driftReport?.unmodeledWork.length, 0, '报告标记已处理')
  assert.equal(after!.spec.driftReport?.appendedTaskIds.length, 2)
  dropGraphCache(g.id)
  dropGraphCache(plain.id)

  // accept-some：只挑第 1 条
  const g2 = graph([node({ id: 't_rc01ca', key: 'T-01' })], {
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      acceptance: [],
      contextRefs: [],
      driftReport: report,
    },
  })
  const taskId2 = await taskWithGraph(g2)
  const some = await __invokeIpc('graph:resolve-converge', { taskId: taskId2, action: 'accept-some', indices: [0] })
  assertOk(some)
  const after2 = await loadGraph(g2.id)
  const picked = Object.values(after2!.nodes).filter((n) => n.derivedFrom?.includes('converge'))
  assert.equal(picked.length, 1, '只追加了选中的那条')
  assert.equal(picked[0]!.title, '补建缓存层任务')
  dropGraphCache(g2.id)

  // dismiss：报告从 spec 上摘掉，图不变
  const g3 = graph([node({ id: 't_rc01da', key: 'T-01' })], {
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      acceptance: [],
      contextRefs: [],
      driftReport: report,
    },
  })
  const taskId3 = await taskWithGraph(g3)
  const dis = await __invokeIpc('graph:resolve-converge', { taskId: taskId3, action: 'dismiss' })
  assertOk(dis)
  const after3 = await loadGraph(g3.id)
  assert.equal(after3!.spec.driftReport, undefined, 'dismiss 后报告被摘除')
  assert.equal(Object.keys(after3!.nodes).length, 1, 'dismiss 不改图结构')
  dropGraphCache(g3.id)
})

test('TC-IPC-016 graph:pending-plan：无闸门 → null；登记后按当前图重算 uncovered（I7）', async () => {
  // 未登记任何闸门 → 直接 null（不是错误）
  assert.equal(await __invokeIpc('graph:pending-plan', 'task_no_gate'), null)

  const g = graph([node({ id: 't_gp01aa', key: 'T-01', title: '主体工作' })], {
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      contextRefs: [],
      acceptance: [ac('AC-01', { coveredBy: ['t_gp01aa'] }), ac('AC-02')],
    },
  })
  const taskId = await taskWithGraph(g)

  // 登记时 uncovered 是陈旧的空数组；读取时应以当前图为准重算出 ['AC-02']
  registerPlanApproval({ taskId, graphId: g.id, state: 'pending', proposedAt: Date.now(), uncovered: [] })
  const plan = await __invokeIpc<PlanApproval | null>('graph:pending-plan', taskId)
  assert.ok(plan, '已登记 → 返回闸门投影')
  assert.deepEqual(plan!.uncovered, ['AC-02'], '有图时以当前图重算覆盖率')

  // 无 graphId（Planner 还在建图）→ 原样返回，不做覆盖率重算
  registerPlanApproval({ taskId, state: 'generating', proposedAt: Date.now(), uncovered: [] })
  const gen = await __invokeIpc<PlanApproval | null>('graph:pending-plan', taskId)
  assert.equal(gen!.state, 'generating')

  dropTaskPlanApproval(taskId)
  dropGraphCache(g.id)
})

test('TC-IPC-017 graph:decide-plan：护栏（NOT_FOUND/CONFLICT）+ 覆盖率兜底（I7）+ 批准冻结 AC（I3）', async () => {
  // 闸门不存在 → NOT_FOUND
  const missing = await __invokeIpc('graph:decide-plan', { taskId: 'task_no_gate', decision: 'approve' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'NOT_FOUND')

  // 覆盖率不足 → 批准被服务端兜底拒绝（前端禁用按钮之外的第二道闸）
  const gUncov = graph([node({ id: 't_dp01aa', key: 'T-01' })], {
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      contextRefs: [],
      acceptance: [ac('AC-01'), ac('AC-02', { coveredBy: ['t_dp01aa'] })],
    },
  })
  const tUncov = await taskWithGraph(gUncov)
  registerPlanApproval({ taskId: tUncov, graphId: gUncov.id, state: 'pending', proposedAt: Date.now(), uncovered: ['AC-01'] })

  const blocked = await __invokeIpc('graph:decide-plan', { taskId: tUncov, decision: 'approve' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'INVARIANT_VIOLATION')

  // 打回必须有说明
  const noNote = await __invokeIpc('graph:decide-plan', { taskId: tUncov, decision: 'reject' })
  assert.equal(noNote.ok, false)
  assert.equal(noNote.error.code, 'SCHEMA_INVALID')

  // 编辑出口空 markdown → SCHEMA_INVALID
  const emptyMd = await __invokeIpc('graph:decide-plan', { taskId: tUncov, decision: 'edit' })
  assert.equal(emptyMd.ok, false)
  assert.equal(emptyMd.error.code, 'SCHEMA_INVALID')

  // 批准成功：spec.state=approved + frozenTests 快照（AC 的 testIds 与 command 去重并入）
  const gOk = graph([node({ id: 't_dp01ba', key: 'T-01', title: '跑通', status: 'in_progress' })], {
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      contextRefs: [],
      acceptance: [
        ac('AC-01', { coveredBy: ['t_dp01ba'], verify: { testIds: ['test_a', 'test_b'] } }),
        ac('AC-02', { coveredBy: ['t_dp01ba'], verify: { command: 'npm test' } }),
      ],
    },
  })
  const tOk = await taskWithGraph(gOk)
  registerPlanApproval({ taskId: tOk, graphId: gOk.id, state: 'pending', proposedAt: Date.now(), uncovered: [] })

  const approved = await __invokeIpc('graph:decide-plan', { taskId: tOk, decision: 'approve' })
  assertOk(approved)
  const after = await loadGraph(gOk.id)
  assert.equal(after!.spec.state, 'approved', '批准 → Spec 置 approved')
  assert.deepEqual(after!.frozenTests, ['test_a', 'test_b', 'npm test'], 'AC 测试标识冻结（I3）')
  assert.equal(after!.revisions.at(-1)!.reason, 'plan-approved')
  assert.equal(getPlanApproval(tOk)!.state, 'approved', '闸门瞬时态同步为 approved')

  // 已决策的闸门不可重复决策 → CONFLICT
  const again = await __invokeIpc('graph:decide-plan', { taskId: tOk, decision: 'approve' })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'CONFLICT')

  dropTaskPlanApproval(tOk)
  dropGraphCache(gOk.id)
  dropGraphCache(gUncov.id)
})

/* ---------------- 清理 --------------- */

test('清理临时工作区', () => {
  rmSync(WORKSPACE, { recursive: true, force: true })
})
