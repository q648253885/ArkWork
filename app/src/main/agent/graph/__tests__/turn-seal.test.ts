/**
 * v0.32.1 详测 — 回合终结收口（缺陷 D35 / D36）
 *
 * 依据：docs/versions/v0.32.1/04-system-design.md §「回合终结收口」
 *
 * ============================================================
 * 本套件要钉住的两条实测缺陷
 * ============================================================
 *
 * **D35 —— 思考突然中断，却被当成正常回合收尾**
 *
 * 两个叠加的根因：
 *  ① `withLlmTimeout` 只把超时判定写在 `catch` 分支。中止一个流式请求时 SDK
 *     并不保证抛错，它完全可能「正常结束迭代」→ `fn` 顺利 resolve，超时被吞掉。
 *     实测形态：恰好 120.1s、usage `0+0`、只留下 reasoning 没有 content。
 *  ② `mapFinishReason` 的 `default → 'stop'`：流根本没给终止帧时，
 *     被兜底成「模型正常说完」。
 * 两者叠加 → 引擎把一个空壳回合当成合法终答 → 任务被静默判 done、清单纹丝不动。
 *
 * **D36 —— 失败后任务清单不收口**
 *
 * 图化（v0.30.0）时 `markRunningFailed` 的「pending 兜底」丢了，只剩
 * `in_progress` 一个判据。而最常见的失败场景里根本没有 in_progress：
 *   `plan generation failed` → 兜底单步清单（`pending`）
 *   → `migrateToGraph` 把 `pending` 映射成 `ready`
 *   → ReAct 立刻失败 → 找不到 in_progress → `{ ok: true }` **静默返回**
 * → 任务 `failed`、清单纹丝不动。
 * 同时 `graph.status` 在生产代码里从没被写过（`sealGraphAtTurnEnd` 是死代码）
 * → 任务 failed、节点 failed、图仍 `in_progress`，三者自相矛盾。
 *
 * ============================================================
 * 分区
 * ============================================================
 *  A. `sealGraphAtTurnEnd` 纯函数：三态收口范围 + D36 兜底 + 幂等（TC-SEAL-001…007）
 *  B. 落盘行为：四个入口真正改写 `graph.json`（TC-SEAL-008…011）
 *  C. 端到端复刻：plan-fallback → 迁移 → 失败 → 清单与图双双收口（TC-SEAL-020）
 *  D. 超时与空响应（D35 根因 ①）（TC-SEAL-012…016）
 *  E. 适配器终止帧（D35 根因 ②）（TC-SEAL-017…018）
 *  F. 源码契约：引擎三个终态分支的挂点（TC-SEAL-021…023）
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs turn-seal
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/* ---------------- 模块引入（先于 setWorkspaceDir，纯加载无副作用） --------------- */

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, updateTask } = await import('../../../store/tasks.js')
const { loadGraph } = await import('../store.js')
const { putGraphCache } = await import('../sync.js')
const { markRunningFailed, cancelIncomplete, sealGraphForOutcome, sealGraphOnSuccess } = await import(
  '../plan-sync.js'
)
const { sealGraphAtTurnEnd, migrateToGraph, unfinishedTaskNodes } = await import('../migrate.js')
const { withLlmTimeout, isIncompleteLlmResponse, LlmTimeoutError } = await import('../../llm-call.js')
const { mapFinishReason: openaiFinish } = await import('../../../llm/openai.js')
const { mapFinishReason: anthropicFinish } = await import('../../../llm/anthropic.js')

import {
  GRAPH_SCHEMA_VERSION,
  defaultPolicy,
  defaultVerification,
  generateGraphId,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import type { PlanItem } from '@shared/types/task'

/* ---------------- 工作区构造 --------------- */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-turn-seal-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

/* ---------------- 构造器（与 plan-sync.test.ts 对齐，减少心智差） --------------- */

function node(over: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.id}`,
    intent: '收口详测用意图',
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
    title: '收口详测图',
    goal: '验证回合终结时节点与图级 status 一起收口',
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
  const task = await createTask({
    title: `收口详测任务 ${g.id}`,
    text: '',
    agentId: 'coder',
    modelId: 'test-model',
  })
  await updateTask(task.id, { graphId: g.id })
  putGraphCache(g)
  return task.id
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ============================================================
 * A. sealGraphAtTurnEnd 纯函数
 * ============================================================ */

test('TC-SEAL-001 failed：只收在途节点，排队项不连坐 —— 并封图级 status', () => {
  const g = graph(
    [
      node({ id: 'run', key: 'T-01', status: 'in_progress' }),
      node({ id: 'ver', key: 'T-02', status: 'verifying' }),
      node({ id: 'queue', key: 'T-03', status: 'ready' }),
      node({ id: 'done', key: 'T-04', status: 'completed' }),
    ],
    { status: 'in_progress' },
  )

  const r = sealGraphAtTurnEnd(g, 'failed', '超迭代')

  assert.equal(r.graph.nodes.run.status, 'failed', 'in_progress → failed')
  assert.equal(r.graph.nodes.ver.status, 'failed', 'verifying 也是在途，同样收 failed')
  assert.equal(r.graph.nodes.queue.status, 'ready', '失败不连坐排队项（TC-SYNC-006 既有裁决）')
  assert.equal(r.graph.nodes.done.status, 'completed', '终态不动')
  assert.equal(r.graph.status, 'failed', '★ 图级 status 必须封口（D35 核心）')
  assert.deepEqual(r.changedIds.sort(), ['run', 'ver'])
})

test('TC-SEAL-002 failed 兜底（D36）：在途为空时收「第一个排队项」，其余不连坐', () => {
  // 精确复刻 plan-fallback 场景：迁移出来的节点全是 ready，没有 in_progress。
  // 修复前：找不到在途 → `{ ok: true }` 静默返回 → 清单纹丝不动。
  const g = graph([
    node({ id: 'a', key: 'T-01', status: 'ready', createdAt: 10 }),
    node({ id: 'b', key: 'T-02', status: 'ready', createdAt: 20 }),
  ])

  const r = sealGraphAtTurnEnd(g, 'failed', 'ReAct loop failed: 401')

  assert.equal(r.graph.nodes.a.status, 'failed', '★ 在途为空时兜底收最早的那个')
  assert.equal(r.graph.nodes.b.status, 'ready', '其余排队项不连坐（同无图分支语义：只标一个）')
  assert.equal(r.graph.status, 'failed')
  assert.equal(r.changedIds.length, 1)
})

test('TC-SEAL-003 failed 兜底不碰 goal 层节点，也不重复收已终态节点', () => {
  const g = graph([
    node({ id: 'goal', key: 'G-00', layer: 'goal', status: 'ready', createdAt: 1 }),
    node({ id: 'cancelled', key: 'T-00', status: 'cancelled', createdAt: 5 }),
    node({ id: 't1', key: 'T-01', status: 'proposed', createdAt: 10 }),
  ])

  const r = sealGraphAtTurnEnd(g, 'failed', '启动即失败')

  assert.equal(r.graph.nodes.goal.status, 'ready', '★ goal 是汇总节点，绝不入兜底 victims')
  assert.equal(r.graph.nodes.cancelled.status, 'cancelled', '已终态的节点不被改写')
  assert.equal(r.graph.nodes.t1.status, 'failed', '兜底可收「待批」这类未完成非 goal 节点')
})

test('TC-SEAL-004 failed 兜底：全部终态时无变更（不制造假失败）', () => {
  const g = graph([
    node({ id: 'd', key: 'T-01', status: 'completed' }),
    node({ id: 'f', key: 'T-02', status: 'failed' }),
  ])

  const r = sealGraphAtTurnEnd(g, 'failed', '无项可收')

  assert.equal(r.changedIds.length, 0, '没有未完成项 → 不动任何节点')
  assert.equal(r.graph.status, 'failed', '但图级 status 仍要封口（与节点收口解耦）')
})

test('TC-SEAL-005 cancelled：所有非终态非 goal 节点全收（与 cancelIncomplete 同口径）', () => {
  const g = graph([
    node({ id: 'goal', key: 'G-00', layer: 'goal', status: 'ready' }),
    node({ id: 'run', key: 'T-01', status: 'in_progress' }),
    node({ id: 'ready', key: 'T-02', status: 'ready' }),
    node({ id: 'blocked', key: 'T-03', status: 'blocked' }),
    node({ id: 'human', key: 'T-04', status: 'needs_human' }),
    node({ id: 'done', key: 'T-05', status: 'completed' }),
    node({ id: 'failed', key: 'T-06', status: 'failed' }),
  ])

  const r = sealGraphAtTurnEnd(g, 'cancelled', '用户取消')

  for (const id of ['run', 'ready', 'blocked', 'human']) {
    assert.equal(r.graph.nodes[id].status, 'cancelled', `${id} 是未完成项，应被取消`)
  }
  assert.equal(r.graph.nodes.goal.status, 'ready', 'goal 不入 victims')
  assert.equal(r.graph.nodes.done.status, 'completed', '已完成保留')
  assert.equal(r.graph.nodes.failed.status, 'failed', '★ 已判失败的节点保留失败信息，不改成 cancelled')
  assert.equal(r.graph.status, 'cancelled', '图级 status 封口')
})

test('TC-SEAL-006 completed：只封图级 status，一个节点都不动', () => {
  const g = graph([
    node({ id: 'done', key: 'T-01', status: 'completed' }),
    // 故意放一个在途节点：成功路径不该把它「抹成完成」，那会造成假完成。
    node({ id: 'run', key: 'T-02', status: 'in_progress' }),
  ])

  const r = sealGraphAtTurnEnd(g, 'completed', '任务完成')

  assert.equal(r.graph.nodes.run.status, 'in_progress', '★ 不做兜底抹平 —— 状态不一致该被暴露而非掩盖')
  assert.equal(r.graph.nodes.done.status, 'completed')
  assert.equal(r.changedIds.length, 0)
  assert.equal(r.graph.status, 'completed', '只封图级 status')
})

test('TC-SEAL-007 纯函数性质：幂等 + 不改 graphRevision + 不改入参', () => {
  const g = graph([node({ id: 'a', key: 'T-01', status: 'ready' })])
  const snapshot = JSON.stringify(g)

  const once = sealGraphAtTurnEnd(g, 'failed', 'x')
  assert.equal(JSON.stringify(g), snapshot, '不修改入参（纯函数）')
  assert.equal(once.graph.graphRevision, g.graphRevision, '★ 不自增 graphRevision（由 saveGraph 落盘时统一负责）')

  const twice = sealGraphAtTurnEnd(once.graph, 'failed', 'x')
  assert.equal(twice.changedIds.length, 0, '重复调用无节点变更（幂等）')
  assert.equal(twice.graph.status, 'failed', '图级状态已一致')
})

/* ============================================================
 * B. 落盘行为（走真实 graph.json）
 * ============================================================ */

test('TC-SEAL-008 markRunningFailed 端到端：D36 场景（全 ready）+ 图级封口一并落盘', async () => {
  const g = graph([
    node({ id: 't_seal001', key: 'T-01', status: 'ready', createdAt: 10 }),
    node({ id: 't_seal002', key: 'T-02', status: 'ready', createdAt: 20 }),
  ])
  const taskId = await taskWithGraph(g)

  const res = await markRunningFailed({ taskId, graphId: g.id }, '任务失败，引擎标记当前项 failed')
  assert.equal(res.ok, true)

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_seal001'].status, 'failed', '★ 兜底把首个排队项标 failed 并落盘')
  assert.equal(disk!.nodes['t_seal002'].status, 'ready', '其余不动')
  assert.equal(disk!.status, 'failed', '★ 图级 status 落盘为 failed')
})

test('TC-SEAL-009 markRunningFailed 有在途时不走兜底（回归保护：不误伤排队项）', async () => {
  const g = graph([
    node({ id: 't_seal003', key: 'T-01', status: 'in_progress' }),
    node({ id: 't_seal004', key: 'T-02', status: 'ready' }),
  ])
  const taskId = await taskWithGraph(g)

  await markRunningFailed({ taskId, graphId: g.id }, '任务失败')

  const disk = await loadGraph(g.id)
  assert.equal(disk!.nodes['t_seal003'].status, 'failed')
  assert.equal(disk!.nodes['t_seal004'].status, 'ready', '有在途时不启用兜底，排队项保持 ready')
  assert.equal(disk!.status, 'failed')
})

test('TC-SEAL-010 sealGraphForOutcome(cancelled) / sealGraphOnSuccess 落盘', async () => {
  // 取消
  const g1 = graph([node({ id: 't_seal005', key: 'T-01', status: 'in_progress' })])
  const t1 = await taskWithGraph(g1)
  await cancelIncomplete({ taskId: t1, graphId: g1.id }, '任务已取消，未完成清单项丢弃')
  await sealGraphForOutcome({ taskId: t1, graphId: g1.id }, 'cancelled', '任务已取消，未完成清单项丢弃')
  const d1 = await loadGraph(g1.id)
  assert.equal(d1!.nodes['t_seal005'].status, 'cancelled')
  assert.equal(d1!.status, 'cancelled', '★ 取消也必须封图级 status')

  // 暂停路径：cancelIncomplete 单独调用（不封口）→ 图级 status 保持 in_progress
  const g2 = graph([node({ id: 't_seal006', key: 'T-01', status: 'in_progress' })])
  const t2 = await taskWithGraph(g2)
  await cancelIncomplete({ taskId: t2, graphId: g2.id }, '任务已暂停，未完成清单项丢弃')
  const d2 = await loadGraph(g2.id)
  assert.equal(d2!.nodes['t_seal006'].status, 'cancelled', '节点照旧被丢弃（v0.19.1 既有语义）')
  assert.equal(d2!.status, 'in_progress', '★ 暂停是可恢复的，图级 status 刻意不封终态')

  // 成功
  const g3 = graph([node({ id: 't_seal007', key: 'T-01', status: 'completed' })])
  const t3 = await taskWithGraph(g3)
  await sealGraphOnSuccess({ taskId: t3, graphId: g3.id }, '任务完成')
  const d3 = await loadGraph(g3.id)
  assert.equal(d3!.status, 'completed', '★ 成功后图级 status 封 completed（否则面板一直显示进行中）')
})

test('TC-SEAL-011 图不存在时优雅返回 ok:false，不抛（落盘失败不牵连任务终态）', async () => {
  const res = await sealGraphForOutcome(
    { taskId: 'T-ghost', graphId: 'tg_does_not_exist' },
    'failed',
    '图已删',
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'NOT_FOUND')
})

/* ============================================================
 * C. 端到端复刻：用户报障的完整时序
 * ============================================================ */

test('TC-SEAL-020 端到端复刻：plan-fallback 单步清单 → 迁移 → ReAct 失败 → 清单与图双双收口', async () => {
  // 复刻实测时序（logs.jsonl 09:10:06）：
  //   ① plan generation failed（401）
  //   ② 写兜底单步清单 → status 为 'pending'
  //   ③ migrateToGraph（1 条扁平清单 → 2 节点：goal + 1 个 task）
  //      —— pending 经 mapPlanItemStatusToNodeStatus 映射为 'ready'
  //   ④ ReAct 立刻失败 → markRunningPlanItemFailed → markRunningFailed
  const fallbackItems: PlanItem[] = [
    {
      id: 'p_fallback_1',
      text: '实现超级玛丽网页小游戏',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
      source: 'plan-fallback',
    },
  ]

  const migrated = migrateToGraph({
    taskId: 'T-seal-e2e',
    title: '生成一个简单的超级玛丽网页小游戏',
    goal: '生成一个简单的超级玛丽网页小游戏',
    planItems: fallbackItems,
    now: 1000,
  })
  assert.ok(migrated, '有清单项 → 应建图')
  const taskNodes = Object.values(migrated!.nodes).filter((n) => n.layer === 'task')
  assert.equal(taskNodes.length, 1, '兜底单步清单迁移出 1 个 task 节点')
  assert.equal(taskNodes[0].status, 'ready', '★ pending 被映射为 ready —— 这正是 D36 兜底要覆盖的形态')

  const taskId = await taskWithGraph(migrated!)

  // ReAct 失败
  const res = await markRunningFailed({ taskId, graphId: migrated!.id }, 'ReAct loop failed: 401')
  assert.equal(res.ok, true)

  const disk = await loadGraph(migrated!.id)
  assert.equal(disk!.nodes[taskNodes[0].id].status, 'failed', '★ 修复前此处纹丝不动（无 in_progress 即静默返回）')
  assert.equal(disk!.status, 'failed', '★ 图级 status 同步封口（修复前永远停在 in_progress）')
})

/* ============================================================
 * D. 超时与空响应（D35 根因 ①）
 * ============================================================ */

test('TC-SEAL-012 isIncompleteLlmResponse：判据是「有没有可推进任务的东西」', () => {
  // 不完整：只有思考（模型想了一堆但什么也没做 → 对 ReAct 是空转）
  assert.equal(isIncompleteLlmResponse({ content: '', thought: '', actions: [] }), true)
  assert.equal(isIncompleteLlmResponse({ content: '  ', thought: '  ' }), true, '纯空白 = 空')
  assert.equal(
    isIncompleteLlmResponse({ content: '', thought: '', reasoningContent: '让我想想…' } as never),
    true,
    '★ 只有 reasoning 没有正文与动作 → 仍是不完整（实测 120s 截断的形态）',
  )

  // 完整：有正文，或有动作
  assert.equal(isIncompleteLlmResponse({ content: '已完成', thought: '' }), false)
  assert.equal(isIncompleteLlmResponse({ content: '', thought: '计划如下', actions: [] }), false, '有思考正文也算有产出')
  assert.equal(isIncompleteLlmResponse({ content: '', thought: '', action: { tool: 'x' } }), false)
  assert.equal(
    isIncompleteLlmResponse({ content: '', thought: '', actions: [{ tool: 'file-writer' }] }),
    false,
    '有工具调用 → 完整',
  )
})

test('TC-SEAL-013 withLlmTimeout：超时后「成功返回空壳」必须抛超时（D35 核心）', async () => {
  // 模拟实测形态：abort 让流「优雅结束」，fn 顺利 resolve 一个空壳。
  await assert.rejects(
    withLlmTimeout(
      async () => {
        await sleep(40) // 远超 10ms 超时
        return { content: '', thought: '', actions: [] }
      },
      10,
      undefined,
      isIncompleteLlmResponse,
    ),
    (err: unknown) => {
      assert.ok(err instanceof LlmTimeoutError, `应抛 LlmTimeoutError，实际 ${String(err)}`)
      assert.match((err as Error).message, /timeout/i, 'message 含 timeout → retryableError 可匹配并重试')
      return true
    },
  )
})

test('TC-SEAL-014 withLlmTimeout：超时后返回「完整结果」照常返回（不误杀已收到的回答）', async () => {
  const r = await withLlmTimeout(
    async () => {
      await sleep(40)
      return { content: '任务已完成，产物在 out/index.html', thought: '', actions: [] }
    },
    10,
    undefined,
    isIncompleteLlmResponse,
  )
  assert.match(r.content, /已完成/, '超时前一瞬间收到的完整回答不该被丢掉')
})

test('TC-SEAL-015 withLlmTimeout：用户主动中止 → 原错误原样抛出，绝不转成超时', async () => {
  const userCtrl = new AbortController()
  const p = withLlmTimeout(
    async () => {
      await sleep(30)
      const e = new Error('The user aborted a request.')
      e.name = 'AbortError'
      throw e
    },
    10,
    userCtrl.signal,
    isIncompleteLlmResponse,
  )
  userCtrl.abort()

  await assert.rejects(p, (err: unknown) => {
    assert.equal((err as Error).name, 'AbortError', '用户中止必须保持 AbortError（上层走 paused/cancelled，不重试）')
    assert.ok(!(err instanceof LlmTimeoutError))
    return true
  })
})

test('TC-SEAL-016 withLlmTimeout：未超时的空响应 → 不在这里判死（交上层重试/收尾）', async () => {
  const r = await withLlmTimeout(
    async () => ({ content: '', thought: '', actions: [] }),
    1000,
    undefined,
    isIncompleteLlmResponse,
  )
  assert.equal(r.content, '', '未超时的空响应原样返回 —— 本函数只负责「超时」这一维度的判定')
})

/* ============================================================
 * E. 适配器终止帧（D35 根因 ②）
 * ============================================================ */

test('TC-SEAL-017 openai mapFinishReason：无终止帧 → interrupted，不再伪装 stop', () => {
  assert.equal(openaiFinish('stop'), 'stop', '显式 stop 仍为 stop')
  assert.equal(openaiFinish('tool_calls'), 'tool_calls')
  assert.equal(openaiFinish('length'), 'length')
  assert.equal(openaiFinish('content_filter'), 'content_filter')

  assert.equal(openaiFinish(undefined), 'interrupted', '★ 缺终止帧（流被截断/中止）')
  assert.equal(openaiFinish(null), 'interrupted', '★ null 也是缺终止帧')
  assert.equal(openaiFinish(''), 'interrupted')
  assert.equal(openaiFinish('some_new_endpoint_value'), 'interrupted', '★ 未知终止帧不再被兜底成 stop')
})

test('TC-SEAL-018 anthropic mapFinishReason：同口径（end_turn → stop，缺帧 → interrupted）', () => {
  assert.equal(anthropicFinish('end_turn'), 'stop')
  assert.equal(anthropicFinish('stop_sequence'), 'stop')
  assert.equal(anthropicFinish('tool_use'), 'tool_calls')
  assert.equal(anthropicFinish('max_tokens'), 'length')

  assert.equal(anthropicFinish(undefined), 'interrupted', '★ 与 openai 适配器对齐')
  assert.equal(anthropicFinish(null), 'interrupted')
})

test('TC-SEAL-019 失败路径不重复封口（markRunningPlanItemFailed 内已含，避免空落盘）', () => {
  // markRunningPlanItemFailed → markRunningFailed → sealAndPersist('failed')
  // 已一次性完成「节点收口 + 图级封口」。若 loop 的失败分支再补一次
  // sealGraphForTaskOutcome，就会多一次「无节点变更、仅 status 幂等」的空落盘
  // （图写失败时还会多一条告警噪音）。这条把「只封一次」钉住。
  const loop = read('src/main/agent/engine/loop.ts')
  const i = loop.indexOf('ReAct loop failed')
  assert.ok(i > 0, '未找到失败分支')
  const failSection = loop.slice(i, i + 500)
  assert.match(failSection, /markRunningPlanItemFailed\(task\)/, '失败分支须调用 markRunningPlanItemFailed')
  assert.ok(
    !/sealGraphForTaskOutcome/.test(failSection),
    '★ 失败分支不得重复调用收口（该职责已内聚在 markRunningPlanItemFailed → markRunningFailed）',
  )
})

/* ============================================================
 * F. 源码契约：引擎三个终态分支的挂点
 * ============================================================ */

/** app/ 根目录（本文件位于 app/src/main/agent/graph/__tests__/） */
const APP = fileURLToPath(new URL('../../../../..', import.meta.url))
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8')

test('TC-SEAL-021 四个终态/起始分支必须各有收口挂点（防回潮）', () => {
  const loop = read('src/main/agent/engine/loop.ts')
  const abort = read('src/main/agent/engine/abort.ts')
  const turnEnd = read('src/main/agent/engine/turn-end.ts')

  assert.match(
    loop,
    /sealGraphForTaskOutcome\(task,\s*'completed'/,
    '★ 成功分支（无工具调用且清单已清空）必须封 graph.status = completed',
  )
  // ★★ v0.32.1 真实环境实测补漏（本测试此前只查了 loop.ts，于是漏掉了最常用的一条成功路径）：
  //    模型**显式调用 task_complete 工具**时走的是 turn-end.finishViaTaskComplete，
  //    它在 loop.ts 里 `return`，永远不会经过上面那个分支 → 实测形状为
  //    「task=done、节点全终态、graph.status=in_progress」，面板一直显示「进行中」。
  assert.match(
    turnEnd,
    /sealGraphForTaskOutcome\(task,\s*'completed'/,
    '★ finishViaTaskComplete（task_complete 工具分支）必须同样封 graph.status —— 漏了它 D36 会在最常走的成功路径上复发',
  )
  assert.match(
    abort,
    /sealGraphForTaskOutcome\(current\s*\?\?\s*task,\s*'cancelled'/,
    '★ 取消分支必须封 graph.status = cancelled',
  )
  assert.match(
    loop,
    /reopenGraphForTaskRun\(task,/,
    '★ 新一轮执行必须重开图（终态 → in_progress）：否则「done 后续聊」会出现任务在跑、图显示已完成',
  )
  // 暂停分支**必须不封** —— 暂停可恢复，封终态会让「继续」后的图状态与事实不符
  const pausedSection = abort.slice(abort.indexOf("status: 'paused'"))
  assert.ok(
    !/sealGraphForTaskOutcome/.test(pausedSection),
    '★ paused 分支不得封口（暂停可恢复；封成终态会误导「继续」后的状态）',
  )
})

test('TC-SEAL-022 失败路径经 gates 自动收口（含 D36 兜底与图级封口）', () => {
  const gates = read('src/main/agent/engine/gates.ts')
  const ps = read('src/main/agent/graph/plan-sync.ts')
  const migrate = read('src/main/agent/graph/migrate.ts')

  assert.match(
    gates,
    /markRunningFailed\(/,
    'markRunningPlanItemFailed 的有图分支必须走桥（继承收口）',
  )
  assert.match(
    ps,
    /export async function markRunningFailed\([\s\S]{0,400}return sealAndPersist\(ctx, 'failed', reason\)/,
    '★ markRunningFailed 必须委托 sealAndPersist —— 节点收口 + 图级封口一次完成',
  )
  assert.match(
    migrate,
    /const queued = all\.filter\(isQueued\)\.sort\(byQueueOrder\)/,
    '★ D36 兜底必须存在（在途为空时收第一个排队项），删了它会退回「失败后清单纹丝不动」',
  )
})

test('TC-SEAL-023 超时包装必须接上「不完整」判据（否则 120s 截断会被静默吞掉）', () => {
  const reason = read('src/main/agent/engine/reason-phase.ts')
  assert.match(
    reason,
    /withLlmTimeout\([\s\S]{0,4000}isIncompleteLlmResponse/,
    '★ reason-phase 调用 withLlmTimeout 时必须传 isIncompleteLlmResponse —— 这是「超时后优雅 resolve」唯一的识别手段',
  )
})

/* ============================================================
 * G. 真实环境实测补漏（v0.32.1 第二次真跑发现）
 *
 * 上述 TC-SEAL-021 曾经只查 loop.ts 的成功分支，于是漏掉了**最常走的**成功路径：
 * 模型显式调 task_complete 工具 → turn-end.finishViaTaskComplete → loop.ts 里 `return`。
 * 真跑实测形状：task=done、节点全终态、graph.status=in_progress（面板一直「进行中」）。
 * 同时发现：持久化层只在「有节点变更」时广播图事件，而纯图级封口零节点变更
 * → 面板连刷新信号都收不到。以下用例把这两点连同「图可重开」一起钉死。
 * ============================================================ */

test('TC-SEAL-024 runner 侧三个终态落地点也必须有收口挂点（无循环在跑时无人封口）', () => {
  const runner = read('src/main/agent/runner.ts')

  // ① runTask 的兜底 catch：异常从 loop 的 catch 块内部再抛出时只能落到这里
  assert.match(
    runner,
    /sealGraphForTaskOutcome\(task,\s*'failed',\s*`run 异常终止/,
    '★ runTask catch 必须封 failed（loop 的 catch 内部再抛时无人收口）',
  )
  // ② 用户取消：paused 状态的任务被取消时没有循环在跑
  assert.match(
    runner,
    /sealGraphForTaskOutcome\(updated,\s*'cancelled',\s*'任务已取消'/,
    '★ cancelTask 必须封 cancelled —— 未在跑的任务（如 paused）取消时没有其它人封口',
  )
  // ③ 启动 reconcile：进程崩溃重启后修正孤儿任务
  assert.match(
    runner,
    /sealGraphForTaskOutcome\(updated,\s*'failed',\s*'进程异常退出/,
    '★ reconcileOrphanRunning 必须封 failed —— 否则重启后任务「失败」而图仍「进行中」',
  )
})

test('TC-SEAL-025 纯图级封口必须单独广播（否则面板永远停在封口前那一帧）', () => {
  const ps = read('src/main/agent/graph/plan-sync.ts')
  const ev = read('src/main/agent/events.ts')
  const sync = read('src/main/agent/graph/sync.ts')

  // persist() 的 graph:update 扇出以「有节点变更」为前提（既有实现，不改）
  assert.match(
    sync,
    /if \(opts\.broadcast !== false && opts\.changes\?\.length\)/,
    '（前提确认）persist 仅在 changes 非空时把 graph 事件扇出到 graph:update',
  )
  assert.match(
    ps,
    /statusChanged && changes\.length === 0[\s\S]{0,200}broadcastGraphStatusChanged/,
    '★ 零节点变更的纯图级封口必须补一条广播 —— 缺了它任务 done 而面板仍显示「进行中」（实测现象）',
  )
  assert.match(
    ps,
    /export async function reopenGraphForRun\([\s\S]{0,1200}broadcastGraphStatusChanged/,
    '★ 图重开同样要广播（否则「继续」后图从终态回到 in_progress 的过程对面板不可见）',
  )
  assert.match(
    ev,
    /export function broadcastGraphStatusChanged\([\s\S]{0,400}broadcast\('graph:update'/,
    '★ 广播实现必须打到 graph:update 通道（渲染层 useGraph 的订阅口）',
  )
})

test('TC-SEAL-026 reopenGraphForRun：终态 → in_progress，只动图不碰节点，幂等', async () => {
  const { reopenGraphForRun } = await import('../plan-sync.js')
  const g = graph([
    node({ id: 't_ro001', key: 'T-01', status: 'cancelled' }),
    node({ id: 't_ro002', key: 'T-02', status: 'completed' }),
  ])
  const taskId = await taskWithGraph(g)
  // 先封成 completed（模拟任务完成）
  await sealGraphOnSuccess({ taskId, graphId: g.id }, '任务完成')
  const sealed = await loadGraph(g.id)
  assert.equal(sealed?.status, 'completed', '前置：图已封成 completed')

  const res = await reopenGraphForRun({ taskId, graphId: g.id }, '新一轮执行开始')
  assert.equal(res.ok, true)
  const reopened = await loadGraph(g.id)
  assert.equal(reopened?.status, 'in_progress', '★ 重开后图级 status 回到 in_progress')
  assert.equal(reopened?.nodes.t_ro001.status, 'cancelled', '★ 节点状态是执行事实，重开不得改写')
  assert.equal(reopened?.nodes.t_ro002.status, 'completed', '★ 节点状态是执行事实，重开不得改写')

  // 幂等：已是 in_progress → 不落盘（graphRevision 不增）
  const before = reopened!.graphRevision
  await sleep(5)
  const res2 = await reopenGraphForRun({ taskId, graphId: g.id }, '重复调用')
  assert.equal(res2.ok, true)
  const again = await loadGraph(g.id)
  assert.equal(again?.graphRevision, before, '★ 幂等：已是 in_progress 时不落盘（graphRevision 不增）')
})

test('TC-SEAL-027 reopenGraphForRun：图不存在时返回错误而非抛错（不牵连任务启动）', async () => {
  const { reopenGraphForRun } = await import('../plan-sync.js')
  const res = await reopenGraphForRun({ taskId: 't_missing', graphId: 'tg_20260101_zzzzzz' }, 'x')
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'NOT_FOUND')
})

test('TC-SEAL-028 引擎失败落点必须持久化失败原因（errorMessage）', () => {
  const loop = read('src/main/agent/engine/loop.ts')
  const runner = read('src/main/agent/runner.ts')

  // 两处引擎内失败落点：工具全部达限（连续 3 轮）与 catch 兜底
  const taskFailedWrites = [...loop.matchAll(/updateTask\(task\.id, \{ status: 'failed'[^}]*\}/g)].map((m) => m[0])
  assert.equal(
    taskFailedWrites.length,
    2,
    `引擎内应有 2 处失败落点，实际 ${taskFailedWrites.length} 处（新增/删除落点时请同步本用例）`,
  )
  for (const w of taskFailedWrites) {
    assert.match(
      w,
      /errorMessage/,
      `★ 失败落点必须写入 errorMessage —— 实测（黑洞端点模型）任务 failed 而 errorMessage 为空，用户与诊断都看不到原因：${w}`,
    )
  }

  // 与 runner 的兜底路径保持同口径（runner 一直有写）
  assert.match(
    runner,
    /updateTask\(taskId, \{\s*status: 'failed',\s*completedAt: Date\.now\(\),\s*errorMessage: message,/,
    '（同口径确认）runner 的 catch 一直把 errorMessage 写进任务记录',
  )
})

test('TC-SEAL-029 unfinishedTaskNodes：列出未收口的 task 层节点（goal 不入、终态不入、按执行序）', () => {
  const g = graph([
    node({ id: 't_u01', key: 'T-01', status: 'completed', createdAt: 1 }),
    node({ id: 't_u02', key: 'T-02', status: 'ready', createdAt: 2 }),
    node({ id: 't_u03', key: 'T-03', status: 'in_progress', createdAt: 3 }),
    node({ id: 't_u04', key: 'T-04', status: 'cancelled', createdAt: 4 }),
    node({ id: 't_u05', key: 'T-05', status: 'failed', createdAt: 5 }),
    node({ id: 't_u06', key: 'T-06', status: 'verifying', createdAt: 6 }),
    node({ id: 't_u07', key: 'G-00', layer: 'goal', status: 'ready', createdAt: 0 }),
  ])
  const out = unfinishedTaskNodes(g).map((n) => n.key)
  assert.deepEqual(out, ['T-02', 'T-03', 'T-06'], '★ goal 与三个终态（completed/cancelled/failed）都不算未收口')
  assert.deepEqual(
    unfinishedTaskNodes({ ...g, nodes: {} }),
    [],
    '空图返回空数组（不抛）',
  )
})

test('TC-SEAL-030 task_complete 必须先让清单收口（D39：不得留下「已完成 + 待执行」）', () => {
  const turnEnd = read('src/main/agent/engine/turn-end.ts')
  const loop = read('src/main/agent/engine/loop.ts')

  // ① 守卫存在：用未收口项列表做判据
  assert.match(
    turnEnd,
    /const leftovers = claim\.graph \? unfinishedTaskNodes\(claim\.graph\) : \[\]/,
    '★ 有图任务的完成前守卫必须基于图（唯一真相）取未收口项',
  )
  // ② 拒绝路径：补配对 observation + 指令性消息，且**不结束回合**
  assert.match(
    turnEnd,
    /(?:export )?async function refuseCompletionForLeftovers\([\s\S]{0,3000}appendPairedControlObservations/,
    '★ 拒绝完成时必须补配对 observation（否则 tool_calls 悬空 → 服务端 400）',
  )
  assert.match(
    turnEnd,
    /refuseCompletionForLeftovers\(\{[\s\S]{0,400}return true \/\/ 不结束任务/,
    '★ 拒绝后必须 return true（回到循环让模型自处），不得继续收尾',
  )
  // ③ 上限兜底：模型坚持时接受完成，但**剩余项必须收成 cancelled**（清单与终态自洽）
  assert.match(
    turnEnd,
    /priorRefusals < MAX_COMPLETE_REFUSALS[\s\S]{0,2500}discardIncompletePlanItems\(task, '任务完成：模型坚持收尾/,
    '★ 超过拒绝上限后必须先把剩余项收口再完成 —— 不能把「已完成 + 4 条待执行」留在界面上',
  )
  // ④ 无图任务（tier 0/1）同守卫：判据取**最新的** planItems，不是内存里的旧对象
  assert.match(
    turnEnd,
    /const fresh = await getTask\(task\.id\)[\s\S]{0,200}status === 'running' \|\| p\.status === 'pending'/,
    '★ 无图分支必须重读 planItems（内存里的 task 可能已过期）',
  )
  // ⑤ 计数器由 loop 维护并透传（本 run 内被拒几次）
  assert.match(
    loop,
    /iteration,\s*completeRefusals,\s*\)\s*\)\s*\{\s*completeRefusals \+= 1/,
    '★ loop 必须把「已拒绝次数」透传给收尾并在被拒时自增（否则上限形同虚设）',
  )
})

test('TC-SEAL-031 有图任务的完成前守卫顺序正确：先收口剩余项、再封图（避免一帧矛盾）', () => {
  const turnEnd = read('src/main/agent/engine/turn-end.ts')
  const iDiscard = turnEnd.indexOf("discardIncompletePlanItems(task, '任务完成：模型坚持收尾")
  const iSeal = turnEnd.indexOf("sealGraphForTaskOutcome(task, 'completed'")
  assert.ok(iDiscard > 0 && iSeal > 0, '两处调用都必须存在')
  assert.ok(
    iDiscard < iSeal,
    '★ 必须先收口剩余节点（cancelled）再封图 completed —— 反了会短暂出现「图已完成、节点待执行」',
  )
})
