/* ============================================================
 * v0.38.0 详测 — 阶段结论 / 门禁通告的交互区投影（TC-UI-003…008）
 *
 * 对应文档：docs/versions/v0.38.0/03-interaction.md §三 / §四 / §八
 *
 * 为什么必须把这组用例存在（而不是靠"改完看一眼"）：
 *   ★ 这两条投影在改之前是**永远不显示的成品代码** —— TurnList 与 tasksSlice
 *     都传 `events: []`，渲染层从来没有 session 事件通道。也就是说：
 *     即使投影分支写对了，只要**接线**没做，用户看到的仍然是一片沉默。
 *     所以本组除了断言"块造得对"，还专门断言"两条入参都真的传了 events"
 *     （接线契约，纪律③）。
 *
 * 载体：project.ts 纯函数 + 源码守卫（node:test，无 React / 无 IPC）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --test src/renderer/flow/__tests__/uc38-note-ui.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ConversationItem, SessionEvent } from '@shared/types/conversation'
import type { ReActStep } from '@shared/types/react'
import type { FlowTurn } from '@shared/types/flow'
import { segmentFlow } from '@shared/utils/flow-fold'
import { stripComments } from '@shared/utils/source-guard'
import { projectConversation, type ProjectInput } from '../project'
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

const userItem = (id: string, text: string, ts: number): ConversationItem => ({ id, type: 'user', text, ts })

/** SessionEvent 夹具（id/seq/ts 是落盘元数据，投影层用它保持块 id 稳定） */
const ev = <T extends SessionEvent['type']>(
  type: T,
  payload: Omit<Extract<SessionEvent, { type: T }>, 'id' | 'seq' | 'ts' | 'type'>,
  ts: number,
  seq = 1,
): SessionEvent =>
  ({ type, ...payload, id: `ev-${seq}`, seq, ts }) as unknown as SessionEvent

/** 一个"第 1 轮、含 1 个 reason + 1 个 tool"的最小会话 */
const baseItems = (): ConversationItem[] => [
  userItem('u1', '看看工作区', 100),
  reactItem('r1', [
    step({ id: 's1', type: 'reason', iteration: 1, thought: '先看一眼目录' }),
    step({ id: 's2', type: 'act', iteration: 1, toolName: 'file-reader', toolArgs: '{"path":"."}' }),
  ]),
]

const noteBlocks = (turns: FlowTurn[]) =>
  turns.flatMap((t) => t.steps.flatMap((s) => s.blocks)).filter((b) => b.kind === 'note')

/* ============================================================
 * TC-UI-003 turn_note → NoteBlock
 * ============================================================ */

test('TC-UI-003 turn_note 投影为 NoteBlock，且挂在所属 iteration 的 FlowStep.blocks（不是 outerBlocks）', () => {
  const turns = projectConversation(
    baseInput({
      items: baseItems(),
      events: [ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '已确认是只读问答', via: 'model' }, 1200)],
    }),
  )
  const notes = noteBlocks(turns)
  assert.equal(notes.length, 1, 'turn_note 必须产出一个 note 块')
  const n = notes[0]!
  assert.equal(n.text, '已确认是只读问答')
  assert.equal(n.via, 'model')
  assert.equal(n.step, 1)
  assert.equal(n.turn, 1)

  // 挂载位置：FlowStep.blocks（§三 3.2）
  const inStep = turns[0]!.steps.some((s) => s.blocks.some((b) => b.kind === 'note'))
  const inOuter = turns[0]!.outerBlocks.some((b) => b.kind === 'note')
  assert.equal(inStep, true, 'note 应挂在 FlowStep.blocks')
  assert.equal(inOuter, false, 'note 不该挂 outerBlocks —— 那样会丢掉与相邻思考/工具的时间邻接')
})

test('TC-UI-003b 事件时间戳决定插入位置：夹在两段进程之间（不是无脑 append 到末尾）', () => {
  // step 内的块时间：reason@1000, tool@1100；note 的 ts=1050 → 应插在两者之间
  const items: ConversationItem[] = [
    userItem('u1', 'x', 100),
    reactItem('r1', [
      step({ id: 's1', type: 'reason', iteration: 1, thought: 'A', startedAt: 1000 }),
      step({ id: 's2', type: 'act', iteration: 1, toolName: 'file-reader', startedAt: 1100, toolArgs: '{"path":"."}' }),
    ]),
  ]
  const turns = projectConversation(
    baseInput({
      items,
      events: [ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '中途结论', via: 'model' }, 1050)],
    }),
  )
  const kinds = turns[0]!.steps[0]!.blocks.map((b) => b.kind)
  assert.deepEqual(kinds, ['reasoning', 'note', 'tool'], '保序插入，让结论出现在它真实发生的位置')
})

test('TC-UI-003c 空文本的 turn_note 被丢弃（不投空白卡片）', () => {
  const turns = projectConversation(
    baseInput({
      items: baseItems(),
      events: [
        ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '   ', via: 'model' }, 1200),
        ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '', via: 'gate-refusal' }, 1300, 2),
      ],
    }),
  )
  assert.equal(noteBlocks(turns).length, 0)
})

test('TC-UI-003d via 白名单守卫：非法 / 缺失 via 回落 model（不产生 undefined 分支）', () => {
  const turns = projectConversation(
    baseInput({
      items: baseItems(),
      events: [
        ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '甲', via: 'bogus' as never }, 1200),
        ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '乙', via: 'plan-commit' }, 1210, 2),
      ],
    }),
  )
  const notes = noteBlocks(turns)
  assert.deepEqual(
    notes.map((n) => n.via),
    ['model', 'plan-commit'],
  )
})

test('TC-UI-003e 事件 iteration 无对应步骤时不丢块：造空壳 FlowStep 承载', () => {
  const turns = projectConversation(
    baseInput({
      items: baseItems(),
      events: [ev('turn_note', { taskId: 'T-TEST', iteration: 7, text: '第七轮结论', via: 'model' }, 5000)],
    }),
  )
  const notes = noteBlocks(turns)
  assert.equal(notes.length, 1, '丢块 = 用户永远看不到这条结论，比"位置不完美"严重得多')
  assert.equal(notes[0]!.step, 7)
})

/* ============================================================
 * TC-UI-004 gate_blocked → notice / gate-blocked
 * ============================================================ */

test('TC-UI-004 gate_blocked 投影为 warning 级 notice，noticeKind=gate-blocked', () => {
  const turns = projectConversation(
    baseInput({
      items: baseItems(),
      events: [
        ev(
          'gate_blocked',
          {
            taskId: 'T-TEST',
            iteration: 1,
            code: 'TREE_SYNC',
            refusals: 1,
            max: 3,
            text: '完成门禁：本次执行有实质动作，但任务清单未更新。已要求模型先同步清单再收尾（第 1/3 次）。',
          },
          1200,
        ),
      ],
    }),
  )
  const notices = turns[0]!.steps[0]!.blocks.filter((b) => b.kind === 'notice')
  assert.equal(notices.length, 1)
  const g = notices[0] as Extract<typeof notices[number], { kind: 'notice' }>
  assert.equal(g.noticeKind, 'gate-blocked')
  assert.equal(g.level, 'warning')
  assert.equal(g.step, 1)
  assert.doesNotMatch(g.text, /\[tree-sync-required\]|\[unfinished-plan\]/u)
})

test('TC-UI-004b 文本由数据带入，投影层不做本地化 / 不改写（纯函数纪律）', () => {
  const raw = '完成门禁：本次执行有实质动作（原样透传校验）。'
  const turns = projectConversation(
    baseInput({
      items: baseItems(),
      events: [
        ev('gate_blocked', { taskId: 'T-TEST', iteration: 1, code: 'UNFINISHED', refusals: 2, max: 3, text: raw }, 1200),
      ],
    }),
  )
  const g = turns[0]!.steps[0]!.blocks.find((b) => b.kind === 'notice') as { text: string }
  assert.equal(g.text, raw, '投影层是纯函数：文案一律由 main 侧带入')
})

/* ============================================================
 * TC-UI-005 note 不折叠，且打断 process run
 * ============================================================ */

test('TC-UI-005 ★ note 不参与进程折叠，并把前后两段 process 切成两个 run', () => {
  const items: ConversationItem[] = [
    userItem('u1', 'x', 100),
    reactItem('r1', [
      step({ id: 's1', type: 'reason', iteration: 1, thought: '想 A', startedAt: 1000 }),
      step({ id: 's2', type: 'reason', iteration: 1, thought: '想 B', startedAt: 1100 }),
      step({ id: 's3', type: 'reason', iteration: 1, thought: '想 C', startedAt: 1300 }),
    ]),
  ]
  const turns = projectConversation(
    baseInput({
      items,
      events: [ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '阶段结论', via: 'model' }, 1200)],
    }),
  )
  const blocks = turns[0]!.steps[0]!.blocks
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['reasoning', 'reasoning', 'note', 'reasoning'],
    '夹具前提：note（ts=1200）恰好落在 1100 与 1300 两段思考之间',
  )

  const segs = segmentFlow(blocks)
  assert.deepEqual(
    segs.map((s) => (s.type === 'fold' ? `fold:${s.run.scope}` : `block:${s.block.kind}`)),
    ['fold:reasoning', 'block:note', 'fold:reasoning'],
    'note 必须是分界块：用户看到结论后，后续思考重新起算（§三 3.2）',
  )
})

test('TC-UI-005b PRIMARY_KINDS 含 note —— "永不折叠"要有可读的事实源', () => {
  const src = stripComments(readFileSync(new URL('../../../shared/utils/flow-fold.ts', import.meta.url), 'utf-8'))
  assert.match(src, /PRIMARY_KINDS = \[[^\]]*'note'/, 'note 属主展示块，必须列进 PRIMARY_KINDS')
})

/* ============================================================
 * TC-UI-008 note 的加入不影响既有块序列（回归护栏）
 * ============================================================ */

test('TC-UI-008 无事件 vs 有事件：既有块类型与顺序一字不变（新块只能"追加语义"，不能重排）', () => {
  const items = baseItems()
  const before = projectConversation(baseInput({ items }))
  const after = projectConversation(
    baseInput({
      items,
      events: [ev('turn_note', { taskId: 'T-TEST', iteration: 1, text: '结论', via: 'model' }, 1200)],
    }),
  )
  const kindsOf = (turns: FlowTurn[]) =>
    turns.map((t) => ({
      outer: t.outerBlocks.map((b) => b.kind),
      steps: t.steps.map((s) => s.blocks.map((b) => b.kind)),
    }))
  const a = kindsOf(before)
  const b = kindsOf(after)
  assert.deepEqual(b.map((x) => x.outer), a.map((x) => x.outer), 'outerBlocks 不该被 note 影响')
  assert.deepEqual(
    b[0]!.steps[0]!.filter((k) => k !== 'note'),
    a[0]!.steps[0],
    '剥掉 note 之后，原块序列必须逐项一致（D69：新块不得改写旧块）',
  )
})

/* ============================================================
 * TC-UI-007 NoteBlock 源码守卫（剥注释后断言）
 * ============================================================ */

test('TC-UI-007 ★ NoteBlock 容器含 select-text 且**不含** select-none（剥注释后断言，D89 同型）', () => {
  const raw = readFileSync(
    new URL('../../components/flow/blocks/NoteBlock.tsx', import.meta.url),
    'utf-8',
  )
  const src = stripComments(raw)
  assert.match(src, /select-text/, '结论是内容，必须可复制（全仓可复制纪律）')
  assert.doesNotMatch(src, /select-none/, '容器不得禁用选择 —— 否则复制不到结论')
})

test('TC-UI-007b NoteBlock 用 text-sm + 中性左边线（与 NoticeBlock 的琥珀条区分）', () => {
  const src = stripComments(
    readFileSync(new URL('../../components/flow/blocks/NoteBlock.tsx', import.meta.url), 'utf-8'),
  )
  assert.match(src, /text-sm/, '字号 text-sm(13px)：比正文小、比 notice 大')
  assert.match(src, /borderLeftColor:\s*'var\(--border-strong\)'/, '中性色（V3：不新增颜色）')
  assert.match(src, /fontSize|text-sm/)
})

test('TC-UI-001/002 BlockRenderer 覆盖 note 分支 + blocks/index 导出 NoteBlock', () => {
  const idx = stripComments(
    readFileSync(new URL('../../components/flow/blocks/index.ts', import.meta.url), 'utf-8'),
  )
  assert.match(idx, /export \{ NoteBlock \} from '\.\/NoteBlock'/)

  const renderer = stripComments(
    readFileSync(new URL('../../components/flow/BlockRenderer.tsx', import.meta.url), 'utf-8'),
  )
  assert.match(renderer, /case 'note':/, '判别联合新增成员后，渲染 switch 必须同步')
})

/* ============================================================
 * 接线契约（纪律③）：块造得再对，不接线也不显示
 * ============================================================ */

test('TC-UI-WIRE-001 ★ TurnList 真的把 store.flowEvents 喂进投影（含 useMemo 依赖）', () => {
  const src = stripComments(
    readFileSync(new URL('../../components/flow/TurnList.tsx', import.meta.url), 'utf-8'),
  )
  assert.match(src, /s\.flowEvents\[s\.selectedTaskId\]/, '必须从 store 取当前任务的投影事件')
  // v0.46.0（PERF-2 W2）改写（纪律㉔）：`?? []` 每次渲染新引用会让投影 turn 级
  // 结构共享的 deps 恒失配 → 空态改用模块级稳定常量 EMPTY_EVENTS（喂入语义不变）。
  assert.match(src, /events:\s*flowEvents,/, '必须传给 projectConversation')
  assert.match(src, /EMPTY_EVENTS/, '空态必须用稳定常量（不得每次渲染新 []）')
  assert.match(src, /flowEvents\]/, '依赖数组必须含 flowEvents —— 漏了就不会重渲染（改了等于没改）')
})

test('TC-UI-WIRE-002 ★ 导出/复制同源：buildConversationMarkdown 也传 flowEvents（D69 纪律）', () => {
  const src = stripComments(
    readFileSync(new URL('../../store/slices/tasksSlice.ts', import.meta.url), 'utf-8'),
  )
  assert.match(src, /events:\s*state\.flowEvents\[taskId\] \?\? \[\]/, '导出必须看到与屏幕同一份块')
  assert.doesNotMatch(src, /events:\s*\[\],\s*\/\/ 与 TurnList 同口径/, '旧的空数组占位必须消失')
})

test('TC-UI-WIRE-003 ★ 订阅层认领两类事件，并按 event.taskId 分桶（不靠"当前选中任务"猜）', () => {
  const src = stripComments(
    readFileSync(new URL('../../store/subscriptions.ts', import.meta.url), 'utf-8'),
  )
  assert.match(src, /event\.type === 'turn_note' \|\| event\.type === 'gate_blocked'/)
  assert.match(src, /appendFlowEvent\(event\.taskId, event\)/)
})

test('TC-UI-WIRE-004 两类事件自带 taskId（渲染层路由的唯一依据）', () => {
  const src = stripComments(readFileSync(new URL('../../../shared/types/react.ts', import.meta.url), 'utf-8'))
  const note = src.slice(src.indexOf("type: 'turn_note'"), src.indexOf("type: 'turn_note'") + 400)
  assert.match(note, /taskId: string/, 'turn_note 必须携带 taskId')
  const gate = src.slice(src.indexOf("type: 'gate_blocked'"), src.indexOf("type: 'gate_blocked'") + 400)
  assert.match(gate, /taskId: string/, 'gate_blocked 必须携带 taskId')
})
