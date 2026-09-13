/**
 * v0.30.0 内核冒烟套件 — TaskGraph 数据模型 / 不变量 / 迁移 / 投影 / 漂移 / Replan
 *
 * 对应文档：docs/versions/v0.30.0/testcases/01-smoke-suite.md
 * 用例 ID 前缀：TC-GRAPH（任务模型）/ TC-SYNC（内核 Sync）/ TC-REPLAN（重规划）
 *
 * 本套件是**密闭的**（不落盘、不调 LLM、不依赖网络）：全部用内存构造的图 +
 * 纯函数入口验证。落盘路径由 store 的行为测试覆盖（另见 tc-store）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALLOWED_TRANSITIONS,
  GRAPH_SCHEMA_VERSION,
  NODE_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
  computeWaves,
  countStatuses,
  defaultPolicy,
  defaultVerification,
  flattenGraph,
  findBlockedNodes,
  generateGraphId,
  generateNodeId,
  isValidGraphId,
  subtreeIds,
  type AcceptanceCriterion,
  type Evidence,
  type NodeStatus,
  type ReplanPatch,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import {
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  validateGraph,
  validateWrite,
} from '../invariants.js'
import { mapPlanItemStatusToNodeStatus, migrateToGraph, sealGraphAtTurnEnd } from '../migrate.js'
import { applyModelClaim, syncAfterAct } from '../write.js'
import { mirrorPlanItems } from '../store.js'
import { computeDrift } from '../drift.js'
import { buildThreeSegInjection, renderActiveWindow } from '../project.js'
import { evaluateEvents } from '../events.js'
import { applyPatch, buildPatch, computeImpact, decideApprovalLevel } from '../replan.js'
import type { PlanItem } from '@shared/types/task'

/* ============================================================
 * 构造器
 * ============================================================ */

function node(over: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.id}`,
    intent: '测试用意图', // I7：默认给一个，避免每个用例都被 I7 拦
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
    title: '测试图',
    goal: '验证 TaskGraph 内核行为',
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

function ac(id: string, status: AcceptanceCriterion['status'] = 'pending', command?: string): AcceptanceCriterion {
  return {
    id,
    statement: `WHEN 条件 THE SYSTEM SHALL 行为（${id}）`,
    type: command ? 'command' : 'manual',
    verify: command ? { command, expectExitCode: 0 } : undefined,
    status,
    coveredBy: [],
  }
}

const ev = (kind: Evidence['kind'], summary = 's'): Evidence => ({
  kind,
  summary,
  at: 1,
  by: { kind: 'agent', id: 'agent' },
})

/* ============================================================
 * TC-GRAPH：数据模型与不变量
 * ============================================================ */

test('TC-GRAPH-001 状态机常量自洽：11 态、终态不含 needs_human/verifying', () => {
  assert.equal(NODE_STATUSES.length, 11)
  assert.equal(TERMINAL_STATUSES.has('completed'), true)
  assert.equal(TERMINAL_STATUSES.has('cancelled'), true)
  // needs_human 与 verifying 都**不是**终态 —— 这正是它们存在的意义
  assert.equal(TERMINAL_STATUSES.has('needs_human'), false)
  assert.equal(TERMINAL_STATUSES.has('verifying'), false)
  for (const s of NODE_STATUSES) assert.ok(Array.isArray(ALLOWED_TRANSITIONS[s]), `缺少 ${s} 的转换表`)
})

test('TC-GRAPH-002 转换表：verifying 不能回到 in_progress，needs_human 不能直通 completed', () => {
  assert.equal(canTransition('verifying', 'in_progress'), false)
  assert.equal(canTransition('verifying', 'completed'), true)
  assert.equal(canTransition('needs_human', 'completed'), false)
  assert.equal(canTransition('needs_human', 'ready'), true)
  // 幂等：同状态视为合法
  assert.equal(canTransition('completed', 'completed'), true)
  // 终态不可逆
  assert.equal(canTransition('completed', 'in_progress'), false)
})

test('TC-GRAPH-003 I1：两个 in_progress → 违规；maxParallel=2 → 通过', () => {
  const g1 = graph([node({ id: 'a', status: 'in_progress' }), node({ id: 'b', status: 'in_progress' })])
  const err = checkI1(g1)
  assert.ok(err)
  assert.equal(err!.invariant, 'I1')

  const g2 = graph(
    [node({ id: 'a', status: 'in_progress' }), node({ id: 'b', status: 'in_progress' })],
    { policy: defaultPolicy({ maxParallel: 2 }) },
  )
  assert.equal(checkI1(g2), null)
})

test('TC-GRAPH-004 I2：completed 无充分证据被拒；只有 diff 被拒；有 test 通过', () => {
  const noEv = graph([node({ id: 'a', status: 'completed' })])
  assert.equal(checkI2(noEv)?.invariant, 'I2')

  // diff 只能证明"改了"，不能证明"对了" —— 单独出现必须被拒
  const onlyDiff = graph([node({ id: 'a', status: 'completed', evidence: [ev('diff')] })])
  assert.equal(checkI2(onlyDiff)?.invariant, 'I2')

  const withTest = graph([node({ id: 'a', status: 'completed', evidence: [ev('test')] })])
  assert.equal(checkI2(withTest), null)

  // human 可信度最高，同样充分
  const withHuman = graph([node({ id: 'a', status: 'completed', evidence: [ev('human')] })])
  assert.equal(checkI2(withHuman), null)
})

test('TC-GRAPH-005 I2：AC 未全部 passing/waived 时不允许 completed', () => {
  const pending = graph([
    node({ id: 'a', status: 'completed', evidence: [ev('test')], acceptance: [ac('AC-01', 'pending')] }),
  ])
  assert.equal(checkI2(pending)?.invariant, 'I2')

  const passing = graph([
    node({ id: 'a', status: 'completed', evidence: [ev('test')], acceptance: [ac('AC-01', 'passing')] }),
  ])
  assert.equal(checkI2(passing), null)

  // waived 也算通过（"确实不再适用"是合法结论，但必须显式标注）
  const waived = graph([
    node({ id: 'a', status: 'completed', evidence: [ev('test')], acceptance: [ac('AC-01', 'waived')] }),
  ])
  assert.equal(checkI2(waived), null)
})

test('TC-GRAPH-006 I2：in_progress → completed 且 required=true 时被判定为"跳过 verifying"', () => {
  const n = node({
    id: 'a',
    status: 'completed',
    evidence: [ev('test')],
    verification: defaultVerification({ required: true, allowSelfAttest: false }),
  })
  const g = graph([n])
  const err = checkI2(g, { kind: 'node-status', nodeId: 'a', from: 'in_progress', to: 'completed' })
  assert.equal(err?.invariant, 'I2')

  // allowSelfAttest=true 时允许直通（用户显式开启的降级通道）
  const selfAttest = graph([
    node({
      id: 'a',
      status: 'completed',
      evidence: [ev('test')],
      verification: defaultVerification({ required: true, allowSelfAttest: true }),
    }),
  ])
  assert.equal(
    checkI2(selfAttest, { kind: 'node-status', nodeId: 'a', from: 'in_progress', to: 'completed' }),
    null,
  )
})

test('TC-GRAPH-007 I3：approved 后改写 AC 陈述被拒；新增 AC 或标 waived 允许', () => {
  const prev = graph([node({ id: 'a', acceptance: [ac('AC-01', 'passing')] })], {
    spec: { ...graph([]).spec, state: 'approved' },
  })
  const rewritten = {
    ...prev,
    nodes: { a: { ...prev.nodes.a, acceptance: [{ ...ac('AC-01', 'passing'), statement: '被弱化后的陈述' }] } },
  }
  assert.equal(checkI3(prev, rewritten)?.invariant, 'I3')

  const waived = {
    ...prev,
    nodes: { a: { ...prev.nodes.a, acceptance: [{ ...ac('AC-01', 'waived') }] } },
  }
  assert.equal(checkI3(prev, waived), null)

  const added = {
    ...prev,
    nodes: { a: { ...prev.nodes.a, acceptance: [...prev.nodes.a.acceptance, ac('AC-02')] } },
  }
  assert.equal(checkI3(prev, added), null)
})

test('TC-GRAPH-008 I3：verify.command 被弱化（严格→宽松）同样被拒', () => {
  const prev = graph([node({ id: 'a', acceptance: [ac('AC-01', 'passing', 'npm test -- auth:strict')] })], {
    spec: { ...graph([]).spec, state: 'approved' },
  })
  const loosened = {
    ...prev,
    nodes: { a: { ...prev.nodes.a, acceptance: [ac('AC-01', 'passing', 'npm test -- auth')] } },
  }
  assert.equal(checkI3(prev, loosened)?.invariant, 'I3')
})

test('TC-GRAPH-009 I4：依赖成环被拒；悬空依赖被拒', () => {
  const cyclic = graph([
    node({ id: 'a', dependsOn: ['b'] }),
    node({ id: 'b', dependsOn: ['a'] }),
  ])
  assert.equal(checkI4(cyclic)?.invariant, 'I4')

  const dangling = graph([node({ id: 'a', dependsOn: ['ghost'] })])
  assert.equal(checkI4(dangling)?.invariant, 'I4')

  const ok = graph([node({ id: 'a' }), node({ id: 'b', dependsOn: ['a'] })])
  assert.equal(checkI4(ok), null)
})

test('TC-GRAPH-010 I5：父节点 completed 但子节点未完成 → 违规', () => {
  const bad = graph([
    node({ id: 'p', status: 'completed', children: ['c'], evidence: [ev('test')] }),
    node({ id: 'c', parentId: 'p', status: 'in_progress' }),
  ])
  assert.equal(checkI5(bad)?.invariant, 'I5')

  // 子节点被取消（主动不做）时父节点可完成
  const okCancel = graph([
    node({ id: 'p', status: 'completed', children: ['c'], evidence: [ev('test')] }),
    node({ id: 'c', parentId: 'p', status: 'cancelled' }),
  ])
  assert.equal(checkI5(okCancel), null)
})

test('TC-GRAPH-011 I6：needs_human 缺 blockingQuestion 或缺 blockingSince → 违规', () => {
  const noQ = graph([node({ id: 'a', status: 'needs_human', blockingSince: 1 })])
  assert.equal(checkI6(noQ)?.invariant, 'I6')

  const noSince = graph([node({ id: 'a', status: 'needs_human', blockingQuestion: '选哪个？' })])
  assert.equal(checkI6(noSince)?.invariant, 'I6')

  const ok = graph([node({ id: 'a', status: 'needs_human', blockingQuestion: '选哪个？', blockingSince: 1 })])
  assert.equal(checkI6(ok), null)
})

test('TC-GRAPH-012 I7：既无 derivedFrom 也无 intent → 违规', () => {
  const bare = graph([node({ id: 'a', intent: undefined })])
  assert.equal(checkI7(bare)?.invariant, 'I7')

  const withDerived = graph([node({ id: 'a', intent: undefined, derivedFrom: ['AC-01'] })])
  assert.equal(checkI7(withDerived), null)
})

test('TC-GRAPH-013 validateWrite 按 I1→I7 顺序返回第一个违规（确定性）', () => {
  // 同时违反 I1（两个 in_progress）与 I7（无 intent）→ 应返回 I1
  const g = graph([
    node({ id: 'a', status: 'in_progress', intent: undefined, derivedFrom: undefined }),
    node({ id: 'b', status: 'in_progress' }),
  ])
  const err = validateWrite(g)
  assert.equal(err?.invariant, 'I1')
})

test('TC-GRAPH-014 validateGraph 一次性返回全部违规（加载自检语义）', () => {
  const g = graph([
    node({ id: 'a', status: 'completed' }), // I2
    node({ id: 'b', status: 'needs_human', blockingSince: 1 }), // I6
    node({ id: 'c', intent: undefined }), // I7
  ])
  const errs = validateGraph(g)
  const ids = errs.map((e) => e.invariant).sort()
  assert.deepEqual(ids, ['I2', 'I6', 'I7'])
})

test('TC-GRAPH-015 computeWaves：按 dependsOn 推导并行分层；成环返回 null', () => {
  const g = graph([
    node({ id: 'a' }),
    node({ id: 'b' }),
    node({ id: 'c', dependsOn: ['a', 'b'] }),
    node({ id: 'd', dependsOn: ['c'] }),
  ])
  const waves = computeWaves(g)
  assert.ok(waves)
  assert.equal(waves!.length, 3)
  assert.deepEqual(waves![0].sort(), ['a', 'b'])
  assert.deepEqual(waves![1], ['c'])
  assert.deepEqual(waves![2], ['d'])

  const cyclic = graph([node({ id: 'x', dependsOn: ['y'] }), node({ id: 'y', dependsOn: ['x'] })])
  assert.equal(computeWaves(cyclic), null)
})

test('TC-GRAPH-016 flattenGraph：needs_human / failed 永不自动折叠', () => {
  const g = graph([
    node({
      id: 'p',
      status: 'completed',
      children: ['doneChild'],
      evidence: [ev('test')],
    }),
    node({ id: 'doneChild', parentId: 'p', status: 'completed', evidence: [ev('test')] }),
    node({ id: 'human', status: 'needs_human', children: ['hChild'], blockingQuestion: 'q', blockingSince: 1 }),
    node({ id: 'hChild', parentId: 'human', status: 'ready' }),
  ])
  const rows = flattenGraph(g)
  const ids = rows.map((r) => r.id)
  // 已完成的 p 被折叠 → 它的子节点不出现在行里
  assert.ok(!ids.includes('doneChild'))
  // needs_human 的子节点必须出现（永不折叠）
  assert.ok(ids.includes('hChild'))
})

test('TC-GRAPH-017 countStatuses / isValidGraphId 边界', () => {
  const g = graph([node({ id: 'a', status: 'ready' }), node({ id: 'b', status: 'completed', evidence: [ev('test')] })])
  const c = countStatuses(g)
  assert.equal(c.total, 2)
  assert.equal(c.ready, 1)
  assert.equal(c.completed, 1)

  assert.equal(isValidGraphId('tg_20260913_ab12cd'), true)
  // 目录穿越防护：这些必须被拒
  assert.equal(isValidGraphId('../../etc/passwd'), false)
  assert.equal(isValidGraphId('tg_..%2f..'), false)
  assert.equal(isValidGraphId(''), false)
})

test('TC-GRAPH-018 id 生成：格式正确且不重复（v0.4.0-rev2 的随机后缀策略）', () => {
  const ids = new Set<string>()
  for (let i = 0; i < 200; i++) {
    const id = generateGraphId()
    assert.ok(isValidGraphId(id), `非法 id: ${id}`)
    ids.add(id)
  }
  // 200 次生成（36^6 ≈ 22 亿空间）不应出现碰撞
  assert.equal(ids.size, 200)
  assert.match(generateNodeId(), /^t_[a-z0-9]{1,6}$/)
})

test('TC-GRAPH-019 findBlockedNodes 按阻塞时间升序（面板置顶区顺序）', () => {
  const g = graph([
    node({ id: 'late', status: 'needs_human', blockingQuestion: 'q', blockingSince: 200 }),
    node({ id: 'early', status: 'needs_human', blockingQuestion: 'q', blockingSince: 100 }),
  ])
  assert.deepEqual(
    findBlockedNodes(g).map((n) => n.id),
    ['early', 'late'],
  )
})

test('TC-GRAPH-020 subtreeIds：含自身与全部后代', () => {
  const g = graph([
    node({ id: 'r', children: ['c1', 'c2'] }),
    node({ id: 'c1', parentId: 'r', children: ['c1a'] }),
    node({ id: 'c1a', parentId: 'c1' }),
    node({ id: 'c2', parentId: 'r' }),
  ])
  assert.deepEqual(subtreeIds(g, 'r').sort(), ['c1', 'c1a', 'c2', 'r'])
})

/* ============================================================
 * TC-SYNC：迁移 / 投影 / 漂移 / 写回 / 事件
 * ============================================================ */

test('TC-SYNC-001 迁移：空清单不建图（轻量模式）', () => {
  const g = migrateToGraph({ taskId: 'T-1', title: 't', goal: 'g', planItems: [] })
  assert.equal(g, null)
})

test('TC-SYNC-002 迁移：六态 → 十一态映射正确，skipped → cancelled', () => {
  assert.equal(mapPlanItemStatusToNodeStatus('done'), 'completed')
  assert.equal(mapPlanItemStatusToNodeStatus('running'), 'in_progress')
  assert.equal(mapPlanItemStatusToNodeStatus('pending'), 'ready')
  assert.equal(mapPlanItemStatusToNodeStatus('failed'), 'failed')
  assert.equal(mapPlanItemStatusToNodeStatus('cancelled'), 'cancelled')
  assert.equal(mapPlanItemStatusToNodeStatus('skipped'), 'cancelled')
})

test('TC-SYNC-003 迁移：v0.29 的 source（8 种）被映射进 Revision，不丢留痕', () => {
  const items: PlanItem[] = [
    { id: 'p1', text: '调研开源项目', status: 'done', createdAt: 1, updatedAt: 2, source: 'engine-decide' },
    { id: 'p2', text: '写 PRD', status: 'done', createdAt: 1, updatedAt: 3, source: 'todo-update' },
    { id: 'p3', text: '用户手动取消的项', status: 'cancelled', createdAt: 1, updatedAt: 4, source: 'user-cancel' },
  ]
  const g = migrateToGraph({ taskId: 'T-1', title: '标题', goal: '目标', planItems: items, now: 100 })
  assert.ok(g)
  assert.equal(g!.policy.tier, 2)
  // 三个迁移节点的 status Revision + 1 条 migrate Revision
  const statusRevs = g!.revisions.filter((r) => r.op === 'status')
  assert.equal(statusRevs.length, 3)
  assert.ok(statusRevs.some((r) => r.by.kind === 'system' && r.reason?.includes('engine-decide')))
  assert.ok(statusRevs.some((r) => r.by.kind === 'agent' && r.reason?.includes('模型显式写回')))
  assert.ok(statusRevs.some((r) => r.by.kind === 'human' && r.reason?.includes('用户手动取消')))
  assert.ok(g!.revisions.some((r) => r.op === 'migrate'))
})

test('TC-SYNC-004 迁移：多个 running 被校正为一个（否则 I1 会拒绝加载整张图）', () => {
  const items: PlanItem[] = [
    { id: 'p1', text: 'a', status: 'running', createdAt: 1, updatedAt: 1 },
    { id: 'p2', text: 'b', status: 'running', createdAt: 1, updatedAt: 1 },
    { id: 'p3', text: 'c', status: 'running', createdAt: 1, updatedAt: 1 },
  ]
  const g = migrateToGraph({ taskId: 'T-1', title: 't', goal: 'g', planItems: items, now: 1 })
  assert.ok(g)
  const running = Object.values(g!.nodes).filter((n) => n.status === 'in_progress')
  assert.equal(running.length, 1, '只能有一个 in_progress')
  assert.equal(checkI1(g!), null)
  assert.equal(validateGraph(g!).length, 0, '迁移产物必须通过全部不变量')
})

test('TC-SYNC-005 迁移：completed 项补齐合成证据（满足 I2），且不设 verification.required', () => {
  const items: PlanItem[] = [{ id: 'p1', text: '做完了的项', status: 'done', createdAt: 1, updatedAt: 2 }]
  const g = migrateToGraph({ taskId: 'T-1', title: 't', goal: 'g', planItems: items, now: 1 })
  const n = Object.values(g!.nodes).find((x) => x.layer === 'task')!
  assert.equal(n.status, 'completed')
  assert.equal(n.evidence.length, 1)
  assert.equal(n.evidence[0].kind, 'human')
  // 关键取舍：老任务不设 required，否则一打开就卡在 verifying
  assert.equal(n.verification.required, false)
  assert.equal(checkI2(g!), null)
})

test('TC-SYNC-006 sealGraphAtTurnEnd：failed 只收敛在途节点；cancelled 额外收敛排队节点', () => {
  const g = graph([
    node({ id: 'run', status: 'in_progress' }),
    node({ id: 'queue', status: 'ready' }),
    node({ id: 'done', status: 'completed', evidence: [ev('test')] }),
  ])
  const failed = sealGraphAtTurnEnd(g, 'failed', '超迭代')
  assert.equal(failed.graph.nodes.run.status, 'failed')
  assert.equal(failed.graph.nodes.queue.status, 'ready', '失败不应连坐排队项')
  assert.equal(failed.graph.nodes.done.status, 'completed')

  const cancelled = sealGraphAtTurnEnd(g, 'cancelled', '用户取消')
  assert.equal(cancelled.graph.nodes.run.status, 'cancelled')
  assert.equal(cancelled.graph.nodes.queue.status, 'cancelled')
  assert.equal(cancelled.graph.nodes.done.status, 'completed')
})

test('TC-SYNC-007 mirrorPlanItems：verifying / needs_human 必须映射为 running，绝不显示为 done', () => {
  const g = graph([
    node({ id: 'v', status: 'verifying' }),
    node({ id: 'h', status: 'needs_human', blockingQuestion: 'q', blockingSince: 1 }),
    node({ id: 'd', status: 'completed', evidence: [ev('test')] }),
    node({ id: 'c', status: 'cancelled' }),
  ])
  const items = mirrorPlanItems(g)
  const byId = new Map(items.map((i) => [i.id, i.status]))
  assert.equal(byId.get('v'), 'running', 'verifying 仍是在途，不能显示完成')
  assert.equal(byId.get('h'), 'running', 'needs_human 仍是在途')
  assert.equal(byId.get('d'), 'done')
  assert.equal(byId.get('c'), 'cancelled')
  // goal 节点不进扁平清单
  assert.equal(items.length, 4)
})

test('TC-SYNC-008 renderActiveWindow：超预算时按 DONE → NEXT → 验收细节 顺序裁剪', () => {
  // 构造一个明显超预算的图：3 个 ready + 当前任务带 2 条长验收
  const longAcc = (i: number) =>
    ac(`AC-${i}`, 'pending', `npm test -- very-long-suite-name-number-${i} --with-many-flags --and-more`)
  const g = graph(
    [
      node({
        id: 'now',
        status: 'in_progress',
        key: 'T-03',
        title: '实现 JWT 刷新逻辑（含并发与竞态处理）',
        acceptance: [longAcc(1), longAcc(2)],
      }),
      node({ id: 'r1', status: 'ready', key: 'T-04', title: '补全单元测试覆盖回归用例' }),
      node({ id: 'r2', status: 'ready', key: 'T-05', title: '运行 typecheck 与 lint 确认无回归' }),
      node({ id: 'r3', status: 'ready', key: 'T-06', title: '打包并验证产物' }),
    ],
    { policy: defaultPolicy({ tier: 3 }) },
  )
  const tight = renderActiveWindow(g, { budget: 60 })
  assert.ok(tight.tokens <= 60 || tight.text.includes('[NOW]'), '要么进预算，要么至少保住 NOW 行')
  assert.ok(tight.trimmed.length > 0, '预算极紧时必须有裁剪记录（用于 H1 埋点）')
  assert.ok(tight.text.includes('[NOW]'), 'NOW 行是硬底线，不允许被裁掉')

  const loose = renderActiveWindow(g, { budget: 100_000 })
  assert.equal(loose.trimmed.length, 0)
  assert.ok(loose.text.includes('[NEXT]'), '宽预算下应有 NEXT 前瞻')
  assert.ok(loose.text.includes('验收:'), '宽预算下应带验收条件（对抗 F2 过早完成）')
})

test('TC-SYNC-009 buildThreeSegInjection：三段合计 ≤1200 tok（固定成本必须可控）', () => {
  const g = graph([node({ id: 'a', status: 'in_progress', key: 'T-01', title: '短任务' })], {
    spec: { ...graph([]).spec, scopeOut: ['不做移动端', '不做邮件推送'] },
  })
  const inj = buildThreeSegInjection(g)
  assert.ok(inj.totalTokens <= 1200, `三段合计 ${inj.totalTokens} 超预算`)
  assert.equal(inj.overBudget, false)
  assert.ok(inj.anchorText.includes('[GOAL]'), '锚点必须含 GOAL')
  assert.ok(inj.anchorText.includes('[SCOPE-OUT]'), '锚点必须含 SCOPE-OUT（防范围蔓延）')
  assert.ok(inj.windowText.includes('[NOW]'))
  assert.ok(inj.afterToolText.includes('→'))
})

test('TC-SYNC-010 Drift：命中声明文件 → 高分；持续低分 2 轮 → hard 干预', () => {
  const g = graph([
    node({
      id: 'a',
      status: 'in_progress',
      intent: '修复 auth token 过期判定',
      contextRefs: [{ kind: 'file', ref: 'src/auth/session.ts' }],
    }),
  ])
  const hit = computeDrift(
    g,
    { toolNames: ['file-editor'], files: ['src/auth/session.ts'], symbols: [], descriptions: ['修改 auth session'] },
    0,
    'a',
  )
  assert.equal(hit.action, 'none')
  assert.equal(hit.streak, 0)

  // 第一轮偏离：soft（未达 streak 阈值）
  const off1 = computeDrift(
    g,
    { toolNames: ['file-editor'], files: ['src/billing/invoice.ts'], symbols: [], descriptions: ['重构 billing 模块'] },
    0,
    'a',
  )
  assert.equal(off1.score < 0.4, true, `期望低分，实际 ${off1.score}`)
  assert.equal(off1.action, 'soft', '第 1 轮不应硬干预')
  assert.equal(off1.streak, 1)

  // 第二轮仍偏离 → hard
  const off2 = computeDrift(
    g,
    { toolNames: ['file-editor'], files: ['src/billing/invoice.ts'], symbols: [], descriptions: ['继续重构 billing'] },
    off1.streak,
    'a',
  )
  assert.equal(off2.action, 'hard')
  assert.equal(off2.streak, 2)
})

test('TC-SYNC-011 Drift：无声明文件时文件信号为 null（不惩罚"声明不全"的节点）', () => {
  const g = graph([node({ id: 'a', status: 'in_progress', contextRefs: [] })])
  const r = computeDrift(
    g,
    { toolNames: ['file-editor'], files: ['src/anything.ts'], symbols: [], descriptions: ['随便改'] },
    0,
    'a',
  )
  // 文件信号必须为 null —— 节点没声明文件时无法比对，判定等于惩罚"声明不全"
  assert.equal(r.signals.file, null)
  assert.equal(r.signals.symbol, null)
  // 但"语义"信号仍可用（有 intent 就比对得到）：动作与意图无关时给出软提示是正确的
  assert.notEqual(r.signals.semantic, null)

  // 动作与 intent 一致时 → 不报漂移
  const aligned = computeDrift(
    g,
    {
      toolNames: ['file-editor'],
      files: ['src/anything.ts'],
      symbols: [],
      descriptions: ['测试用意图 相关改动'],
    },
    0,
    'a',
  )
  assert.equal(aligned.action, 'none')
})

test('TC-SYNC-012 Drift：纯文本回合不判定漂移，也不清空 streak', () => {
  const g = graph([node({ id: 'a', status: 'in_progress' })])
  const r = computeDrift(g, { toolNames: [], files: [], symbols: [], descriptions: [] }, 1, 'a')
  assert.equal(r.action, 'none')
  assert.equal(r.streak, 1, '说一句话不应洗白已有的偏离计数')
})

test('TC-SYNC-013 Write：普通工具成功不再自动推进（v0.29 行为的刻意移除）', () => {
  const g = graph([node({ id: 'a', status: 'in_progress', key: 'T-01' })])
  const res = syncAfterAct(g, { toolName: 'file-writer', ok: true, args: { path: 'src/x.ts' } })
  assert.equal(res.graph.nodes.a.status, 'in_progress', '改了文件 ≠ 做完了')
})

test('TC-SYNC-014 Write：验证命令通过 + AC 全过 → 自动 completed 并落证据', () => {
  const g = graph([
    node({
      id: 'a',
      status: 'verifying',
      key: 'T-01',
      acceptance: [ac('AC-01', 'pending', 'npm test -- auth')],
      verification: defaultVerification({ required: true, command: 'npm test -- auth' }),
    }),
  ])
  const res = syncAfterAct(g, {
    toolName: 'shell',
    ok: true,
    args: {},
    command: 'npm test -- auth',
    exitCode: 0,
  })
  const n = res.graph.nodes.a
  assert.equal(n.acceptance[0].status, 'passing')
  assert.ok(n.evidence.some((e) => e.kind === 'test'))
  assert.equal(n.status, 'completed')
})

test('TC-SYNC-015 Write：验证失败未超上限 → 回 in_progress 自动重试；超上限 → failed', () => {
  const base = node({
    id: 'a',
    status: 'verifying',
    key: 'T-01',
    acceptance: [ac('AC-01', 'pending', 'npm test -- auth')],
    verification: defaultVerification({ required: true, command: 'npm test -- auth', maxAttempts: 2 }),
  })

  const first = syncAfterAct(graph([{ ...base }]), {
    toolName: 'shell',
    ok: false,
    args: {},
    command: 'npm test -- auth',
    exitCode: 1,
    errorMessage: '1 failed',
  })
  assert.equal(first.graph.nodes.a.attempts, 1)
  const failedAc = first.graph.nodes.a.acceptance[0]
  // 把 AC 改回 pending 以便再验一次（真实流程里下一次验证会覆盖它）
  assert.equal(failedAc.status, 'failing')

  const second = syncAfterAct(graph([{ ...base, attempts: 1 }]), {
    toolName: 'shell',
    ok: false,
    args: {},
    command: 'npm test -- auth',
    exitCode: 1,
    errorMessage: '1 failed',
  })
  assert.equal(second.graph.nodes.a.attempts, 2)
  assert.equal(second.graph.nodes.a.status, 'failed', '达到 maxAttempts 应 failed')
})

test('TC-SYNC-016 Write：依赖完成后 blocked 自动解除（并且随即被调度为 in_progress）', () => {
  const g = graph([
    node({ id: 'dep', status: 'completed', evidence: [ev('test')] }),
    node({ id: 'blocked', status: 'blocked', dependsOn: ['dep'] }),
  ])
  const res = syncAfterAct(g, { toolName: 'file-reader', ok: true, args: { path: 'a.ts' } })
  // 解除阻塞这个动作必须发生（有对应的变更记录）
  const unblock = res.changes.find((c) => c.nodeId === 'blocked' && c.from === 'blocked')
  assert.ok(unblock, '应记录 blocked → ready 的变更')
  assert.equal(unblock!.to, 'ready')
  // 且随后被"无 in_progress 时自动推进"接管（同一轮内的第二步），故最终可能在途
  assert.ok(['ready', 'in_progress'].includes(res.graph.nodes.blocked.status))
  assert.equal(res.graph.nodes.blocked.status, 'in_progress', '同一轮内应被调度起来')
})

test('TC-SYNC-017 Write：无 in_progress 时自动推进首个就绪项（v0.19 的"清单卡死"修复保留）', () => {
  const g = graph([node({ id: 'q', status: 'ready' })])
  const res = syncAfterAct(g, { toolName: 'file-reader', ok: true, args: {} })
  assert.equal(res.graph.nodes.q.status, 'in_progress')
})

test('TC-SYNC-018 完成宣称：required=true 且缺证据 → 置 verifying 并返回验证触发（不接受自证）', () => {
  const g = graph([
    node({
      id: 'a',
      status: 'in_progress',
      key: 'T-01',
      acceptance: [ac('AC-01', 'pending', 'npm test -- auth')],
      verification: defaultVerification({ required: true, command: 'npm test -- auth' }),
    }),
  ])
  const res = applyModelClaim(g, { summary: '我做完了', nodeId: 'a' })
  assert.equal(res.graph.nodes.a.status, 'verifying', '不能直接 completed')
  assert.ok(res.verifyTrigger)
  assert.equal(res.verifyTrigger!.command, 'npm test -- auth')
})

test('TC-SYNC-019 完成宣称：required=false → 补证据后 completed（仍不允许零证据）', () => {
  const g = graph([node({ id: 'a', status: 'in_progress', key: 'T-01', title: '改文档' })])
  const res = applyModelClaim(g, { summary: '文档已更新' })
  assert.equal(res.graph.nodes.a.status, 'completed')
  assert.equal(res.graph.nodes.a.evidence.length, 1)
  assert.equal(checkI2(res.graph), null)
})

test('TC-SYNC-020 事件判定：E1 连续失败 / E8 预算压力 / E9 定时兜底 / E7 验收脱节', () => {
  // E1
  const failed = graph([
    node({
      id: 'a',
      status: 'failed',
      attempts: 3,
      verification: defaultVerification({ maxAttempts: 3 }),
    }),
  ])
  assert.ok(evaluateEvents(failed).some((d) => d.event === 'E1'))

  // E8
  const overBudget = graph([
    node({ id: 'a', status: 'in_progress', tokensUsed: 9000, tokenBudget: 10000 }),
  ])
  assert.ok(evaluateEvents(overBudget).some((d) => d.event === 'E8'))

  // E9：完成 5 个节点且上次收敛计数为 0
  const fiveDone = graph(
    Array.from({ length: 5 }, (_, i) => node({ id: `d${i}`, status: 'completed', evidence: [ev('test')] })),
  )
  assert.ok(evaluateEvents(fiveDone, { lastConvergeCompleted: 0 }).some((d) => d.event === 'E9'))

  // E7：完成率高但 AC 通过率低
  const mismatch = graph(
    Array.from({ length: 5 }, (_, i) => node({ id: `m${i}`, status: 'completed', evidence: [ev('test')] })),
    {
      spec: {
        ...graph([]).spec,
        acceptance: [ac('AC-01', 'failing'), ac('AC-02', 'pending'), ac('AC-03', 'pending')],
      },
    },
  )
  assert.ok(evaluateEvents(mismatch).some((d) => d.event === 'E7'))

  // E4：假设被证伪
  const invalid = graph([node({ id: 'a' })], {
    spec: {
      ...graph([]).spec,
      assumptions: [{ id: 'AS-01', text: '用户量 < 10 万', invalidated: '压测到 50 万' }],
    },
  })
  assert.ok(evaluateEvents(invalid).some((d) => d.event === 'E4'))
})

/* ============================================================
 * TC-REPLAN：结构化补丁的事务性
 * ============================================================ */

test('TC-REPLAN-001 buildPatch：reason 缺失或 ops 为空 → 直接拒绝', () => {
  const g = graph([node({ id: 'a' })])
  assert.equal(buildPatch(g, { triggerEvent: 'E3', reason: '  ', ops: [{ op: 'relink', id: 'a', dependsOn: [] }] }).error?.code, 'FORBIDDEN')
  assert.equal(buildPatch(g, { triggerEvent: 'E3', reason: 'x', ops: [] }).error?.code, 'SCHEMA_INVALID')
})

test('TC-REPLAN-002 批准级别：仅追加 = 1；invalidate 已完成 = 2；改已批准 AC = 4（禁止）', () => {
  const plain = graph([node({ id: 'a' })])
  const addOnly = buildPatch(plain, {
    triggerEvent: 'E3',
    reason: '发现新依赖',
    ops: [{ op: 'add', node: node({ id: 'new1' }) }],
  })
  assert.equal(addOnly.patch?.approvalLevel, 1)

  const withDone = graph([
    node({ id: 'done', status: 'completed', evidence: [ev('test')] }),
    node({ id: 'x', dependsOn: ['done'] }),
  ])
  const invalidating = buildPatch(withDone, {
    triggerEvent: 'E3',
    reason: '需要重做',
    ops: [{ op: 'update', id: 'done', patch: { dependsOn: ['x'] } }],
  })
  assert.equal(invalidating.patch?.approvalLevel, 2)
  assert.deepEqual(invalidating.patch?.impact.invalidatedTasks, ['done'])

  const approved = graph([node({ id: 'a', acceptance: [ac('AC-01', 'passing', 'npm test')] })], {
    spec: { ...graph([]).spec, state: 'approved' },
  })
  const acEdit = buildPatch(approved, {
    triggerEvent: 'E1',
    reason: '想放宽验收',
    ops: [{ op: 'update', id: 'a', patch: { acceptance: [ac('AC-01', 'passing', 'npm test -- loose')] } }],
  })
  assert.equal(acEdit.error?.code, 'FORBIDDEN', '第 4 级必须在 buildPatch 阶段就被拒')
})

test('TC-REPLAN-003 applyPatch：第 2 级未获批准 → 拒绝且图不变', () => {
  const g = graph([node({ id: 'done', status: 'completed', evidence: [ev('test')] })])
  const built = buildPatch(g, {
    triggerEvent: 'E1',
    reason: '重做',
    ops: [{ op: 'remove', id: 'done', reason: '方案变更' }],
  })
  assert.ok(built.patch)
  const res = applyPatch(g, built.patch!, false)
  assert.equal(res.error?.code, 'FORBIDDEN')
  assert.equal(res.graph, g, '未批准时不得改动图（同一引用）')
})

test('TC-REPLAN-004 applyPatch 原子性：op 中途失败 → 全量回滚（返回原图引用）', () => {
  const g = graph([node({ id: 'a' })])
  const bad: ReplanPatch = {
    id: 'rp_test',
    reason: '构造一个必失败的补丁',
    triggerEvent: 'E3',
    approvalLevel: 1,
    state: 'applied',
    createdAt: 1,
    impact: { invalidatedTasks: [], affectedACs: [], estimatedExtraTokens: 0 },
    ops: [
      { op: 'add', node: node({ id: 'newA' }) }, // 这一条会成功
      { op: 'remove', id: 'does-not-exist', reason: '不存在' }, // 这一条必然抛错
    ],
  }
  const res = applyPatch(g, bad, true)
  assert.ok(res.error)
  assert.equal(res.graph, g, '回滚必须返回原图（逐字段一致）')
  assert.equal(res.graph.nodes.newA, undefined, '前一 op 的效果也必须回滚')
})

test('TC-REPLAN-005 applyPatch：第 1 级自动应用成功，且留下 replan 审计', () => {
  const g = graph([node({ id: 'root' })])
  const built = buildPatch(g, {
    triggerEvent: 'E3',
    reason: '发现需要先建索引',
    ops: [{ op: 'add', node: node({ id: 'idx', key: 'T-09', title: '添加复合索引' }), after: 'root' }],
  })
  assert.ok(built.patch)
  const res = applyPatch(g, built.patch!, true)
  assert.equal(res.error, undefined)
  assert.ok(res.graph.nodes.idx)
  assert.equal(res.graph.rootIds.includes('idx'), true)
  assert.ok(
    res.graph.revisions.some((r) => r.op === 'replan' && r.reason === '发现需要先建索引'),
    'Replan 必须写 reason 并留审计',
  )
})

test('TC-REPLAN-006 applyPatch：remove 会连带删除整个子树并清理悬空依赖', () => {
  const g = graph([
    node({ id: 'p', children: ['c'] }),
    node({ id: 'c', parentId: 'p' }),
    node({ id: 'other', dependsOn: ['c'] }),
  ])
  const built = buildPatch(g, {
    triggerEvent: 'E3',
    reason: '整块不再需要',
    ops: [{ op: 'remove', id: 'p', reason: '方案取消' }],
  })
  const res = applyPatch(g, built.patch!, true)
  assert.equal(res.error, undefined)
  assert.equal(res.graph.nodes.p, undefined)
  assert.equal(res.graph.nodes.c, undefined, '子节点必须一起删（否则成孤儿）')
  assert.deepEqual(res.graph.nodes.other.dependsOn, [], '依赖已删节点的边必须被清理')
})

test('TC-REPLAN-007 computeImpact：仅改标题不算 invalidate（避免虚报代价）', () => {
  const g = graph([node({ id: 'done', status: 'completed', evidence: [ev('test')] })])
  const impact = computeImpact(g, [{ op: 'update', id: 'done', patch: { title: '换个说法' } }])
  assert.deepEqual(impact.invalidatedTasks, [], '改标题不该说"这让 T-xx 白做了"')
})

test('TC-REPLAN-008 decideApprovalLevel 组合：invalidate 优先于纯追加', () => {
  const g = graph([
    node({ id: 'done', status: 'completed', evidence: [ev('test')] }),
    node({ id: 'x', dependsOn: ['done'] }),
  ])
  const ops = [
    { op: 'add' as const, node: node({ id: 'n1' }) },
    { op: 'relink' as const, id: 'x', dependsOn: [] },
  ]
  const level = decideApprovalLevel(g, ops, computeImpact(g, ops))
  // relink 未改已完成节点的依赖 → 仍是第 1 级
  assert.equal(level, 1)
})
