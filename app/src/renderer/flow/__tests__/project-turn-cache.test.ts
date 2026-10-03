/**
 * v0.46.0 — PERF-2 W2/W3 渲染层投影结构共享（turn 级引用缓存 + derive 短路）
 *
 * 依据：docs/versions/v0.46.0/04-system-design.md §二 A（W2/W3）
 * 背景：流式期间每个攒批 flush 都全量重投影 + 全树重渲染（全组件树仅 1 处
 * memo），会话越长每 token 成本越高。修复后：deps 全 `===` 的已落定轮复用
 * 上一轮投影的 FlowTurn 对象 —— 流式 flush 只重建真正在变的末轮，
 * 下游 React.memo 才能真正跳过重渲染。
 *
 * 手法：真执行（project.ts / derive-conversation.ts 纯函数，node:test 可密闭）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs project-turn-cache
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationItem, SessionEvent } from '@shared/types/conversation'
import type { ReActStep } from '@shared/types/react'
import { projectConversation, type ProjectInput } from '../project'
import { deriveConversation } from '../../store/derive-conversation'
import type { FlowUiState } from '../../store/types'
import type { Task, PlanItem } from '@shared/types/task'

const UI: FlowUiState = {
  viewMode: 'standard',
  showThinking: true,
  blockUiState: {},
  turnUiState: {},
  scrollAnchorByTask: {},
}

const baseInput = (over: Partial<ProjectInput> = {}): ProjectInput => ({
  taskId: 'T-TEST',
  items: [],
  steps: [],
  events: [],
  streamBuffers: {},
  planItems: [],
  viewMode: 'standard',
  showThinking: true,
  ui: UI,
  now: 1_700_000_000_000,
  ...over,
})

const step = (over: Partial<ReActStep> & Pick<ReActStep, 'id' | 'type' | 'iteration'>): ReActStep => ({
  taskId: 'T-TEST',
  startedAt: 1_000,
  durationMs: 10,
  status: 'success',
  ...over,
})

const reactItem = (id: string, steps: ReActStep[]): ConversationItem => ({
  id,
  type: 'react',
  steps,
  ts: steps[0]?.startedAt ?? 0,
})

const userItem = (id: string, text: string, ts: number): ConversationItem => ({
  id,
  type: 'user',
  text,
  ts,
})

const twoTurnItems = (): ConversationItem[] => [
  userItem('u1', '第一问', 100),
  reactItem('r1', [step({ id: 's1', type: 'reason', iteration: 1, thought: '思考 A' })]),
  userItem('u2', '第二问', 500),
  reactItem('r2', [step({ id: 's3', type: 'reason', iteration: 2, thought: '思考 B' })]),
]

/* ============================================================
 * TC-PROJ46-001 流式核心收益：只有末轮流式缓冲在变 → 已落定轮引用稳定
 * ============================================================ */
test('TC-PROJ46-001 流式 flush：末轮重建，已落定轮引用稳定（结构共享）', () => {
  const items = twoTurnItems()
  const first = projectConversation(baseInput({ items }))
  assert.equal(first.length, 2)
  // 流式 flush：仅 reasoning 缓冲增长（items / steps / ui 全部同引用）
  const second = projectConversation(
    baseInput({ items, streamBuffers: { 'T-TEST:turn:reasoning': { seq: 2, text: '流式思考中' } } }),
  )
  assert.equal(second.length, 2)
  assert.equal(second[0], first[0], '已落定轮（第 1 轮）引用必须稳定 —— memo 跳过的前提')
  assert.notEqual(second[1], first[1], '末轮（流式）必须重建')
})

test('TC-PROJ46-002 步骤变更只重建所属轮：react 包装重建但 step 引用不变 → 中间轮稳定', () => {
  const u1 = userItem('u1', '第一问', 100)
  const u2 = userItem('u2', '第二问', 500)
  const s1 = step({ id: 's1', type: 'reason', iteration: 1, thought: '思考 A' })
  const s3 = step({ id: 's3', type: 'reason', iteration: 2, thought: '思考 B' })
  const first = projectConversation(
    baseInput({ items: [u1, reactItem('r1', [s1]), u2, reactItem('r2', [s3])] }),
  )
  // 第 2 轮落地新 step（act_end）→ derive 重建 react 包装，但第 1 轮的 step
  // 引用不变（store 按 id 替换，其余保留引用）→ 第 1 轮引用保持稳定
  const items2: ConversationItem[] = [
    u1,
    reactItem('r1b', [s1]),
    u2,
    reactItem('r2b', [
      s3,
      step({ id: 's4', type: 'act', iteration: 2, toolName: 'file-reader', toolArgs: '{"path":"/a"}' }),
    ]),
  ]
  const second = projectConversation(baseInput({ items: items2 }))
  assert.equal(second[0], first[0], '第 1 轮 step 引用未变 → 引用稳定（deps 采 step 引用而非 item 包装）')
  assert.notEqual(second[1], first[1], '第 2 轮新增 step → 重建')
})

test('TC-PROJ46-003 ui 折叠变更 → 全量重建不串值（保守正确）', () => {
  const items = twoTurnItems()
  const ui1: FlowUiState = { ...UI, blockUiState: {} }
  const first = projectConversation(baseInput({ items, ui: ui1 }))
  const ui2: FlowUiState = { ...UI, turnUiState: { 'T-TEST:turn-1': { collapsed: true } } }
  const second = projectConversation(baseInput({ items, ui: ui2 }))
  assert.notEqual(second[0], first[0], 'ui 引用变化 → 重建（保守：折叠态正确性优先）')
  assert.equal(second[0].collapsed, true)
  assert.notEqual(second[1], first[1])
})

test('TC-PROJ46-004 事件（turn_note）变更 → 目标轮重建', () => {
  const items = twoTurnItems()
  const first = projectConversation(baseInput({ items }))
  const ev: SessionEvent = {
    id: 'ev1',
    seq: 1,
    ts: 700,
    type: 'turn_note',
    iteration: 2,
    text: '阶段结论',
    via: 'model',
  } as unknown as SessionEvent
  const second = projectConversation(baseInput({ items, events: [ev] }))
  assert.equal(second[0], first[0], '无关轮稳定')
  assert.notEqual(second[1], first[1], 'note 挂载轮重建')
})

test('TC-PROJ46-005 缓存正确性：同 id 不同内容必然重建（防串轮）', () => {
  const items1 = twoTurnItems()
  const first = projectConversation(baseInput({ items: items1 }))
  // 同结构但第 1 轮 step 内容变化（thought 变了 → step 对象是新引用）
  const items2: ConversationItem[] = [
    userItem('u1', '第一问', 100),
    reactItem('r1', [step({ id: 's1', type: 'reason', iteration: 1, thought: '思考 A-改' })]),
    userItem('u2', '第二问', 500),
    reactItem('r2', [step({ id: 's3', type: 'reason', iteration: 2, thought: '思考 B' })]),
  ]
  const second = projectConversation(baseInput({ items: items2 }))
  assert.notEqual(second[0], first[0], 'step 引用变化 → 必须重建')
})

/* ============================================================
 * TC-PROJ46-006 deriveConversation 引用级短路（W3）
 * ============================================================ */

const fakeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'T-TEST',
    title: 't',
    status: 'running',
    input: { text: '第一问' },
    createdAt: 1,
    updatedAt: 1,
    planItems: [],
    agentId: '@default',
    modelId: 'm',
  }) as unknown as Task

test('TC-PROJ46-006 derive 短路：steps/memory/task 引用全等 → 同一结果引用', () => {
  const task = fakeTask()
  const steps = [step({ id: 's1', type: 'reason', iteration: 1, thought: 'A' })]
  const memory: never[] = []
  const first = deriveConversation(task, steps, memory)
  const second = deriveConversation(task, steps, memory)
  assert.equal(second, first, '引用级短路命中 —— 流式期间 items 引用稳定的关键')
})

test('TC-PROJ46-007 derive 失配：task / memory / 任意 step 引用变化 → 重算', () => {
  const task = fakeTask()
  const steps = [step({ id: 's1', type: 'reason', iteration: 1, thought: 'A' })]
  const memory: never[] = []
  const first = deriveConversation(task, steps, memory)
  assert.notEqual(deriveConversation({ ...task } as Task, steps, memory), first, 'task 引用变化 → 重算')
  assert.notEqual(deriveConversation(task, steps, [] as never[]), first, 'memory 引用变化 → 重算')
  const replaced = [step({ id: 's1', type: 'reason', iteration: 1, thought: 'A改' })]
  assert.notEqual(deriveConversation(task, replaced, memory), first, 'step 引用变化 → 重算')
  const inserted = [...steps, step({ id: 's2', type: 'act', iteration: 1, toolName: 'file-reader' })]
  assert.notEqual(deriveConversation(task, inserted, memory), first, '长度变化 → 重算')
  // 中间 step 替换（长度不变）也必须重算 —— O(n) 逐元素引用比较兜住
  const middle = [
    step({ id: 's0', type: 'act', iteration: 1, toolName: 'shell' }),
    step({ id: 's1', type: 'reason', iteration: 1, thought: 'A' }),
  ]
  const base = deriveConversation(task, [steps[0]!, middle[0]!], memory)
  const swapped = deriveConversation(task, [steps[0]!, step({ id: 's0', type: 'act', iteration: 1, toolName: 'file-reader' })], memory)
  assert.notEqual(swapped, base, '中间元素引用变化 → 重算（防静默旧值）')
})

/* ============================================================
 * TC-PROJ46-008 纯度守卫：缓存不改变输出语义（同输入两次投影值相等）
 * ============================================================ */
test('TC-PROJ46-008 缓存透明：连续投影（无新输入）结果 deep-equal 原语义', () => {
  const items = twoTurnItems()
  const planItems: PlanItem[] = []
  const first = projectConversation(baseInput({ items, planItems }))
  const second = projectConversation(baseInput({ items, planItems }))
  assert.deepEqual(second, first, '缓存命中路径输出与全新构建语义一致')
  assert.equal(second[0], first[0])
})
