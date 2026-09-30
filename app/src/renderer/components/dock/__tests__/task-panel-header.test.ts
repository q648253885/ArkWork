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
import { sanitizeTierReason } from '../../../utils/tier-reason'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const PANEL = read('../TaskPanel.tsx')
const GRAPH_TYPES = read('../../../../shared/types/graph.ts')

/* ============================================================
 * 一、视图切换（v0.43.0 R3 语义变更）：树/DAG 切换整组退役
 * ============================================================ */

test('TC-PANEL-HDR-001 ★ v0.43.0 R3：依赖图退役 —— 树/DAG 切换零残留（否定腿）', () => {
  assert.doesNotMatch(PANEL, /taskPanel\.viewDag/, '依赖图切换文案不得残留')
  assert.doesNotMatch(PANEL, /view === 'dag'/, 'DAG 视图分支不得残留')
  assert.doesNotMatch(PANEL, /DagView/, 'DagView 挂载不得残留（文件本体留待清创版）')
})

/* ============================================================
 * 二、TierPill：从缩写升级为释义（单一真源）
 * ============================================================ */

test('TC-PANEL-HDR-002 ★ v0.43.0 R2：档位行移到标题下方（全宽释义 + info 弹层），释义真源不变', () => {
  assert.match(
    PANEL,
    /data-testid="graph-tier-badge"[\s\S]{0,400}\{tierLabel\(snapshot\.tier, i18n\.language\)\}/,
    '档位徽章独立行显示完整释义（不再窄态缩写）',
  )
  assert.match(PANEL, /data-testid="tier-info-btn"/, 'info 按钮存在（用户可点击查看 T0–T3 说明）')
  // v0.43.0（用户反馈①）：裸「i」不直观 → 图标 + 文字标签
  assert.match(PANEL, /<Icon\.Info width=\{12\} height=\{12\} aria-hidden \/>/, 'info 按钮应带描述图标')
  assert.match(PANEL, /\{t\('taskPanel\.tierInfo\.helpLabel'\)\}/, 'info 按钮应带文字标签（不只有 i）')
  // v0.43.0（用户反馈②）：判定理由先净化，内部迁移语言不外露
  assert.match(PANEL, /sanitizeTierReason\(snapshot\?\.tierReason\)/, '判定理由应经展示层净化')
  assert.match(PANEL, /createPortal\(/, '弹层必须 Portal 到 body（纪律⑤：逃逸裁切容器）')
  assert.match(PANEL, /taskPanel\.tierInfo\.title/, '弹层标题走 i18n')
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

test('TC-PANEL-HDR-006 ★ v0.43.0：窄态折叠按钮仍降级纯图标；控制行允许换行', () => {
  assert.match(PANEL, /\{!narrow && <span>\{foldAll \? t\('taskPanel\.expandAllShort'\)/, '窄态折叠按钮应降级为纯图标')
  assert.match(
    PANEL,
    /<div className="mt-2\.5 flex min-w-0 flex-wrap items-center gap-2">/,
    '控制行应允许换行（<300px 时不遮挡）',
  )
})

/* ============================================================
 * 六、关键回归：筛选条后向兼容 + 五态可达 + 轻量模式
 * ============================================================ */

test('TC-PANEL-HDR-007 ★ v0.43.0 R4：筛选条改两 Tab（本轮任务 / 全部任务），旧四档退役', () => {
  assert.match(
    PANEL,
    /const FILTER_KEYS: readonly FilterKey\[\] = \['round', 'all'\]/,
    '筛选键应恰为 round/all',
  )
  assert.match(PANEL, /FILTER_KEYS\.map\(/, '筛选条应遍历 FILTER_KEYS 渲染')
  assert.match(PANEL, /filterCounts\[k\]/, '每档展示计数')
  assert.match(PANEL, /roundById/, '轮次 join（node.id ↔ planItem.id）必须存在')
  assert.doesNotMatch(PANEL, /'todo', 'active', 'ended'/, '旧四档键不得残留')
})

test('TC-PANEL-HDR-008 五态（加载/空/错误/成功/损坏）在重设计后仍可达', () => {
  assert.match(PANEL, /if \(!g\.loading && !g\.error && g\.snapshot === null\)/, '空态守卫应保留')
  assert.match(PANEL, /<EmptyState/, '空态应渲染 EmptyState')
  assert.match(PANEL, /if \(g\.broken \|\| \(g\.error && g\.error\.code === 'SCHEMA_INVALID'\)\)/, '损坏/错误态守卫应保留')
  assert.match(PANEL, /\{g\.loading && !snap && \(/, '加载态守卫应保留')
  const headerCalls = PANEL.match(/<PanelHeader/g) ?? []
  assert.ok(headerCalls.length >= 2, `错误态与成功态都应渲染 PanelHeader，实际 ${headerCalls.length} 处`)
})

test('TC-PANEL-HDR-009 ★ v0.43.0 R1：标题 = 本轮目标简介（goal 优先），「未命名任务」占位不外露', () => {
  assert.match(PANEL, /snapshot\?\.goal \|\| snapshot\?\.title/, '标题取值 goal 优先（本轮目标 = 引擎轮次晋升时更新）')
  assert.match(PANEL, /\/\^未命名任务\/\.test\(rawTitle\)/, '「未命名任务」占位必须走兜底链')
  assert.match(PANEL, /taskPanel\.roundFallback/, '兜底文案走 i18n（本轮任务）')
})

test('TC-PANEL-HDR-010 ★ v0.43.0 i18n 新键四语言齐备（roundFallback / filter.round / tierInfo.*）', () => {
  for (const loc of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`../../../i18n/locales/${loc}.json`)) as {
      taskPanel?: Record<string, unknown>
      filter?: Record<string, unknown>
    }
    const tp = json.taskPanel
    assert.ok(tp, `${loc}.json 缺 taskPanel 命名空间`)
    for (const k of ['roundFallback', 'tierInfo']) assert.ok(tp![k], `${loc}.json 缺 taskPanel.${k}`)
    const ti = tp!.tierInfo as Record<string, unknown>
    for (const k of ['title', 'helpLabel', 'reasonLabel', 'd0', 'd1', 'd2', 'd3']) {
      assert.ok(typeof ti[k] === 'string' && (ti[k] as string).length > 0, `${loc}.json 缺 taskPanel.tierInfo.${k}`)
    }
  }
})

/* ============================================================
 * 七、v0.43.0 用户反馈②：判定理由展示层净化（真值表 · 真执行）
 * ============================================================ */

test('TC-PANEL-HDR-011 ★ 内部迁移语言不外露：sanitizeTierReason 剥离「迁移自…」', () => {
  assert.equal(
    sanitizeTierReason('迁移自 v0.29（无 tier 判定，按既有清单规模取 T2）'),
    undefined,
    '中文迁移语言应剥离',
  )
  assert.equal(sanitizeTierReason('migrated from v0.29 (no tier logic)'), undefined, '英文迁移语言应剥离')
  assert.equal(sanitizeTierReason('按任务规模自动判定'), '按任务规模自动判定', '正常理由应原样保留')
  assert.equal(sanitizeTierReason('   '), undefined, '空白理由应归一为 undefined')
  assert.equal(sanitizeTierReason(undefined), undefined, '缺省理由应为 undefined')
})
