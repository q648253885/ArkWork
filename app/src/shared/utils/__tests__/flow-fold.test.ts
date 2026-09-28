/* ============================================================
 * ArkWork — v0.32.0 交互区进程折叠纯函数单测
 * 规格来源：docs/versions/v0.32.0/04-system-design.md §1.3–1.5
 *           docs/versions/v0.32.0/03-interaction.md §一 / 二 / 三
 *
 * 手法：密闭纯函数断言（零 React / 零 store / 零 DOM），
 *       沿用 `shared/utils/__tests__/ime.test.ts` 的写法。
 * 运行（cwd=app）：node scripts/run-tests.mjs flow-fold
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowBlock, FlowFoldRun, FlowViewMode } from '@shared/types/flow'
import type { ToolCallKind } from '@shared/types/tool-present'
import type { FoldUiState } from '../flow-fold.js'
import {
  TOOL_COUNT_ORDER,
  TOOL_FOLD_I18N_KEY,
  buildFoldRun,
  countToolRun,
  isProcessBlock,
  resolveFoldDefault,
  applyUserFoldToggle,
  resolveFoldOpen,
  runHasFailure,
  runHasRunning,
  segmentFlow,
  thinkingCountOf,
  toolCountTotal,
  toolKindOf,
  toolRunParts,
} from '../flow-fold.js'

/* ---------- 工厂 ---------- */

let seq = 0
const nextId = (k: string) => `t1:t1:s1:${k}:${seq++}`

function reasoning(over: Partial<Extract<FlowBlock, { kind: 'reasoning' }>> = {}): FlowBlock {
  return {
    kind: 'reasoning',
    id: nextId('reason'),
    turn: 1,
    step: 1,
    seq: 0,
    source: 'native',
    text: '先确认脚本类型',
    summary: '先确认脚本类型',
    startedAt: 1000,
    durationMs: 2400,
    status: 'settled',
    ...over,
  }
}

function tool(
  over: Partial<Extract<FlowBlock, { kind: 'tool' }>> = {},
  kind: ToolCallKind | undefined = 'read',
): FlowBlock {
  return {
    kind: 'tool',
    id: nextId('tool'),
    turn: 1,
    step: 1,
    call: { card: 'generic', title: '读取文件', kind },
    status: 'success',
    startedAt: 2000,
    durationMs: 300,
    intent: '读取文件',
    ...over,
  }
}

function say(): FlowBlock {
  return {
    kind: 'say',
    id: nextId('say'),
    turn: 1,
    step: 1,
    text: '先跑一次类型检查。',
    status: 'settled',
    isSummarySource: true,
    ts: 1500,
  }
}

function notice(): FlowBlock {
  return {
    kind: 'notice',
    id: nextId('notice'),
    turn: 1,
    step: 1,
    noticeKind: 'gate-blocked',
    text: '门控拦截',
    level: 'warning',
    ts: 2100,
  }
}

function plan(): FlowBlock {
  return {
    kind: 'plan',
    id: nextId('plan'),
    turn: 1,
    step: 0,
    goal: '修复缺陷',
    items: ['定位', '修复'],
    states: ['done', 'running'],
    aggregate: 'running',
    collapsed: false,
    ts: 900,
  }
}

function answer(): FlowBlock {
  return {
    kind: 'answer',
    id: nextId('answer'),
    turn: 1,
    step: 0,
    text: '完成',
    origin: 'task-complete',
    streaming: false,
    ts: 4000,
    tsLabel: '10:00',
  }
}

function errorBlock(): FlowBlock {
  return {
    kind: 'error',
    id: nextId('error'),
    turn: 1,
    step: 0,
    text: '模型调用失败',
    actions: ['retry'],
    ts: 3000,
  }
}

const segTypes = (segs: ReturnType<typeof segmentFlow>) => segs.map((s) => s.type)
const foldScopes = (segs: ReturnType<typeof segmentFlow>) =>
  segs.filter((s) => s.type === 'fold').map((s) => (s as { run: FlowFoldRun }).run.scope)

/* ============================================================
 * TC-FOLD-001 进程块分类（只有 reasoning / tool 属进程）
 * ============================================================ */

test('TC-FOLD-001 isProcessBlock：思考与工具为进程块，其余七类为主展示块', () => {
  assert.equal(isProcessBlock(reasoning()), true)
  assert.equal(isProcessBlock(tool()), true)
  for (const b of [say(), notice(), plan(), errorBlock()]) {
    assert.equal(isProcessBlock(b), false, `${b.kind} 不应被判为进程块`)
  }
})

/* ============================================================
 * TC-FOLD-002 保序切分：过程收条，主块原样，顺序不变
 * ============================================================ */

test('TC-FOLD-002 segmentFlow 保序：思考 → 叙述 → 工具 得到「折叠/主块/折叠」', () => {
  const blocks = [reasoning(), say(), tool(), tool()]
  const segs = segmentFlow(blocks)
  assert.deepEqual(segTypes(segs), ['fold', 'block', 'fold'])
  assert.deepEqual(foldScopes(segs), ['reasoning', 'tool'])
  // 主块就是那条 say（时间位置未被挪动）
  const mid = segs[1]
  assert.equal(mid.type === 'block' && mid.block.kind, 'say')
})

/* ============================================================
 * TC-FOLD-003 连续同类合并为一个 run
 * ============================================================ */

test('TC-FOLD-003 连续同类进程块合并为单个 run（不产生 N 条折叠行）', () => {
  const segs = segmentFlow([reasoning(), reasoning(), reasoning()])
  assert.equal(segs.length, 1)
  const run = (segs[0] as { run: FlowFoldRun }).run
  assert.equal(run.blocks.length, 3)
  assert.equal(run.scope, 'reasoning')
})

/* ============================================================
 * TC-FOLD-004 kind 变化不再断组（v0.36.1 过程组）
 * ============================================================ */

test('TC-FOLD-004 思考紧接工具 → 单个混合 process run（v0.36.1：相关过程整体收起）', () => {
  const segs = segmentFlow([reasoning(), tool()])
  assert.equal(segs.length, 1)
  assert.deepEqual(foldScopes(segs), ['process'])
  const run = (segs[0] as { run: FlowFoldRun }).run
  assert.equal(run.blocks.length, 2)
})

/* ============================================================
 * TC-FOLD-005 主展示块永不折叠
 * ============================================================ */

test('TC-FOLD-005 主展示块（say/plan/answer/notice/error）各自独立成段，不被吞进 run', () => {
  const blocks = [say(), plan(), errorBlock()]
  const segs = segmentFlow(blocks)
  assert.equal(segs.length, 3)
  assert.ok(segs.every((s) => s.type === 'block'))
  assert.deepEqual(
    segs.map((s) => (s.type === 'block' ? s.block.kind : 'fold')),
    ['say', 'plan', 'error'],
  )
})

/* ============================================================
 * TC-FOLD-006 notice 切断工具 run（异常必须可见 —— 期望行为）
 * ============================================================ */

test('TC-FOLD-006 notice 夹在两次工具之间 → 两个 run 夹一条提示（异常不可被折叠吞掉）', () => {
  const segs = segmentFlow([tool(), notice(), tool()])
  assert.deepEqual(segTypes(segs), ['fold', 'block', 'fold'])
  const mid = segs[1]
  assert.equal(mid.type === 'block' && mid.block.kind, 'notice')
})

/* ============================================================
 * TC-FOLD-007 run id 稳定性（= 首块 id）
 * ============================================================ */

test('TC-FOLD-007 run id = 该 run 首个块的 id（确定性、可持久化、跨虚拟化稳定）', () => {
  const first = tool()
  const segs = segmentFlow([first, tool(), tool()])
  const run = (segs[0] as { run: FlowFoldRun }).run
  assert.equal(run.id, first.id)
  assert.equal(segs[0].type === 'fold' && segs[0].key, `fold:${first.id}`)
})

/* ============================================================
 * TC-FOLD-008 分类计数 + 固定拼接顺序
 * ============================================================ */

test('TC-FOLD-008 countToolRun / toolRunParts：按八分类计数且顺序固定', () => {
  const blocks = [
    tool({}, 'read'),
    tool({}, 'read'),
    tool({}, 'search'),
    tool({}, 'execute'),
    tool({}, 'fetch'),
  ]
  const counts = countToolRun(blocks)
  assert.deepEqual(counts, { read: 2, search: 1, execute: 1, fetch: 1 })
  assert.equal(toolCountTotal(counts), 5)

  const parts = toolRunParts(counts)
  assert.deepEqual(
    parts.map((p) => p.kind),
    ['read', 'search', 'execute', 'fetch'],
    '拼接顺序必须遵循 TOOL_COUNT_ORDER（确定性 + 扫读习惯）',
  )
  assert.deepEqual(parts[0], { kind: 'read', count: 2 })
  // 全零项不得出现（禁止空壳条目）
  assert.equal(toolRunParts({}).length, 0)
})

test('TC-FOLD-008b TOOL_COUNT_ORDER 与 i18n key 映射覆盖全部八分类', () => {
  assert.equal(TOOL_COUNT_ORDER.length, 8)
  for (const k of TOOL_COUNT_ORDER) {
    assert.ok(TOOL_FOLD_I18N_KEY[k], `${k} 缺少 i18n key 映射`)
    assert.match(TOOL_FOLD_I18N_KEY[k], /^flow\.fold\./)
  }
})

/* ============================================================
 * TC-FOLD-009 toolKindOf 退化链
 * ============================================================ */

test('TC-FOLD-009 toolKindOf：call.kind 优先，缺省按卡片形态退化', () => {
  assert.equal(toolKindOf(tool({}, 'search') as never), 'search')
  const noKind = (card: 'generic' | 'terminal' | 'write') =>
    toolKindOf({ kind: 'tool', call: { card, title: 'x' } } as never)
  assert.equal(noKind('terminal'), 'execute')
  assert.equal(noKind('write'), 'edit')
  assert.equal(noKind('generic'), 'other')
})

/* ============================================================
 * TC-FOLD-010 三档视图模式默认态（v0.31.0 viewMode 空壳 → 本版接线）
 * ============================================================ */

test('TC-FOLD-010 resolveFoldDefault：紧凑全折叠 / 标准异常展开 / 详尽全展开', () => {
  const ok = { hasFailure: false }
  const bad = { hasFailure: true }
  const table: Array<[FlowViewMode, boolean, boolean]> = [
    ['compact', false, false],
    ['standard', false, true],
    ['verbose', true, true],
  ]
  for (const [mode, normal, failure] of table) {
    assert.equal(resolveFoldDefault(mode, ok), normal, `${mode} + 正常 run`)
    assert.equal(resolveFoldDefault(mode, bad), failure, `${mode} + 异常 run`)
  }
})

/* ============================================================
 * TC-FOLD-011 用户意志最高（模式切换不重置手动展开态）
 * ============================================================ */

test('TC-FOLD-011 resolveFoldOpen：用户干预过则以应用态为准，未干预回落模式策略', () => {
  // 用户碰过 → 无视 viewMode 与异常，一律以 store 的应用态 open 为准
  assert.equal(
    resolveFoldOpen({ open: true, userOpen: true, viewMode: 'compact', hasFailure: false }),
    true,
  )
  assert.equal(
    resolveFoldOpen({ open: false, userOpen: false, viewMode: 'verbose', hasFailure: false }),
    false,
  )
  assert.equal(
    resolveFoldOpen({ open: false, userOpen: false, viewMode: 'standard', hasFailure: true }),
    false,
    '用户手动收起失败段后，不得被「异常自动展开」再次顶开',
  )
  // 未干预时回落模式策略
  assert.equal(
    resolveFoldOpen({ open: false, userOpen: null, viewMode: 'standard', hasFailure: true }),
    true,
  )
  assert.equal(
    resolveFoldOpen({ open: false, userOpen: null, viewMode: 'standard', hasFailure: false }),
    false,
  )
  assert.equal(
    resolveFoldOpen({ open: false, userOpen: null, viewMode: 'verbose', hasFailure: false }),
    true,
  )
})

test('TC-FOLD-011b 缺陷 D33 回归：展开之后必须收得回去（开↔关往返可逆）', () => {
  // 这条用例的存在理由：v0.32.0 实测「点开后无法收起」。
  // 病根是 setBlockOpen 恒写 userOpen:true，门闩一旦恒真就再也回不去。
  // 因此这里不断言实现细节，只断言**用户看得见的行为**：往返必须可逆。
  const KEY = 'run-1'
  const store: Record<string, FoldUiState> = {}

  const click = (): boolean => {
    const prev = store[KEY]
    const shown = resolveFoldOpen({
      open: prev?.open ?? false,
      userOpen: prev?.userOpen ?? null,
      viewMode: 'standard',
      hasFailure: false,
    })
    store[KEY] = applyUserFoldToggle(prev, !shown)
    return resolveFoldOpen({
      open: store[KEY].open,
      userOpen: store[KEY].userOpen,
      viewMode: 'standard',
      hasFailure: false,
    })
  }

  assert.equal(click(), true, '第一次点击：展开')
  assert.equal(click(), false, '第二次点击：必须收起（D33 的原始症状）')
  assert.equal(click(), true, '第三次点击：又能展开')
  assert.equal(click(), false, '第四次点击：又能收起 —— 往返任意次都成立')

  // 意图与应用态必须同步落库，否则门闩与显示会分叉
  assert.equal(store[KEY].open, false)
  assert.equal(store[KEY].userOpen, false)

  // 反向自检：把门闩写死成 true（缺陷版实现）会立刻让收起失效
  const buggy = applyUserFoldToggle(store[KEY], false)
  const buggyShown = resolveFoldOpen({
    open: buggy.open,
    // 模拟缺陷版：门闩恒真而应用态恒真
    userOpen: true,
    viewMode: 'standard',
    hasFailure: false,
  })
  assert.equal(buggyShown, false, '应用态为 false 时，读数就是 false（证明病根在门闩写法）')
})

/* ============================================================
 * TC-FOLD-012 异常 / 运行中判定（失败不静默的输入侧）
 * ============================================================ */

test('TC-FOLD-012 runHasFailure / runHasRunning 覆盖工具六态与思考四态', () => {
  assert.equal(runHasFailure([tool({ status: 'failed' })]), true)
  assert.equal(runHasFailure([tool({ status: 'guarded' })]), true, '软失败守卫也算异常（不静默）')
  assert.equal(runHasFailure([reasoning({ status: 'failed' })]), true)
  assert.equal(runHasFailure([tool({ status: 'success' }), reasoning()]), false)

  assert.equal(runHasRunning([tool({ status: 'running' })]), true)
  assert.equal(runHasRunning([tool({ status: 'pending' })]), true)
  assert.equal(runHasRunning([reasoning({ status: 'streaming' })]), true)
  assert.equal(runHasRunning([reasoning({ status: 'pending' })]), true)
  assert.equal(runHasRunning([reasoning({ status: 'settled' })]), false)
  assert.equal(runHasRunning([tool({ status: 'cancelled' })]), false)
})

/* ============================================================
 * TC-FOLD-013 时长与起始时刻
 * ============================================================ */

test('TC-FOLD-013 buildFoldRun：时长取 run 内块之和，起始取首块', () => {
  const a = tool({ durationMs: 300, startedAt: 2000 })
  const b = tool({ durationMs: 700, startedAt: 2400 })
  const run = buildFoldRun('tool', [a, b])
  assert.equal(run.durationMs, 1000)
  assert.equal(run.startedAt, 2000)
})

/* ============================================================
 * TC-FOLD-014 边界：空输入 / 单块
 * ============================================================ */

test('TC-FOLD-014 边界：空输入得空段；单进程块得单 run', () => {
  assert.deepEqual(segmentFlow([]), [])
  const segs = segmentFlow([tool()])
  assert.equal(segs.length, 1)
  assert.equal(segs[0].type, 'fold')
})

/* ============================================================
 * TC-FOLD-015 组合场景（本版验收 C-4 的等价断言）
 * ============================================================ */

test('TC-FOLD-015 组合场景：思考×2 → 叙述 → 工具×3 → 计划 → 工具 → 答复', () => {
  const blocks = [
    reasoning(),
    reasoning(),
    say(),
    tool({}, 'read'),
    tool({}, 'read'),
    tool({}, 'execute'),
    plan(),
    tool({}, 'search'),
    answer(),
  ]
  const segs = segmentFlow(blocks)
  assert.deepEqual(segTypes(segs), ['fold', 'block', 'fold', 'block', 'fold', 'block'])
  assert.deepEqual(foldScopes(segs), ['reasoning', 'tool', 'tool'])

  const first = (segs[0] as { run: FlowFoldRun }).run
  assert.equal(first.blocks.length, 2)
  const second = (segs[2] as { run: FlowFoldRun }).run
  assert.equal(second.blocks.length, 3)
  assert.deepEqual(countToolRun(second.blocks), { read: 2, execute: 1 })
  const third = (segs[4] as { run: FlowFoldRun }).run
  assert.deepEqual(countToolRun(third.blocks), { search: 1 })
})

/* ============================================================
 * v0.36.1 过程组（docs/versions/v0.36.0/13-process-group-design.md §四）
 * ============================================================ */

test('TC-FOLD-020 跨 step 混排整轮序列：思考/工具交替 → 单个 process run，say/answer 断组', () => {
  // 模拟一个 3 迭代回合的整轮渲染序列（迭代边界不再断组）：
  // [思考, 读×2] → [思考, 搜×1] → [思考, 执行×1] 全部连续 → 一个过程组
  const blocks = [
    reasoning(),
    tool({}, 'read'),
    tool({}, 'read'),
    reasoning(),
    tool({}, 'search'),
    reasoning(),
    tool({}, 'execute'),
  ]
  const segs = segmentFlow(blocks)
  assert.equal(segs.length, 1, '混排进程块必须收成单个过程组（旧行为 6 条折叠行）')
  const run = (segs[0] as { run: FlowFoldRun }).run
  assert.equal(run.scope, 'process')
  assert.equal(run.blocks.length, 7)
  assert.deepEqual(countToolRun(run.blocks), { read: 2, search: 1, execute: 1 })
  assert.equal(thinkingCountOf(run.blocks), 3)

  // say / answer 插入即断组 —— 白字正文独立可见，过程分居前后
  const withSay = segmentFlow([
    reasoning(),
    tool({}, 'read'),
    say(),
    reasoning(),
    tool({}, 'execute'),
    answer(),
  ])
  assert.deepEqual(segTypes(withSay), ['fold', 'block', 'fold', 'block'])
  const runA = (withSay[0] as { run: FlowFoldRun }).run
  const runB = (withSay[2] as { run: FlowFoldRun }).run
  assert.deepEqual(foldScopes(withSay), ['process', 'process'])
  assert.equal(runA.blocks.length, 2)
  assert.equal(runB.blocks.length, 2)
})

test('TC-FOLD-021 thinkingCountOf：仅计 reasoning 块，空 run 得 0', () => {
  assert.equal(thinkingCountOf([]), 0)
  assert.equal(thinkingCountOf([tool({}, 'read'), say()]), 0)
  assert.equal(
    thinkingCountOf([reasoning(), reasoning(), tool({}, 'read'), reasoning()]),
    3,
  )
})
