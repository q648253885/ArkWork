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
import { useTranslation } from 'react-i18next'
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

interface ShortcutEntry {
  keys: string
  desc: string
}

/* ============================================================
 * 入口组件：HelpCenter
 * - 全局浮层（与 ModulePage 同视觉族，但浮于其上）
 * - 提供目录（左侧）、章节正文（右侧）+ 快捷键总表
 * - 通过 store 内已有动作实现"现在去试试"跳转
 * - 章节 / 快捷键数据在组件内用 t() 构建，确保语言切换重渲染
 * ============================================================ */
export function HelpCenter() {
  const { t } = useTranslation()

  const shortcuts: ShortcutEntry[] = [
    { keys: '⌘K', desc: t('help.shortcuts.desc.quickAction') },
    { keys: '⌘P', desc: t('help.shortcuts.desc.quickOpen') },
    { keys: '⌘N', desc: t('help.shortcuts.desc.newTask') },
    { keys: '⌘B', desc: t('help.shortcuts.desc.sidebar') },
    { keys: '⌘J', desc: t('help.shortcuts.desc.inspector') },
    { keys: '⌘E', desc: t('help.shortcuts.desc.preview') },
    { keys: '⌘,', desc: t('help.shortcuts.desc.settings') },
    { keys: '⌘?', desc: t('help.shortcuts.desc.help') },
    { keys: '⌘/', desc: t('help.shortcuts.desc.helpAlt') },
    { keys: '⌘⇧W', desc: t('help.shortcuts.desc.workspace') },
    { keys: '⌘1', desc: t('help.shortcuts.desc.agents') },
    { keys: '⌘2', desc: t('help.shortcuts.desc.skills') },
    { keys: '⌘3', desc: t('help.shortcuts.desc.kb') },
    { keys: '⌘4', desc: t('help.shortcuts.desc.memory') },
    { keys: '⌘5', desc: t('help.shortcuts.desc.automations') },
    { keys: '⌘6', desc: t('help.shortcuts.desc.settingsModule') },
    { keys: '⌥1', desc: t('help.shortcuts.desc.inspTodos') },
    { keys: '⌥2', desc: t('help.shortcuts.desc.inspContext') },
    { keys: '⌥3', desc: t('help.shortcuts.desc.inspFiles') },
    { keys: '⌥4', desc: t('help.shortcuts.desc.inspLogs') },
    { keys: '⌥5', desc: t('help.shortcuts.desc.inspBrowser') },
    { keys: 'Esc', desc: t('help.shortcuts.desc.esc') },
  ]

  const sections = useMemo<HelpSection[]>(
    () => [
      {
        id: 'workspace',
        title: t('help.sections.workspace.title'),
        icon: 'Workspace',
        summary: t('help.sections.workspace.summary'),
        bullets: [
          t('help.sections.workspace.bullets.0'),
          t('help.sections.workspace.bullets.1'),
          t('help.sections.workspace.bullets.2'),
          t('help.sections.workspace.bullets.3'),
        ],
        actions: [
          { kind: 'workspace', label: t('help.sections.workspace.actions.0') },
          { kind: 'module', page: 'settings', label: t('help.sections.workspace.actions.1') },
          { kind: 'newTask', label: t('help.sections.workspace.actions.2') },
        ],
      },
      {
        id: 'tasks',
        title: t('help.sections.tasks.title'),
        icon: 'List',
        summary: t('help.sections.tasks.summary'),
        bullets: [
          t('help.sections.tasks.bullets.0'),
          t('help.sections.tasks.bullets.1'),
          t('help.sections.tasks.bullets.2'),
          t('help.sections.tasks.bullets.3'),
        ],
        actions: [
          { kind: 'newTask', label: t('help.sections.tasks.actions.0') },
          { kind: 'composer', label: t('help.sections.tasks.actions.1') },
        ],
      },
      {
        id: 'parallel',
        title: t('help.sections.parallel.title'),
        icon: 'Bolt',
        summary: t('help.sections.parallel.summary'),
        bullets: [
          t('help.sections.parallel.bullets.0'),
          t('help.sections.parallel.bullets.1'),
          t('help.sections.parallel.bullets.2'),
        ],
        actions: [
          { kind: 'inspector', tab: 'todos', label: t('help.sections.parallel.actions.0') },
          { kind: 'inspector', tab: 'logs', label: t('help.sections.parallel.actions.1') },
        ],
      },
      {
        id: 'conversation',
        title: t('help.sections.conversation.title'),
        icon: 'Command',
        summary: t('help.sections.conversation.summary'),
        bullets: [
          t('help.sections.conversation.bullets.0'),
          t('help.sections.conversation.bullets.1'),
          t('help.sections.conversation.bullets.2'),
        ],
        actions: [
          { kind: 'composer', label: t('help.sections.conversation.actions.0') },
          { kind: 'newTask', label: t('help.sections.conversation.actions.1') },
        ],
      },
      {
        id: 'agents',
        title: t('help.sections.agents.title'),
        icon: 'Bot',
        summary: t('help.sections.agents.summary'),
        bullets: [
          t('help.sections.agents.bullets.0'),
          t('help.sections.agents.bullets.1'),
          t('help.sections.agents.bullets.2'),
        ],
        actions: [
          { kind: 'module', page: 'agents', label: t('help.sections.agents.actions.0') },
        ],
      },
      {
        id: 'skills',
        title: t('help.sections.skills.title'),
        icon: 'Bolt',
        summary: t('help.sections.skills.summary'),
        bullets: [
          t('help.sections.skills.bullets.0'),
          t('help.sections.skills.bullets.1'),
          t('help.sections.skills.bullets.2'),
          t('help.sections.skills.bullets.3'),
        ],
        actions: [
          { kind: 'module', page: 'skills', label: t('help.sections.skills.actions.0') },
        ],
      },
      {
        id: 'kb',
        title: t('help.sections.kb.title'),
        icon: 'Book',
        summary: t('help.sections.kb.summary'),
        bullets: [
          t('help.sections.kb.bullets.0'),
          t('help.sections.kb.bullets.1'),
          t('help.sections.kb.bullets.2'),
        ],
        actions: [
          { kind: 'module', page: 'kb', label: t('help.sections.kb.actions.0') },
          { kind: 'kbOff', label: t('help.sections.kb.actions.1') },
          { kind: 'kbOn', label: t('help.sections.kb.actions.2') },
        ],
      },
      {
        id: 'memory',
        title: t('help.sections.memory.title'),
        icon: 'Brain',
        summary: t('help.sections.memory.summary'),
        bullets: [
          t('help.sections.memory.bullets.0'),
          t('help.sections.memory.bullets.1'),
          t('help.sections.memory.bullets.2'),
          t('help.sections.memory.bullets.3'),
          t('help.sections.memory.bullets.4'),
        ],
        actions: [
          { kind: 'module', page: 'memory', label: t('help.sections.memory.actions.0') },
        ],
      },
      {
        id: 'automations',
        title: t('help.sections.automations.title'),
        icon: 'Clock',
        summary: t('help.sections.automations.summary'),
        bullets: [
          t('help.sections.automations.bullets.0'),
          t('help.sections.automations.bullets.1'),
          t('help.sections.automations.bullets.2'),
        ],
        actions: [
          { kind: 'module', page: 'automations', label: t('help.sections.automations.actions.0') },
        ],
      },
      {
        id: 'inspector',
        title: t('help.sections.inspector.title'),
        icon: 'Graph',
        summary: t('help.sections.inspector.summary'),
        bullets: [
          t('help.sections.inspector.bullets.0'),
          t('help.sections.inspector.bullets.1'),
          t('help.sections.inspector.bullets.2'),
          t('help.sections.inspector.bullets.3'),
          t('help.sections.inspector.bullets.4'),
          t('help.sections.inspector.bullets.5'),
        ],
        actions: [
          { kind: 'inspector', tab: 'todos', label: t('help.sections.inspector.actions.0') },
          { kind: 'inspector', tab: 'context', label: t('help.sections.inspector.actions.1') },
          { kind: 'inspector', tab: 'files', label: t('help.sections.inspector.actions.2') },
          { kind: 'inspector', tab: 'logs', label: t('help.sections.inspector.actions.3') },
          { kind: 'inspector', tab: 'browser', label: t('help.sections.inspector.actions.4') },
        ],
      },
      {
        id: 'models',
        title: t('help.sections.models.title'),
        icon: 'Settings',
        summary: t('help.sections.models.summary'),
        bullets: [
          t('help.sections.models.bullets.0'),
          t('help.sections.models.bullets.1'),
          t('help.sections.models.bullets.2'),
          t('help.sections.models.bullets.3'),
          t('help.sections.models.bullets.4'),
          t('help.sections.models.bullets.5'),
        ],
        actions: [
          { kind: 'module', page: 'settings', label: t('help.sections.models.actions.0') },
        ],
      },
      {
        id: 'privacy',
        title: t('help.sections.privacy.title'),
        icon: 'Lock',
        summary: t('help.sections.privacy.summary'),
        bullets: [
          t('help.sections.privacy.bullets.0'),
          t('help.sections.privacy.bullets.1'),
          t('help.sections.privacy.bullets.2'),
          t('help.sections.privacy.bullets.3'),
          t('help.sections.privacy.bullets.4'),
        ],
        actions: [
          { kind: 'module', page: 'settings', label: t('help.sections.privacy.actions.0') },
        ],
      },
    ],
    [t],
  )

  const helpOpen = useStore((s) => s.helpOpen)
  const setHelpOpen = useStore((s) => s.setHelpOpen)
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? 'workspace')
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
    () => sections.find((s) => s.id === activeId) ?? sections[0],
    [activeId, sections],
  )

  if (!helpOpen) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('help.title')}
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
            <h1 className="text-sm font-semibold text-text-primary truncate">{t('help.title')}</h1>
            <p className="text-2xs text-text-tertiary truncate">{t('help.subtitle')}</p>
          </div>
          {/* polish-workspace-task-title-skills-context-help §Task 6.2：X 按钮紧贴右边框 */}
          <Tooltip label={t('help.closeLabel')} kbd="Esc">
            <button
              onClick={() => setHelpOpen(false)}
              aria-label={t('help.closeLabel')}
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
            aria-label={t('help.dir.navAria')}
            data-testid="help-index"
            className="w-56 flex-shrink-0 border-r border-border-subtle bg-bg-surface overflow-y-auto py-2"
          >
            <div className="px-3 pt-1 pb-2 text-2xs uppercase tracking-wider text-text-tertiary">
              {t('help.dir.title')}
            </div>
            {sections.map((s) => {
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
              {t('help.dir.ref')}
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
              <span className="truncate">{t('help.dir.shortcuts')}</span>
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
                  <h2 className="text-lg font-semibold text-text-primary">{t('help.shortcuts.title')}</h2>
                  <span className="text-2xs text-text-tertiary tabular">{t('help.shortcuts.subtitle')}</span>
                </header>
                <p className="text-sm text-text-secondary leading-relaxed mb-4">
                  {t('help.shortcuts.desc')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {shortcuts.map((s) => (
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
                  {t('help.privacyFooter')}
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
                    {t('help.tryNow')}
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
                  {t('help.privacyFooter')}
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