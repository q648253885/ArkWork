/* ============================================================
 * ArkWork — 产物卡与路径链接化（v0.44.0 · TC-ART，对应 R-A/R-B/R-C）
 *
 * 用户实机反馈（T-20261001-2r3063）：最终答复里 "docs/SIMILAR_PROJECTS.md"
 * 只是纯文本 —— 不可点击、产物没有存在感。本套件钉死三层：
 *  ① 投影：最后一次 task-complete 答复轮追加 ArtifactBlock（去重 / 跳过
 *     command / 无产物不出块 / 仅最后一轮）；
 *  ② 呈现契约：ArtifactCard / NoteBlock / SayBlock / LinkifiedText /
 *     BlockRenderer（源码守卫，stripComments 剥注释）；
 *  ③ i18n 四语言键齐备。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs artifact-block
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ConversationItem } from '@shared/types/conversation'
import type { ReActStep } from '@shared/types/react'
import type { PlanItem } from '@shared/types/task'
import type { ArtifactBlock, FlowBlock, FlowTurn } from '@shared/types/flow'
import type { FlowUiState } from '../../store/types'
import { projectConversation, type ProjectInput } from '../project'
import { linkifyWorkspacePaths } from '../../utils/path-links'
/** 注释剥离器唯一真源（纪律㉒） */
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

/* ---------- 工厂（同 project.test.ts 口径） ---------- */

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

const userItem = (id: string, text: string, ts: number): ConversationItem => ({ id, type: 'user', text, ts })

const completeTurnItems = (answerId = 'a1', answerText = '已完成同类项目调研：成文于 docs/SIMILAR_PROJECTS.md。'): ConversationItem[] => [
  userItem('u1', 'q', 100),
  reactItem('r1', [step({
    id: 's1', type: 'reason', iteration: 1, thought: '收尾',
    action: { tool: 'task_complete', args: { summary: answerText } },
  })]),
  { id: answerId, type: 'assistant', text: answerText, ts: 300 },
]

function reactItem(id: string, steps: ReActStep[]): ConversationItem {
  return { id, type: 'react', steps, ts: steps[0]?.startedAt ?? 0 }
}

const artifactBlocksOf = (turns: FlowTurn[]): ArtifactBlock[] =>
  turns.flatMap((t) => t.outerBlocks.filter((b): b is ArtifactBlock => b.kind === 'artifact'))

/* ============================================================
 * 一、投影（R-B 数据面）
 * ============================================================ */

const PLAN_WITH_ARTIFACT: PlanItem[] = [
  { id: 'p1', text: '调研候选', status: 'done', createdAt: 1, updatedAt: 2, artifact: { path: 'docs/SIMILAR_PROJECTS.md', kind: 'file' } },
  { id: 'p2', text: '汇总', status: 'done', createdAt: 1, updatedAt: 2, artifact: { path: 'docs/SIMILAR_PROJECTS.md', kind: 'file' } },
]

test('TC-ART-001 task-complete 答复轮出现产物卡：entries 来自 planItems 声明、按 path 去重', () => {
  const turns = projectConversation(baseInput({ items: completeTurnItems(), planItems: PLAN_WITH_ARTIFACT }))
  const cards = artifactBlocksOf(turns)
  assert.equal(cards.length, 1, '恰好一张产物卡（挂在最后一次完成轮）')
  assert.deepEqual(cards[0]!.entries, [{ path: 'docs/SIMILAR_PROJECTS.md', kind: 'file' }], '两项声明同一产物 → 去重为一条')
  assert.equal(cards[0]!.turn, turns[turns.length - 1]!.header.index, '与答复同轮（答复轮，turn 号以 header.index 为准）')
})

test('TC-ART-002 command 型产物不进卡；file/dir 正常', () => {
  const planItems: PlanItem[] = [
    { id: 'p1', text: '跑校验', status: 'done', createdAt: 1, updatedAt: 2, artifact: { path: 'npm test', kind: 'command' } },
    { id: 'p2', text: '出报告', status: 'done', createdAt: 1, updatedAt: 2, artifact: { path: 'docs/r.md', kind: 'file' } },
    { id: 'p3', text: '打包目录', status: 'done', createdAt: 1, updatedAt: 2, artifact: { path: 'dist', kind: 'dir' } },
  ]
  const turns = projectConversation(baseInput({ items: completeTurnItems(), planItems }))
  const cards = artifactBlocksOf(turns)
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0]!.entries.map((e) => e.path), ['docs/r.md', 'dist'], 'command 是校验命令不是文件，不渲染为可点击产物')
})

test('TC-ART-003 无产物 / 无 task-complete 轮 → 不出块（诚实 UI，不渲染空卡）', () => {
  // 无 artifact 声明
  const noArtifact = projectConversation(baseInput({
    items: completeTurnItems(),
    planItems: [{ id: 'p1', text: '调研', status: 'done', createdAt: 1, updatedAt: 2 }],
  }))
  assert.equal(artifactBlocksOf(noArtifact).length, 0, '无产物声明不出卡')
  // 空清单
  const empty = projectConversation(baseInput({ items: completeTurnItems(), planItems: [] }))
  assert.equal(artifactBlocksOf(empty).length, 0, '空清单不出卡')
  // 有产物但无 task-complete 轮（ask_user 收尾）
  const askUser = projectConversation(baseInput({
    items: [
      userItem('u1', 'q', 100),
      reactItem('r1', [step({
        id: 's1', type: 'reason', iteration: 1,
        action: { tool: 'ask_user', args: { question: '继续吗？' } },
      })]),
      { id: 'a1', type: 'assistant', text: '继续吗？', ts: 300 },
    ],
    planItems: PLAN_WITH_ARTIFACT,
  }))
  assert.equal(artifactBlocksOf(askUser).length, 0, 'ask-user 轮不出产物卡（任务未完成）')
})

test('TC-ART-004 多次完成仅最后一次 task-complete 轮出卡', () => {
  const items: ConversationItem[] = [
    userItem('u1', '第一轮指令', 100),
    reactItem('r1', [step({ id: 's1', type: 'reason', iteration: 1, action: { tool: 'task_complete', args: { summary: '第一轮完成' } } })]),
    { id: 'a1', type: 'assistant', text: '第一轮完成', ts: 200 },
    userItem('u2', '第二轮指令', 300),
    reactItem('r2', [step({ id: 's2', type: 'reason', iteration: 2, action: { tool: 'task_complete', args: { summary: '第二轮完成' } } })]),
    { id: 'a2', type: 'assistant', text: '第二轮完成', ts: 400 },
  ]
  const turns = projectConversation(baseInput({ items, planItems: PLAN_WITH_ARTIFACT }))
  const cards = artifactBlocksOf(turns)
  assert.equal(cards.length, 1, '只有最后一次完成轮有卡（历史轮不回填当前集合）')
  assert.equal(cards[0]!.turn, turns[turns.length - 1]!.header.index, '挂在最后一次完成的答复轮')
})

/* ============================================================
 * 二、LinkifiedText 无损性（R-C 纯执行）
 * ============================================================ */

test('TC-ART-010 LinkifiedText 数据面无损：分段拼接 ≡ 原文（linkify 契约复验）', () => {
  const samples = [
    '已完成同类项目调研：成文于 docs/SIMILAR_PROJECTS.md。唯一遗留是网络抓取中断。',
    '修改了 src/a.ts、src/b.ts 两处',
    '产物 docs/vX.Y/report.md:12 已落盘',
    '没有任何路径的普通句子',
  ]
  for (const s of samples) {
    const joined = linkifyWorkspacePaths(s).map((seg) => seg.value).join('')
    assert.equal(joined, s, 'text 段与 path 段拼接必须与输入逐字一致（含标点与空白）')
  }
})

test('TC-ART-011 负腿：无路径文本不产生 path 段', () => {
  for (const s of ['就这么一句话', '时间 12:30 开会', 'https://example.com 不是工作区路径']) {
    assert.equal(linkifyWorkspacePaths(s).some((seg) => seg.kind === 'path'), false, s)
  }
})

/* ---------- v0.45.0（R-E）：写盘兜底第二数据源 ---------- */

test('TC-ART-012 R-E 写盘兜底：planItems 无声明时，file-writer / file-editor 成功路径进产物卡（时间序）', () => {
  const writeSteps = [
    step({ id: 'w2', type: 'act', iteration: 2, startedAt: 2_000, toolName: 'file-writer', toolArgs: JSON.stringify({ path: 'docs/late.md' }) }),
    step({ id: 'w1', type: 'act', iteration: 1, startedAt: 1_500, toolName: 'file-editor', toolArgs: JSON.stringify({ path: 'src/a.ts' }) }),
    step({ id: 'w0', type: 'act', iteration: 1, startedAt: 1_000, toolName: 'file-writer', toolArgs: JSON.stringify({ path: 'docs/first.md' }) }),
  ]
  const items: ConversationItem[] = [
    userItem('u1', 'q', 100),
    reactItem('r1', [
      step({ id: 's1', type: 'reason', iteration: 3, thought: '收尾', action: { tool: 'task_complete', args: { summary: '完成' } } }),
      ...writeSteps,
    ]),
    { id: 'a1', type: 'assistant', text: '完成', ts: 3_000 },
  ]
  const turns = projectConversation(baseInput({ items, steps: writeSteps }))
  const cards = artifactBlocksOf(turns)
  assert.equal(cards.length, 1, '无声明也有卡（R-E 写盘兜底）')
  assert.deepEqual(
    cards[0]!.entries.map((e) => e.path),
    ['docs/first.md', 'src/a.ts', 'docs/late.md'],
    '写盘路径按执行时间序排列',
  )
})

test('TC-ART-013 R-E 负腿与去重：失败/软失败/非法 args 不进卡；声明优先、path 去重', () => {
  const writeSteps = [
    step({ id: 'w1', type: 'act', iteration: 1, toolName: 'file-writer', toolArgs: JSON.stringify({ path: 'docs/r.md' }), status: 'failed', errorMessage: 'x' }),
    step({ id: 'w2', type: 'act', iteration: 1, toolName: 'file-writer', toolArgs: JSON.stringify({ path: 'docs/blocked.md' }), softFail: true }),
    step({ id: 'w3', type: 'act', iteration: 1, toolName: 'file-writer', toolArgs: 'not-json' }),
    step({ id: 'w4', type: 'act', iteration: 1, toolName: 'file-writer', toolArgs: JSON.stringify({ path: 'docs/dupe.md' }) }),
    step({ id: 'w5', type: 'act', iteration: 1, toolName: 'shell', toolArgs: JSON.stringify({ command: 'echo hi > docs/x.md' }) }),
  ]
  const planItems: PlanItem[] = [
    { id: 'p1', text: '出报告', status: 'done', createdAt: 1, updatedAt: 2, artifact: { path: 'docs/dupe.md', kind: 'file' } },
  ]
  const items: ConversationItem[] = [
    userItem('u1', 'q', 100),
    reactItem('r1', [
      step({ id: 's1', type: 'reason', iteration: 2, thought: '收尾', action: { tool: 'task_complete', args: { summary: '完成' } } }),
      ...writeSteps,
    ]),
    { id: 'a1', type: 'assistant', text: '完成', ts: 300 },
  ]
  const turns = projectConversation(baseInput({ items, steps: writeSteps, planItems }))
  const cards = artifactBlocksOf(turns)
  assert.equal(cards.length, 1)
  assert.deepEqual(cards[0]!.entries, [{ path: 'docs/dupe.md', kind: 'file' }], '声明优先占位；失败/软失败/非法 args/shell 不进卡；path 去重')
})

/* ============================================================
 * 三、呈现契约（源码守卫，stripComments 剥注释）
 * ============================================================ */

test('TC-ART-005 i18n 四语言：flow.artifactCard.title 齐备', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
    const json = JSON.parse(read(`../../i18n/locales/${lang}.json`)) as {
      flow: { artifactCard?: { title?: string } }
    }
    assert.ok(json.flow.artifactCard?.title, `${lang}.flow.artifactCard.title 必须存在`)
  }
})

test('TC-ART-006 NoteBlock 契约：正文经 LinkifiedText（R-C）', () => {
  const src = stripComments(read('../../components/flow/blocks/NoteBlock.tsx'))
  assert.match(src, /<LinkifiedText text=\{block\.text\} \/>/, '阶段结论正文必须经 LinkifiedText 分段链接化')
  assert.match(src, /from '\.\.\/LinkifiedText'/, '消费唯一实现（path-links 判据不得到处重写）')
})

test('TC-ART-007 SayBlock 契约：两种字号形态均经 LinkifiedText', () => {
  const src = stripComments(read('../../components/flow/blocks/SayBlock.tsx'))
  const hits = src.split('<LinkifiedText text={block.text} />').length - 1
  assert.equal(hits, 2, `say 主/次两级形态都应经 LinkifiedText（实测 ${hits} 处）`)
})

test('TC-ART-008 TaskArtifactCard 契约：经 FileLink 打开（不直连 openPreview）、全路径展示（D112）', () => {
  const src = stripComments(read('../../components/flow/blocks/TaskArtifactCard.tsx'))
  assert.match(src, /<FileLink/, '产物条目必须渲染为 FileLink')
  assert.match(src, /flow\.artifactCard\.title/, '标题走 i18n')
  assert.doesNotMatch(src, /openPreview/, '禁止直连 openPreview（唯一门面 = useOpenPath → openDoc）')
})

test('TC-ART-009 BlockRenderer 分发契约：kind artifact → TaskArtifactCard（唯一 kind switch）', () => {
  const src = stripComments(read('../../components/flow/BlockRenderer.tsx'))
  assert.match(src, /case 'artifact':\s*\n\s*return <TaskArtifactCard block=\{block\} \/>/, '分发只发生在 BlockRenderer 的 kind switch（TC-BLOCK-001 口径）')
  const blocksIndex = stripComments(read('../../components/flow/blocks/index.ts'))
  assert.match(blocksIndex, /export \{ TaskArtifactCard \} from '\.\/TaskArtifactCard'/, '桶导出在位')
})
