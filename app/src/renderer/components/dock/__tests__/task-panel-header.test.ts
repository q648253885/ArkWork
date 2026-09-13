/**
 * v0.30.1 详测 — TC-PANEL-HDR（任务面板顶栏 UI 重设计 · 源码契约）
 *
 * 依据：docs/versions/v0.30.1/04-system-design.md §6（问题④ 重设计）
 *       docs/versions/v0.30.1/prototype/index.html（冻结的视觉基准）
 *       docs/versions/v0.30.1/testcases/00-cumulative-matrix.md §3.5
 *
 * 用户诉求原文：「任务清单上方的功能选择没有解释，只有图标和 T1 T2 这样的内容，
 * 用户无法知道什么意思，需要补充和重新设计 UI。」
 *
 * 本套件为**源码契约**（readFileSync + 正则）：组件依赖 ResizeObserver / react-i18next
 * 运行时，node:test 无 DOM，故锁定「用户能否看懂每个控件」这一不变量 —— 防的是
 * 重设计被后续 PR 改回「仅图标 + T2」。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/renderer/components/dock/__tests__/task-panel-header.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const PANEL = read('../TaskPanel.tsx')
const GRAPH_TYPES = read('../../../../shared/types/graph.ts')

/* ============================================================
 * 一、ViewSwitch：图标 + 文字（不再仅图标）
 * ============================================================ */

test('TC-PANEL-HDR-001 ViewSwitch 渲染「图标 + 文字」且保留 aria-pressed', () => {
  assert.match(
    PANEL,
    /label=\{t\('taskPanel\.viewTree'\)\}[\s\S]{0,80}showText=\{!narrow\}/,
    '树视图按钮应带 i18n 文案并受窄态降级开关控制',
  )
  assert.match(
    PANEL,
    /label=\{t\('taskPanel\.viewDag'\)\}[\s\S]{0,80}showText=\{!narrow\}/,
    '依赖图按钮应带 i18n 文案并受窄态降级开关控制',
  )
  assert.match(
    PANEL,
    /\{showText && <span>\{label\}<\/span>\}/,
    'SegBtn 应在 showText 时把文字渲染出来（不只是 title）',
  )
  assert.match(PANEL, /aria-pressed=\{active\}/, 'SegBtn 应保留 aria-pressed 语义')
})

/* ============================================================
 * 二、TierPill：从缩写升级为释义（单一真源）
 * ============================================================ */

test('TC-PANEL-HDR-002 TierPill 宽态含释义、窄态仅 T{n}，title 回退 tierReason', () => {
  assert.match(
    PANEL,
    /<span>\{narrow \? `T\$\{snapshot\.tier\}` : tierLabel\(snapshot\.tier, i18n\.language\)\}<\/span>/,
    '宽态显示 tierLabel 释义，窄态降级为 T{n}',
  )
  assert.match(
    PANEL,
    /title=\{snapshot\.tierReason \?\? tierLabel\(snapshot\.tier, i18n\.language\)\}/,
    'title 应优先 tierReason，回退 tierLabel',
  )
  assert.match(
    PANEL,
    /import \{ tierLabel \} from '@shared\/types\/graph'/,
    '释义应取自 shared/types/graph 的单一真源，不另写文案',
  )
  assert.ok(
    GRAPH_TYPES.includes('TIER_LABEL_I18N') && GRAPH_TYPES.includes('export function tierLabel'),
    'graph.ts 应导出四语言 tier 释义真源 tierLabel',
  )
})

/* ============================================================
 * 三、FoldAllButton：状态化文案 + 图标随态
 * ============================================================ */

test('TC-PANEL-HDR-003 FoldAllButton 状态化文案 + 图标随态', () => {
  assert.match(
    PANEL,
    /foldAll \? t\('taskPanel\.expandAllShort'\) : t\('taskPanel\.foldAllShort'\)/,
    '已折叠 →「全部展开」，全展开 →「全部折叠」',
  )
  assert.match(
    PANEL,
    /foldAll \? <Icon\.ChevronRight width=\{12\} height=\{12\} \/> : <Icon\.ChevronDown width=\{12\} height=\{12\} \/>/,
    '图标应随态：折叠用 ChevronRight、展开用 ChevronDown',
  )
  assert.match(
    PANEL,
    /title=\{t\('taskPanel\.foldAll'\)\}/,
    '既有 foldAll 应保留为 title（长解释）',
  )
})

/* ============================================================
 * 四、新增 i18n 键（四语言齐备）
 * ============================================================ */

test('TC-PANEL-HDR-004 新增键 foldAllShort / expandAllShort 四语言齐备且被 UI 引用', () => {
  assert.ok(PANEL.includes("taskPanel.foldAllShort"), 'UI 应引用 taskPanel.foldAllShort')
  assert.ok(PANEL.includes("taskPanel.expandAllShort"), 'UI 应引用 taskPanel.expandAllShort')
  for (const loc of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`../../../i18n/locales/${loc}.json`)) as {
      taskPanel?: Record<string, unknown>
    }
    const tp = json.taskPanel
    assert.ok(tp, `${loc}.json 缺 taskPanel 命名空间`)
    for (const k of ['foldAllShort', 'expandAllShort']) {
      assert.ok(typeof tp![k] === 'string' && (tp![k] as string).length > 0, `${loc}.json 缺 taskPanel.${k}`)
    }
  }
})

/* ============================================================
 * 五、布局规则（≥360 / <360 / <300）
 * ============================================================ */

test('TC-PANEL-HDR-005 布局 ≥360px：控件 ml-auto 右对齐、筛选条不换行', () => {
  assert.match(
    PANEL,
    /<span className="ml-auto flex shrink-0 items-center gap-1">/,
    '右侧控件组应 ml-auto 右对齐',
  )
  assert.match(
    PANEL,
    /className="inline-flex min-w-0 overflow-x-auto rounded-md border border-border-default bg-bg-surface-2 p-0\.5"/,
    '筛选条应横向滚动而非换行',
  )
  assert.match(PANEL, /whitespace-nowrap rounded-sm px-1\.5 py-0\.5 text-2xs/, '筛选档位文字应不换行')
})

test('TC-PANEL-HDR-006 窄态 <360 降级纯图标且保留 title/aria-label；<300 允许换行', () => {
  assert.match(PANEL, /showText=\{!narrow\}/, '窄态视图切换应降级为纯图标')
  assert.match(PANEL, /\{!narrow && <span>\{foldAll \? t\('taskPanel\.expandAllShort'\)/, '窄态折叠按钮应降级为纯图标')
  assert.match(PANEL, /aria-label=\{label\}\s*\n\s*title=\{label\}/, 'SegBtn 降级后仍应保留 aria-label + title')
  assert.match(
    PANEL,
    /<div className="mt-2\.5 flex min-w-0 flex-wrap items-center gap-2">/,
    '控制行应允许换行（<300px 时不遮挡）',
  )
})

/* ============================================================
 * 六、关键回归：筛选条后向兼容 + 五态可达 + 轻量模式
 * ============================================================ */

test('TC-PANEL-HDR-007 筛选条 4 档顺序与计数不变（不破坏 TC-FIX2-003/005）', () => {
  assert.match(
    PANEL,
    /const FILTER_KEYS: readonly FilterKey\[\] = \['all', 'todo', 'active', 'ended'\]/,
    '筛选键应恰为 all/todo/active/ended',
  )
  assert.match(PANEL, /FILTER_KEYS\.map\(/, '筛选条应遍历 FILTER_KEYS 渲染')
  assert.match(PANEL, /filterCounts\[k\]/, '每档展示计数')
})

test('TC-PANEL-HDR-008 五态（加载/空/错误/成功/损坏）在重设计后仍可达', () => {
  assert.match(PANEL, /if \(!g\.loading && !g\.error && g\.snapshot === null\)/, '空态守卫应保留')
  assert.match(PANEL, /<EmptyState/, '空态应渲染 EmptyState')
  assert.match(PANEL, /if \(g\.broken \|\| \(g\.error && g\.error\.code === 'SCHEMA_INVALID'\)\)/, '损坏/错误态守卫应保留')
  assert.match(PANEL, /\{g\.loading && !snap && \(/, '加载态守卫应保留')
  const headerCalls = PANEL.match(/<PanelHeader/g) ?? []
  assert.ok(headerCalls.length >= 2, `错误态与成功态都应渲染 PanelHeader，实际 ${headerCalls.length} 处`)
})

test('TC-PANEL-HDR-009 轻量模式仅渲染「树视图」、隐藏依赖图控件', () => {
  assert.match(
    PANEL,
    /\{!snapshot\?\.lightweight && \([\s\S]{0,220}taskPanel\.viewDag/,
    '轻量模式下不应渲染依赖图控件（避免死控件）',
  )
})
