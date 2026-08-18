/* ============================================================
 * ArkWork — HelpCenter (Task 14)
 * 完整帮助系统：覆盖工作区 / 任务 / 并行执行 / 对话流 / 智能体 /
 * 技能 / 知识库 / 记忆 L1–L4 / 自动化 / Inspector / 模型设置 /
 * 快捷键总表 / 隐私与本地存储。每章末尾提供「现在去试试」跳转
 * 入口，复用 store.openModulePage / selectTask / setInspectorTab
 * / setCmdPaletteOpen / setQuickOpenOpen 等已有动作。
 *
 * 入口：⌘? 全局快捷键；Sidebar 底部"帮助"按钮；
 * ModulePage / 任务对话顶部也可直接挂载。
 *
 * 视觉：与 ModulePage 同一族（页面化 + 统一头部 + 关闭按钮）。
 * 关闭优先级由 App.tsx 的 Esc 链处理。
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type ModulePage } from '../store'
import { Icon, type IconName } from '../icons'
import { Tooltip } from './ui'

/* ============================================================
 * 类型与元数据
 * ============================================================ */
type HelpAction =
  | { kind: 'module'; page: ModulePage; label: string }
  | { kind: 'inspector'; tab: 'todos' | 'context' | 'files' | 'logs' | 'browser'; label: string }
  | { kind: 'workspace'; label: string }
  | { kind: 'quickAction'; label: string }
  | { kind: 'quickOpen'; label: string }
  | { kind: 'composer'; label: string }
  | { kind: 'newTask'; label: string }
  | { kind: 'kbOff'; label: string }
  | { kind: 'kbOn'; label: string }

interface HelpSection {
  id: string
  title: string
  icon: IconName
  summary: string
  bullets: string[]
  actions: HelpAction[]
}

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '⌘K', desc: 'Quick Action（搜索 / 命令 / @ 提及 / # 话题）' },
  { keys: '⌘P', desc: 'QuickOpen：按名字跳转到任务、文件、技能' },
  { keys: '⌘N', desc: '新建任务并聚焦到 Composer' },
  { keys: '⌘B', desc: '折叠 / 展开左侧 Sidebar' },
  { keys: '⌘J', desc: '折叠 / 展开右侧 Inspector' },
  { keys: '⌘E', desc: '开关 PreviewWindow 浮窗' },
  { keys: '⌘,', desc: '打开设置（页面化）' },
  { keys: '⌘?', desc: '打开 / 关闭 HelpCenter（本页）' },
  { keys: '⌘/', desc: '打开 / 关闭 HelpCenter（备选快捷键）' },
  { keys: '⌘⇧W', desc: '打开工作区切换器' },
  { keys: '⌘1', desc: '智能体（Agents）' },
  { keys: '⌘2', desc: '技能（Skills）' },
  { keys: '⌘3', desc: '知识库（KB）' },
  { keys: '⌘4', desc: '记忆（Memory）' },
  { keys: '⌘5', desc: '自动化（Automations）' },
  { keys: '⌘6', desc: '设置（Settings）' },
  { keys: '⌥1', desc: 'Inspector：清单（Todos）' },
  { keys: '⌥2', desc: 'Inspector：上下文（Context）' },
  { keys: '⌥3', desc: 'Inspector：文件（Files）' },
  { keys: '⌥4', desc: 'Inspector：日志（Logs）' },
  { keys: '⌥5', desc: 'Inspector：浏览器（Browser）' },
  { keys: 'Esc', desc: '按优先级关闭浮层 / ModulePage / Inspector' },
]

const SECTIONS: HelpSection[] = [
  {
    id: 'workspace',
    title: '工作区',
    icon: 'Workspace',
    summary: '左侧栏显示当前工作区、任务线程、能力入口与搜索；折叠态保留 64px 图标栏。',
    bullets: [
      '顶部主按钮"新建任务"直达对话。',
      'Threads 默认按 Pinned / Today / This week / Earlier 分组，全部折叠以减少视觉噪声。',
      '能力入口（智能体 / 技能 / 知识 / 记忆 / 自动化 / 设置）单击直达 ModulePage，重复点击保持打开。',
      '侧栏宽度 64–320px 之间可拖。',
    ],
    actions: [
      { kind: 'workspace', label: '打开工作区切换器' },
      { kind: 'module', page: 'settings', label: '打开设置页（外观 / 工作区）' },
      { kind: 'newTask', label: '新建任务' },
    ],
  },
  {
    id: 'tasks',
    title: '任务',
    icon: 'List',
    summary: '任务是 ArkWork 的最小协作单元：一个任务 = 一段对话 + 计划 + 文件上下文 + 历史步骤。',
    bullets: [
      '新建任务后 Composer 自动聚焦；输入回车即开始第一轮执行，标题自动取首条消息简化生成。',
      'Threads 行 ⋯ 菜单支持重命名、运行 / 停止、收藏、删除。',
      '失败 / 取消的步骤可单独"重新运行"；历史消息与文件保留。',
      '任务级知识库开关：每个任务可独立启用 KB 检索（不依赖全局）。',
    ],
    actions: [
      { kind: 'newTask', label: '新建一个任务试试' },
      { kind: 'composer', label: '聚焦 Composer' },
    ],
  },
  {
    id: 'parallel',
    title: '并行执行',
    icon: 'Bolt',
    summary: '无依赖的多次工具调用会被自动并行发起，进度按工具维度独立展示，不会互相覆盖。',
    bullets: [
      '同一 Agent 一次推理中可触发多个工具调用，引擎并发执行。',
      '前后依赖（写入后再读取）仍按串行语料执行，避免竞态。',
      '计划卡 / 右侧清单共享同一份 planItems 数据源，杜绝"提前勾完"。',
    ],
    actions: [
      { kind: 'inspector', tab: 'todos', label: '打开 Inspector · 清单' },
      { kind: 'inspector', tab: 'logs', label: '打开 Inspector · 日志' },
    ],
  },
  {
    id: 'conversation',
    title: '对话流',
    icon: 'Command',
    summary: '对话流承载用户消息、计划、工具调用结果与 Agent 回复；可滚动、可锁定焦点。',
    bullets: [
      '用户消息与 Agent 回复的文本块默认按时间倒序堆叠；工具调用以"折叠卡片"展示。',
      '当 Agent 正在执行时，对话顶部出现"正在运行命令…"等人类可读描述（按工具类型映射）。',
      'Composer 支持多行输入；长任务可暂停 / 继续 / 取消。',
    ],
    actions: [
      { kind: 'composer', label: '聚焦 Composer' },
      { kind: 'newTask', label: '新建任务开始一段对话' },
    ],
  },
  {
    id: 'agents',
    title: '智能体',
    icon: 'Bot',
    summary: '智能体（Agent）= 人格 + 默认模型 + 启用技能 + Dock 偏好。可创建、编辑、复制。',
    bullets: [
      '智能体页展示所有 Agent，每条带：图标、人格摘要、模型、已启用技能数、Dock 预设。',
      '新建 / 编辑打开 AgentEditor 表单：人格提示词、默认模型、可用技能、Dock 布局。',
      '切换 Agent 会自动应用其 Dock 偏好；状态栏短暂显示一次提示条。',
    ],
    actions: [
      { kind: 'module', page: 'agents', label: '打开智能体页面' },
    ],
  },
  {
    id: 'skills',
    title: '技能（内置 / 市场 / 已导入）',
    icon: 'Bolt',
    summary: '技能按来源分类为三组，每组有独立徽标与数量角标；导入来源可追溯。',
    bullets: [
      '内置：ArkWork 自带技能，不可删除；用于 shell / 文件读取 / KB 查询等基础能力。',
      '市场：从 SkillHub 安装的技能，可更新 / 移除；已安装项展示在「市场 Tab」已安装区。',
      '已导入：本地文件导入或外部 MCP 接入技能，含来源字段。',
      '从 zip 导入时整个 zip 内容（所有 .md / 子目录文件）都会被解压到 Skill 文件夹。',
    ],
    actions: [
      { kind: 'module', page: 'skills', label: '打开能力中心' },
    ],
  },
  {
    id: 'kb',
    title: '知识库',
    icon: 'Book',
    summary: '把 PDF / TXT / Markdown / DOCX 解析为可检索文本（SQLite FTS5），kb_query 工具调用命中片段。',
    bullets: [
      '支持文档解析中 / 已索引 / 失败三态；失败可在 KB 页面一键重试。',
      '提供"会话级 + 全局级"双层 KB 开关：关闭后 kb-search 不注入上下文，无需重启。',
      '命中片段可在 Inspector · 上下文面板与文件面板查看。',
    ],
    actions: [
      { kind: 'module', page: 'kb', label: '打开知识库页面' },
      { kind: 'kbOff', label: '关闭全局 KB（演示开关）' },
      { kind: 'kbOn', label: '重新启用全局 KB' },
    ],
  },
  {
    id: 'memory',
    title: '记忆 L1 – L4',
    icon: 'Brain',
    summary: 'ArkWork 维护四层记忆，自动蒸馏晋升，原始层会自动清理。',
    bullets: [
      'L1 工作记忆：当轮对话上下文内的临时条目。',
      'L2 文件记忆：会话内抽取的事实、引用、命令记录。',
      'L3 策展记忆：跨会话的主题 / 复用片段，可被搜索并注入。',
      'L4 画像记忆：长期用户偏好与角色画像，慢变量更新。',
      '满足门槛（主题计数 / 复用次数 / L2 体积）会自动蒸馏；UI 中"手动转知识库"已下线。',
    ],
    actions: [
      { kind: 'module', page: 'memory', label: '打开记忆页面' },
    ],
  },
  {
    id: 'automations',
    title: '自动化',
    icon: 'Clock',
    summary: '定时或手动触发的 Agent 任务；支持闹钟式频率选择 + 自定义 cron。',
    bullets: [
      '在自动化页面创建 / 编辑 / 删除；命中触发时间后会进入任务队列。',
      '执行结果会回写到对应任务的对话流，便于回看。',
      '自动化执行期间的状态可在状态栏右下角"运行中"指示器实时反映。',
    ],
    actions: [
      { kind: 'module', page: 'automations', label: '打开自动化页面' },
    ],
  },
  {
    id: 'inspector',
    title: 'Inspector',
    icon: 'Graph',
    summary: '右侧五固定 Tab：清单 / 上下文 / 文件 / 日志 / 浏览器。',
    bullets: [
      '当前激活标签再点击可折叠；折叠后任意标签再次点击能重新展开（不再"卡住"）。',
      '清单：实时同步 planItems，状态源唯一。',
      '上下文：只读展示当前任务注入的 KB / 记忆片段与 token 预算；L2 起可在记忆中心编辑。',
      '文件：工作区文件浏览（不再保留假"收藏"按钮）。',
      '日志：工具调用 / 权限 / 错误流水；可一键复制。',
      '浏览器：内嵌 BrowserPanel 与 PreviewWindow 联动。',
    ],
    actions: [
      { kind: 'inspector', tab: 'todos', label: '打开清单' },
      { kind: 'inspector', tab: 'context', label: '打开上下文' },
      { kind: 'inspector', tab: 'files', label: '打开文件' },
      { kind: 'inspector', tab: 'logs', label: '打开日志' },
      { kind: 'inspector', tab: 'browser', label: '打开浏览器' },
    ],
  },
  {
    id: 'models',
    title: '模型 / 设置',
    icon: 'Settings',
    summary: '设置页五分区：模型 / 工作区 / 外观 / 快捷键 / 高级。',
    bullets: [
      '模型：选择默认 / 备用模型，配置 API Key；支持 OpenAI、Anthropic、本地 Ollama。',
      '工作区：选择工作区根目录、默认 KB、文件忽略规则。',
      '外观：主题（浅 / 深 / 跟随系统）+ 字体密度。',
      '快捷键：当前所有快捷键只读总表（与 HelpCenter 同步）。',
      '高级：实验性开关、日志级别、自动更新通道。',
      '当前模型仅在 Composer 唯一展示，其他位置（TopBar / StatusBar / 任务头）已收敛。',
    ],
    actions: [
      { kind: 'module', page: 'settings', label: '打开设置' },
    ],
  },
  {
    id: 'privacy',
    title: '隐私 / 本地存储',
    icon: 'Lock',
    summary: 'ArkWork 默认本地优先：任务 / 对话 / 记忆落本地 JSON，知识库索引落本地 SQLite（FTS5）与文件系统。',
    bullets: [
      '数据目录：开发态 userData 重定向到 app/.dev-data；打包态在系统 userData（macOS：~/Library/Application Support/ArkWork）。',
      '应用数据根目录为 {userData}/arkwork-data：任务 / 智能体 / 技能 / 模型 / 记忆均以 JSON 持久化于此。',
      '当前工作区：{userData}/arkwork-data/workspace/default（可在设置 · 工作区切换）；任务记忆位于 {workspaceDir}/.arkwork/memory/{taskId}。',
      '模型调用由用户显式配置的 API Key 发起；ArkWork 不上传你的对话内容。',
      '一键导出 / 清空工作区数据；所有变更可在设置 → 高级找到入口。',
    ],
    actions: [
      { kind: 'module', page: 'settings', label: '打开设置 · 高级' },
    ],
  },
]

/* ============================================================
 * 入口组件：HelpCenter
 * - 全局浮层（与 ModulePage 同视觉族，但浮于其上）
 * - 提供目录（左侧）、章节正文（右侧）+ 快捷键总表
 * - 通过 store 内已有动作实现"现在去试试"跳转
 * ============================================================ */
export function HelpCenter() {
  const helpOpen = useStore((s) => s.helpOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  const [activeId, setActiveId] = useState<string>(SECTIONS[0]?.id ?? 'workspace')
  const contentRef = useRef<HTMLDivElement | null>(null)

  // 关闭路径：Esc 由 App.tsx 统一处理
  useEffect(() => {
    if (!helpOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setHelpOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [helpOpen, setHelpOpen])

  // 打开时把滚动锚点滚回顶部
  useEffect(() => {
    if (helpOpen) contentRef.current?.scrollTo({ top: 0 })
  }, [helpOpen])

  const active = useMemo(
    () => SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0],
    [activeId],
  )

  if (!helpOpen) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="ArkWork 帮助中心"
      data-testid="help-center"
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 backdrop-blur-sm"
      // Phase A Task 3：HelpCenter 背景不再点击关闭（防误触），仅 Esc 退出
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mt-12 mb-12 w-full max-w-[960px] mx-4 bg-bg-base text-text-primary border border-border-default rounded-xl shadow-panel overflow-hidden flex flex-col">
        {/* 统一头部：与 ModulePage 同款（图标 + 标题 + 说明 + 关闭按钮） */}
        <div className="relative flex items-center gap-3 h-14 pl-5 pr-3 border-b border-border-subtle flex-shrink-0 bg-bg-base">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-bg-surface border border-border-subtle text-accent flex-shrink-0">
            <Icon.Info width={17} height={17} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-text-primary truncate">ArkWork 帮助中心</h1>
            <p className="text-2xs text-text-tertiary truncate">覆盖全部主要功能 · ⌘? 打开 / 关闭</p>
          </div>
          {/* polish-workspace-task-title-skills-context-help §Task 6.2：X 按钮紧贴右边框 */}
          <Tooltip label="关闭帮助" kbd="Esc">
            <button
              onClick={() => setHelpOpen(false)}
              aria-label="关闭帮助"
              className="inline-flex items-center justify-center w-9 h-9 flex-shrink-0 rounded-lg border border-transparent text-text-tertiary hover:bg-bg-hover hover:border-border-subtle hover:text-text-primary transition-colors focus-ring"
            >
              <Icon.X width={16} height={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>

        {/* 主区域：左目录 + 右内容 */}
        <div className="flex-1 min-h-0 flex">
          {/* 目录 */}
          <nav
            aria-label="帮助目录"
            data-testid="help-index"
            className="w-56 flex-shrink-0 border-r border-border-subtle bg-bg-surface overflow-y-auto py-2"
          >
            <div className="px-3 pt-1 pb-2 text-2xs uppercase tracking-wider text-text-tertiary">
              目录
            </div>
            {SECTIONS.map((s) => {
              const isActive = s.id === active.id
              const ItemIcon = Icon[s.icon]
              return (
                <button
                  key={s.id}
                  data-section={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={`w-full flex items-center gap-2 h-8 px-3 text-xs text-left transition-colors focus-ring ${
                    isActive
                      ? 'bg-accent-soft text-accent'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                  aria-current={isActive ? 'true' : undefined}
                >
                  <ItemIcon width={14} height={14} aria-hidden="true" />
                  <span className="truncate">{s.title}</span>
                </button>
              )
            })}
            <div className="px-3 pt-3 pb-1 text-2xs uppercase tracking-wider text-text-tertiary">
              参考
            </div>
            <button
              data-section="shortcuts"
              onClick={() => setActiveId('shortcuts')}
              className={`w-full flex items-center gap-2 h-8 px-3 text-xs text-left transition-colors focus-ring ${
                activeId === 'shortcuts'
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
              aria-current={activeId === 'shortcuts' ? 'true' : undefined}
            >
              <Icon.Command width={14} height={14} aria-hidden="true" />
              <span className="truncate">快捷键</span>
            </button>
          </nav>

          {/* 内容 */}
          <div
            ref={contentRef}
            className="flex-1 min-w-0 overflow-y-auto"
            data-testid="help-content"
          >
            {/* polish3 §Task 2.5：activeId === 'shortcuts' 时渲染独立的快捷键总表视图；
                其他章节渲染章节正文 + 现在去试试，章节正文下方不再展示总表。 */}
            {activeId === 'shortcuts' ? (
              <article className="max-w-[720px] mx-auto px-8 py-8">
                <header className="flex items-baseline gap-2 mb-2">
                  <h2 className="text-lg font-semibold text-text-primary">快捷键总表</h2>
                  <span className="text-2xs text-text-tertiary tabular">全局快捷键参考</span>
                </header>
                <p className="text-sm text-text-secondary leading-relaxed mb-4">
                  ArkWork 全局可用的快捷键一览；按功能分组。
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {SHORTCUTS.map((s) => (
                    <div
                      key={s.keys}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-bg-surface border border-border-subtle"
                    >
                      <span className="text-xs text-text-secondary truncate">{s.desc}</span>
                      <kbd className="inline-flex items-center justify-center min-w-[40px] h-5 px-1.5 rounded-md text-[11px] font-medium bg-bg-elevated text-text-secondary border border-border-default flex-shrink-0">
                        {s.keys}
                      </kbd>
                    </div>
                  ))}
                </div>
                <p className="mt-8 text-2xs text-text-tertiary">
                  隐私 · ArkWork 默认本地优先。对话、记忆、知识库索引落本地 SQLite 与文件系统，模型调用由你在设置中显式配置的 API Key 发起。
                </p>
              </article>
            ) : (
              <article className="max-w-[720px] mx-auto px-8 py-8">
                <header className="flex items-baseline gap-2 mb-2">
                  <h2 className="text-lg font-semibold text-text-primary">{active.title}</h2>
                  <span className="text-2xs text-text-tertiary tabular">#{active.id}</span>
                </header>
                <p className="text-sm text-text-secondary leading-relaxed mb-4">
                  {active.summary}
                </p>
                <ul className="space-y-1.5 mb-6 list-disc pl-5 text-sm text-text-secondary leading-relaxed">
                  {active.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>

                {/* 现在去试试 */}
                <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
                  <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-text-tertiary mb-2">
                    <Icon.Play width={12} height={12} aria-hidden="true" />
                    现在去试试
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {active.actions.map((a, i) => (
                      <HelpActionButton key={i} action={a} onClose={() => setHelpOpen(false)} />
                    ))}
                  </div>
                </div>

                {/* polish3 §Task 2.5：快捷键总表已不再附在章节正文末尾；改为独立章节，
                    通过左侧目录「快捷键」项访问。 */}
                <p className="mt-10 text-2xs text-text-tertiary">
                  隐私 · ArkWork 默认本地优先。对话、记忆、知识库索引落本地 SQLite 与文件系统，模型调用由你在设置中显式配置的 API Key 发起。
                </p>
              </article>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * HelpActionButton — 把章节内的"现在去试试"动作映射到 store 行为
 * ============================================================ */
function HelpActionButton({
  action,
  onClose,
}: {
  action: HelpAction
  onClose: () => void
}) {
  const openModulePage = useStore((s) => s.openModulePage)
  const setInspectorTab = useStore((s) => s.setInspectorTab)
  const toggleRightDock = useStore((s) => s.toggleRightDock)
  const setCmdPaletteOpen = useStore((s) => s.setCmdPaletteOpen)
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen)
  const createTask = useStore((s) => s.createTask)
  const globalKbEnabled = useStore((s) => s.globalKbEnabled)
  const setGlobalKbEnabled = useStore((s) => s.setGlobalKbEnabled)

  const onClick = () => {
    switch (action.kind) {
      case 'module':
        openModulePage(action.page)
        onClose()
        return
      case 'workspace':
        onClose()
        // 工作区切换器由 TopBar 监听 topbar:open-workspace 事件（与 ⌘⇧W 同路径）
        window.dispatchEvent(new CustomEvent('topbar:open-workspace'))
        return
      case 'inspector': {
        const s = useStore.getState()
        if (s.rightDockCollapsed) toggleRightDock()
        setInspectorTab(action.tab)
        onClose()
        return
      }
      case 'quickAction':
        setCmdPaletteOpen(true)
        onClose()
        return
      case 'quickOpen':
        setQuickOpenOpen(true)
        onClose()
        return
      case 'composer':
        onClose()
        // 聚焦由 App.tsx 监听 composer:focus 事件触发
        window.dispatchEvent(new Event('composer:focus'))
        return
      case 'newTask':
        onClose()
        void createTask({ title: '', text: '' }).then(() => {
          window.dispatchEvent(new Event('composer:focus'))
        })
        return
      case 'kbOff':
        if (globalKbEnabled) void setGlobalKbEnabled(false)
        onClose()
        return
      case 'kbOn':
        if (!globalKbEnabled) void setGlobalKbEnabled(true)
        onClose()
        return
    }
  }

  return (
    <button
      onClick={onClick}
      data-testid={`help-jump-${action.kind}`}
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium bg-accent hover:bg-accent-hover text-text-inverse transition-colors focus-ring"
    >
      <Icon.ArrowUp width={12} height={12} aria-hidden="true" className="-rotate-45" />
      <span>{action.label}</span>
    </button>
  )
}

/* ============================================================
 * 帮助入口按钮（挂在 Sidebar 底部 / TopBar 等位置）
 * 复用现有 'sidebar:open-help' CustomEvent 路径与 ⌘? 路径
 * ============================================================ */
export function openHelpCenter(): void {
  window.dispatchEvent(new CustomEvent('app:open-help'))
}
