/**
 * v0.30.1 详测 — replan 待批准链路接线（问题②）
 *
 * 对应文档：docs/versions/v0.30.1/testcases/00-cumulative-matrix.md §3.3（TC-REPLAN-PEND-001..008）
 * 技术方案：docs/versions/v0.30.1/04-system-design.md §4
 *
 * 为什么单独一个套件：v0.30.0 存在一条**生产不可达路径** ——
 * 第 2/3 级补丁生成后从未登记进 `pending.ts` 的待决表，导致 `graph:decide-replan`
 * 的 `getPendingPatch` 恒落空、返回 NOT_FOUND（断链全景见 04-system-design §4.1）。
 * 本套件锁死修复后的完整闭环：生成侧登记 + 广播 → 决定侧命中 → accept/reject/edit。
 *
 * 与 graph-store-ipc.test.ts 的分工：那边覆盖存储与 18 个 IPC 频道；
 * 本套件专测「补丁从生成到决定的接线」，同样走**真实文件系统**（/tmp 临时工作区）。
 *
 * 注：TC-REPLAN-PEND-003 采用**源码契约断言** —— 测试桩下 `BrowserWindow.getAllWindows()`
 * 返回 `[]` 且 `webContents.send` 是 no-op，广播 payload 无法在测试中捕获（见 window.ts / electron-stub.mjs）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* ---------------- 模块引入（先于 setWorkspaceDir 完成，纯加载无副作用） --------------- */

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, updateTask, deleteTask } = await import('../../../store/tasks.js')
const { loadGraph, saveGraph, getGraphJsonPath } = await import('../store.js')
const { registerGraphHandlers } = await import('../../../ipc/graph.js')
const { putGraphCache, dropGraphCache } = await import('../sync.js')
const {
  registerPendingPatch,
  listPendingPatches,
  getPendingPatch,
  registerPlanApproval,
  getPlanApproval,
  resetPendingPatches,
} = await import('../pending.js')
const { GRAPH_TOOL_HANDLERS } = await import('../tools.js')

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
  type GraphResult,
  type ReplanPatch,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import type { SkillContext } from '../../registry.js'
import type { Task } from '@shared/types/task'

/* ---------------- 工作区构造 --------------- */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-replan-pending-'))

setWorkspaceDir(WORKSPACE)
resetTaskCollection()
resetPendingPatches()

/* electron-stub 提供的 __invokeIpc 在注册后可用 */
registerGraphHandlers()

/* ---------------- 图构造器（对齐 graph-store-ipc.test.ts，减少两份测试的心智差） --------------- */

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
    goal: '验证 replan 待批准链路的接线',
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

/** 手工构造一个待决补丁（用于登记/清理类用例，绕过 buildPatch 的 id 随机性） */
function makePatch(id: string, over: Partial<ReplanPatch> = {}): ReplanPatch {
  return {
    id,
    reason: '详测补丁',
    triggerEvent: 'E3',
    createdAt: Date.now(),
    ops: [],
    impact: { invalidatedTasks: [], affectedACs: [], estimatedExtraTokens: 0 },
    approvalLevel: 2,
    state: 'pending',
    ...over,
  }
}

/** 组装调用 replan 工具所需的 SkillContext（只需 taskId + task.graphId） */
function toolCtx(taskId: string, graphId: string): SkillContext {
  return {
    taskId,
    signal: new AbortController().signal,
    task: { graphId } as unknown as Task,
  }
}

/** 直接调用生成侧工具 `replan`（等价于 Agent 在 act 阶段发起补丁） */
async function runReplan(taskId: string, graphId: string, args: Record<string, unknown>): Promise<any> {
  const handler = GRAPH_TOOL_HANDLERS.replan as (a: unknown, c: SkillContext) => Promise<any>
  assert.ok(handler, 'replan handler 已注册')
  return handler(args, toolCtx(taskId, graphId))
}

function assertOk<T = any>(res: GraphResult<T>): asserts res is { ok: true; data: T } {
  if (!res.ok) assert.fail(`期望 ok，实际 error=${JSON.stringify(res.error)}`)
}

/* 一个"有已完成节点"的基图：remove 已完成节点 → 影响集非空 → 第 2 级（需批准） */
function baseGraph(): TaskGraph {
  return graph([
    node({ id: 't_rppdone', key: 'T-01', title: '已完成', status: 'completed', evidence: [testEvidence('test')] }),
    node({ id: 't_rppkeep', key: 'T-02', title: '保留' }),
  ])
}

/* ============================================================
 * TC-REPLAN-PEND：生成侧登记 + 决定侧命中 + 待决清理
 * ============================================================ */

test('TC-REPLAN-PEND-001 第 2 级补丁生成后登记进待决表（生成侧登记生效）', async () => {
  const g = baseGraph()
  const taskId = await taskWithGraph(g)

  const res = await runReplan(taskId, g.id, {
    reason: '详测：移除已完成节点',
    trigger_event: 'E3',
    ops: [{ op: 'remove', id: 't_rppdone', reason: '方案变更' }],
  })

  assert.equal(res.ok, true, '第 2 级补丁应生成成功')
  assert.equal(res.pending, true, '第 2 级 → 等待用户批准（不自动应用）')
  assert.equal(res.approvalLevel, 2)

  const pending = listPendingPatches(g.id)
  assert.equal(pending.length, 1, '补丁已登记进待决注册表（修复前此处恒为 0）')
  assert.equal(pending[0].id, res.patchId, '登记的正是刚生成的补丁')
  assert.equal(pending[0].state, 'pending')

  // 未落盘：第 2 级在批准前不改图、不产生磁盘写入
  assert.equal(existsSync(getGraphJsonPath(g.id)), false, '第 2 级登记阶段不落盘')
  dropGraphCache(g.id)
})

test('TC-REPLAN-PEND-002 同一 patch.id 重复登记不堆叠（去重，风险 R2）', async () => {
  const g = baseGraph()
  const taskId = await taskWithGraph(g)

  const patch = makePatch('rp_dup001')
  registerPendingPatch(g.id, patch)
  registerPendingPatch(g.id, patch)
  registerPendingPatch(g.id, makePatch('rp_dup001', { reason: '换个理由重复提交' }))

  const same = listPendingPatches(g.id).filter((p) => p.id === 'rp_dup001')
  assert.equal(same.length, 1, '同一 id 只保留一条（registerPendingPatch 内部按 id 去重）')
  assert.equal(same[0].reason, '详测补丁', '重复提交不覆盖首条内容')

  dropGraphCache(g.id)
})

test('TC-REPLAN-PEND-003 登记时广播既有事件 graph_replan_proposed（不新增事件类型）', () => {
  // 广播在测试桩下不可观测（getAllWindows → []）：改用源码契约断言
  const toolsSrc = readFileSync(new URL('../tools.ts', import.meta.url), 'utf-8')
  assert.ok(/registerPendingPatch\(/.test(toolsSrc), 'tools.ts 生成侧调用 registerPendingPatch')
  assert.ok(/type:\s*'graph_replan_proposed'/.test(toolsSrc), 'tools.ts 广播 graph_replan_proposed')

  // 复用既有事件联合类型（未新增类型 → 前端 toGraphUpdatePayload 的穷举 switch 无需改动）
  const reactSrc = readFileSync(new URL('../../../../shared/types/react.ts', import.meta.url), 'utf-8')
  assert.ok(/graph_replan_proposed/.test(reactSrc), 'ReActEvent 联合类型已含该事件（既有）')
})

test('TC-REPLAN-PEND-004 getPendingPatch 命中：accept 应用 + Revision；reject 仅标记、图不变', async () => {
  const g = graph([
    node({ id: 't_rppdone', key: 'T-01', status: 'completed', evidence: [testEvidence('test')] }),
    node({ id: 't_rppdone2', key: 'T-02', status: 'completed', evidence: [testEvidence('test')] }),
    node({ id: 't_rppkeep', key: 'T-03' }),
  ])
  const taskId = await taskWithGraph(g)

  // ---- accept：命中 + 应用 ----
  const gen = await runReplan(taskId, g.id, {
    reason: '详测：移除已完成节点 A',
    trigger_event: 'E3',
    ops: [{ op: 'remove', id: 't_rppdone', reason: '方案变更' }],
  })
  assert.equal(gen.pending, true, '生成侧已登记 → 决定侧应能命中')
  const patchId = gen.patchId as string
  assert.ok(getPendingPatch(g.id, patchId), 'getPendingPatch 命中（修复前为 undefined → NOT_FOUND）')

  const acc = await __invokeIpc<GraphResult<GraphSnapshot>>('graph:decide-replan', {
    taskId,
    patchId,
    decision: 'accept',
  })
  assertOk(acc)
  const after = await loadGraph(g.id)
  assert.equal(after!.nodes['t_rppdone'], undefined, 'accept → 补丁 ops 已应用')
  assert.ok(after!.graphRevision > g.graphRevision, 'accept 落盘并递增 graphRevision')
  assert.equal(getPendingPatch(g.id, patchId)?.state, 'applied', '补丁标记 applied')

  // ---- reject：仅标记，图不变 ----
  const revBefore = after!.graphRevision
  const gen2 = await runReplan(taskId, g.id, {
    reason: '详测：移除已完成节点 B',
    trigger_event: 'E3',
    ops: [{ op: 'remove', id: 't_rppdone2', reason: '方案变更' }],
  })
  const patchId2 = gen2.patchId as string
  const rej = await __invokeIpc<GraphResult<GraphSnapshot>>('graph:decide-replan', {
    taskId,
    patchId: patchId2,
    decision: 'reject',
    userNote: '不需要',
  })
  assertOk(rej)
  const after2 = await loadGraph(g.id)
  assert.ok(after2!.nodes['t_rppdone2'], 'reject → 被拒补丁未应用（节点仍在）')
  assert.equal(after2!.graphRevision, revBefore, 'reject 不落盘、图版本不变')
  assert.equal(getPendingPatch(g.id, patchId2)?.state, 'rejected', '补丁标记 rejected')

  dropGraphCache(g.id)
})

test('TC-REPLAN-PEND-005 edit 语义 =「打回并附修改意见」：映射 rejected 且 userNote 写入 Revision.reason', async () => {
  const g = baseGraph()
  const taskId = await taskWithGraph(g)

  const gen = await runReplan(taskId, g.id, {
    reason: '详测：移除已完成节点',
    trigger_event: 'E3',
    ops: [{ op: 'remove', id: 't_rppdone', reason: '方案变更' }],
  })
  const patchId = gen.patchId as string

  // 空意见 → SCHEMA_INVALID（edit 与 reject 的语义差别在此）
  const empty = await __invokeIpc<GraphResult<GraphSnapshot>>('graph:decide-replan', {
    taskId,
    patchId,
    decision: 'edit',
    userNote: '   ',
  })
  assert.equal(empty.ok, false)
  assert.equal((empty as any).error.code, 'SCHEMA_INVALID')
  assert.equal(getPendingPatch(g.id, patchId)?.state, 'pending', '缺意见不消耗补丁，用户可重来')

  // 有意见 → 打回 + 意见注入
  const note = '请改成只调整依赖，不要删除已完成节点'
  const ed = await __invokeIpc<GraphResult<GraphSnapshot>>('graph:decide-replan', {
    taskId,
    patchId,
    decision: 'edit',
    userNote: note,
  })
  assertOk(ed)
  const after = await loadGraph(g.id)
  assert.ok(after!.nodes['t_rppdone'], 'edit 不应用原 ops（图结构不变）')
  const lastRev = after!.revisions.at(-1)
  assert.ok(lastRev, 'edit 追加了一条 Revision')
  assert.ok(lastRev!.reason?.startsWith('user-rework-replan:'), 'Revision.reason 带 user-rework-replan 前缀')
  assert.ok(lastRev!.reason!.includes(note), '修改意见写入 Revision.reason')
  assert.equal(getPendingPatch(g.id, patchId)?.state, 'rejected', 'edit 映射为 rejected')
  assert.equal(getPendingPatch(g.id, patchId)?.userNote, note, 'userNote 落在补丁上')

  dropGraphCache(g.id)
})

test('TC-REPLAN-PEND-006 第 1 级仍自动应用；第 4 级仍禁止（v0.30.0 回归）', async () => {
  // ---- 第 1 级：add-only → 自动应用，不登记待决 ----
  const g1 = graph([node({ id: 't_rpp6a', key: 'T-01', title: '原有' })])
  const t1 = await taskWithGraph(g1)
  const r1 = await runReplan(t1, g1.id, {
    reason: '追加一个新任务',
    trigger_event: 'E3',
    ops: [{ op: 'add', node: { title: '补丁任务', layer: 'task' } }],
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.applied, true, '第 1 级 → 自动应用')
  assert.equal(listPendingPatches(g1.id).length, 0, '自动应用不进待决表')
  const after1 = await loadGraph(g1.id)
  assert.equal(Object.keys(after1!.nodes).length, 2, 'add 已落盘')
  dropGraphCache(g1.id)

  // ---- 第 4 级：改已批准 AC → buildPatch 阶段即拒绝（禁止） ----
  const g4 = graph(
    [node({ id: 't_rpp6b', key: 'T-01', acceptance: [ac('AC-01')] })],
    {
      spec: {
        state: 'approved',
        scopeIn: [],
        scopeOut: [],
        assumptions: [],
        constraints: [],
        acceptance: [],
        contextRefs: [],
      },
    },
  )
  const t4 = await taskWithGraph(g4)
  const r4 = await runReplan(t4, g4.id, {
    reason: '想放宽验收',
    trigger_event: 'E1',
    ops: [{ op: 'update', id: 't_rpp6b', patch: { acceptance: [ac('AC-01', { statement: '放宽后的标准' })] } }],
  })
  assert.equal(r4.ok, false, '第 4 级必须被拒')
  assert.equal(r4.rejected, true)
  assert.ok(String(r4.error).includes('验收'), '拒绝理由指向验收条件不可改写')
  assert.equal(listPendingPatches(g4.id).length, 0, '禁止的补丁不登记')
  dropGraphCache(g4.id)
})

test('TC-REPLAN-PEND-007 任务删除 → dropGraphPending + dropTaskPlanApproval 清空待决表', async () => {
  const g = baseGraph()
  const taskId = await taskWithGraph(g)

  registerPendingPatch(g.id, makePatch('rp_del001'))
  registerPlanApproval({ taskId, graphId: g.id, state: 'pending', proposedAt: Date.now(), uncovered: [] })
  assert.equal(listPendingPatches(g.id).length, 1)
  assert.ok(getPlanApproval(taskId), '闸门已登记')

  await deleteTask(taskId)

  assert.equal(listPendingPatches(g.id).length, 0, '删除任务 → 待决补丁被清理')
  assert.equal(getPlanApproval(taskId), undefined, '删除任务 → 计划闸门被清理')
  dropGraphCache(g.id)
})

test('TC-REPLAN-PEND-008 任务终态 → dropGraphPending；paused 不清；待决不落盘（S4）', async () => {
  const g = baseGraph()
  const taskId = await taskWithGraph(g)
  await saveGraph(g, { taskId })
  const onDiskBefore = readFileSync(getGraphJsonPath(g.id), 'utf-8')

  registerPendingPatch(g.id, makePatch('rp_term01'))
  assert.equal(listPendingPatches(g.id).length, 1)

  // S4：待决补丁是纯内存瞬时态，登记不产生磁盘写入
  const onDiskAfter = readFileSync(getGraphJsonPath(g.id), 'utf-8')
  assert.equal(onDiskAfter, onDiskBefore, '登记待决不落盘')
  assert.ok(!onDiskAfter.includes('rp_term01'), '磁盘上不存在该补丁 id')

  // paused 可恢复 → 不清理
  await updateTask(taskId, { status: 'paused' })
  assert.equal(listPendingPatches(g.id).length, 1, 'paused 不清待决表（可恢复）')

  // 终态 → 清理
  await updateTask(taskId, { status: 'done' })
  assert.equal(listPendingPatches(g.id).length, 0, '终态（done）清理待决补丁')

  // 重启后内存表为空：resetPendingPatches 模拟新进程冷启动
  registerPendingPatch(g.id, makePatch('rp_term02'))
  assert.equal(listPendingPatches(g.id).length, 1)
  resetPendingPatches()
  assert.equal(listPendingPatches(g.id).length, 0, '重启后内存表为空')

  dropGraphCache(g.id)
})

/* ---------------- 清理 --------------- */

test('清理临时工作区', () => {
  rmSync(WORKSPACE, { recursive: true, force: true })
})
