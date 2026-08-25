/* ============================================================
 * ArkWork — CommandPalette (v0.7.0 F722)
 * 升级：模糊匹配 + @ # / > 前缀语法
 *
 * 前缀语义：
 *   无前缀 — 全局模糊搜索（任务 / Agent / 命令 / 文件 / Skill）
 *   @      — 仅搜索 Agent
 *   #      — 仅搜索任务
 *   /      — 仅搜索命令（操作）
 *   >      — 仅搜索文件（参考 VSCode ⌘P 的 : 行号语义，这里用 > 表"前往文件"）
 *
 * 键盘：↑↓ 导航 / ⏎ 执行 / Esc 关闭
 * ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon, type IconName } from '../icons'
import { STATUS_LABEL } from '../constants'
import { useStore } from '../store'
import { ark } from '../ipc/client'
import { shortTaskId } from '../types'
import { Kbd } from './ui'
import type { FsNode } from '../types'

type SectionCode = 'command' | 'task' | 'agent' | 'file' | 'skill'

interface PaletteItem {
  id: string
  label: string
  hint?: string
  shortcut?: string
  icon?: IconName
  section: SectionCode
  action: () => void
}

/** 模糊匹配 + 评分（与 QuickOpen 一致） */
function fuzzyScore(label: string, query: string): number {
  if (!query) return 0
  const l = label.toLowerCase()
  const q = query.toLowerCase()
  if (l.includes(q)) {
    let score = 100 - l.indexOf(q)
    if (l.startsWith(q)) score += 200
    return score
  }
  let qi = 0
  let consecutive = 0
  let maxConsec = 0
  for (let i = 0; i < l.length && qi < q.length; i++) {
    if (l[i] === q[qi]) {
      qi++
      consecutive++
      maxConsec = Math.max(maxConsec, consecutive)
    } else {
      consecutive = 0
    }
  }
  return qi === q.length ? 10 + maxConsec * 5 : -1
}

/** 收集文件树中所有文件节点 */
function collectFiles(nodes: FsNode[]): FsNode[] {
  const out: FsNode[] = []
  const walk = (list: FsNode[]) => {
    for (const n of list) {
      if (n.type === 'file') out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

type Prefix = 'all' | 'agent' | 'task' | 'command' | 'file'

function detectPrefix(query: string): { prefix: Prefix; term: string } {
  if (!query) return { prefix: 'all', term: '' }
  const first = query[0]
  const rest = query.slice(1)
  if (first === '@') return { prefix: 'agent', term: rest }
  if (first === '#') return { prefix: 'task', term: rest }
  if (first === '/') return { prefix: 'command', term: rest }
  if (first === '>') return { prefix: 'file', term: rest }
  return { prefix: 'all', term: query }
}

export function CommandPalette() {
  const { t, i18n } = useTranslation()

  const prefixHint: Record<Prefix, string> = {
    all: t('palette.prefixHint.all'),
    agent: t('palette.prefixHint.agent'),
    task: t('palette.prefixHint.task'),
    command: t('palette.prefixHint.command'),
    file: t('palette.prefixHint.file'),
  }

  const sectionLabel: Record<SectionCode, string> = {
    command: t('palette.section.command'),
    task: t('palette.section.task'),
    agent: t('palette.section.agent'),
    file: t('palette.section.file'),
    skill: t('palette.section.skill'),
  }
  const cmdPaletteOpen = useStore((s) => s.cmdPaletteOpen)
  const setCmdPaletteOpen = useStore((s) => s.setCmdPaletteOpen)
  const selectTask = useStore((s) => s.selectTask)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const setSelectedActivity = useStore((s) => s.setActiveActivity)
  const toggleLeftNav = useStore((s) => s.toggleLeftNav)
  const toggleRightDock = useStore((s) => s.toggleRightDock)
  const openModulePage = useStore((s) => s.openModulePage)
  const closeModulePage = useStore((s) => s.closeModulePage)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const setSettingsTab = useStore((s) => s.setSettingsTab)
  const setCmdPaletteOpenState = useStore((s) => s.setCmdPaletteOpen)
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen)
  const openPreview = useStore((s) => s.openPreview)
  const storeTasks = useStore((s) => s.tasks)
  const storeAgents = useStore((s) => s.agents)
  const storeSkills = useStore((s) => s.skills)
  const storeFiles = useStore((s) => s.files)
  const createTask = useStore((s) => s.createTask)
  const exportConversation = useStore((s) => s.exportConversation)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  // 关闭时重置
  useEffect(() => {
    if (!cmdPaletteOpen) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [cmdPaletteOpen])

  // 构建全部候选项
  const allItems = useMemo<PaletteItem[]>(() => {
    const fileItems: PaletteItem[] = []
    const fileList = collectFiles(storeFiles)
    for (const f of fileList.slice(0, 50)) {
      fileItems.push({
        id: `file-${f.path}`,
        label: f.name,
        hint: f.path,
        icon: 'File',
        section: 'file',
        action: () => void openPreview(f.path),
      })
    }

    return [
      // 操作命令
      {
        id: 'new-task',
        label: t('palette.command.newTask'),
        shortcut: '⌘N',
        icon: 'Plus',
        section: 'command',
        action: () => void createTask({ title: '', text: '' }),
      },
      {
        id: 'quick-open',
        label: t('palette.command.quickOpen'),
        shortcut: '⌘P',
        icon: 'File',
        section: 'command',
        action: () => setQuickOpenOpen(true),
      },
      {
        id: 'toggle-leftnav',
        label: t('palette.command.toggleLeftNav'),
        shortcut: '⌘B',
        icon: 'List',
        section: 'command',
        action: () => toggleLeftNav(),
      },
      {
        id: 'toggle-rightdock',
        label: t('palette.command.toggleRightDock'),
        shortcut: '⌘J',
        icon: 'Box',
        section: 'command',
        action: () => toggleRightDock(),
      },
      {
        id: 'open-automations',
        label: t('palette.command.openAutomations'),
        shortcut: '⌘2',
        icon: 'Clock',
        section: 'command',
        action: () => openModulePage('automations'),
      },
      {
        id: 'open-skills',
        label: t('palette.command.openSkills'),
        shortcut: '⌘3',
        icon: 'Bolt',
        section: 'command',
        action: () => openModulePage('skills'),
      },
      {
        id: 'open-agents',
        label: t('palette.command.openAgents'),
        shortcut: '⌘4',
        icon: 'Bot',
        section: 'command',
        action: () => openModulePage('agents'),
      },
      {
        id: 'open-kb',
        label: t('palette.command.openKb'),
        shortcut: '⌘5',
        icon: 'Book',
        section: 'command',
        action: () => openModulePage('kb'),
      },
      {
        id: 'open-memory-page',
        label: t('palette.command.openMemory'),
        shortcut: '⌘6',
        icon: 'Brain',
        section: 'command',
        action: () => openModulePage('memory'),
      },
      {
        id: 'close-module',
        label: t('palette.command.backToTasks'),
        shortcut: '⌘1 / Esc',
        icon: 'ChevronLeft',
        section: 'command',
        action: () => closeModulePage(),
      },
      {
        id: 'open-memory',
        label: t('palette.command.openMemoryPanel'),
        icon: 'Brain',
        section: 'command',
        action: () => setSelectedActivity('memory'),
      },
      {
        id: 'open-files',
        label: t('palette.command.openFilesPanel'),
        icon: 'Folder',
        section: 'command',
        action: () => setSelectedActivity('files'),
      },
      {
        id: 'open-skills',
        label: t('palette.command.openSkillsPanel'),
        icon: 'Bolt',
        section: 'command',
        action: () => setSelectedActivity('skills'),
      },
      {
        id: 'open-tasks',
        label: t('palette.command.openTasksPanel'),
        icon: 'List',
        section: 'command',
        action: () => setSelectedActivity('tasks'),
      },
      {
        id: 'open-automations',
        label: t('palette.command.openAutomationsPanel'),
        icon: 'Clock',
        section: 'command',
        action: () => setSelectedActivity('automations'),
      },
      {
        id: 'export-conversation',
        label: t('palette.command.exportConversation'),
        icon: 'Download',
        section: 'command',
        action: () => exportConversation(),
      },
      {
        id: 'open-settings',
        label: t('palette.command.openSettings'),
        shortcut: '⌘,',
        icon: 'Settings',
        section: 'command',
        action: () => openModulePage('settings'),
      },
      {
        id: 'open-settings-models',
        label: t('palette.command.settingsModels'),
        icon: 'Settings',
        section: 'command',
        action: () => {
          setSettingsTab('models')
          openModulePage('settings')
        },
      },
      {
        id: 'open-settings-advanced',
        label: t('palette.command.settingsAdvanced'),
        icon: 'Settings',
        section: 'command',
        action: () => {
          setSettingsTab('advanced')
          openModulePage('settings')
        },
      },
      // 任务
      ...storeTasks.slice(0, 20).map((t) => ({
        id: `task-${t.id}`,
        label: t.title,
        hint: `${shortTaskId(t.id)} · ${STATUS_LABEL[t.status] ?? t.status}`,
        icon: 'List' as IconName,
        section: 'task',
        action: () => void selectTask(t.id),
      })),
      ...storeAgents.map((a) => ({
        id: `agent-${a.id}`,
        label: `@${a.name}`,
        hint: a.description,
        icon: 'Bot' as IconName,
        section: 'agent',
        action: () => setSelectedAgent(a.id),
      })),
      ...(['spec', 'plan', 'bugfix'] as const).map((id) => ({
        id: `slash-${id}`,
        label: `/${id}`,
        hint: t('palette.command.slashHint'),
        icon: 'Sparkle' as IconName,
        section: 'command',
        action: () => setQuery(`/${id}`),
      })),
      {
        id: 'single-attempt', label: t('palette.command.singleAttempt'), hint: t('palette.command.singleAttemptHint'), icon: 'Bolt' as IconName, section: 'command', action: () => undefined,
      },
      // Skill
      ...storeSkills.slice(0, 20).map((s) => ({
        id: `skill-${s.id}`,
        label: s.name,
        hint: s.description,
        icon: 'Sparkle' as IconName,
        section: 'skill',
        action: () => setSelectedActivity('skills'),
      })),
      // 文件
      ...fileItems,
    ] as PaletteItem[]
  }, [storeTasks, storeAgents, storeSkills, storeFiles, selectTask, setSelectedAgent, setSelectedActivity, toggleLeftNav, toggleRightDock, openModulePage, closeModulePage, setSettingsOpen, setSettingsTab, setQuickOpenOpen, openPreview, createTask, exportConversation, i18n.language])

  // 根据前缀过滤 + 模糊评分排序
  const filtered = useMemo(() => {
    const { prefix, term } = detectPrefix(query)
    let pool = allItems
    if (prefix === 'agent') pool = allItems.filter((i) => i.section === 'agent')
    else if (prefix === 'task') pool = allItems.filter((i) => i.section === 'task')
    else if (prefix === 'command') pool = allItems.filter((i) => i.section === 'command')
    else if (prefix === 'file') pool = allItems.filter((i) => i.section === 'file')

    const q = term.trim()
    if (!q) return pool.slice(0, 50)

    return pool
      .map((item) => {
        const score = Math.max(
          fuzzyScore(item.label, q),
          item.hint ? fuzzyScore(item.hint, q) : -1,
        )
        return { item, score }
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.item)
  }, [allItems, query])

  // 按 section 分组（保持过滤后的顺序）
  const sections = useMemo(() => {
    const acc: Record<string, PaletteItem[]> = {}
    for (const item of filtered) {
      ;(acc[item.section] ??= []).push(item)
    }
    return acc
  }, [filtered])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // 键盘导航
  useEffect(() => {
    if (!cmdPaletteOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setCmdPaletteOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        filtered[activeIndex]?.action()
        setCmdPaletteOpenState(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [cmdPaletteOpen, filtered, activeIndex, setCmdPaletteOpen, setCmdPaletteOpenState])

  if (!cmdPaletteOpen) return null

  const { prefix } = detectPrefix(query)
  const placeholder = prefixHint[prefix]

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      // Phase A Task 3：CommandPalette 背景不再点击关闭（防误触），仅 Esc 退出
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="w-[640px] max-h-[70vh] bg-bg-elevated border border-border-default rounded-lg shadow-lg flex flex-col overflow-hidden scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle">
          <Icon.Search width={16} height={16} className="text-text-tertiary" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            placeholder={placeholder}
            className="flex-1 text-sm text-text-primary placeholder-text-tertiary bg-transparent outline-none"
          />
          {/* 前缀提示 */}
          <div className="flex items-center gap-1 text-2xs text-text-tertiary">
            <PrefixChip active={prefix === 'all'} onClick={() => setQuery('')}>{t('palette.chip.all')}</PrefixChip>
            <PrefixChip active={prefix === 'agent'} onClick={() => setQuery('@')}>{t('palette.prefixHint.agent')}</PrefixChip>
            <PrefixChip active={prefix === 'task'} onClick={() => setQuery('#')}>{t('palette.prefixHint.task')}</PrefixChip>
            <PrefixChip active={prefix === 'command'} onClick={() => setQuery('/')}>{t('palette.prefixHint.command')}</PrefixChip>
            <PrefixChip active={prefix === 'file'} onClick={() => setQuery('>')}>{t('palette.prefixHint.file')}</PrefixChip>
          </div>
          <Kbd>Esc</Kbd>
        </div>

        {/* 结果 */}
        <div className="flex-1 overflow-y-auto py-1">
          {Object.entries(sections).map(([section, items]) => (
            <div key={section}>
              <div className="px-3 py-1 text-2xs text-text-tertiary uppercase tracking-wider font-medium">
                {sectionLabel[section as SectionCode]}
              </div>
              {items.map((item) => {
                const idx = filtered.indexOf(item)
                const active = idx === activeIndex
                const IconComp = item.icon ? Icon[item.icon] : null
                return (
                  <button
                    key={item.id}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => {
                      item.action()
                      setCmdPaletteOpen(false)
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      active ? 'bg-bg-active text-text-primary' : 'text-text-secondary hover:bg-bg-hover'
                    }`}
                  >
                    {IconComp && (
                      <IconComp width={16} height={16} className="text-text-tertiary flex-shrink-0" />
                    )}
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.hint && (
                      <span className="text-2xs text-text-tertiary truncate max-w-[200px]">{item.hint}</span>
                    )}
                    {item.shortcut && (
                      <span className="text-2xs text-text-tertiary font-mono">{item.shortcut}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-text-tertiary">
              {t('palette.empty', {
                agent: t('palette.prefixHint.agent'),
                task: t('palette.prefixHint.task'),
                command: t('palette.prefixHint.command'),
                file: t('palette.prefixHint.file'),
              })}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border-subtle text-2xs text-text-tertiary">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t('palette.footer.navigate')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⏎</Kbd>
            {t('palette.footer.select')}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t('palette.footer.close')}
          </span>
          <span className="ml-auto">
            {t('palette.footer.itemCount', { count: filtered.length, total: allItems.length })}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * PrefixChip — 前缀切换小标签
 * ============================================================ */
function PrefixChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-1.5 py-0.5 rounded transition-colors ${
        active
          ? 'bg-accent-soft text-accent'
          : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
