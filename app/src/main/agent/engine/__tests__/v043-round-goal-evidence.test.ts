/* ============================================================
 * ArkWork — v0.43.0 任务清单侧边栏升级：引擎侧详测（TC-V043）
 *
 * 规格来源：docs/versions/v0.43.0/00-release-goal.md R1–R5
 *   R1 标题 = 本轮目标简介（plan-commit 的 reason 落 ledger.goal → 下推 graph.goal）
 *   R4 轮次（round）：replan（含新建项且账本原有项）→ round+1；新建项 stamp 新轮次
 *   R5 证据门禁：改状态 / replan 必须有理由；完成必须有产物证据（全模式降级 verifying）
 *
 * 手法：A 层真执行（临时工作区走真实 mutate / commitPlanDraft / reconcile），
 *      纯函数真值表（buildReplanNote）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs v043-round-goal-evidence
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, updateTask, getTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-v043-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const { ensureLedger, loadLedger, mutate } = await import('../../ledger/index.js')
const { commitPlanDraft } = await import('../plan-commit-pipeline.js')
const { buildReplanNote, REPLAN_NOTE_REASON_MAX } = await import('../turn-note-policy.js')

/* ---------------- 夹具 ---------------- */

async function newTask(texts: string[]): Promise<string> {
  const t = await createTask({
    title: `V043-${texts.length}`,
    text: texts[0] ?? '任务',
    agentId: 'default',
    modelId: 'm1',
  })
  const now = Date.now()
  await updateTask(t.id, {
    planItems: texts.map((text, i) => ({
      id: `p${i}`,
      text,
      status: i === 0 ? ('running' as const) : ('pending' as const),
      createdAt: now,
      updatedAt: now,
    })),
  })
  await ensureLedger((await getTask(t.id))!)
  return t.id
}

/** 空账本任务（无 planItems 播种）—— 用于「首次建计划」场景 */
async function emptyTask(): Promise<string> {
  const t = await createTask({ title: 'V043-empty', text: '空任务', agentId: 'default', modelId: 'm1' })
  await ensureLedger((await getTask(t.id))!) // 先建空账本（round=1，items 为空）
  return t.id
}

async function itemIds(taskId: string): Promise<string[]> {
  const l = await loadLedger(taskId)
  return (l?.items ?? []).map((it) => it.id)
}

/* ============================================================
 * 一、R4 轮次晋升
 * ============================================================ */

test('TC-V043-001 首次建计划（账本原空）不晋升轮次：round 保持 1，新建项 round=1', async () => {
  const id = await emptyTask()
  const r = await mutate(id, {
    kind: 'plan-commit',
    layout: [
      { kind: 'new', text: '第一步', status: 'running' },
      { kind: 'new', text: '第二步', status: 'pending' },
    ],
    reason: '首轮目标：搭好骨架',
    source: 'task-plan',
  })
  assert.ok(r.ok, r.error?.message)
  const l = (await loadLedger(id))!
  assert.equal(l.round, 1, '首次建计划不是 replan，轮次应为 1')
  assert.deepEqual(l.items.map((it) => it.round), [1, 1], '新建项 stamp 首轮次')
  assert.equal(l.goal, '首轮目标：搭好骨架', '首次建计划 reason 仍应落 goal（供面板标题）')
})

test('TC-V043-002 replan 晋升轮次：既有项保留旧轮次，新建项 stamp 新轮次，goal 更新', async () => {
  const id = await newTask(['旧任务 A', '旧任务 B'])
  const before = (await loadLedger(id))!
  const oldIds = before.items.map((it) => it.id)

  const r = await mutate(id, {
    kind: 'plan-commit',
    layout: [
      { kind: 'existing', id: oldIds[0]!, status: before.items[0]!.status },
      { kind: 'existing', id: oldIds[1]!, status: before.items[1]!.status },
      { kind: 'new', text: '本轮新增 C', status: 'pending' },
    ],
    reason: '依据新证据：需要补做 C',
    source: 'task-plan',
  })
  assert.ok(r.ok, r.error?.message)
  const l = (await loadLedger(id))!
  assert.equal(l.round, 2, '含新建项且账本原有项 = replan → 轮次 +1')
  assert.equal(l.goal, '依据新证据：需要补做 C', 'replan 的 reason 即本轮目标简介')
  const byText = new Map(l.items.map((it) => [it.text, it.round]))
  assert.equal(byText.get('旧任务 A'), 1, '既有项保留原轮次（只在「全部任务」可见）')
  assert.equal(byText.get('旧任务 B'), 1)
  assert.equal(byText.get('本轮新增 C'), 2, '新建项 stamp 新轮次（「本轮任务」判据）')
})

test('TC-V043-003 纯状态更新（无新建项）不晋升轮次', async () => {
  const id = await newTask(['任务 A', '任务 B'])
  const before = (await loadLedger(id))!
  const ids = before.items.map((it) => it.id)
  // 先晋升一次，确认基线为 2
  await mutate(id, {
    kind: 'plan-commit',
    layout: [
      { kind: 'existing', id: ids[0]!, status: before.items[0]!.status },
      { kind: 'existing', id: ids[1]!, status: before.items[1]!.status },
      { kind: 'new', text: '新增项', status: 'pending' },
    ],
    reason: '第一次 replan',
    source: 'task-plan',
  })
  const mid = (await loadLedger(id))!
  assert.equal(mid.round, 2)
  const midIds = mid.items.map((it) => it.id)
  // 仅改状态（带 artifact 以避免 R5 降级干扰）
  const r = await mutate(id, {
    kind: 'plan-commit',
    layout: midIds.map((iid) => ({
      kind: 'existing' as const,
      id: iid,
      status: 'done' as const,
      artifact: { path: 'out/x.md', kind: 'file' as const },
    })),
    reason: '全部完成',
    source: 'task-plan',
  })
  assert.ok(r.ok, r.error?.message)
  const l = (await loadLedger(id))!
  assert.equal(l.round, 2, '无新建项的纯状态更新不得晋升轮次')
})

/* ============================================================
 * 二、R1 本轮目标（goal）
 * ============================================================ */

test('TC-V043-004 首次建计划 reason 落 goal；replan 时 goal 覆盖为最新目标', async () => {
  const id = await emptyTask()
  await mutate(id, {
    kind: 'plan-commit',
    layout: [{ kind: 'new', text: 'A', status: 'running' }],
    reason: '目标一',
    source: 'task-plan',
  })
  assert.equal((await loadLedger(id))!.goal, '目标一')

  const ids = await itemIds(id)
  await mutate(id, {
    kind: 'plan-commit',
    layout: [
      { kind: 'existing', id: ids[0]!, status: 'running' },
      { kind: 'new', text: 'B', status: 'pending' },
    ],
    reason: '目标二：依据用户新要求调整',
    source: 'task-plan',
  })
  assert.equal((await loadLedger(id))!.goal, '目标二：依据用户新要求调整', 'replan 的 reason 覆盖本轮目标')
})

/* ============================================================
 * 三、R5 证据门禁（commitPlanDraft 落库前拦截）
 * ============================================================ */

test('TC-V043-005 状态变更无 reason → 管线拒绝（清单不落库）', async () => {
  const id = await newTask(['任务 A'])
  const ids = await itemIds(id)
  const r = await commitPlanDraft({
    task: { id, graphId: undefined },
    iteration: 1,
    draft: [{ text: '任务 A', status: 'done' }],
    reason: '',
    source: 'task-plan',
  })
  assert.equal(r.ok, false, '状态变更缺理由必须被拒')
  assert.match(r.errorMessage ?? '', /理由/, '拒绝理由须为人话，指明要填 reason')
  assert.equal((await loadLedger(id))!.items[0]!.status, 'running', '被拒后清单不得变化')
  assert.ok(ids.length > 0)
})

test('TC-V043-006 replan（新增项）无 reason → 管线拒绝；有 reason → 通过', async () => {
  const id = await newTask(['任务 A'])
  const rejected = await commitPlanDraft({
    task: { id, graphId: undefined },
    iteration: 1,
    draft: [
      { text: '任务 A', status: 'doing' },
      { text: '新增 B', status: 'todo' },
    ],
    reason: '',
    source: 'task-plan',
  })
  assert.equal(rejected.ok, false, 'replan 缺依据必须被拒')
  assert.match(rejected.errorMessage ?? '', /依据|理由/, '拒绝理由须为人话')

  const passed = await commitPlanDraft({
    task: { id, graphId: undefined },
    iteration: 1,
    draft: [
      { text: '任务 A', status: 'doing' },
      { text: '新增 B', status: 'todo' },
    ],
    reason: '用户追加需求 B',
    source: 'task-plan',
  })
  assert.equal(passed.ok, true, passed.errorMessage)
  assert.equal((await loadLedger(id))!.items.length, 2, '带依据的 replan 应落库')
})

/* ============================================================
 * 四、R5 replan 依据回执（纯函数真值表）
 * ============================================================ */

test('TC-V043-007 buildReplanNote 真值表：仅「真 replan」产回执', () => {
  // 首次建计划（账本原空）→ 无回执
  assert.equal(buildReplanNote(2, false, '首次建计划'), null, '首次建计划不是 replan，不产回执')
  // 无新建项 → 无回执
  assert.equal(buildReplanNote(0, true, '仅改状态'), null, '无新建项不产回执')
  // reason 空 → 无回执（防御：门禁已拦，这里再兜一层）
  assert.equal(buildReplanNote(1, true, '   '), null)
  // 真 replan → 回执含「本轮任务更新」+ 依据 + 新增数
  const note = buildReplanNote(3, true, '依据：跑测试发现两处回归')
  assert.ok(note, '真 replan 必须产回执')
  assert.match(note!, /本轮任务更新/)
  assert.match(note!, /依据：跑测试发现两处回归/)
  assert.match(note!, /新增 3 项/)
})

test('TC-V043-008 buildReplanNote 超长 reason 截断加省略号（不淹没交互区）', () => {
  const long = '理由'.repeat(REPLAN_NOTE_REASON_MAX)
  const note = buildReplanNote(1, true, long)!
  assert.ok(note.includes('…'), '超长依据应截断')
  assert.ok(note.length < long.length + 40, '回执长度应受限（截断生效）')
})

/* ============================================================
 * 五、R1 goal 下推 graph（reconcilePlanItemsToGraph goalText）
 * ============================================================ */

const { saveGraph } = await import('../../graph/store.js')
const { getGraphById } = await import('../../graph/sync.js')
const { reconcilePlanItemsToGraph } = await import('../../graph/plan-sync.js')
const { GRAPH_SCHEMA_VERSION, defaultPolicy, defaultVerification, generateGraphId } = await import('@shared/types/graph')

async function makeGraph(): Promise<{ graphId: string }> {
  const goalId = 'g_goal'
  const t1 = 'n1'
  const graphId = generateGraphId()
  const graph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    id: graphId,
    title: 'V043 goal 下推',
    goal: '旧目标',
    status: 'in_progress' as const,
    graphRevision: 1,
    spec: { state: 'draft' as const, scopeIn: [], scopeOut: [], assumptions: [], constraints: [], acceptance: [], contextRefs: [] },
    nodes: {
      [goalId]: {
        id: goalId, key: 'GOAL', parentId: null, layer: 'goal' as const, title: '目标', intent: '旧目标',
        status: 'ready' as const, assignee: { kind: 'system' as const }, priority: 'p0' as const,
        children: [t1], dependsOn: [], acceptance: [], evidence: [], verification: defaultVerification(),
        contextRefs: [], tokensUsed: 0, attempts: 0, sessionIds: [], createdAt: 1, updatedAt: 1, revision: 1,
      },
      [t1]: {
        id: t1, key: 'T-01', parentId: goalId, layer: 'task' as const, title: '任务一', intent: '任务一',
        status: 'ready' as const, assignee: { kind: 'system' as const }, priority: 'p1' as const,
        children: [], dependsOn: [], acceptance: [], evidence: [], verification: defaultVerification(),
        contextRefs: [], tokensUsed: 0, attempts: 0, sessionIds: [], createdAt: 1, updatedAt: 1, revision: 1,
      },
    },
    rootIds: [goalId],
    policy: defaultPolicy(),
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
  }
  // saveGraph 是异步落盘 API（store 层）
  await saveGraph(graph as never, { taskId: 't-v043-goal' })
  return { graphId }
}

test('TC-V043-009 reconcile 带 goalText → 下推 graph.goal；不带 → 不变', async () => {
  const { graphId } = await makeGraph()
  const ctx = { taskId: 't-v043-goal', graphId, iteration: 1 }

  const first = await reconcilePlanItemsToGraph(
    ctx,
    [{ id: 'n1', text: '任务一', status: 'running' }],
    'task-plan',
    'replan',
    '本轮目标：补齐失败用例',
  )
  assert.ok(first.ok, first.error?.message)
  assert.equal((await getGraphById(graphId))!.goal, '本轮目标：补齐失败用例', 'goalText 应下推到 graph.goal')

  const second = await reconcilePlanItemsToGraph(
    ctx,
    [{ id: 'n1', text: '任务一', status: 'running' }],
    'task-plan',
    '再次对账',
  )
  assert.ok(second.ok)
  assert.equal((await getGraphById(graphId))!.goal, '本轮目标：补齐失败用例', '未给 goalText 时 goal 不得被清空/改写')
})