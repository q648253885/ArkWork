/* ============================================================
 * ArkWork — B3 投影层单测（TC-FLOW-001/002/003）
 * 载体：flow/project.ts 纯函数密闭断言（node:test，无 React / 无 IPC）。
 * 规格：docs/versions/v0.31.0/testcases/00-cumulative-matrix.md §3.8。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationItem, SessionEvent } from '@shared/types/conversation'
import type { ReActStep } from '@shared/types/react'
import type { PlanItem } from '@shared/types/task'
import type { AnswerBlock, FlowTurn, SayBlock, ReasoningBlock, UserBlock } from '@shared/types/flow'
import { projectConversation, turnRenderSequence, type ProjectInput } from '../project'
import type { FlowUiState } from '../../store/types'

/* ---------- 工厂 ---------- */

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

/* ============================================================
 * TC-FLOW-001 轮切分：user 边界开新轮 / plan 卡归入当前轮 /
 * plan 先于任何 user 时自动开 automation 轮 / 轮序号 1-based
 * ============================================================ */
test('TC-FLOW-001 轮切分与触发者归因', () => {
  const items: ConversationItem[] = [
    userItem('u1', '第一问', 100),
    reactItem('r1', [
      step({ id: 's1', type: 'reason', iteration: 1, thought: '思考 A' }),
      step({ id: 's2', type: 'act', iteration: 1, toolName: 'file-reader', toolArgs: '{"path":"/a"}' }),
    ]),
    userItem('u2', '第二问', 500),
    reactItem('r2', [
      step({ id: 's3', type: 'reason', iteration: 2, thought: '思考 B' }),
    ]),
    { id: 'p1', type: 'plan', plan: { goal: '目标 G', items: ['x'], useResources: [], skipResources: [] }, ts: 600 },
  ]

  const turns = projectConversation(baseInput({ items }))

  assert.equal(turns.length, 2)
  // 轮 1：user 触发，含 UserBlock + 1 个 step
  assert.equal(turns[0].header.index, 1)
  assert.equal(turns[0].header.trigger, 'user')
  assert.equal(turns[0].steps.length, 1)
  assert.equal(turns[0].steps[0].index, 1)
  const u0 = turns[0].outerBlocks[0] as UserBlock
  assert.equal(u0.kind, 'user')
  assert.equal(u0.text, '第一问')
  // 轮 2：user 触发 + 计划卡归入当前轮（不另开轮）
  assert.equal(turns[1].header.index, 2)
  assert.equal(turns[1].header.trigger, 'user')
  assert.equal(turns[1].steps.length, 1)
  assert.equal(turns[1].outerBlocks.filter((b) => b.kind === 'plan').length, 1)

  // plan 先于任何 user → 自动开 automation 轮
  const turns2 = projectConversation(baseInput({
    items: [
      { id: 'p0', type: 'plan', plan: { goal: '前置', items: [], useResources: [], skipResources: [] }, ts: 50 },
      userItem('u1', 'hi', 100),
    ],
  }))
  assert.equal(turns2.length, 2)
  assert.equal(turns2[0].header.trigger, 'automation')
  assert.equal(turns2[1].header.trigger, 'user')

  // 空 items + 空 events → 空输出
  assert.deepEqual(projectConversation(baseInput()), [])
})

/* ============================================================
 * TC-FLOW-002 思考来源分类（native / content / none）+ truncated +
 * say 块 + isSummarySource 仅标最后一处
 * ============================================================ */
test('TC-FLOW-002 思考来源与 say 标记', () => {
  const items: ConversationItem[] = [
    userItem('u1', 'q', 100),
    reactItem('r1', [
      step({ id: 's1', type: 'reason', iteration: 1, thought: '内容式思考', say: '先看 A' }),
      step({ id: 's2', type: 'reason', iteration: 2, reasoning: '原生推理链', thought: '兜底不该生效', say: '再看 B', truncated: true }),
      step({ id: 's3', type: 'reason', iteration: 3, say: '结论' }),
    ]),
  ]

  const turns = projectConversation(baseInput({ items }))
  assert.equal(turns.length, 1)
  const seq = turnRenderSequence(turns[0])

  const reasoning = seq.filter((b) => b.kind === 'reasoning') as ReasoningBlock[]
  assert.equal(reasoning.length, 2) // 无思考的第 3 步不产 reasoning 块（source='none'）
  assert.equal(reasoning[0].source, 'content')
  assert.equal(reasoning[0].text, '内容式思考')
  assert.equal(reasoning[1].source, 'native')
  assert.equal(reasoning[1].text, '原生推理链') // native 优先于 thought
  assert.equal(reasoning[1].truncated, true)

  const says = seq.filter((b) => b.kind === 'say') as SayBlock[]
  assert.equal(says.length, 3)
  assert.equal(says.filter((s) => s.isSummarySource).length, 1)
  assert.equal(says[says.length - 1].isSummarySource, true) // 仅最后一个 say
  assert.equal(says[0].status, 'settled')
})

/* ============================================================
 * TC-FLOW-003 流式缓冲 → streaming ReasoningBlock（不跳变 RC-3 展示侧）+
 * 轮级错误事件 + 纯函数等幂（同一输入两次求值 deep-equal；入参不被改写）
 * ============================================================ */
test('TC-FLOW-003 流式缓冲与轮级状态', () => {
  // 1) 缓冲存在 → 最后一轮追加 streaming ReasoningBlock，轮转 running
  const items: ConversationItem[] = [userItem('u1', 'q', 100)]
  const turns = projectConversation(baseInput({
    items,
    streamBuffers: { 'T-TEST:turn:reasoning': { seq: 3, text: '正在思考……' } },
  }))
  assert.equal(turns.length, 1)
  assert.equal(turns[0].header.status, 'running')
  const seq = turnRenderSequence(turns[0])
  const streamBlocks = seq.filter((b) => b.kind === 'reasoning' && (b as ReasoningBlock).status === 'streaming') as ReasoningBlock[]
  assert.equal(streamBlocks.length, 1)
  assert.equal(streamBlocks[0].text, '正在思考……')
  assert.equal(streamBlocks[0].source, 'native')

  // 2) 落定后（缓冲被 B1 store 清空）→ 无 streaming 块（不跳变：settled 块承载同源内容）
  const items2: ConversationItem[] = [
    userItem('u1', 'q', 100),
    reactItem('r1', [step({ id: 's1', type: 'reason', iteration: 1, reasoning: '原生推理链' })]),
  ]
  const settled = projectConversation(baseInput({ items: items2 }))
  const seq2 = turnRenderSequence(settled[0])
  assert.equal(seq2.filter((b) => b.kind === 'reasoning' && (b as ReasoningBlock).status === 'streaming').length, 0)
  const r = seq2.find((b) => b.kind === 'reasoning') as ReasoningBlock
  assert.equal(r.status, 'settled')
  assert.equal(r.text, '原生推理链')

  // 3) task_failed 事件 → 轮 failed + ErrorBlock（outerBlocks）
  const ev: SessionEvent = {
    type: 'task_failed',
    iteration: 1,
    error: 'boom',
    id: 'e1',
    seq: 9,
    ts: 2_000,
  }
  const failedTurns = projectConversation(baseInput({ items: items2, events: [ev] }))
  assert.equal(failedTurns[0].header.status, 'failed')
  assert.equal(failedTurns[0].header.errorMessage, 'boom')
  assert.equal(failedTurns[0].outerBlocks.filter((b) => b.kind === 'error').length, 1)
})

test('TC-FLOW-003b 纯函数等幂与输入不可变', () => {
  const items: ConversationItem[] = [
    userItem('u1', 'q', 100),
    reactItem('r1', [
      step({ id: 's1', type: 'reason', iteration: 1, thought: 't', say: 's' }),
      step({
        id: 's2', type: 'act', iteration: 1, toolName: 'file-writer', intent: '写文件',
        toolArgs: JSON.stringify({ path: 'docs/a.md', content: 'x' }),
      }),
      step({ id: 's3', type: 'observation', iteration: 1, summary: 'done', rawL2Path: '/l2.json' }),
    ]),
  ]
  const steps = items[1].steps ?? []
  const input = baseInput({ items })
  const snapshot = JSON.stringify(input)

  const out1: FlowTurn[] = projectConversation(input)
  const out2: FlowTurn[] = projectConversation(input)
  assert.deepEqual(out2, out1)
  assert.equal(JSON.stringify(input), snapshot, '投影不得改写入参')

  // observation 归并进最近 ToolBlock（rawL2Path + result.summary）
  const tool = out1[0].steps[0].blocks.find((b) => b.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.rawL2Path, '/l2.json')
  assert.equal(tool.result?.summary, 'done')
  // v0.31.0 B4 口径：title 来自呈现协议（present.ts file-writer → `写入 ${path}`），
  // 不再读 step.intent（intent 保留为 ToolBlock.intent 供 fallback 与 A11 定位）
  assert.equal(tool.call.title, '写入 docs/a.md')

  // 计量聚合
  assert.equal(out1[0].summary.toolTotal, 1)
  assert.equal(out1[0].summary.toolCounts.execute, undefined)
  assert.equal(out1[0].summary.toolCounts.edit, 1) // file-writer → edit

  // AnswerBlock 唯一来源 = assistant 项（旧 deriveConversation 同源）；
  // origin 由前置 react 组首个 reason 步的 action 推导（task_complete → task-complete）
  const items3: ConversationItem[] = [
    userItem('u1', 'q', 100),
    reactItem('r2', [step({
      id: 's9', type: 'reason', iteration: 2, thought: '内部推理',
      action: { tool: 'task_complete', args: { summary: '任务完成总结' } },
    })]),
    { id: 'a1', type: 'assistant', text: '任务完成总结', ts: 300 },
  ]
  const out3 = projectConversation(baseInput({ items: items3 }))
  const answers = turnRenderSequence(out3[0]).filter((b) => b.kind === 'answer') as AnswerBlock[]
  assert.equal(answers.length, 1)
  assert.equal(answers[0].origin, 'task-complete')
  assert.equal(answers[0].text, '任务完成总结')
})

/* ---------- planItems 状态注入（PlanBlock 六态以任务持久化为真源） ---------- */
test('TC-FLOW-004 计划卡状态取 task.planItems', () => {
  const planItems: PlanItem[] = [
    { id: 'p1', text: 'x', status: 'done', createdAt: 1, updatedAt: 2 },
    { id: 'p2', text: 'y', status: 'running', createdAt: 1, updatedAt: 2 },
  ]
  const items: ConversationItem[] = [
    userItem('u1', 'q', 100),
    {
      id: 'p-card', type: 'plan',
      plan: { goal: 'G', items: ['x', 'y'], useResources: [], skipResources: [] },
      planStates: ['pending', 'pending'],
      ts: 200,
    },
  ]
  const turns = projectConversation(baseInput({ items, planItems }))
  const plan = turns[0].outerBlocks.find((b) => b.kind === 'plan')
  assert.ok(plan && plan.kind === 'plan')
  assert.deepEqual(plan.states, ['done', 'running']) // 持久化六态优先于 item.planStates
  assert.equal(plan.aggregate, 'running')
})
