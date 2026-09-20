/* ============================================================
 * ArkWork — 能力页三 Tab / 工作台中心两子页 契约（v0.34.0 · P3 · TC-ABL-001..014）
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §4.1 / §4.2 / §4.3
 *
 * 用户实测诉求原文：
 *   「工作区的插件和能力里面的插件有重叠，将能力里面的插件变成 MCP，
 *     将工作区的插件转移到能力中。」
 * 根因（编码期核实）：v0.24.2 起能力页的「插件」Tab 其实是 **MCP 管理**
 *   （`PluginsPanel`），与工作台中心的「插件」（能力插件）同名不同物 ——
 *   两个「插件」入口，用户无法分辨。
 *
 * ★ 覆盖方式的诚实说明（v0.32.2 审计教训）：
 *   仓库没有 jsdom / testing-library 基建，组件类断言只能走**源码契约**。
 *   但「只 grep 到符号」曾把**死组件**钉成正确（TC-PUI-009 断言了未挂载的
 *   RightDock 全绿）。因此本组不用「文件里有这个名字」，而是钉
 *   **渲染树位置**：`{activeTab === 'plugins' && <CapabilityPluginsPanel />}`
 *   这一级 —— 分支 + 组件同时在场，才算真挂上。
 *   局限：仍无法证明运行时真的渲染（那需要渲染基建）。此缺口记入
 *   04-system-design §9.2，属已知欠账，不假装已覆盖。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs abilities-tabs
 *
 * ★ v0.35.0 修订（TC-ABL-007/007b/009/011/011b）：
 *   插件能跑代码之后，能力页这块面板的契约变了两处 ——
 *     · 来源徽标由两档（bundled / local）改**三档**（bundled / workspace / global）：
 *       `User` 分不出「只在本工作区生效」与「全局生效」，后果完全不同；
 *     · 「新建插件」由「贴一段 JSON 引导」改**脚手架**（生成最小可运行目录）：
 *       代码插件的 Host/Client/清单三者形状耦合，手拼必踩坑。
 *   同时新增两条把守：开关与「打开目录」必须带**当前作用域**（否则静默写错级别）；
 *   空 id/name 必须被拦下（不落一个空目录）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const abilitiesSrc = src('../panels/AbilitiesPanel.tsx')
const capabilitySrc = src('../panels/CapabilityPluginsPanel.tsx')
const workbenchSrc = src('../workbench/WorkbenchCenter.tsx')
const mcpPanelSrc = src('../panels/PluginsPanel.tsx')

const PLUGINS_VIEW = fileURLToPath(new URL('../workbench/PluginsView.tsx', import.meta.url))

/* ============================================================
 * 1. 能力页：三 Tab 顺序与内容归属
 * ============================================================ */

test('TC-ABL-001 能力页 Tab 类型恰为 skills | plugins | mcp（三而不再是两）', () => {
  assert.match(
    abilitiesSrc,
    /type AbilityTab = 'skills' \| 'plugins' \| 'mcp'/,
    "Tab 联合类型必须含 mcp —— 这是「能力里的插件变成 MCP」的落地锚点",
  )
})

test('TC-ABL-002 Tab 渲染顺序为 技能 → 插件 → MCP（Q5 裁决，显式数组不靠对象键序）', () => {
  assert.match(
    abilitiesSrc,
    /const TAB_ORDER: AbilityTab\[\] = \['skills', 'plugins', 'mcp'\]/,
    '必须显式声明顺序数组（对象键序在 JS 里不保证，是隐性回归点）',
  )
  assert.match(abilitiesSrc, /TAB_ORDER\.map\(/, '渲染必须走 TAB_ORDER，而不是 Object.keys')
  assert.doesNotMatch(abilitiesSrc, /Object\.keys\(TAB_META\)/, '不得再依赖对象键序')
})

test('TC-ABL-003 ★ 三个 Tab 的渲染树位置：分支 + 组件同时在场', () => {
  assert.match(
    abilitiesSrc,
    /\{activeTab === 'skills' && <SkillsPanel \/>\}/,
    "skills 分支必须渲染 SkillsPanel",
  )
  assert.match(
    abilitiesSrc,
    /\{activeTab === 'plugins' && <CapabilityPluginsPanel \/>\}/,
    "plugins 分支必须渲染 CapabilityPluginsPanel（能力插件管理）",
  )
  assert.match(
    abilitiesSrc,
    /\{activeTab === 'mcp' && <PluginsPanel \/>\}/,
    'mcp 分支必须渲染 PluginsPanel（原误名「插件」的 MCP 管理）',
  )
  // 三门必须互斥且穷尽（用 && 而不是 ? :，避免漏掉第三支）
  assert.match(abilitiesSrc, /^import \{ CapabilityPluginsPanel \} from '\.\/CapabilityPluginsPanel'$/m, '必须 import 新面板')
  assert.match(abilitiesSrc, /^import \{ PluginsPanel \} from '\.\/PluginsPanel'$/m, '必须 import MCP 面板')
  assert.match(abilitiesSrc, /^import \{ SkillsPanel \} from '\.\/SkillsPanel'$/m, '必须 import 技能面板')
})

test('TC-ABL-004 计数徽标：skills / plugins / mcps 三源各归其位', () => {
  assert.match(abilitiesSrc, /skills: skills\.length/, 'skills 计数取 skills')
  assert.match(abilitiesSrc, /plugins: plugins\.length/, 'plugins 计数必须取 **plugins**（原为 mcps.length —— 正是命名错位的物证）')
  assert.match(abilitiesSrc, /mcp: mcps\.length/, 'mcp 计数取 mcps')
  assert.match(abilitiesSrc, /const plugins = useStore\(\(s\) => s\.plugins\)/, '必须从 store 取 plugins')
})

test('TC-ABL-005 Tab 标签取自 i18n 且不再把 MCP 文案挂在 plugins 上', () => {
  assert.match(abilitiesSrc, /label: t\('panel\.abilities\.tab\.plugins'\)/, 'plugins 标签走 i18n')
  assert.match(abilitiesSrc, /label: t\('panel\.abilities\.tab\.mcp'\)/, 'mcp 标签必须独立成键（不得复用 plugins）')
  assert.match(abilitiesSrc, /hint: t\('panel\.abilities\.hint\.mcp'\)/, 'mcp hint 独立成键')
})

test('TC-ABL-006 三 Tab 的 key 与 label 都落在 DOM 上（便于 e2e/调试定位）', () => {
  assert.match(abilitiesSrc, /data-tab=\{t\}/, '必须输出稳定 tab 标识（testable）')
  assert.match(abilitiesSrc, /data-tab-label=\{meta\.label\}/, '标签文本同时落到 data 属性')
  assert.match(abilitiesSrc, /data-testid="abilities-tabs"/, 'Tab 条保留既有 testid')
})

/* ============================================================
 * 2. CapabilityPluginsPanel：简化规格 + 只复用既有 IPC
 * ============================================================ */

test('TC-ABL-007 一行一插件：行节点带插件 id，开关是 role=switch', () => {
  assert.match(capabilitySrc, /data-plugin-row=\{p\.id\}/, '每插件一行且可定位')
  assert.match(capabilitySrc, /role="switch"/, '启停用开关语义（无障碍）')
  assert.match(capabilitySrc, /aria-checked=\{checked\}/, '开关必须暴露状态')
  // 开关复用既有 store 动作：别名 → store 动作 → 调用点，三段都要在（只查别名会被改名绕过）
  assert.match(capabilitySrc, /useStore\(\(s\) => s\.setPluginEnabled\)/, '必须绑定既有 setPluginEnabled')
  assert.match(capabilitySrc, /useStore\(\(s\) => s\.uninstallPlugin\)/, '必须绑定既有 uninstallPlugin')
  assert.match(capabilitySrc, /useStore\(\(s\) => s\.openPluginsDir\)/, '绑定既有 openPluginsDir')
  assert.match(capabilitySrc, /useStore\(\(s\) => s\.rescanPlugins\)/, '绑定既有 rescanPlugins')
  assert.match(capabilitySrc, /uninstall\(p\.id\)/, '卸载调用点必须落在绑定好的动作上')
  assert.match(capabilitySrc, /rescan\(\)/, '重新扫描走既有 IPC')
})

test('TC-ABL-007b ★ v0.35.0：开关与「打开目录」必须带上**当前作用域**（否则静默写错级别）', () => {
  // 这是 v0.35.0 引入 workspace 级之后才出现的新误伤面：不改这两处调用点，
  // 用户在本工作区视图里拨开关，实际写的是全局那份 plugins.json。
  assert.match(capabilitySrc, /setEnabled\(p\.id, next, scope\)/, '启停必须把当前作用域传下去')
  assert.match(capabilitySrc, /openDir\(scope\)/, '打开目录必须打开当前作用域那个目录')
  assert.match(capabilitySrc, /useStore\(\(s\) => s\.setPluginScope\)/, '必须有作用域切换动作')
})

test('TC-ABL-008 详情就地展开（不跳页），且随包示例不可卸载', () => {
  assert.match(capabilitySrc, /data-testid="plugin-detail"/, '详情必须有可定位容器')
  assert.match(capabilitySrc, /expandedId === p\.id/, '展开态由 id 决定（一次只展开一个）')
  assert.match(capabilitySrc, /aria-expanded=\{expanded\}/, '展开按钮须暴露状态')
  assert.match(
    capabilitySrc,
    /disabled=\{!p\.uninstallable \|\| busy\}/,
    '随包示例（uninstallable=false）必须禁用卸载入口',
  )
})

test('TC-ABL-009 ★ v0.35.0 来源徽标区分三档 bundled / workspace / global（不再是 bundled / local）', () => {
  assert.match(capabilitySrc, /const bundled = p\.source === 'bundled'/, "来源判定必须用语义 'bundled'")
  assert.doesNotMatch(capabilitySrc, /'builtin'/, "不得残留旧来源语义 'builtin'（P4 改名须彻底）")
  // v0.35.0：`User` 这一档已分不出「只在本工作区生效」与「全局生效」——两者的后果完全不同，
  // 故必须拆成两档，并把「来源徽标」收进一个统一助手（避免三处各写一遍判断）
  assert.match(capabilitySrc, /function sourceText\(/, '来源文案必须收敛到单一助手')
  assert.match(capabilitySrc, /workbench\.plugins\.sourceBundled/, '随包示例徽标走 i18n')
  assert.match(capabilitySrc, /workbench\.plugins\.scopeWorkspace/, '本工作区徽标走 i18n')
  assert.match(capabilitySrc, /workbench\.plugins\.scopeGlobal/, '全局徽标走 i18n')
  assert.doesNotMatch(capabilitySrc, /workbench\.plugins\.sourceLocal/, '两档来源语义已被三档取代')
})

test('TC-ABL-010 空态与问题区都在（降级必须可见，不许空白面板）', () => {
  assert.match(capabilitySrc, /workbench\.plugins\.empty/, '必须有空态文案')
  assert.match(capabilitySrc, /workbench\.plugins\.emptyHint/, '空态必须给「怎么做」（人话指引）')
  assert.match(capabilitySrc, /brokenCount > 0/, '坏插件必须汇总可见')
  assert.match(capabilitySrc, /p\.invalidReason &&/, '单行也要标出问题')
})

test('TC-ABL-011 ★ v0.35.0「新建插件」= 脚手架（生成最小可运行目录），不再是贴一段 JSON', () => {
  // v0.34.0 的做法是「展开一段 SAMPLE_JSON 让用户自己拼」。代码插件时代这不够用 ——
  // 插件的 Host 半/Client 半/清单三者形状耦合，手拼必然踩坑（设计 §7 · P1）。
  assert.match(capabilitySrc, /data-testid="new-plugin-toggle"/, '新建插件入口存在')
  assert.match(capabilitySrc, /data-testid="new-plugin-guide"/, '脚手架区按需展开')
  assert.match(capabilitySrc, /aria-expanded=\{showScaffold\}/, '展开态须暴露（含 aria）')
  for (const tid of ['scaffold-id', 'scaffold-name', 'scaffold-kind', 'scaffold-create']) {
    assert.match(capabilitySrc, new RegExp(`data-testid="${tid}"`), `脚手架必须有 ${tid}`)
  }
  assert.match(capabilitySrc, /SCAFFOLD_KINDS/, '可选类型必须同源于 PLUGIN_KINDS（含 v0.35.0 的 tool 档）')
  // 走 store 动作，不得直连 window.api
  assert.match(capabilitySrc, /useStore\(\(s\) => s\.scaffoldPlugin\)/, '必须走既有 scaffoldPlugin 动作')
  assert.doesNotMatch(capabilitySrc, /window\.api\./, '必须走 store，不得直连 window.api')
  assert.match(capabilitySrc, /scaffold\(\{ id, name, kind: draftKind, scope \}\)/, '脚手架必须把当前作用域带下去')
})

test('TC-ABL-011b v0.35.0 脚手架前的入口守卫：id/name 为空必须拦下并给人话提示（不落一个空目录）', () => {
  assert.match(capabilitySrc, /scaffoldIdRequired/, '缺 id/name 时必须给可读提示')
  assert.match(capabilitySrc, /pushToast\(\{ type: 'warning'/, '用警告 toast 提示，而不是静默失败')
})

/* ============================================================
 * 3. 工作台中心：收敛两子页 + PluginsView 真删除
 * ============================================================ */

test('TC-ABL-012 ★ 工作台中心恰为两子页，且不再渲染 plugins', () => {
  assert.match(workbenchSrc, /type Tab = 'profiles' \| 'diagnostics'/, '类型收敛为两值')
  assert.match(workbenchSrc, /const TABS: Array<\{ id: Tab; icon: IconName \}> = \[\s*\{ id: 'profiles'/, 'TABS 数组以 profiles 起始')
  assert.doesNotMatch(workbenchSrc, /id: 'plugins'/, 'TABS 不得再含 plugins')
  assert.doesNotMatch(workbenchSrc, /\{tab === 'plugins'/, '不得再渲染 plugins 子页')
  assert.doesNotMatch(workbenchSrc, /PluginsView/, '不得再引用 PluginsView')
  assert.match(workbenchSrc, /\{tab === 'profiles' && <ProfilesView \/>\}/, 'profiles 分支保留')
  assert.match(workbenchSrc, /\{tab === 'diagnostics' && <DiagnosticsView \/>\}/, 'diagnostics 分支保留')
})

test('TC-ABL-013 ★ PluginsView.tsx 必须**物理删除**（不是仅取消引用）', () => {
  assert.equal(
    existsSync(PLUGINS_VIEW),
    false,
    '文件必须删除 —— 留着不引用就是 v0.32.2 审计里的「死组件」，下一个人会以为它还活着',
  )
})

test('TC-ABL-014 MCP 面板「仅更名」：PluginsPanel 行为未被改动', () => {
  // 设计 §4.1 明确「PluginsPanel 仅更名，行为不动」——
  // 用一个最小指纹把守：它仍然管理 MCP server 列表（而不是被改成别的用途）
  assert.ok(mcpPanelSrc.length > 200, 'PluginsPanel 应仍是实体组件')
  assert.match(mcpPanelSrc, /mcp/i, 'PluginsPanel 仍是 MCP 管理（含 mcp 语义）')
})
