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
import { Icon, type IconName } from '../icons'
import { STATUS_LABEL } from '../constants'
import { useStore } from '../store'
import { ark } from '../ipc/client'
import { shortTaskId } from '../types'
import { Kbd } from './ui'
import type { FsNode } from '../types'

interface PaletteItem {
  id: string
  label: string
  hint?: string
  shortcut?: string
  icon?: IconName
  section: string
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

const PREFIX_HINT: Record<Prefix, string> = {
  all: '搜索任务、Agent、命令、文件、Skill…',
  agent: '@ Agent',
  task: '# 任务',
  command: '/ 命令',
  file: '> 文件',
}

export function CommandPalette() {
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
        section: '文件',
        action: () => void openPreview(f.path),
      })
    }

    return [
      // 操作命令
      {
        id: 'new-task',
        label: '新建任务',
        shortcut: '⌘N',
        icon: 'Plus',
        section: '命令',
        action: () => void createTask({ title: '', text: '' }),
      },
      {
        id: 'quick-open',
        label: '文件快速打开',
        shortcut: '⌘P',
        icon: 'File',
        section: '命令',
        action: () => setQuickOpenOpen(true),
      },
      {
        id: 'toggle-leftnav',
        label: '折叠/展开左栏',
        shortcut: '⌘B',
        icon: 'List',
        section: '命令',
        action: () => toggleLeftNav(),
      },
      {
        id: 'toggle-rightdock',
        label: '折叠/展开右栏',
        shortcut: '⌘J',
        icon: 'Box',
        section: '命令',
        action: () => toggleRightDock(),
      },
      {
        id: 'open-automations',
        label: '打开：自动化',
        shortcut: '⌘2',
        icon: 'Clock',
        section: '命令',
        action: () => openModulePage('automations'),
      },
      {
        id: 'open-skills',
        label: '打开：能力',
        shortcut: '⌘3',
        icon: 'Bolt',
        section: '命令',
        action: () => openModulePage('skills'),
      },
      {
        id: 'open-agents',
        label: '打开：智能体',
        shortcut: '⌘4',
        icon: 'Bot',
        section: '命令',
        action: () => openModulePage('agents'),
      },
      {
        id: 'open-kb',
        label: '打开：知识库',
        shortcut: '⌘5',
        icon: 'Book',
        section: '命令',
        action: () => openModulePage('kb'),
      },
      {
        id: 'open-memory-page',
        label: '打开：记忆',
        shortcut: '⌘6',
        icon: 'Brain',
        section: '命令',
        action: () => openModulePage('memory'),
      },
      {
        id: 'close-module',
        label: '返回任务',
        shortcut: '⌘1 / Esc',
        icon: 'ChevronLeft',
        section: '命令',
        action: () => closeModulePage(),
      },
      {
        id: 'open-memory',
        label: '打开记忆面板',
        icon: 'Brain',
        section: '命令',
        action: () => setSelectedActivity('memory'),
      },
      {
        id: 'open-files',
        label: '打开文件面板',
        icon: 'Folder',
        section: '命令',
        action: () => setSelectedActivity('files'),
      },
      {
        id: 'open-skills',
        label: '打开能力面板',
        icon: 'Bolt',
        section: '命令',
        action: () => setSelectedActivity('skills'),
      },
      {
        id: 'open-tasks',
        label: '打开任务面板',
        icon: 'List',
        section: '命令',
        action: () => setSelectedActivity('tasks'),
      },
      {
        id: 'open-automations',
        label: '打开自动化面板',
        icon: 'Clock',
        section: '命令',
        action: () => setSelectedActivity('automations'),
      },
      {
        id: 'export-conversation',
        label: '导出当前对话',
        icon: 'Download',
        section: '命令',
        action: () => exportConversation(),
      },
      {
        id: 'open-settings',
        label: '打开设置',
        shortcut: '⌘,',
        icon: 'Settings',
        section: '命令',
        action: () => openModulePage('settings'),
      },
      {
        id: 'open-settings-models',
        label: '设置 → 模型',
        icon: 'Settings',
        section: '命令',
        action: () => {
          setSettingsTab('models')
          openModulePage('settings')
        },
      },
      {
        id: 'open-settings-advanced',
        label: '设置 → 高级（压缩策略 / 开发者工具）',
        icon: 'Settings',
        section: '命令',
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
        section: '任务',
        action: () => void selectTask(t.id),
      })),
      ...storeAgents.map((a) => ({
        id: `agent-${a.id}`,
        label: `@${a.name}`,
        hint: a.description,
        icon: 'Bot' as IconName,
        section: 'Agent',
        action: () => setSelectedAgent(a.id),
      })),
      ...(['spec', 'plan', 'bugfix'] as const).map((id) => ({
        id: `slash-${id}`,
        label: `/${id}`,
        hint: '调用对应技能（跳过自动判定）',
        icon: 'Sparkle' as IconName,
        section: '命令',
        action: () => setQuery(`/${id}`),
      })),
      {
        id: 'single-attempt', label: '单 attempt 模式', hint: '占位：后续接入执行策略', icon: 'Bolt' as IconName, section: '命令', action: () => undefined,
      },
      // Skill
      ...storeSkills.slice(0, 20).map((s) => ({
        id: `skill-${s.id}`,
        label: s.name,
        hint: s.description,
        icon: 'Sparkle' as IconName,
        section: 'Skill',
        action: () => setSelectedActivity('skills'),
      })),
      // 文件
      ...fileItems,
    ]
  }, [storeTasks, storeAgents, storeSkills, storeFiles, selectTask, setSelectedAgent, setSelectedActivity, toggleLeftNav, toggleRightDock, openModulePage, closeModulePage, setSettingsOpen, setSettingsTab, setQuickOpenOpen, openPreview, createTask, exportConversation])

  // 根据前缀过滤 + 模糊评分排序
  const filtered = useMemo(() => {
    const { prefix, term } = detectPrefix(query)
    let pool = allItems
    if (prefix === 'agent') pool = allItems.filter((i) => i.section === 'Agent')
    else if (prefix === 'task') pool = allItems.filter((i) => i.section === '任务')
    else if (prefix === 'command') pool = allItems.filter((i) => i.section === '命令')
    else if (prefix === 'file') pool = allItems.filter((i) => i.section === '文件')

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
  const placeholder = PREFIX_HINT[prefix]

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
            <PrefixChip active={prefix === 'all'} onClick={() => setQuery('')}>全部</PrefixChip>
            <PrefixChip active={prefix === 'agent'} onClick={() => setQuery('@')}>@ Agent</PrefixChip>
            <PrefixChip active={prefix === 'task'} onClick={() => setQuery('#')}># 任务</PrefixChip>
            <PrefixChip active={prefix === 'command'} onClick={() => setQuery('/')}>/ 命令</PrefixChip>
            <PrefixChip active={prefix === 'file'} onClick={() => setQuery('>')}>&gt; 文件</PrefixChip>
          </div>
          <Kbd>Esc</Kbd>
        </div>

        {/* 结果 */}
        <div className="flex-1 overflow-y-auto py-1">
          {Object.entries(sections).map(([section, items]) => (
            <div key={section}>
              <div className="px-3 py-1 text-2xs text-text-tertiary uppercase tracking-wider font-medium">
                {section}
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
              无匹配项 — 试试前缀：@ Agent / # 任务 / / 命令 / &gt; 文件
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border-subtle text-2xs text-text-tertiary">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            导航
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⏎</Kbd>
            选择
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd>
            关闭
          </span>
          <span className="ml-auto">
            {filtered.length} / {allItems.length} 项
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
