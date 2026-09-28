/**
 * v0.36.4 详测 — D123 双通道漂移 → 完成守卫逼模型重做已完成任务
 *
 * 依据：docs/versions/v0.36.4/16-v0364-windows-compat-design.md §二 D123
 *
 * 用户 macOS 实测（TravelSky Code 项目会话日志，问题「不在 windows 中也有」）：
 *   模型已用 todo-update 把 5 项清单全部标完（工具输出「当前清单：[x] 1..5」），
 *   但 task_complete 被 [unfinished-plan] 拦截：「T-02/T-03/T-04 仍是 ready」→
 *   模型被迫重做已完成任务，循环 4 轮才收口。
 *
 * 根因（结构缺陷，平台无关）：
 *   ① `planItemId === nodeId` 是隐式不变量，任何断链（丢镜像/重建图）后 todo_update
 *     的图写返回 NOT_FOUND 被 act.ts **静默丢弃**（纪律⑨：静默退化是复合缺陷的粘合剂）；
 *   ② UI/模型看到内存清单 [x]（通道 A），图节点停在 ready（通道 B）；
 *   ③ 完成守卫只读通道 B → 误报「未收口」→ 逼模型重做。
 *
 * 修复面：
 *   - plan-sync.applyPlanItemStatusesRobust：id 直查 → `T-{index+1}` key 兜底两级定位；
 *   - act.ts todo_update：消费图写结果，仍失败则回退直写 tasks.json + 降级告知模型；
 *   - turn-end 完成守卫：双通道对账 —— 图说 ready 但镜像已终态的项不算 leftover。
 *
 * 手法：A 层真执行（真实临时工作区走 applyPlanItemStatusesRobust），
 *       B 层源码契约（剥离注释后断言，防 D89 式注释误报）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/graph/__tests__/todo-sync-robust.test.ts
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
const { resetTaskCollection, createTask } = await import('../../../store/tasks.js')
const { saveGraph } = await import('../store.js')
const { applyPlanItemStatusesRobust } = await import('../plan-sync.js')
const { getGraphById } = await import('../sync.js')

import {
  GRAPH_SCHEMA_VERSION,
  defaultPolicy,
  defaultVerification,
  generateGraphId,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import { stripComments } from '@shared/utils/source-guard'

/* ---------------- 工作区构造（与 plan-sync.test.ts 同 harness） --------------- */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-todo-robust-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

/* ---------------- 图构造器（key 显式 T-01…，对齐 migrateToGraph 产物形状） --------------- */

function node(over: Partial<TaskNode> & { id: string; key: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.key}`,
    intent: 'D123 回归用意图',
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
    title: 'D123 详测图',
    goal: '验证 todo_update 图写断链不再逼模型重做',
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

// 剥离注释改用唯一真源 @shared/utils/source-guard（D101/D102，TC-D102-001 守卫）

const ACT = stripComments(readFileSync(new URL('../../engine/act.ts', import.meta.url), 'utf-8'))
// v0.38.1（D177）：task_plan 落库管线（含 reconcile 调用）收敛到 plan-commit-pipeline.ts
const PIPELINE = stripComments(
  readFileSync(new URL('../../engine/plan-commit-pipeline.ts', import.meta.url), 'utf-8'),
)
const TURN_END = stripComments(readFileSync(new URL('../../engine/turn-end.ts', import.meta.url), 'utf-8'))

/* ============================================================
 * A. 运行时行为（applyPlanItemStatusesRobust 两级定位）
 * ============================================================ */

test('TC-D123-001 id 直查快路径：不变量成立时按 planItemId 命中节点', async () => {
  const task = await createTask({ title: 'D123 快路径', text: '', agentId: 'coder', modelId: 'test-model' })
  const g = graph([node({ id: 'nd_d123a', key: 'T-01', title: '对位节点', status: 'ready' })])
  await saveGraph(g, { skipSnapshot: true, taskId: task.id })

  const res = await applyPlanItemStatusesRobust(
    { taskId: task.id, graphId: g.id, iteration: 0 },
    [{ planItemId: 'nd_d123a', index: 0, to: 'done' }],
    'todo-update',
    'D123 快路径回归',
  )
  assert.equal(res.ok, true, 'id 直查应命中')

  const saved = await getGraphById(g.id)
  assert.equal(saved?.nodes['nd_d123a'].status, 'completed', '节点应转 completed')
})

test('TC-D123-002 id 断裂 → key 兜底：过期 planItem id 按 T-{index+1} 对位节点（核心回归）', async () => {
  const task = await createTask({ title: 'D123 key 兜底', text: '', agentId: 'coder', modelId: 'test-model' })
  const g = graph([
    node({ id: 'nd_d123b1', key: 'T-01', title: '第一项', status: 'ready' }),
    node({ id: 'nd_d123b2', key: 'T-02', title: '第二项', status: 'ready' }),
  ])
  await saveGraph(g, { skipSnapshot: true, taskId: task.id })

  // 断链形态：planItem.id 是重建清单的旧 id（图里查无此节点），但 key=T-02 对位第二项
  const res = await applyPlanItemStatusesRobust(
    { taskId: task.id, graphId: g.id, iteration: 0 },
    [{ planItemId: 'plan_1_1727000000000_stale', index: 1, to: 'done' }],
    'todo-update',
    'D123 key 兜底回归',
  )
  assert.equal(res.ok, true, 'id 断裂时 key 兜底应命中（原实现此处 NOT_FOUND 被静默吞掉）')

  const saved = await getGraphById(g.id)
  assert.equal(saved?.nodes['nd_d123b2'].status, 'completed', 'T-02 节点应转 completed（图通道不再滞留 ready）')
  assert.equal(saved?.nodes['nd_d123b1'].status, 'ready', '其余节点不受影响')
})

test('TC-D123-003 两级都未命中 → 返回 NOT_FOUND（不静默、不编造）', async () => {
  const task = await createTask({ title: 'D123 全断链', text: '', agentId: 'coder', modelId: 'test-model' })
  const g = graph([node({ id: 'nd_d123c', key: 'T-01', title: '唯一项', status: 'ready' })])
  await saveGraph(g, { skipSnapshot: true, taskId: task.id })

  const res = await applyPlanItemStatusesRobust(
    { taskId: task.id, graphId: g.id, iteration: 0 },
    [{ planItemId: 'plan_totally_broken', index: 3, to: 'done' }],
    'todo-update',
    'D123 全断链回归',
  )
  assert.equal(res.ok, false, '两级未命中必须显式失败')
  assert.equal(res.error?.code, 'NOT_FOUND')
  assert.match(res.error?.message ?? '', /key 兜底 T-04 也未命中/, '错误消息应含 key 兜底线索（人话诊断）')
})

test('TC-D123-004 图不存在 → NOT_FOUND（与 commitStatuses 同语义）', async () => {
  const res = await applyPlanItemStatusesRobust(
    { taskId: 'no-such-task', graphId: 'tg_20260923_nosuch', iteration: 0 },
    [{ planItemId: 'x', index: 0, to: 'done' }],
    'todo-update',
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'NOT_FOUND')
})

/* ============================================================
 * B. 源码契约（act.ts 消费结果 + turn-end 双通道对账）
 * ============================================================ */

/**
 * v0.37.0（缺陷 D132）**语义变更**：账本（TaskLedger）是清单唯一真相源，图是**派生层**。
 *
 * 旧契约（v0.36.4）要求「图写失败 → warn + **回退直写 tasks.json**」。
 * 但那条回退本身就是**第二个写入者**：图通道一降级，盘上就出现两份互相漂移的清单，
 * 正是本版要根治的病根（诊断 §2 L2 镜像回写放大）。
 *
 * 新契约：图写失败只置**降级标记** + warn + 结果摘要告知模型「以账本为准」；
 * 清单真相**绝不回写**（`planItems` 只能由账本投影产生）。
 */
/**
 * v0.38.1（缺陷 D174）**原语升级**：task_plan 的图镜像下推从
 * `applyPlanItemStatusesRobust`（只改既有节点状态）升级为
 * `reconcilePlanItemsToGraph`（结构对账：缺节点补建 / 多余节点 cancelled /
 * 状态文本 key 全量对齐）。降级契约不变：失败只置降级标记 + warn，
 * 清单真相绝不回写（`planItems` 只能由账本投影产生）。
 */
test('TC-D123-005 task_plan 消费图写结果：失败只置降级标记（不再回写清单真相）', () => {
  // v0.38.1（D177）：reconcile 调用与降级标记随落库管线收敛到 plan-commit-pipeline.ts，
  // act.ts task_plan 分支经 commitPlanDraft 间接消费 —— 断言目标随之指向管线本体。
  assert.match(PIPELINE, /reconcilePlanItemsToGraph\(/, '图镜像下推应使用结构对账原语（D174：续聊增项不再 NOT_FOUND）')
  assert.match(
    ACT,
    /commitPlanDraft\(/,
    'act.ts task_plan 必须经共享管线落库（不得自带第二套 reconcile 实现）',
  )
  assert.match(
    PIPELINE,
    /if \(!syncRes\.ok\) \{[\s\S]{0,400}?logger\.warn[\s\S]{0,400}?graphSyncDegraded = true/,
    '图写失败必须 warn 并置降级标记（原实现丢弃返回值 = 静默退化）',
  )
  // 否定性不变量：降级路径**不得**再直写 planItems（唯一写入口纪律 / D132）。
  assert.doesNotMatch(
    PIPELINE,
    /if \(!syncRes\.ok\) \{[\s\S]{0,600}?updateTask\([\s\S]{0,200}?planItems/,
    '图写失败不得回退直写 planItems —— 那会重新制造第二个写入者（D132）',
  )
  assert.match(
    ACT,
    /任务图通道本次未同步（清单账本已记录，以账本为准）[\s\S]{0,40}不要重做/,
    '降级时结果摘要应告知模型以账本为准（不要重做已完成项）',
  )
  assert.match(PIPELINE, /graphSyncDegraded = true/, '降级路径应置降级标记')
})

test('TC-D123-006 完成判据只取账本（唯一真相源）：图/镜像双通道对账补丁随第二套守卫退场', () => {
  // v0.36.4（D123）的「双通道对账」是给这样一个现场打的补丁：判据取图节点，
  // 而图通道可能滞后于清单镜像 → 逼模型重做已完成项。
  // v0.39.0（D183）：完成判据改成**读账本本身**（唯一真相源），第二套守卫删除 ——
  // 判据只剩一处，就不存在「两个通道谁滞后」的问题，补丁随之退场。
  assert.doesNotMatch(TURN_END, /graphLeftovers/, 'D183：图侧 leftover 判据已随第二套守卫退场')
  assert.doesNotMatch(TURN_END, /mirrorSettledCount/, 'D183：镜像对账补丁不再需要（账本即判据）')
  assert.doesNotMatch(TURN_END, /PLAN_ITEM_TERMINAL/, '同上')
  assert.doesNotMatch(TURN_END, /status === 'running' \|\| p\.status === 'pending'/, '无图分支的第二套判据同样退场')
  assert.match(TURN_END, /const verdict = await guardFinish\(/, '完成判据 = guardFinish（读账本）')
  assert.match(
    TURN_END,
    /verdict\.leftovers\.length > 0/,
    '在途项直接来自账本 verdict —— 不再二次过滤（二次过滤正是 D123 的成因）',
  )
})

/* ============================================================
 * C. v0.38.1 D174 — 结构对账（reconcilePlanItemsToGraph）
 *
 * 用户实测（「未命名任务 6」续聊「重新制定计划，考察并开发优化这个项目」）：
 * 模型按 D128/D172 纪律提交 7 项新清单 → 账本 plan-commit 生效（items=7），
 * 但图镜像下推走 applyPlanItemStatusesRobust 只能改既有节点 —— 新项 id 直查
 * 与 T-{index+1} key 兜底双双未命中 → 整批 NOT_FOUND → 图写降级 →
 * 账本 7 项 / 图 1 节点双通道漂移，任务面板（图投影）永远显示旧清单
 * （日志实证：ledger-sync items=7 ↔ engine-decide items=1 来回翻飞 +
 * 「节点不存在：li_muhwltpg_4lc0o（key 兜底 T-02 也未命中）」）。
 * ============================================================ */

const { reconcilePlanItemsToGraph, RECONCILE_SOURCE } = await import('../plan-sync.js')

/** 带 goal 节点的图（reconcile 要求 goal 层存在） */
function graphWithGoal(taskNodes: TaskNode[], over: Partial<TaskGraph> = {}): TaskGraph {
  const goal = node({
    id: 'nd_goal_d174',
    key: 'G',
    layer: 'goal',
    title: 'D174 对账目标',
    status: 'ready',
    children: taskNodes.map((n) => n.id),
  })
  const g = graph([goal, ...taskNodes], over)
  g.rootIds = [goal.id]
  return g
}

function item(id: string, text: string, status: 'pending' | 'running' | 'done' = 'pending') {
  return { id, text, status }
}

test('TC-D174-001 结构增长：旧 1 节点图 + 新 3 项清单 → 缺失节点补建（id=item.id 恢复 §4.7 不变量）', async () => {
  const task = await createTask({ title: 'D174 增长', text: '', agentId: 'coder', modelId: 'test-model' })
  const g = graphWithGoal([node({ id: 'nd_d174_old', key: 'T-01', title: '旧项', status: 'completed' })])
  await saveGraph(g, { skipSnapshot: true, taskId: task.id })

  const res = await reconcilePlanItemsToGraph(
    { taskId: task.id, graphId: g.id, iteration: 1 },
    [
      item('nd_d174_old', '旧项', 'done'),
      item('li_d174_new_a', '新工作甲', 'running'),
      item('li_d174_new_b', '新工作乙', 'pending'),
    ],
    'task-plan',
    'D174 续聊新增清单项',
  )
  assert.equal(res.ok, true, `结构对账应成功（原实现此处整批 NOT_FOUND）：${res.error?.message ?? ''}`)

  const saved = await getGraphById(g.id)
  assert.ok(saved)
  const taskNodes = Object.values(saved!.nodes).filter((n) => n.layer === 'task')
  assert.equal(taskNodes.length, 3, '图应有 3 个任务节点（1 既有 + 2 新建）')
  // 新节点 id = item.id：§4.7 planItemId === nodeId 不变量直接恢复
  assert.ok(saved!.nodes['li_d174_new_a'], '新建节点必须以 planItem.id 为 id')
  assert.ok(saved!.nodes['li_d174_new_b'], '新建节点必须以 planItem.id 为 id')
  assert.equal(saved!.nodes['li_d174_new_a']!.status, 'in_progress', 'running 项 → in_progress')
  assert.equal(saved!.nodes['li_d174_new_b']!.status, 'ready', 'pending 项 → ready')
  assert.equal(saved!.nodes['li_d174_new_a']!.parentId, 'nd_goal_d174', '新节点父级 = goal')
  // key 重排：T-01/T-02/T-03 与最终清单顺序一致
  const keys = taskNodes.map((n) => n.key).sort()
  assert.deepEqual(keys, ['T-01', 'T-02', 'T-03'], 'key 应按最终顺序重排')
  // goal.children 按清单顺序
  assert.deepEqual(
    saved!.nodes['nd_goal_d174']!.children,
    ['nd_d174_old', 'li_d174_new_a', 'li_d174_new_b'],
    'goal.children 应按最终清单顺序重排',
  )
  // 新节点留痕
  assert.deepEqual(saved!.nodes['li_d174_new_a']!.derivedFrom, [RECONCILE_SOURCE], '新建节点应带对账来源标记')
})

test('TC-D174-002 结构收缩：3 节点图 + 新 1 项清单 → 多余节点 cancelled 留痕（不物理删除）', async () => {
  const task = await createTask({ title: 'D174 收缩', text: '', agentId: 'coder', modelId: 'test-model' })
  const g = graphWithGoal([
    node({ id: 'nd_d174_s1', key: 'T-01', title: '保留项', status: 'in_progress' }),
    node({ id: 'nd_d174_s2', key: 'T-02', title: '将移除甲', status: 'ready' }),
    node({ id: 'nd_d174_s3', key: 'T-03', title: '将移除乙', status: 'ready' }),
  ])
  await saveGraph(g, { skipSnapshot: true, taskId: task.id })

  const res = await reconcilePlanItemsToGraph(
    { taskId: task.id, graphId: g.id, iteration: 1 },
    [item('nd_d174_s1', '保留项', 'running')],
    'task-plan',
    'D174 清单收缩',
  )
  assert.equal(res.ok, true)

  const saved = await getGraphById(g.id)
  assert.ok(saved)
  assert.equal(saved!.nodes['nd_d174_s1']!.status, 'in_progress', '保留项状态不受影响')
  assert.equal(saved!.nodes['nd_d174_s2']!.status, 'cancelled', '被移除项 → cancelled 留痕')
  assert.equal(saved!.nodes['nd_d174_s3']!.status, 'cancelled', '被移除项 → cancelled 留痕')
  assert.ok(saved!.nodes['nd_d174_s2'], '不物理删除节点（审计可查）')
  // children：清单项在前，被移除残余在末尾
  assert.deepEqual(
    saved!.nodes['nd_goal_d174']!.children,
    ['nd_d174_s1', 'nd_d174_s2', 'nd_d174_s3'],
    'children 顺序 = 清单项在前、残余在末尾',
  )
})

test('TC-D174-003 幂等：图已与清单一致时零变更不落盘（graphRevision 不变）', async () => {
  const task = await createTask({ title: 'D174 幂等', text: '', agentId: 'coder', modelId: 'test-model' })
  const g = graphWithGoal([node({ id: 'nd_d174_i1', key: 'T-01', title: '唯一项', status: 'ready' })])
  await saveGraph(g, { skipSnapshot: true, taskId: task.id })
  const before = (await getGraphById(g.id))!.graphRevision

  const items = [item('nd_d174_i1', '唯一项', 'pending')]
  const first = await reconcilePlanItemsToGraph(
    { taskId: task.id, graphId: g.id, iteration: 0 },
    items,
    'task-plan',
    'D174 首次对账',
  )
  assert.equal(first.ok, true)
  const afterFirst = (await getGraphById(g.id))!.graphRevision

  const second = await reconcilePlanItemsToGraph(
    { taskId: task.id, graphId: g.id, iteration: 0 },
    items,
    'task-plan',
    'D174 重复对账',
  )
  assert.equal(second.ok, true)
  const afterSecond = (await getGraphById(g.id))!.graphRevision
  assert.ok(afterSecond >= afterFirst, '图 revision 单调')
  assert.equal(afterSecond, afterFirst, '重复对账必须零写入（幂等；title/intent/key/状态全对齐后无 diff）')
  void before
})

test('TC-D174-004 空清单防御：不触发结构清空', async () => {
  const task = await createTask({ title: 'D174 空清单', text: '', agentId: 'coder', modelId: 'test-model' })
  const g = graphWithGoal([node({ id: 'nd_d174_e1', key: 'T-01', title: '唯一项', status: 'ready' })])
  await saveGraph(g, { skipSnapshot: true, taskId: task.id })

  const res = await reconcilePlanItemsToGraph(
    { taskId: task.id, graphId: g.id, iteration: 0 },
    [],
    'task-plan',
  )
  assert.equal(res.ok, true, '空清单直接放行（不把图清空）')
  const saved = await getGraphById(g.id)
  assert.equal(Object.values(saved!.nodes).filter((n) => n.layer === 'task').length, 1, '节点原样保留')
})
