/* ============================================================
 * ArkWork — Quick Action (v0.13.0)
 * ⌘K 四源搜索：Commands / Files / Skills / Agents
 * ============================================================ */
import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { Icon, type IconName } from '../icons'
import { Kbd } from './ui'
import type { FsNode } from '../types'

interface QuickItem {
  id: string
  label: string
  hint?: string
  shortcut?: string
  icon: IconName
  source: 'command' | 'file' | 'skill' | 'agent'
  action: () => void
}

type Source = 'all' | QuickItem['source']

function detectPrefix(query: string): { prefix: Source; term: string } {
  if (!query) return { prefix: 'all', term: '' }
  const first = query[0]
  const rest = query.slice(1)
  if (first === '/') return { prefix: 'command', term: rest }
  if (first === '>') return { prefix: 'file', term: rest }
  if (first === '@') return { prefix: 'skill', term: rest }
  if (first === '#') return { prefix: 'agent', term: rest }
  return { prefix: 'all', term: query }
}

function fuzzyScore(label: string, query: string): number {
  if (!query) return 0
  const candidate = label.toLowerCase()
  const target = query.toLowerCase()
  if (candidate.includes(target)) {
    let score = 100 - candidate.indexOf(target)
    if (candidate.startsWith(target)) score += 200
    return score
  }

  let targetIndex = 0
  let consecutive = 0
  let maxConsecutive = 0
  for (let i = 0; i < candidate.length && targetIndex < target.length; i++) {
    if (candidate[i] === target[targetIndex]) {
      targetIndex += 1
      consecutive += 1
      maxConsecutive = Math.max(maxConsecutive, consecutive)
    } else {
      consecutive = 0
    }
  }
  return targetIndex === target.length ? 10 + maxConsecutive * 5 : -1
}

function collectFiles(nodes: FsNode[]): FsNode[] {
  const result: FsNode[] = []
  const walk = (list: FsNode[]) => {
    for (const node of list) {
      if (node.type === 'file') result.push(node)
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}

export function QuickAction() {
  const { t } = useTranslation()
  const open = useStore((s) => s.cmdPaletteOpen)
  const setOpen = useStore((s) => s.setCmdPaletteOpen)
  const agents = useStore((s) => s.agents)
  const skills = useStore((s) => s.skills)
  const files = useStore((s) => s.files)
  const createTask = useStore((s) => s.createTask)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const openPreview = useStore((s) => s.openPreview)
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen)
  const toggleLeftNav = useStore((s) => s.toggleLeftNav)
  const toggleRightDock = useStore((s) => s.toggleRightDock)
  const openModulePage = useStore((s) => s.openModulePage)
  const closeModulePage = useStore((s) => s.closeModulePage)
  const exportConversation = useStore((s) => s.exportConversation)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()

  // 必须所有 hooks 都在条件 return 前（React Hooks 规则）
  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  const items = useMemo<QuickItem[]>(() => {
    const result: QuickItem[] = [
      {
        id: 'cmd-new-task',
        label: t('quickaction.commands.newTask'),
        shortcut: '⌘N',
        icon: 'Plus',
        source: 'command',
        action: () => {
          closeModulePage()
          void createTask({ title: '', text: '' }).then(() => {
            window.dispatchEvent(new Event('composer:focus'))
          })
        },
      },
      {
        id: 'cmd-quick-open',
        label: t('quickaction.commands.quickOpen'),
        shortcut: '⌘P',
        icon: 'File',
        source: 'command',
        action: () => setQuickOpenOpen(true),
      },
      {
        id: 'cmd-toggle-left',
        label: t('quickaction.commands.toggleLeft'),
        shortcut: '⌘B',
        icon: 'ChevronLeft',
        source: 'command',
        action: toggleLeftNav,
      },
      {
        id: 'cmd-toggle-right',
        label: t('quickaction.commands.toggleRight'),
        shortcut: '⌘J',
        icon: 'ChevronRight',
        source: 'command',
        action: toggleRightDock,
      },
      {
        id: 'cmd-open-settings',
        label: t('quickaction.commands.openSettings'),
        shortcut: '⌘,',
        icon: 'Settings',
        source: 'command',
        action: () => openModulePage('settings'),
      },
      {
        id: 'cmd-export',
        label: t('quickaction.commands.export'),
        icon: 'Download',
        source: 'command',
        action: exportConversation,
      },
      {
        id: 'cmd-return-task',
        label: t('quickaction.commands.returnTask'),
        icon: 'ChevronLeft',
        source: 'command',
        action: closeModulePage,
      },
    ]

    for (const agent of agents) {
      result.push({
        id: `agent-${agent.id}`,
        label: `@${agent.name}`,
        hint: agent.description,
        icon: 'Bot',
        source: 'agent',
        action: () => setSelectedAgent(agent.id),
      })
    }

    for (const skill of skills) {
      result.push({
        id: `skill-${skill.id}`,
        label: skill.name,
        hint: skill.description,
        icon: 'Bolt',
        source: 'skill',
        action: () => openModulePage('skills'),
      })
    }

    for (const file of collectFiles(files).slice(0, 50)) {
      result.push({
        id: `file-${file.path}`,
        label: file.name,
        hint: file.path,
        icon: 'File',
        source: 'file',
        action: () => void openPreview(file.path),
      })
    }

    return result
  }, [
    t,
    agents,
    skills,
    files,
    createTask,
    setSelectedAgent,
    openPreview,
    setQuickOpenOpen,
    toggleLeftNav,
    toggleRightDock,
    openModulePage,
    closeModulePage,
    exportConversation,
  ])

  const filtered = useMemo(() => {
    const { prefix, term } = detectPrefix(query)
    const pool = prefix === 'all' ? items : items.filter((item) => item.source === prefix)
    const target = term.trim()
    if (!target) return pool.slice(0, 50)

    return pool
      .map((item) => ({
        item,
        score: Math.max(
          fuzzyScore(item.label, target),
          item.hint ? fuzzyScore(item.hint, target) : -1,
        ),
      }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(({ item }) => item)
  }, [items, query])

  const { prefix } = detectPrefix(query)
  const grouped = useMemo(() => {
    const sections: Partial<Record<QuickItem['source'], QuickItem[]>> = {}
    const order: QuickItem['source'][] = prefix === 'all'
      ? ['command', 'file', 'skill', 'agent']
      : [prefix]

    for (const source of order) {
      const sectionItems = filtered.filter((item) => item.source === source)
      if (sectionItems.length > 0) sections[source] = sectionItems
    }
    return { sections, order }
  }, [filtered, prefix])

  useEffect(() => {
    setActiveIndex((current) => {
      if (filtered.length === 0) return 0
      return Math.min(current, filtered.length - 1)
    })
  }, [query, filtered.length])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => filtered.length === 0 ? 0 : Math.min(index + 1, filtered.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => Math.max(index - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        filtered[activeIndex]?.action()
        if (filtered[activeIndex]) setOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, filtered, activeIndex, setOpen])

  if (!open) return null

  const placeholderMap: Record<Source, string> = {
    all: t('quickaction.placeholder.all'),
    command: t('quickaction.placeholder.command'),
    file: t('quickaction.placeholder.file'),
    skill: t('quickaction.placeholder.skill'),
    agent: t('quickaction.placeholder.agent'),
  }
  const activeOptionId = filtered[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined

  const sourceLabel = (source: QuickItem['source']): string => {
    if (source === 'command') return t('quickaction.source.command')
    if (source === 'file') return t('quickaction.source.file')
    if (source === 'skill') return t('quickaction.source.skill')
    return t('quickaction.source.agent')
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      // Phase A Task 3：QuickAction 背景不再点击关闭（防误触），仅 Esc 退出
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick Action"
        className="w-[min(640px,calc(100vw-32px))] h-[480px] max-h-[480px] bg-bg-overlay border border-border-default rounded-lg shadow-panel flex flex-col overflow-hidden scale-in overscroll-contain"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle focus-within:ring-2 focus-within:ring-inset focus-within:ring-accent">
          <Icon.Search width={16} height={16} className="text-text-tertiary flex-shrink-0" aria-hidden="true" />
          <input
            autoFocus
            name="quick-action-query"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('quickaction.inputAriaLabel')}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholderMap[prefix]}
            className="min-w-0 flex-1 text-sm text-text-primary placeholder-text-tertiary bg-transparent"
          />
          <div className="hidden sm:flex items-center gap-1 text-2xs text-text-tertiary">
            <PrefixChip active={prefix === 'all'} onClick={() => setQuery('')}>{t('quickaction.prefix.all')}</PrefixChip>
            <PrefixChip active={prefix === 'command'} onClick={() => setQuery('/')}>{t('quickaction.prefix.command')}</PrefixChip>
            <PrefixChip active={prefix === 'file'} onClick={() => setQuery('>')}>{t('quickaction.prefix.file')}</PrefixChip>
            <PrefixChip active={prefix === 'skill'} onClick={() => setQuery('@')}>{t('quickaction.prefix.skill')}</PrefixChip>
            <PrefixChip active={prefix === 'agent'} onClick={() => setQuery('#')}>{t('quickaction.prefix.agent')}</PrefixChip>
          </div>
          <Kbd>Esc</Kbd>
        </div>

        <div id={listboxId} role="listbox" aria-label={t('quickaction.resultsAriaLabel')} className="flex-1 min-h-0 overflow-y-auto py-1 overscroll-contain">
          {grouped.order.map((section) => {
            const sectionItems = grouped.sections[section]
            if (!sectionItems) return null
            return (
              <div key={section} role="group" aria-label={sourceLabel(section)}>
                <div className="px-3 py-1 text-2xs text-text-tertiary uppercase tracking-wider font-medium">
                  {sourceLabel(section)}
                </div>
                {sectionItems.map((item) => {
                  const index = filtered.indexOf(item)
                  const active = index === activeIndex
                  const ItemIcon = Icon[item.icon]
                  return (
                    <button
                      id={`${listboxId}-option-${index}`}
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => {
                        item.action()
                        setOpen(false)
                      }}
                      className={`w-full min-h-8 flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors focus-ring ${
                        active ? 'bg-bg-active text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                      }`}
                    >
                      <ItemIcon width={16} height={16} className="flex-shrink-0" aria-hidden="true" />
                      <span className="flex-1 min-w-0 truncate">{item.label}</span>
                      {item.hint && (
                        <span className="text-2xs text-text-tertiary truncate max-w-[220px]">{item.hint}</span>
                      )}
                      {item.shortcut && (
                        <span className="text-2xs text-text-tertiary font-mono flex-shrink-0">{item.shortcut}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
          {filtered.length === 0 && (
            <div role="status" aria-live="polite" className="px-3 py-8 text-center text-sm text-text-tertiary break-words">
              {t('quickaction.noMatches', { query })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border-subtle text-2xs text-text-tertiary">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> {t('quickaction.footer.navigate')}</span>
          <span className="flex items-center gap-1"><Kbd>⏎</Kbd> {t('quickaction.footer.select')}</span>
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> {t('quickaction.footer.close')}</span>
          <span className="ml-auto tabular">{t('quickaction.footer.count', { count: filtered.length })}</span>
        </div>
      </div>
    </div>
  )
}

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
      type="button"
      onClick={onClick}
      className={`min-h-8 px-2 rounded-md transition-colors focus-ring ${
        active ? 'bg-accent-soft text-accent' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}