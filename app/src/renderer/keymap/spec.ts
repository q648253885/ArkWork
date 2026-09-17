/* ============================================================
 * ArkWork — 键位声明表（v0.31.0 B0）
 *
 * **纯数据、零 import**（除类型）：node:test 可直接 import 本文件做
 * 完备性 / 零撞键 / 预留位断言，无需 DOM、store、electron 桩。
 *
 * 内容 = 迁移前 `App.tsx` 全局 keydown **13 个分支**的逐条落码。
 * 分支数 ≠ 键位数：`Mod+1~6` 与 `Alt+1~6` 各是一个分支展开成的 6 条声明，
 * `Mod+/` 与 `Mod+?` 是同一动作的两个别名（分两条，便于用户单独重绑）。
 * 合计 **24 条声明**。
 *
 * 迁移纪律（R7 / C-9）：**键位、优先级、动作一律不变**。本表与迁移前 if 链的
 * 逐条对应关系见 04-system-design.md「B0 精读后修正」。
 * 唯二刻意偏差：
 *   ① `Mod` 在 macOS 上只认 Command（不再用 `metaKey || ctrlKey` 代偿）——
 *      理由见 `@shared/utils/keys` 文件头。
 *   ② 本表把「表单内 Shift+Tab 放行」的判定从「键位层」下沉到 handler 内部
 *      （行为不变：命中后不 preventDefault、不切换权限模式）。
 * ============================================================ */
import type { Chord } from '@shared/utils/keys'
import type { KeybindingSpec } from './types'

/** 帮助中心分组标题所用的 i18n key（顺序即展示顺序） */
export const GROUP_ORDER = ['global', 'inspector', 'help', 'editor', 'region'] as const

/**
 * 迁移后的默认键位表。
 *
 * `titleKey` 复用既有 `help.shortcuts.desc.*` —— 目的是让帮助中心 4 语言文案
 * **零改动**沿用（新增两条除外），避免"中央化"顺带改名造成译文返工。
 */
export const KEYMAP_SPEC = [
  /* ---------- 分支 1：Mod+/ 与 Mod+? 开关 HelpCenter ---------- */
  {
    id: 'help.toggle',
    chord: 'Mod+/',
    priority: 0,
    titleKey: 'help.shortcuts.desc.help',
    group: 'help',
  },
  {
    id: 'help.toggleAlt',
    chord: 'Mod+?',
    priority: 0,
    titleKey: 'help.shortcuts.desc.helpAlt',
    group: 'help',
  },

  /* ---------- 分支 2：Mod+K Quick Action ---------- */
  {
    id: 'palette.quickAction',
    chord: 'Mod+K',
    priority: 0,
    titleKey: 'help.shortcuts.desc.quickAction',
    group: 'global',
  },

  /* ---------- 分支 3：Mod+P QuickOpen ---------- */
  {
    id: 'quickOpen.toggle',
    chord: 'Mod+P',
    priority: 0,
    titleKey: 'help.shortcuts.desc.quickOpen',
    group: 'global',
  },

  /* ---------- 分支 4：Mod+N 新建任务 ---------- */
  {
    id: 'task.new',
    chord: 'Mod+N',
    priority: 0,
    titleKey: 'help.shortcuts.desc.newTask',
    group: 'global',
  },

  /* ---------- 分支 5：Mod+B 折叠左侧栏 ---------- */
  {
    id: 'nav.toggleLeft',
    chord: 'Mod+B',
    priority: 0,
    titleKey: 'help.shortcuts.desc.sidebar',
    group: 'global',
  },

  /* ---------- 分支 6：Mod+J 折叠右侧栏 ---------- */
  {
    id: 'inspector.toggleRight',
    chord: 'Mod+J',
    priority: 0,
    titleKey: 'help.shortcuts.desc.inspector',
    group: 'global',
  },

  /* ---------- 分支 7：Mod+E 浮窗开关 ---------- */
  {
    id: 'preview.toggle',
    chord: 'Mod+E',
    priority: 0,
    titleKey: 'help.shortcuts.desc.preview',
    group: 'global',
  },

  /* ---------- 分支 8：Mod+, 设置页 ---------- */
  {
    id: 'module.settings',
    chord: 'Mod+,',
    priority: 0,
    titleKey: 'help.shortcuts.desc.settings',
    group: 'global',
  },

  /* ---------- 分支 9：Mod+Shift+W 工作区切换器 ---------- */
  {
    id: 'workspace.switcher',
    chord: 'Mod+Shift+W',
    priority: 0,
    titleKey: 'help.shortcuts.desc.workspace',
    group: 'global',
  },

  /* ---------- 分支 10：Mod+1~6 能力入口（顺序即 Sidebar 顺序） ---------- */
  { id: 'module.goto.agents', chord: 'Mod+1', priority: 0, titleKey: 'help.shortcuts.desc.agents', group: 'global' },
  { id: 'module.goto.skills', chord: 'Mod+2', priority: 0, titleKey: 'help.shortcuts.desc.skills', group: 'global' },
  { id: 'module.goto.kb', chord: 'Mod+3', priority: 0, titleKey: 'help.shortcuts.desc.kb', group: 'global' },
  { id: 'module.goto.memory', chord: 'Mod+4', priority: 0, titleKey: 'help.shortcuts.desc.memory', group: 'global' },
  {
    id: 'module.goto.automations',
    chord: 'Mod+5',
    priority: 0,
    titleKey: 'help.shortcuts.desc.automations',
    group: 'global',
  },
  {
    id: 'module.goto.settings',
    chord: 'Mod+6',
    priority: 0,
    titleKey: 'help.shortcuts.desc.settingsModule',
    group: 'global',
  },

  /* ---------- 分支 11：Alt+1~6 Inspector 直达 ----------
   * 第 6 项（终端）迁移前**有实现但帮助表漏列** —— 本版补上，属显示修正而非行为变更。 */
  {
    id: 'inspector.tab.todos',
    chord: 'Alt+1',
    priority: 0,
    titleKey: 'help.shortcuts.desc.inspTodos',
    group: 'inspector',
  },
  {
    id: 'inspector.tab.context',
    chord: 'Alt+2',
    priority: 0,
    titleKey: 'help.shortcuts.desc.inspContext',
    group: 'inspector',
  },
  {
    id: 'inspector.tab.files',
    chord: 'Alt+3',
    priority: 0,
    titleKey: 'help.shortcuts.desc.inspFiles',
    group: 'inspector',
  },
  {
    id: 'inspector.tab.logs',
    chord: 'Alt+4',
    priority: 0,
    titleKey: 'help.shortcuts.desc.inspLogs',
    group: 'inspector',
  },
  {
    id: 'inspector.tab.browser',
    chord: 'Alt+5',
    priority: 0,
    titleKey: 'help.shortcuts.desc.inspBrowser',
    group: 'inspector',
  },
  {
    id: 'inspector.tab.terminal',
    chord: 'Alt+6',
    priority: 0,
    titleKey: 'help.shortcuts.desc.inspTerminal',
    group: 'inspector',
  },

  /* ---------- 分支 12：Shift+Tab 权限模式循环 ----------
   * 迁移前同样未进帮助表；本版补列（C-27：全部键位在帮助中心可见且与实际一致）。 */
  {
    id: 'permission.cycle',
    chord: 'Shift+Tab',
    priority: 0,
    titleKey: 'help.shortcuts.desc.permissionCycle',
    group: 'global',
  },

  /* ---------- 分支 13：Escape 优先级关闭链 ----------
   * 单条声明、内部保留原有的 9 级优先级链（顺序即语义）——
   * 拆成多条反而会让「同一时刻只关闭一层」的保证依赖优先级排序，更脆。 */
  {
    id: 'overlay.escape',
    chord: 'Escape',
    priority: -100,
    titleKey: 'help.shortcuts.desc.esc',
    group: 'global',
  },
] as const satisfies readonly KeybindingSpec[]

/**
 * 键位 id 的**字面量联合**（由 `as const` 推导）。
 *
 * 价值：`actions.ts` 用 `Record<KeymapId, handler>` 声明处理函数表，
 * 于是「声明了却没实现」在 **typecheck 阶段**就失败 —— 不必等到运行时抛错。
 */
export type KeymapId = (typeof KEYMAP_SPEC)[number]['id']

/**
 * **后续批次已裁决、当前尚未占用**的和弦（`03-interaction` §5.5）。
 *
 * 存在的意义：让「键位已被裁决」这件事在代码里可断言 ——
 * 本版新增任何键位若撞上这张表，测试当场失败，而不是等到 B2/B3 才发现抢了别人的键。
 */
export const RESERVED_CHORDS: readonly { chord: Chord; batch: string; actionKey: string }[] = [
  // B2 编辑器
  { chord: 'Mod+S', batch: 'B2', actionKey: 'editor.save' },
  { chord: 'Alt+Mod+S', batch: 'B2', actionKey: 'editor.saveAll' },
  { chord: 'Mod+F', batch: 'B2', actionKey: 'editor.find' },
  { chord: 'Alt+Mod+F', batch: 'B2', actionKey: 'editor.replace' },
  { chord: 'Mod+D', batch: 'B2', actionKey: 'editor.selectNextOccurrence' },
  { chord: 'Mod+Shift+K', batch: 'B2', actionKey: 'editor.deleteLine' },
  { chord: 'Alt+ArrowUp', batch: 'B2', actionKey: 'editor.moveLineUp' },
  { chord: 'Alt+ArrowDown', batch: 'B2', actionKey: 'editor.moveLineDown' },
  { chord: 'Shift+Alt+ArrowUp', batch: 'B2', actionKey: 'editor.copyLineUp' },
  { chord: 'Shift+Alt+ArrowDown', batch: 'B2', actionKey: 'editor.copyLineDown' },
  { chord: 'Ctrl+G', batch: 'B2', actionKey: 'editor.gotoLine' },
  { chord: 'F2', batch: 'B2', actionKey: 'editor.nextDiagnostic' },
  { chord: 'Shift+F2', batch: 'B2', actionKey: 'editor.prevDiagnostic' },
  // B0 声明但依赖后续批次的能力（命令面板含编辑域命令 / 新建文件 / 关闭 Tab）
  { chord: 'Mod+Shift+P', batch: 'B4', actionKey: 'palette.command' },
  { chord: 'Mod+Shift+N', batch: 'B5', actionKey: 'files.newFile' },
  { chord: 'Mod+W', batch: 'B2', actionKey: 'preview.closeTab' },
  // B3 交互区
  { chord: 'Mod+Shift+1', batch: 'B3', actionKey: 'flow.viewCompact' },
  { chord: 'Mod+Shift+2', batch: 'B3', actionKey: 'flow.viewStandard' },
  { chord: 'Mod+Shift+3', batch: 'B3', actionKey: 'flow.viewVerbose' },
  { chord: 'Mod+Shift+T', batch: 'B3', actionKey: 'flow.toggleThinking' },
  { chord: 'Mod+Shift+E', batch: 'B3', actionKey: 'flow.toggleTurn' },
  { chord: 'Mod+Shift+ArrowUp', batch: 'B3', actionKey: 'flow.prevTurn' },
  { chord: 'Mod+Shift+ArrowDown', batch: 'B3', actionKey: 'flow.nextTurn' },
  { chord: 'Mod+ArrowUp', batch: 'B3', actionKey: 'flow.blockNavUp' },
  { chord: 'Mod+ArrowDown', batch: 'B3', actionKey: 'flow.blockNavDown' },
  { chord: 'Mod+Shift+O', batch: 'B3', actionKey: 'flow.toggleBlock' },
  // B4 交互区收敛键
  { chord: 'Mod+Shift+C', batch: 'B4', actionKey: 'flow.copyBlockResult' },
  { chord: 'Mod+Shift+R', batch: 'B4', actionKey: 'flow.retryBlock' },
  { chord: 'Mod+Shift+G', batch: 'B4', actionKey: 'flow.gotoInspectorPanel' },
  { chord: 'Mod+Shift+J', batch: 'B4', actionKey: 'flow.gotoRunningBlock' },
  { chord: 'Mod+Shift+L', batch: 'B4', actionKey: 'flow.gotoFailedBlock' },
  { chord: 'Mod+Shift+Y', batch: 'B4', actionKey: 'flow.copyTurnMarkdown' },
  // P2（登记以显式"已裁决、本版不做"）
  { chord: 'Mod+Shift+F', batch: 'P2', actionKey: 'flow.search' },
]

/**
 * **刻意共享**的和弦：同一个物理按键在不同上下文下指向不同动作，
 * 由 `when` + `priority` 消歧（`03-interaction` §5.4 裁决 ①）。
 *
 * 测试用它断言「注册表确实支持窄作用域覆盖宽作用域」，
 * 这样 B2 只需加一条高优先级声明即可接管，不需要改注册表实现。
 */
export const PLANNED_SHARED_CHORDS: readonly {
  chord: Chord
  /** 当前（B0）持有者 */
  currentId: string
  /** 后续批次的接管者与其 `when` 条件 */
  takeover: { batch: string; when: readonly string[]; noteKey: string }
}[] = [
  {
    chord: 'Mod+/',
    currentId: 'help.toggle',
    takeover: {
      batch: 'B2',
      when: ['editorFocused'],
      noteKey: 'editor.toggleLineComment',
    },
  },
]

/** 迁移前的 13 个分支 → 本表 id 的对应关系（用于完备性断言与人工对账） */
export const MIGRATED_BRANCHES: readonly { branch: number; before: string; ids: readonly string[] }[] = [
  { branch: 1, before: 'meta && !alt && !shift && (key==="?" || key==="/")', ids: ['help.toggle', 'help.toggleAlt'] },
  { branch: 2, before: 'meta && key==="k"', ids: ['palette.quickAction'] },
  { branch: 3, before: 'meta && key==="p" && !shift', ids: ['quickOpen.toggle'] },
  { branch: 4, before: 'meta && key==="n" && !shift', ids: ['task.new'] },
  { branch: 5, before: 'meta && key==="b"', ids: ['nav.toggleLeft'] },
  { branch: 6, before: 'meta && key==="j"', ids: ['inspector.toggleRight'] },
  { branch: 7, before: 'meta && key==="e"', ids: ['preview.toggle'] },
  { branch: 8, before: 'meta && key===","', ids: ['module.settings'] },
  { branch: 9, before: 'meta && key==="w" && shift', ids: ['workspace.switcher'] },
  {
    branch: 10,
    before: 'meta && !alt && /^[1-6]$/',
    ids: [
      'module.goto.agents',
      'module.goto.skills',
      'module.goto.kb',
      'module.goto.memory',
      'module.goto.automations',
      'module.goto.settings',
    ],
  },
  {
    branch: 11,
    before: 'alt && !meta && /^[1-6]$/',
    ids: [
      'inspector.tab.todos',
      'inspector.tab.context',
      'inspector.tab.files',
      'inspector.tab.logs',
      'inspector.tab.browser',
      'inspector.tab.terminal',
    ],
  },
  { branch: 12, before: 'key==="Tab" && shift && !meta && !ctrl && !alt', ids: ['permission.cycle'] },
  { branch: 13, before: 'key==="Escape"', ids: ['overlay.escape'] },
]
