/* ============================================================
 * ArkWork — 对话 Markdown 渲染单测（v0.34.4 · D69）
 *
 * 载体：`store/conversation-markdown.ts` 纯函数密闭断言
 *      （node:test 直连，无 React / 无 store / 无 i18n 链）。
 *
 * 为什么要有这份文件（纪律⑪的闭环）：
 *   屏幕走 `projectConversation` → `FlowTurn`（**9 种 FlowBlock**），
 *   而 v0.34.4 之前导出走 `ConversationItem`（4 种 type）→ 用户报
 *   「导出的内容和真正内容不一致」。治法是把导出接到同一条投影链上。
 *   但「接上了」还不够 —— 以后屏幕**加一种块**，导出必须同步能渲染它，
 *   否则同一个病会以新形态复发。故本文件的核心是：
 *
 *     ★ TC-CMD-010「结构对等」：渲染器的 `case` 集合 必须 ≡
 *       `@shared/types/flow` 里 FlowBlock 判别联合的 kind 集合。
 *       任何一边多一个 / 少一个，本用例报红（**解析源码，不是 grep 文本**，
 *       它断言的是判别的取值域，不是字符串出现过）。
 *
 * 用例：TC-CMD-001 … TC-CMD-024
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/renderer/store/__tests__/conversation-markdown.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  renderTurnsMarkdown,
  hasRenderableTurns,
  DEFAULT_LABELS,
} from '../conversation-markdown'

import type {
  AnswerBlock,
  ApprovalBlock,
  ErrorBlock,
  FlowBlock,
  FlowStep,
  FlowTurn,
  NoticeBlock,
  NoteBlock,
  PlanBlock,
  ReasoningBlock,
  SayBlock,
  SubagentGroupBlock,
  ToolBlock,
  TurnMetrics,
  UserBlock,
} from '@shared/types/flow'
import type { PlanItemStatus } from '@shared/types/task'
import type { ToolCallView, ToolResultView } from '@shared/types/tool-present'

/* ============================================================
 * 工厂
 * ============================================================ */

/** 固定时刻：本地 2026-09-19 14:05 → fmtClock 必为 "14:05"（不依赖 Date.now） */
const T0 = new Date(2026, 8, 19, 14, 5, 0).getTime()
const CLOCK = '14:05'

const metrics = (over: Partial<TurnMetrics> = {}): TurnMetrics => ({
  tokensIn: 0,
  tokensOut: 0,
  ...over,
})

const turn = (over: Partial<FlowTurn> = {}): FlowTurn => ({
  id: 'turn-1',
  header: {
    index: 1,
    trigger: 'user',
    agentId: 'default',
    agentName: 'Ark',
    agentAvatarColor: '#7c6cff',
    startedAt: T0,
    durationMs: 0,
    status: 'done',
    metrics: metrics(),
  },
  steps: [],
  outerBlocks: [],
  summary: { thinkingMs: 0, toolCounts: {}, toolTotal: 0, metrics: metrics() },
  collapsed: false,
  ...over,
})

const step = (over: Partial<FlowStep> = {}): FlowStep => ({
  index: 1,
  summary: '',
  status: 'done',
  collapsed: false,
  durationMs: 0,
  blocks: [],
  ...over,
})

/* ---------- 九种块 ---------- */

const bUser = (over: Partial<UserBlock> = {}): UserBlock => ({
  kind: 'user',
  id: 'b-user',
  turn: 1,
  step: 0,
  text: '请分析这个项目',
  ts: T0,
  tsLabel: CLOCK,
  ...over,
})

const bSay = (over: Partial<SayBlock> = {}): SayBlock => ({
  kind: 'say',
  id: 'b-say',
  turn: 1,
  step: 1,
  text: '先看目录结构，再定位入口。',
  status: 'settled',
  isSummarySource: true,
  ts: T0,
  ...over,
})

const bReasoning = (over: Partial<ReasoningBlock> = {}): ReasoningBlock => ({
  kind: 'reasoning',
  id: 'b-reasoning',
  turn: 1,
  step: 1,
  seq: 1,
  source: 'native',
  text: '用户要的是项目分析，先摸清构建配置。',
  summary: '',
  startedAt: T0,
  durationMs: 2000,
  status: 'settled',
  ...over,
})

const bTool = (over: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool',
  id: 'b-tool',
  turn: 1,
  step: 1,
  call: { card: 'generic', title: 'file-reader', kind: 'read', rawInput: { path: 'package.json' } },
  result: { card: 'generic', summary: '读取 42 行', content: '{"name":"arkwork"}' },
  status: 'success',
  startedAt: T0,
  durationMs: 130,
  ...over,
})

const bPlan = (over: Partial<PlanBlock> = {}): PlanBlock => ({
  kind: 'plan',
  id: 'b-plan',
  turn: 1,
  step: 1,
  goal: '分析工作区结构',
  items: ['读取清单', '扫描源码', '汇总报告'],
  states: ['done', 'running', 'pending'] as PlanItemStatus[],
  aggregate: 'running',
  collapsed: false,
  ts: T0,
  ...over,
})

const bApproval = (over: Partial<ApprovalBlock> = {}): ApprovalBlock => ({
  kind: 'approval',
  id: 'b-approval',
  turn: 1,
  step: 0,
  cardKind: 'needs-human',
  refId: 'node-abc',
  ts: T0,
  ...over,
})

const bNotice = (over: Partial<NoticeBlock> = {}): NoticeBlock => ({
  kind: 'notice',
  id: 'b-notice',
  turn: 1,
  step: 1,
  noticeKind: 'compaction',
  text: '上下文压缩完成',
  detail: '47 条 → 12 条',
  level: 'info',
  ts: T0,
  ...over,
})

const bAnswer = (over: Partial<AnswerBlock> = {}): AnswerBlock => ({
  kind: 'answer',
  id: 'b-answer',
  turn: 1,
  step: 0,
  text: '这是个 Electron + React 的桌面 Agent 工作台。',
  origin: 'task-complete',
  streaming: false,
  ts: T0,
  tsLabel: CLOCK,
  ...over,
})

const bNote = (over: Partial<NoteBlock> = {}): NoteBlock => ({
  kind: 'note',
  id: 'b-note',
  turn: 1,
  step: 1,
  text: '阶段结论：配置已定位，开始改代码。',
  via: 'model',
  ts: T0,
  ...over,
})

const bError = (over: Partial<ErrorBlock> = {}): ErrorBlock => ({
  kind: 'error',
  id: 'b-error',
  turn: 1,
  step: 0,
  text: '模型请求超时',
  detail: '120s 无响应',
  actions: ['retry', 'rerun'],
  ts: T0,
  ...over,
})

/** v0.36.0（F4.1）：并行子 agent 组卡（第十种块） */
const bSubagentGroup = (over: Partial<SubagentGroupBlock> = {}): SubagentGroupBlock => ({
  kind: 'subagent-group',
  id: 'b-subagent',
  turn: 1,
  step: 0,
  parentTaskId: 'task-parent',
  children: [
    {
      childTaskId: 'child-1',
      agentId: '@researcher',
      agentName: '研究员',
      objective: '对比三个状态库',
      modelId: 'claude-sonnet-4.5',
      status: 'done',
      stepSummary: '生成对比矩阵',
      durationMs: 42000,
    },
    {
      childTaskId: 'child-2',
      agentId: '@coder',
      agentName: '代码专家',
      objective: '补齐单元用例',
      status: 'failed',
      stepSummary: '用例编译失败',
      durationMs: 18000,
    },
  ],
  settled: true,
  ts: T0,
  ...over,
})

/** 一个「满轮」：十种块各一（user/answer/approval/error/subagent-group 走 outer，其余走 step） */
const fullTurn = (): FlowTurn =>
  turn({
    header: {
      index: 1,
      trigger: 'user',
      agentId: 'default',
      agentName: 'Ark',
      agentAvatarColor: '#7c6cff',
      startedAt: T0,
      durationMs: 8300,
      status: 'failed',
      metrics: metrics({ tokensIn: 1234, tokensOut: 567 }),
      errorMessage: '轮级：迭代次数超限',
    },
    outerBlocks: [
      bUser(),
      bApproval(),
      bError(),
      bAnswer(),
      bSubagentGroup(),
    ],
    steps: [
      step({
        summary: '读取配置',
        durationMs: 130,
        blocks: [bPlan(), bReasoning(), bTool(), bNote(), bNotice(), bSay()],
      }),
    ],
    summary: { thinkingMs: 2000, toolCounts: { read: 1 }, toolTotal: 1, metrics: metrics() },
  })

const render = (turns: FlowTurn[], title = '未命名任务 4', agentId = 'default'): string =>
  renderTurnsMarkdown(title, agentId, turns)

/* ============================================================
 * ① 块覆盖真值表 —— 9 种 FlowBlock 每种至少一条断言
 * ============================================================ */

test('TC-CMD-001 user 块：轮内用户消息带时刻与正文', () => {
  const md = render([turn({ outerBlocks: [bUser()] })])
  assert.match(md, /### 你 · 14:05/, 'user 块应输出三级标题（你 · 时刻）')
  assert.ok(md.includes('请分析这个项目'), 'user 块正文必须出现')
})

test('TC-CMD-002 say 块：模型显式结论原样进入正文（不带标题级）', () => {
  const md = render([turn({ steps: [step({ blocks: [bSay()] })] })])
  assert.ok(md.includes('先看目录结构，再定位入口。'), 'say 块正文必须出现（这是模型显式产出，导出不得吞掉）')
  assert.doesNotMatch(md, /#### 你/, 'say 不是用户块，不应被误标为「你」')
})

test('TC-CMD-003 reasoning 块：来源 + 耗时 + 正文 + 错误', () => {
  const md = render([turn({ steps: [step({ blocks: [bReasoning()] })] })])
  assert.match(md, /#### 思考过程 · 原生思考 · 耗时 2\.0s/, 'reasoning 块头应含来源与耗时')
  assert.ok(md.includes('用户要的是项目分析，先摸清构建配置。'), 'reasoning 正文必须出现（思考通道不得丢）')

  // 空正文时回落 summary（04 §5.3 取值链在导出侧同样成立）
  const only = render([turn({ steps: [step({ blocks: [bReasoning({ text: '', summary: '无正文，仅有摘要' })] })] })])
  assert.ok(only.includes('无正文，仅有摘要'), 'reasoning 无正文时应回落 summary（不许导出成空块）')

  const failed = render([
    turn({ steps: [step({ blocks: [bReasoning({ status: 'failed', errorMessage: '思考中断' })] })] }),
  ])
  assert.ok(failed.includes('思考中断'), 'reasoning 的 errorMessage 必须导出（否则用户看不到中断原因）')

  // content 源与 none 源可区分（导出与屏幕同口径）
  const content = render([turn({ steps: [step({ blocks: [bReasoning({ source: 'content' })] })] })])
  assert.match(content, /正文通道/, 'content 源标签应可辨（不得与原生思考混淆）')
})

test('TC-CMD-004 tool 块：工具名 + 类型 + 参数 + 状态/耗时/意图 + 结果 + L2 入口 + 子调用', () => {
  const md = render([
    turn({
      steps: [
        step({
          blocks: [
            bTool({
              durationMs: 1300,
              intent: '读取依赖清单以判断技术栈',
              rawL2Path: 't1/.arkwork/memory/T-X/steps.jsonl#12',
              children: [bTool({ id: 'child-1' })],
            }),
          ],
        }),
      ],
    }),
  ])
  assert.match(md, /#### 工具 · file-reader/, 'tool 块头应含工具名')
  assert.match(md, /类型 `read`/, 'tool 块应标注 ToolCallKind')
  assert.match(md, /参数：/, 'tool 块应输出参数段')
  assert.ok(md.includes('"path": "package.json"'), 'rawInput 应以 JSON 落进参数段（同参重复是本次空转的现场）')
  assert.match(md, /\*\*状态\*\*：成功 ｜ 耗时 1\.3s/, 'tool 块应含状态与耗时')
  assert.ok(md.includes('读取依赖清单以判断技术栈'), 'intent 必须导出')
  assert.match(md, /结果：读取 42 行/, '结果摘要必须导出')
  assert.ok(md.includes('{"name":"arkwork"}'), 'generic 结果内容必须导出')
  assert.ok(
    md.includes('t1/.arkwork/memory/T-X/steps.jsonl#12'),
    'rawL2Path 必须导出（大结果入口是「内容和屏幕不一致」的高发区）',
  )
  assert.match(md, /_子调用 1 个_/, '子调用数量必须导出')
})

test('TC-CMD-005 plan 块：目标 + 清单 + 六态标记逐项对位', () => {
  const states: PlanItemStatus[] = ['done', 'running', 'failed', 'skipped', 'cancelled', 'pending']
  const md = render([
    turn({
      steps: [
        step({
          blocks: [
            bPlan({
              items: ['一', '二', '三', '四', '五', '六'],
              states,
              goal: '分析工作区结构',
            }),
          ],
        }),
      ],
    }),
  ])
  assert.match(md, /#### 计划清单 · 分析工作区结构/, 'plan 块头应含目标')
  assert.match(md, /\[x\] 1\. 一/, 'done → [x]')
  assert.match(md, /\[~\] 2\. 二/, 'running → [~]')
  assert.match(md, /\[!\] 3\. 三/, 'failed → [!]')
  assert.match(md, /\[-\] 4\. 四/, 'skipped → [-]')
  assert.match(md, /\[·\] 5\. 五/, 'cancelled → [·]')
  assert.match(md, /\[ \] 6\. 六/, 'pending → [ ]')

  // 清单项数 > 状态数（迁移期旧数据）时不得崩、不得错位
  const ragged = render([turn({ steps: [step({ blocks: [bPlan({ items: ['a', 'b'], states: ['done'] })] })] })])
  assert.match(ragged, /\[x\] 1\. a/, '前项仍按状态渲染')
  assert.match(ragged, /\[ \] 2\. b/, '缺状态按 pending 兜底（不许出现 undefined）')
  assert.doesNotMatch(ragged, /undefined/, '不得把内部占位符泄进导出正文')
})

test('TC-CMD-006 approval 块：卡片类型与关联 id', () => {
  const md = render([turn({ outerBlocks: [bApproval({ cardKind: 'replan', refId: 'patch-7' })] })])
  assert.match(md, /#### 待确认 · replan/, 'approval 块应含 cardKind')
  assert.ok(md.includes('ref: patch-7'), 'refId 必须导出（否则用户不知道在确认哪张卡）')
})

test('TC-CMD-007 notice 块：通告类型 + 一行文案 + 详情', () => {
  const md = render([turn({ steps: [step({ blocks: [bNotice({ noticeKind: 'gate-blocked' })] })] })])
  assert.match(md, /#### 通知 · gate-blocked/, 'notice 块应含 noticeKind')
  assert.ok(md.includes('上下文压缩完成'), 'notice 一行文案必须导出')
  assert.ok(md.includes('47 条 → 12 条'), 'notice 详情必须导出（压缩是「内容对不上」的常见嫌疑）')
})

test('TC-CMD-008 answer 块：来源 + 时刻 + 正文', () => {
  const md = render([turn({ outerBlocks: [bAnswer({ origin: 'ask-user' })] })])
  assert.match(md, /### 答复 · ask-user · 14:05/, 'answer 块应含 origin 与时刻')
  assert.ok(md.includes('这是个 Electron + React 的桌面 Agent 工作台。'), '最终答复必须导出（导出漏终答是本缺陷最恶劣的表现）')
})

test('TC-CMD-009 error 块：错误标题 + 正文 + 详情', () => {
  const md = render([turn({ outerBlocks: [bError()] })])
  assert.match(md, /#### 错误/, 'error 块应有错误头')
  assert.ok(md.includes('模型请求超时'), '错误正文必须导出')
  assert.ok(md.includes('120s 无响应'), '错误详情必须导出（诊断空转全靠它）')
})

test('TC-CMD-030 子 agent 组卡：数量 + 逐行 agent/状态/耗时/摘要（v0.36.0 F4.1）', () => {
  const md = render([turn({ outerBlocks: [bSubagentGroup()] })])
  assert.match(md, /#### 并行子 agent · 2 个/, '组卡标题应含子 agent 数量')
  assert.ok(md.includes('@研究员'), '每个子 agent 必须逐行导出（不能只给一个"N 个"就完了）')
  assert.ok(md.includes('@代码专家'), '失败的那个子 agent 同样要导出')
  assert.ok(md.includes('done'), '状态必须导出（否则看不出哪个失败了）')
  assert.ok(md.includes('failed'), '失败状态必须导出')
  assert.ok(md.includes('42.0s'), '耗时必须导出')
  assert.ok(md.includes('生成对比矩阵'), '单步/终态摘要必须导出')
  // 未终结时标题标注「进行中」—— 导出件是静态快照，读者必须能分辨它是中途态
  const running = render([
    turn({ outerBlocks: [bSubagentGroup({ settled: false })] }),
  ])
  assert.match(running, /#### 并行子 agent · 2 个（进行中）/, '未终结组卡应标注「进行中」')
})

test('TC-CMD-010 ★ 结构对等：渲染器的 case 集合 ≡ FlowBlock 判别联合的 kind 集合', () => {
  // 这条用例是纪律⑪的机器化：**屏幕加一种块，导出不加渲染 → 立即报红**。
  // 断言的是「判别取值域」（解析 `kind: '...'` 字面量），不是「源码里出现过某词」，
  // 因此不可能被注释 / 无关字符串蒙过（v0.32.2 审计：TC-PUI-009 曾因只 grep 文本而把错误钉成正确）。
  const flowSrc = readFileSync(new URL('../../../shared/types/flow.ts', import.meta.url), 'utf-8')
  const rendererSrc = readFileSync(new URL('../conversation-markdown.ts', import.meta.url), 'utf-8')

  const unionKinds = new Set(
    [...flowSrc.matchAll(/\bkind:\s*'([a-z-]+)'/g)].map((m) => m[1]),
  )
  const renderedKinds = new Set(
    [...rendererSrc.matchAll(/\bcase\s*'([a-z-]+)'\s*:/g)].map((m) => m[1]),
  )

  // 先自证：判别联合确实有 11 种（若 flow.ts 改了形态本用例要显式失败而非静默空集）
  assert.equal(unionKinds.size, 11, `FlowBlock 判别联合应有 11 种 kind，实得 ${unionKinds.size}：${[...unionKinds].join(',')}`)

  const missing = [...unionKinds].filter((k) => !renderedKinds.has(k)).sort()
  assert.deepEqual(
    missing,
    [],
    `★ 导出渲染器缺少这些块（屏幕看得到、导出看不到）：${missing.join(', ')}`,
  )

  const extra = [...renderedKinds].filter((k) => !unionKinds.has(k)).sort()
  assert.deepEqual(
    extra,
    [],
    `渲染器有 stray case（判别联合里不存在，多半是改名后的残骸）：${extra.join(', ')}`,
  )
})

test('TC-CMD-010b 满轮导出：十一种块同时在场且彼此不串味', () => {
  const md = render([fullTurn()])
  for (const frag of [
    '### 你 · 14:05',
    '#### 待确认 · needs-human',
    '#### 错误',
    '### 答复 · task-complete · 14:05',
    '#### 计划清单 · 分析工作区结构',
    '#### 思考过程 · 原生思考',
    '#### 工具 · file-reader',
    '#### 阶段结论 · model',
    '#### 通知 · compaction',
    '#### 并行子 agent · 2 个',
    '先看目录结构，再定位入口。',
  ]) {
    assert.ok(md.includes(frag), `满轮导出应含：${frag}`)
  }
})

/* ============================================================
 * ② 轮头 / 步头 / 页眉 / 轮级错误
 * ============================================================ */

test('TC-CMD-011 轮头：轮号 · 时刻 · 状态 · 耗时 · tokens 五元齐备', () => {
  const md = render([
    turn({
      header: {
        index: 3,
        trigger: 'steering',
        agentId: 'coder',
        agentName: 'Coder',
        agentAvatarColor: '#f80',
        startedAt: T0,
        durationMs: 8300,
        status: 'paused',
        metrics: metrics({ tokensIn: 1234, tokensOut: 567 }),
      },
    }),
  ])
  assert.match(md, /## 轮 #3 · 14:05 · 已暂停 · 耗时 8\.3s · ↑1234 ↓567 tokens/, '轮头五元应齐备且顺序稳定')
})

test('TC-CMD-012 轮头：无耗时 / 零 tokens 时不留空壳分隔符', () => {
  const md = render([turn({ header: { ...turn().header, durationMs: 0, metrics: metrics() } })])
  assert.match(md, /^## 轮 #1 · 14:05 · 已完成$/m, '零值项应被过滤（不得出现「· ·」或「↑0 ↓0」）')
  assert.doesNotMatch(md, /↑0 ↓0/, '零 tokens 不应输出（噪音）')
})

test('TC-CMD-013 步头：步号 · 摘要 · 状态 · 耗时', () => {
  const md = render([turn({ steps: [step({ index: 2, summary: '扫描源码', status: 'guarded', durationMs: 1500 })] })])
  assert.match(md, /### 步骤 2 · 扫描源码 · 被守卫拦截 · 耗时 1\.5s/, '步头应含步号/摘要/状态/耗时')
})

test('TC-CMD-014 页眉：标题 + Agent 署名 + 轮数', () => {
  const md = render([turn(), turn({ id: 'turn-2', header: { ...turn().header, index: 2 } })], '未命名任务 4', 'default')
  assert.match(md, /^# 未命名任务 4$/m, '一级标题应为任务标题')
  assert.match(md, /> Agent: @default ｜ 2 轮/, '页眉应含 Agent 署名与轮数')
})

test('TC-CMD-015 轮级错误：从 header.errorMessage 落到导出（不依赖 ErrorBlock 存在）', () => {
  const md = render([turn({ header: { ...turn().header, status: 'failed', errorMessage: '迭代 51 次仍未产出' } })])
  assert.match(md, /> \*\*错误\*\*：迭代 51 次仍未产出/, '轮级错误应作为引用块导出')
})

/* ============================================================
 * ③ 工具卡全形态（调用三种卡 × 结果七种卡）
 * ============================================================ */

test('TC-CMD-016 terminal 调用卡：描述与 cwd 落进参数段', () => {
  const call: ToolCallView = {
    card: 'terminal',
    title: 'shell-run',
    kind: 'execute',
    description: '统计源码行数',
    cwd: '/tmp/ws',
  }
  const md = render([turn({ steps: [step({ blocks: [bTool({ call, result: undefined })] })] })])
  assert.ok(md.includes('统计源码行数'), 'terminal 卡的 description 应导出')
  assert.ok(md.includes('cwd: /tmp/ws'), 'terminal 卡的 cwd 应导出（命令跑在哪是诊断关键）')
})

test('TC-CMD-017 terminal 结果卡：exitCode 与输出', () => {
  const r: ToolResultView = {
    card: 'terminal',
    summary: '命令失败',
    exitCode: 1,
    output: 'Error: ENOENT',
  }
  const md = render([turn({ steps: [step({ blocks: [bTool({ result: r, status: 'failed', errorMessage: '退出码 1' })] })] })])
  assert.match(md, /exitCode: 1/, 'terminal 结果应带 exitCode')
  assert.ok(md.includes('Error: ENOENT'), 'terminal 输出应导出')
  assert.ok(md.includes('退出码 1'), '失败时的 errorMessage 应导出')
})

test('TC-CMD-018 write 调用卡与结果卡：逐文件增删计数 + 定位', () => {
  const call: ToolCallView = {
    card: 'write',
    title: 'file-writer',
    kind: 'edit',
    changes: [{ path: 'src/a.ts', added: 3, removed: 1, oldText: null, newText: 'x' }],
    locations: [{ path: 'src/a.ts', line: 12 }],
  }
  const r: ToolResultView = {
    card: 'write',
    summary: '已写入 1 个文件',
    changes: [{ path: 'src/a.ts', added: 3, removed: 1, oldText: null, newText: 'x' }],
  }
  const md = render([turn({ steps: [step({ blocks: [bTool({ call, result: r })] })] })])
  assert.match(md, /`src\/a\.ts` \+3 −1/, 'write 卡应输出逐文件增删计数')
  assert.ok(md.includes('`src/a.ts:12`'), 'write 卡的 locations 应导出（点不到行号就看不出改了哪）')
  assert.ok(md.includes('已写入 1 个文件'), 'write 结果摘要应导出')
})

test('TC-CMD-019 read 结果卡：带行号逐行导出', () => {
  const r: ToolResultView = {
    card: 'read',
    summary: '读取 2 行',
    path: 'src/index.ts',
    offset: 1,
    lines: [
      { number: 1, text: 'export const a = 1' },
      { number: 2, text: 'export const b = 2' },
    ],
    totalLines: 2,
  }
  const md = render([turn({ steps: [step({ blocks: [bTool({ result: r })] })] })])
  assert.ok(md.includes('1\texport const a = 1'), 'read 卡应带行号逐行导出')
  assert.ok(md.includes('2\texport const b = 2'), 'read 卡第二行同样导出')
})

test('TC-CMD-020 search 结果卡两形态：paths 清单 / matches 分组', () => {
  const paths: ToolResultView = {
    card: 'search',
    shape: 'paths',
    summary: '命中 2 个文件',
    paths: ['src/a.ts', 'src/b.ts'],
    truncated: false,
    total: 2,
  }
  const md1 = render([turn({ steps: [step({ blocks: [bTool({ result: paths })] })] })])
  assert.ok(md1.includes('- `src/a.ts`') && md1.includes('- `src/b.ts`'), 'paths 形态应逐条导出')

  const matches: ToolResultView = {
    card: 'search',
    shape: 'matches',
    summary: '命中 1 文件 2 处',
    files: [{ path: 'src/a.ts', matches: [{ lineNumber: 7, line: 'foo()' }, { lineNumber: 9, line: 'bar()' }] }],
    truncated: false,
    total: 2,
  }
  const md2 = render([turn({ steps: [step({ blocks: [bTool({ result: matches })] })] })])
  assert.ok(md2.includes('- `src/a.ts`'), 'matches 形态应输出文件分组')
  assert.ok(md2.includes('L7: foo()') && md2.includes('L9: bar()'), 'matches 形态应输出行号 + 行内容')
})

test('TC-CMD-021 web 结果卡两形态：检索来源清单 / 抓取状态码', () => {
  const search: ToolResultView = {
    card: 'web',
    kind: 'search',
    summary: '找到 2 条',
    sources: [{ url: 'https://a.example/1', title: '资料一' }, { url: 'https://b.example/2' }],
    answer: '综述结论',
    truncated: false,
  }
  const md1 = render([turn({ steps: [step({ blocks: [bTool({ result: search })] })] })])
  assert.ok(md1.includes('1. [资料一](https://a.example/1)'), 'web 检索应输出带序号的来源链接')
  assert.ok(md1.includes('2. [https://b.example/2](https://b.example/2)'), '无标题来源回落 URL 作为标题')
  assert.ok(md1.includes('综述结论'), 'web 检索的 answer 应导出')

  const fetchView: ToolResultView = {
    card: 'web',
    kind: 'fetch',
    summary: '抓取完成',
    url: 'https://c.example/doc',
    statusCode: 200,
  }
  const md2 = render([turn({ steps: [step({ blocks: [bTool({ result: fetchView })] })] })])
  assert.ok(md2.includes('`https://c.example/doc` → HTTP 200'), 'web 抓取应输出 url → HTTP 状态码')
})

test('TC-CMD-022 ★ 被守卫拦截的调用必须出现在导出里（空转现场的第一手证据）', () => {
  const md = render([
    turn({
      steps: [
        step({
          status: 'guarded',
          blocks: [
            bTool({
              id: 'g1',
              status: 'guarded',
              errorMessage: '同一签名连续 5 次，已拦截',
              result: undefined,
            }),
          ],
        }),
      ],
    }),
  ])
  assert.match(md, /\*\*状态\*\*：被守卫拦截/, 'guarded 状态应导出（否则用户以为模型什么都没做）')
  assert.ok(md.includes('同一签名连续 5 次，已拦截'), '拦截原因必须导出（这是空转诊断的落点）')
  assert.ok(md.includes('被守卫拦截'), '步头也应体现被拦截')
})

/* ============================================================
 * ④ 边界与性质
 * ============================================================ */

test('TC-CMD-023 空输入：返回空串（调用方据此提示「没有可导出内容」）', () => {
  assert.equal(renderTurnsMarkdown('t', 'default', []), '', '无轮次 → 空串')
  assert.equal(renderTurnsMarkdown('t', 'default', undefined as unknown as FlowTurn[]), '', '脏输入 → 空串（不得抛错）')
})

test('TC-CMD-024 hasRenderableTurns 与渲染同源判定', () => {
  assert.equal(hasRenderableTurns([]), false, '无轮次 → false')
  assert.equal(hasRenderableTurns([turn()]), false, '有轮但全空 → false（否则会复制出一份只有标题的文档）')
  assert.equal(hasRenderableTurns([turn({ outerBlocks: [bUser()] })]), true, '有 outerBlocks → true')
  assert.equal(hasRenderableTurns([turn({ steps: [step({ blocks: [bSay()] })] })]), true, '有步骤块 → true')
  assert.equal(
    hasRenderableTurns([turn({ summary: { thinkingMs: 0, toolCounts: {}, toolTotal: 2, metrics: metrics() } })]),
    true,
    '摘要里有工具调用 → true（摘要是屏幕可见内容之一）',
  )
})

test('TC-CMD-025 确定性：同输入两次渲染逐字符相同，且不改动入参', () => {
  const t = fullTurn()
  const snapshot = JSON.stringify(t)
  const a = render([t])
  const b = render([t])
  assert.equal(a, b, '同一输入必须产出逐字符相同的 Markdown（导出可复现）')
  assert.equal(JSON.stringify(t), snapshot, '渲染是纯函数，不得改动入参')
})

test('TC-CMD-026 ★ 纯模块：无 react / i18n / store 依赖（node:test 可直连）', () => {
  const src = readFileSync(new URL('../conversation-markdown.ts', import.meta.url), 'utf-8')
  // 用 `from '...'` 全量扫描而非逐行匹配：多行 import 语句不会被漏掉
  const imports = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1])
  assert.ok(imports.length >= 1, '应能解析出至少一个 import 说明符（否则本用例在测空气）')
  const forbidden = imports.filter(
    (p) => /react|i18n|zustand|\/store\/index|slices\//.test(p),
  )
  assert.deepEqual(
    forbidden,
    [],
    `conversation-markdown 必须是纯模块，出现了禁用依赖：${forbidden.join(', ')}`,
  )
})

test('TC-CMD-027 labels 可覆盖：默认中文之外的语言由调用方注入', () => {
  const md = renderTurnsMarkdown('T', 'default', [turn({ outerBlocks: [bAnswer()] })], {
    ...DEFAULT_LABELS,
    you: 'You',
    answer: 'Answer',
    turn: 'turn',
  })
  assert.match(md, /### Answer · task-complete/, 'answer 标签应被覆盖')
  assert.match(md, /## turn #1/, '轮标签应被覆盖')
})

test('TC-CMD-028 压行：连续空行压成一段，末尾不留空行', () => {
  const md = render([turn({ outerBlocks: [bUser()], steps: [step({ blocks: [bSay()] })] })])
  assert.doesNotMatch(md, /\n{3,}/, '不得出现三重以上换行（Markdown 渲染会出现意外空段）')
  assert.equal(md, md.trimEnd(), '末尾不得残留空行')
})

test('TC-CMD-029 空文本块不产出空壳标题（脏数据不得变成噪音）', () => {
  const md = render([turn({ outerBlocks: [bUser({ text: '   ' })], steps: [step({ blocks: [bSay({ text: '' })] })] })])
  assert.doesNotMatch(md, /\n\n\n/, '空正文不应留下多余空行')
  assert.ok(!md.includes('   '), '空白正文不应被原样写入')
})
