/* ============================================================
 * ArkWork — v0.36.0 B11/P4-a：流式正文通道投影 单测
 * 载体：flow/project.ts 纯函数（node:test 密闭，无 React / 无 IPC）
 * 规格来源：docs/versions/v0.36.0/12-b11-fix-batch-design.md §五（P4-a）
 * 运行（cwd=app）：node scripts/run-tests.mjs b11-text-stream
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationItem } from '@shared/types/conversation'
import type { ReActStep } from '@shared/types/react'
import type { FlowUiState } from '../../store/types'
import { projectConversation, type ProjectInput } from '../project'

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

const userItem = (id: string, text: string, ts: number): ConversationItem => ({
  id,
  type: 'user',
  text,
  ts,
})

test('TC-EXEC-001a :turn:text 缓冲 → 末轮 streaming Answer 块（正文实时可见）', () => {
  const items: ConversationItem[] = [userItem('u1', '分析一下', 100)]
  const turns = projectConversation(
    baseInput({
      items,
      streamBuffers: { 'T-TEST:turn:text': { seq: 3, text: 'TravelSky Code 是一个' } },
    }),
  )
  assert.equal(turns.length, 1)
  const t = turns[0]
  const streamed = t.outerBlocks.find((b) => b.kind === 'answer' && (b as { streaming?: boolean }).streaming === true)
  assert.ok(streamed, '必须存在 streaming answer 块')
  assert.equal((streamed as { text: string }).text, 'TravelSky Code 是一个')
  assert.equal(t.header.status, 'running', '流式期间轮必须呈 running')
})

test('TC-EXEC-001b 无 text 缓冲时不产生流式块（历史数据零影响）', () => {
  const items: ConversationItem[] = [userItem('u1', '问', 100)]
  const turns = projectConversation(baseInput({ items }))
  const streamed = turns[0].outerBlocks.filter((b) => b.kind === 'answer')
  assert.equal(streamed.length, 0)
})

test('TC-EXEC-001c 落定去重护栏：settled answer 同文时不再叠加流式块', () => {
  const items: ConversationItem[] = [
    userItem('u1', '问', 100),
    {
      id: 'a1',
      type: 'assistant',
      text: '最终结论',
      ts: 900,
    },
  ]
  const turns = projectConversation(
    baseInput({
      items,
      streamBuffers: { 'T-TEST:turn:text': { seq: 9, text: '最终结论' } },
    }),
  )
  const answers = turns[0].outerBlocks.filter((b) => b.kind === 'answer')
  assert.equal(answers.length, 1, 'settled answer 与流式块同文时只保留一份')
  assert.equal((answers[0] as { streaming?: boolean }).streaming, false)
})

test('TC-EXEC-001d 落定 say 块已含同文时不再叠加流式块', () => {
  const items: ConversationItem[] = [
    userItem('u1', '问', 100),
    {
      id: 'r1',
      type: 'react',
      steps: [step({ id: 's1', type: 'reason', iteration: 1, thought: '思考', say: '同一段结论' })],
      ts: 200,
    },
  ]
  const turns = projectConversation(
    baseInput({
      items,
      streamBuffers: { 'T-TEST:turn:text': { seq: 5, text: '同一段结论' } },
    }),
  )
  const streamed = turns[0].outerBlocks.filter(
    (b) => b.kind === 'answer' && (b as { streaming?: boolean }).streaming === true,
  )
  assert.equal(streamed.length, 0, 'say 块接管后流式缓冲块必须退位')
})

test('TC-EXEC-002a 流式正文过 SAY 兜底剥离（裸标记不进流式块）', () => {
  const items: ConversationItem[] = [userItem('u1', '问', 100)]
  const turns = projectConversation(
    baseInput({
      items,
      streamBuffers: { 'T-TEST:turn:text': { seq: 2, text: '结论 A\n<<SAY>>>\n摘要' } },
    }),
  )
  const streamed = turns[0].outerBlocks.find(
    (b) => b.kind === 'answer' && (b as { streaming?: boolean }).streaming === true,
  ) as { text: string } | undefined
  assert.ok(streamed)
  assert.ok(!streamed.text.includes('SAY'))
})
