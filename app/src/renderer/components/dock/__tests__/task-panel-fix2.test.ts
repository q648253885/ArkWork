/**
 * v0.30.0 详测 — 任务面板 UI 改版（fix2 契约回归）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P1（元素清单 / 五项状态 / 边界交互）
 *       docs/versions/v0.30.0/prototype/page-01-task-panel.html（冻结的视觉基准）
 *
 * 用户诉求原文：「侧边栏 UI 不美观…title 和列表不要挨太紧密，且不要过于折叠，
 * 字体和排列方式优化，不要遮挡太多内容，尽量一行显示出来。」
 *
 * 本套件为**源码契约**（readFileSync + 正则）：组件依赖 ResizeObserver / react-i18next
 * 的运行时环境，node:test 无 DOM，故锁定「结构性不变量」而非渲染快照 —— 与
 * v018-plan-item-patch-broadcast.test.ts 同手法。防的是「改版被后续 PR 悄悄改回去」。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/renderer/components/dock/__tests__/task-panel-fix2.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const PANEL = read('../TaskPanel.tsx')
const ROW = read('../../graph/NodeRow.tsx')

/* ============================================================
 * 一、默认全展开 + 永不折叠（用户诉求「不要过于折叠」）
 * ============================================================ */

test('TC-FIX2-001 默认全展开：折叠集合初始为空、foldAll 初始为 false', () => {
  assert.match(
    PANEL,
    /useState<Set<string>>\(new Set\(\)\)/,
    'collapsedIds 应初始为空集合 → 新布局默认全展开',
  )
  assert.match(PANEL, /const \[foldAll, setFoldAll\] = useState\(false\)/, 'foldAll 初始应为 false')
})

test('TC-FIX2-002 needs_human / failed 节点永不自动折叠', () => {
  assert.match(
    PANEL,
    /const NEVER_FOLD: ReadonlySet<NodeStatus> = new Set<NodeStatus>\(\['needs_human', 'failed'\]\)/,
    'NEVER_FOLD 应恰为 needs_human + failed',
  )
  assert.match(PANEL, /!NEVER_FOLD\.has\(r\.status\)/, 'rowCollapsedOf 应先绕过 NEVER_FOLD')
})

/* ============================================================
 * 二、四档筛选（全部 / 待办 / 进行中 / 已结束）
 * ============================================================ */

test('TC-FIX2-003 筛选项恰为 4 档且顺序固定', () => {
  assert.match(
    PANEL,
    /const FILTER_KEYS: readonly FilterKey\[\] = \['all', 'todo', 'active', 'ended'\]/,
    '筛选键应恰为 all/todo/active/ended',
  )
})

test('TC-FIX2-004 四档状态映射口径正确（11 态 → 3 组，互斥且完备）', () => {
  assert.match(
    PANEL,
    /todo:\s*\[[^\]]*'draft'[^\]]*'proposed'[^\]]*'approved'[^\]]*'ready'[^\]]*'blocked'[^\]]*\]/,
    '待办 = draft/proposed/approved/ready/blocked',
  )
  assert.match(
    PANEL,
    /active:\s*\[[^\]]*'in_progress'[^\]]*'verifying'[^\]]*'needs_human'[^\]]*\]/,
    '进行中 = in_progress/verifying/needs_human',
  )
  assert.match(
    PANEL,
    /ended:\s*\[[^\]]*'completed'[^\]]*'cancelled'[^\]]*'failed'[^\]]*\]/,
    '已结束 = completed/cancelled/failed',
  )
})

test('TC-FIX2-005 筛选条渲染每档的 i18n 标签与计数（tabular-nums）', () => {
  assert.match(PANEL, /FILTER_KEYS\.map\(/, '筛选条应遍历 FILTER_KEYS 渲染')
  assert.match(PANEL, /t\(`taskPanel\.filter\.\$\{k\}`\)/, '每档标签走 i18n')
  assert.match(PANEL, /filterCounts\[k\]/, '每档展示计数')
})

/* ============================================================
 * 三、单行显示 + 窄面板降级（用户诉求「尽量一行显示」「不要遮挡」）
 * ============================================================ */

test('TC-FIX2-006 节点行单行：data-node-id 锚点 + 窄面板元信息降级', () => {
  assert.match(ROW, /data-node-id=\{row\.id\}/, '行根节点应有 data-node-id（供定位滚动）')
  assert.match(ROW, /narrow\?: boolean/, 'NodeRow 应接受 narrow 降级开关')
  assert.match(ROW, /\{!narrow && \(/, '窄面板隐藏非关键元信息，保住标题单行')
})

test('TC-FIX2-007 行内菜单为绝对定位浮层：不占常态宽度、不挤动元信息', () => {
  assert.match(
    ROW,
    /className="pointer-events-none absolute right-1\.5 top-1\/2[^"]*group-hover:opacity-100/,
    '行内「⋯」应绝对定位 + hover 显现（对齐原型 .row .more）',
  )
})

test('TC-FIX2-008 面板向两处 NodeRow 传入 narrow（置顶区 + 树本体）', () => {
  const hits = PANEL.match(/<NodeRow[\s\S]*?narrow=\{narrow\}/g) ?? []
  assert.ok(hits.length >= 2, `两处 NodeRow 都应传 narrow，实际 ${hits.length} 处`)
  assert.match(PANEL, /const narrow = width < NARROW_WIDTH/, 'narrow 由面板宽度实时计算')
  assert.match(PANEL, /const NARROW_WIDTH = 360/, '窄面板阈值应为 360px')
})

test('TC-FIX2-009 定位滚动依赖 NodeRow 的 data-node-id 选择器（两处口径必须一致）', () => {
  assert.match(
    PANEL,
    /querySelector<HTMLElement>\(`\[data-node-id="\$\{id\}"\]`\)/,
    'locateTo 应以 [data-node-id] 查询并 scrollIntoView',
  )
})

/* ============================================================
 * 四、i18n 四语齐备（zh / en / ja / ko）
 * ============================================================ */

test('TC-FIX2-010 四语均具备筛选 / 定位 / 进度 / 折叠词条', () => {
  for (const loc of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`../../../i18n/locales/${loc}.json`)) as {
      taskPanel?: Record<string, unknown>
    }
    const tp = json.taskPanel
    assert.ok(tp, `${loc}.json 缺 taskPanel 命名空间`)
    const filter = tp!.filter as Record<string, unknown> | undefined
    assert.ok(filter, `${loc}.json 缺 taskPanel.filter`)
    for (const k of ['all', 'todo', 'active', 'ended']) {
      assert.ok(typeof filter![k] === 'string', `${loc}.json 缺 taskPanel.filter.${k}`)
    }
    for (const k of ['locate', 'locateTip', 'progressTip', 'foldAll']) {
      assert.ok(typeof tp![k] === 'string', `${loc}.json 缺 taskPanel.${k}`)
    }
  }
})
