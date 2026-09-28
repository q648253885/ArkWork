/* ============================================================
 * ArkWork — 死代码门槛：不得复活 + 不得误删活件（v0.36.0 · B9）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §3.8（F6.3）
 *
 * ★ 为什么要有这条用例（不是「跑一遍 grep 就完了」）
 *   as-built §14.4 给了一张「渲染层 8 个死组件」清单，但那张表是 v0.35.0 期做的，
 *   到 B9 已经**失真**：清单里的 `StepList` 其实指向一个**不存在**的路径
 *   （`components/StepList.tsx` 从来没有；真正在跑的是 `components/right/StepList.tsx`，
 *   由 SettingsContent 渲染），而 `ArtifactCard` 之类又确实是死的。
 *   ⇒ 「死组件清单」这种资产一旦靠人工维护就必然漂移（纪律②：计数必须逐文件实测）。
 *   本套件把清单**变成可执行的断言**：删除项入册即「不得复活」，存活项入册即
 *   「不得误删」，两侧都由用例把守。
 *
 * ★ 三条不可退化的性质
 *   ① **删干净**：删除清单里的文件确实不在盘上，且生产代码对它**零引用**
 *      （注释里提到不算 —— 源码守卫必须先剥注释，见纪律⑫）；
 *   ② **别删错**：清单外的活件（活组件 / 仍被消费的类型骨架）必须在盘上；
 *   ③ **检测器不空转**：表驱动自检 —— 注入一个真引用必须报红，注释里提一句必须不报。
 *      空转的守卫比没有守卫更危险（纪律⑨：静默退化）。
 *
 * ★ 本套件把守的第 4 条（真正抓出 ProgressPanel 的那条）
 *   注册表里的 widget 若声明了 `dockTabId`，该 id **必须**是 Inspector 真能渲染的
 *   内置 Tab —— 否则 `component` 永远不被渲染，就是下一个「注册了但没挂点」。
 *   ProgressPanel 正是这样烂掉的：`dockTabId: 'progress'` 不在 `INSPECTOR_TAB_REFS`
 *   内，`getEnabledWidgets()` 又零调用方。
 *
 * 反向核验记录（纪律⑩）：把 `ArtifactCard` 的 import 加回任一生产文件 → TC-DEAD-002 报红；
 *   把 `dockTabId: 'progress'` 加回注册表 → TC-DEAD-005 报红；两条均已实测。
 * ============================================================ */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { INSPECTOR_TAB_REFS } from '@shared/utils/panel-model'
import { stripComments } from '@shared/utils/source-guard'
// v0.38.0（D158）：全仓快照**每进程只扫一次**（此前 TC-DEAD-002 扫一遍、
// TC-DEAD-005 对每个 widget 再各扫一遍 → 5 个守卫用例吃掉全量测试时间的 83%）
import { getRepoScan } from '@shared/utils/repo-scan'

/** cwd = app/（与 run-tests.mjs 同口径） */
const APP_ROOT = process.cwd()
const SRC_ROOT = join(APP_ROOT, 'src')
const REPO = getRepoScan(SRC_ROOT)

/* ============================================================
 * ① 删除清单（无理由不得入册 —— 强制每次删除都写下「为什么」）
 * ============================================================ */

/** 相对 `src/` 的路径 → 删除理由 */
const REMOVED: Array<[string, string]> = [
  ['renderer/components/ArtifactCard.tsx', '无任何 import（`ArtifactCardItem` 亦无非自身引用）；产物卡片已改走 flow/ChangeSummary 的 card 变体'],
  ['renderer/components/CommandPalette.tsx', 'v0.13.0 起被 QuickAction（⌘K 四源）取代，无挂载点；其 copyConversation 命令已迁入 QuickAction'],
  ['renderer/components/LeftNav.tsx', '被 Sidebar + App.tsx 内联 CollapsedSidebar 取代；折叠态自成一格，无 import'],
  ['renderer/components/MessageActions.tsx', '消息操作已并入 FlowTurn/气泡组件，无 import'],
  ['renderer/components/SettingsDialog.tsx', 'v0.11.0 起被 SettingsContent（非 Modal）取代，无 import'],
  ['renderer/components/AgentChip.tsx', 'Composer 仅 import 从未渲染（v0.24.x 改为下拉入口）；死 import 与死组件同删'],
  ['renderer/components/panels/MarketPanel.tsx', '市场入口已并入 SkillsPanel 市场 Tab，无 import'],
  ['renderer/components/dock/ProgressPanel.tsx', '`dockTabId: progress` 不在 INSPECTOR_TAB_REFS 内、getEnabledWidgets 零调用方 ⇒ component 永不渲染'],
  ['main/engine/phase-runner.ts', '最小骨架：invokeSkill/faultTolerant 是 stub、deriveSkillIdFromPlanItem 硬编码 file-reader，且唯一消费者 runTurnForTask 无生产调用点'],
]

/**
 * 必须存活的反例（防误删）—— 清单本身也接受「实测结论与 as-built 不一致」。
 * 这几条都是「看起来像死件、实测是活件」或「删了会断链」的。
 */
const MUST_SURVIVE: Array<[string, string]> = [
  ['renderer/components/right/StepList.tsx', 'as-built §14.4 把 StepList 列为死件，但真实路径是这里，且 SettingsContent.tsx 正在渲染它'],
  ['main/engine/types.ts', 'Turn 类型骨架：compaction-hook.ts 仍 import type { Turn }；F4/子 agent 复用其类型'],
  ['renderer/components/sidebarRegistry.ts', 'widget 注册表仍在被 AgentEditor（勾选清单）消费'],
  ['shared/utils/source-guard.ts', '注释剥离器唯一真源（D101 收敛），全仓守卫共用'],
]

/* ============================================================
 * ② 检测器（纯函数，供自检用例直接驱动）
 * ============================================================ */

/** 生产代码位置（排除 `__tests__` 与测试文件）—— v0.38.0（D158）改用共享快照，walk 规则不变 */

/**
 * 在**剥掉注释**的源码里找符号引用。
 *
 * 剥注释是硬要求（纪律⑫）：本项目注释里到处在讲「某某组件已删除 / 已被取代」，
 * 不剥就会把注释本身当引用 —— 这也是 B8 期 TC-ABL-012 假红的同一个根因。
 */
export function findSymbolRefs(symbol: string, src: string): boolean {
  const code = stripComments(src)
  return new RegExp('\\b' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(code)
}

/** 全仓生产代码里引用了任一删除符号的文件（相对 `src/`，去重排序） */
function offendersOf(symbols: string[]): string[] {
  const hits = new Set<string>()
  for (const full of REPO.production) {
    const src = REPO.stripped(full)
    for (const s of symbols) {
      if (findSymbolRefs(s, src)) {
        hits.add(relative(SRC_ROOT, full).split(sep).join('/'))
        break
      }
    }
  }
  return [...hits].sort()
}

/** 删除符号（组件名 + 已删函数名 + 已删模块路径标记） */
const REMOVED_SYMBOLS = [
  'ArtifactCard',
  'CommandPalette',
  'LeftNav',
  'MessageActions',
  'SettingsDialog',
  'AgentChip',
  'MarketPanel',
  'ProgressPanel',
  'runTurnForTask',
]

/* ============================================================
 * ③ 用例
 * ============================================================ */

test('TC-DEAD-001 删除清单：文件确实不在盘上，且每条都有删除理由', () => {
  assert.ok(REMOVED.length >= 9, `删除清单应至少 9 项，实际 ${REMOVED.length}`)
  for (const [rel, reason] of REMOVED) {
    assert.ok(reason.trim().length >= 8, `${rel} 的删除理由过于潦草（无理由不得删除）`)
    assert.equal(existsSync(join(SRC_ROOT, rel)), false, `${rel} 已列为删除项，不得复活`)
  }
  assert.ok(existsSync(join(SRC_ROOT, 'main/engine/types.ts')), 'engine/types.ts 必须保留（Turn 骨架）')
})

test('TC-DEAD-002 生产代码对已删符号零引用（注释里提到不算）', () => {
  const offenders = offendersOf(REMOVED_SYMBOLS)
  assert.deepEqual(
    offenders,
    [],
    `以下生产文件仍引用已删除的符号，请一并清理：\n  ${offenders.join('\n  ')}`,
  )
})

test('TC-DEAD-003 ★ 检测器自检：真引用必中，注释/字符串里的字样不得误报', () => {
  // 反例（必须命中）
  assert.equal(findSymbolRefs('ProgressPanel', "import { ProgressPanel } from './dock/ProgressPanel'"), true)
  assert.equal(findSymbolRefs('AgentChip', 'const x = <AgentChip agent={a} />'), true)
  assert.equal(findSymbolRefs('LeftNav', 'export function LeftNav() { return null }'), true)
  // 正例（必须不误报）：块注释 / 行注释里的字样
  assert.equal(findSymbolRefs('ProgressPanel', '/* 原 ProgressPanel 已下线 */\nconst a = 1'), false)
  assert.equal(findSymbolRefs('CommandPalette', '// v0.13.0：QuickAction 取代 CommandPalette\nconst b = 2'), false)
  // 边界：前缀/后缀同名标识符不得误伤（`toggleLeftNav` ≠ `LeftNav`）
  assert.equal(findSymbolRefs('LeftNav', 'const toggleLeftNav = () => {}'), false)
  assert.equal(findSymbolRefs('ArtifactCard', 'const y = ArtifactCardItem'), false)
})

test('TC-DEAD-004 ★ 不得误删活件：清单外的活组件与类型骨架必须在盘上', () => {
  for (const [rel, why] of MUST_SURVIVE) {
    assert.equal(existsSync(join(SRC_ROOT, rel)), true, `${rel} 是活件（${why}），不得删除`)
  }
})

interface WidgetEntry {
  widgetId: string
  component: string
  dockTabId?: string
}

/** 从注册表源码切出每个 widget 条目（够用即可：只取四个字段） */
function parseWidgets(code: string): WidgetEntry[] {
  const starts = [...code.matchAll(/widgetId:\s*'([^']+)'/g)]
  return starts.map((m, i) => {
    const from = m.index as number
    const to = i + 1 < starts.length ? (starts[i + 1]!.index as number) : code.length
    const chunk = code.slice(from, to)
    const comp = /component:\s*([A-Za-z0-9_]+)/.exec(chunk)
    const dock = /dockTabId:\s*'([^']+)'/.exec(chunk)
    return {
      widgetId: m[1] as string,
      component: comp ? (comp[1] as string) : '',
      dockTabId: dock ? (dock[1] as string) : undefined,
    }
  })
}

/** 某组件符号是否在 `sidebarRegistry.ts` 之外的**生产代码**里被引用（= 另有渲染点） */
function hasExternalConsumer(component: string): boolean {
  if (!component) return false
  for (const full of REPO.production) {
    if (full.endsWith(join('renderer', 'components', 'sidebarRegistry.ts'))) continue
    if (findSymbolRefs(component, REPO.stripped(full))) return true
  }
  return false
}

test('TC-DEAD-005 ★ 注册即渲染：每个 widget 都必须有真实渲染挂点', () => {
  const registry = join(SRC_ROOT, 'renderer/components/sidebarRegistry.ts')
  const code = stripComments(readFileSync(registry, 'utf-8'))
  const widgets = parseWidgets(code)

  // ① widget 清单是**冻结快照**：增删都必须是刻意的
  assert.deepEqual(
    widgets.map((w) => w.widgetId),
    ['checklist', 'context', 'files', 'browser', 'terminal', 'memory', 'logs', 'preview'],
    'widget 清单变了：请确认新条目**有渲染挂点**后同步本清单',
  )

  // ② 声明了 dockTabId 的，该 id 必须是 Inspector 真能渲染的内置 Tab。
  //    ProgressPanel 就是这样烂掉的（dockTabId: 'progress' ∉ INSPECTOR_TAB_REFS）。
  const builtins = INSPECTOR_TAB_REFS as readonly string[]
  const notRenderable = widgets.filter((w) => w.dockTabId && !builtins.includes(w.dockTabId))
  assert.deepEqual(
    notRenderable.map((w) => `${w.widgetId} -> ${w.dockTabId}`),
    [],
    '这些 dockTabId 不在 INSPECTOR_TAB_REFS 内 ⇒ 其 component 永不渲染（死挂点）',
  )

  // ③ 不声明 dockTabId 的（注册表之外的消费点），其 component 必须确实在别处被引用 ——
  //    否则就是「注册了、也声明了组件、但没有任何地方渲染」的第二个 ProgressPanel。
  const orphans = widgets
    .filter((w) => !w.dockTabId)
    .filter((w) => !hasExternalConsumer(w.component))
    .map((w) => `${w.widgetId}(${w.component})`)
  assert.deepEqual(
    orphans,
    [],
    `这些 widget 既无内置 Tab 挂点、其 component 也无注册表之外的渲染点 ⇒ 死挂点：${orphans.join(', ')}`,
  )

  // ④ 每个 widget 都必须声明 component（注册表的核心承诺）
  assert.ok(
    widgets.every((w) => w.component !== ''),
    `有 widget 未声明 component：${widgets.filter((w) => !w.component).map((w) => w.widgetId).join(', ')}`,
  )
})
