/* ============================================================
 * ArkWork — TasksPanel (v0.7.0)
 * 任务列表面板：复用 LeftRail 任务列表逻辑，重构为干净面板版
 * - 顶部：搜索输入 + 新建任务
 * - 时间分组：今天 / 更早
 * - 任务行：状态指示 + 标题 + 时间 + 右键菜单（收藏/重命名/停止/删除）
 * ============================================================ */
import { useMemo, useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { STATUS_COLOR, STATUS_CHAR, STATUS_LABEL, PULSE_STATUS } from '../../constants'
import { formatUpdatedAt } from '../../types'
import type { Task, TaskStatus } from '../../types'
import { Tooltip, EmptyState } from '../ui'
import { useTranslation } from 'react-i18next'

/** v0.17.0 增强：任务状态筛选顺序（全部 + 六态） */
const TASK_STATUS_ORDER: TaskStatus[] = ['pending', 'running', 'paused', 'done', 'failed', 'cancelled']

export function TasksPanel() {
  const { t } = useTranslation()
  const tasks = useStore((s) => s.tasks)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all')

  // 各状态任务计数（供筛选 chips 展示）
  const countByStatus = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of tasks) m[t.status] = (m[t.status] ?? 0) + 1
    return m
  }, [tasks])

  // 过滤（关键词 + 状态）+ 排序（收藏优先，再按更新时间倒序）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = tasks.filter((t) => {
      const matchQ = !q || t.title.toLowerCase().includes(q)
      const matchS = statusFilter === 'all' || t.status === statusFilter
      return matchQ && matchS
    })
    return [...list].sort((a, b) => {
      if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }, [tasks, query, statusFilter])

  // 时间分组：今天 / 更早
  const groups = useMemo(() => groupByTime(filtered, t), [filtered, t])

  return (
    <div className="flex flex-col h-full">
      {/* 头部：列表标题与计数；新建任务入口由 LeftNav 顶部统一承载 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-xs text-text-primary font-semibold tracking-wide">{t('panel.tasks.title')}</span>
        <span className="ml-auto inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-bg-surface text-2xs text-text-tertiary tabular">{tasks.length}</span>
      </div>

      {/* 搜索框 — v0.9.1：合并为单个过滤框（原「搜索任务…」按钮与过滤 input 重复，
          两个输入框并排名义不清；跨任务全局搜索走 ⌘K 命令面板） */}
      <div className="px-2.5 py-2 flex-shrink-0">
        <div className="relative">
          <Icon.Search
            width={12}
            height={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('panel.tasks.searchPlaceholder')}
            className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-surface border border-border-subtle rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
          />
        </div>
      </div>

      {/* v0.17.0 增强：状态筛选 chips（全部 + 六态） */}
      <div className="flex items-center gap-1 px-2.5 pb-2 flex-shrink-0 flex-wrap">
        <button
          onClick={() => setStatusFilter('all')}
          aria-pressed={statusFilter === 'all'}
          className={`flex items-center gap-1 h-6 px-2 rounded-full text-2xs tabular transition-colors ${
            statusFilter === 'all'
              ? 'bg-bg-active text-text-primary'
              : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
          }`}
        >
          {t('panel.tasks.filterAll')}<span className="opacity-60">{tasks.length}</span>
        </button>
        {TASK_STATUS_ORDER.filter((st) => (countByStatus[st] ?? 0) > 0).map((st) => {
          const active = statusFilter === st
          return (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              aria-pressed={active}
              className={`flex items-center gap-1 h-6 px-2 rounded-full text-2xs tabular transition-colors ${
                active
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: STATUS_COLOR[st] }}
              />
              {STATUS_LABEL[st]}
              <span className="opacity-60">{countByStatus[st] ?? 0}</span>
            </button>
          )
        })}
      </div>

      {/* 任务列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {tasks.length === 0 ? (
          <EmptyState
            icon={<Icon.List width={22} height={22} />}
            title={t('panel.tasks.empty.title')}
            hint={t('panel.tasks.empty.hint')}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Icon.Search width={22} height={22} />}
            title={t('panel.tasks.noMatch.title')}
            hint={statusFilter !== 'all' ? t('panel.tasks.noMatch.byStatus', { status: STATUS_LABEL[statusFilter] }) : t('panel.tasks.noMatch.byQuery', { query: query.trim() })}
          />
        ) : (
          groups.map((g) => (
            <div key={g.key} className="mb-2">
              <div className="px-1.5 pt-1 pb-1 text-2xs text-text-tertiary uppercase tracking-wider font-semibold">
                {g.label}
                <span className="ml-1.5 normal-case tabular">({g.items.length})</span>
              </div>
              <div className="space-y-0.5">
                {g.items.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * TaskRow — 任务条目（含右键菜单：收藏/重命名/停止/删除）
 * ============================================================ */
function TaskRow({ task }: { task: Task }) {
  const { t } = useTranslation()
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const selectTask = useStore((s) => s.selectTask)
  const deleteTask = useStore((s) => s.deleteTask)
  const toggleStar = useStore((s) => s.toggleStar)
  const renameTask = useStore((s) => s.renameTask)
  const cancelTask = useStore((s) => s.cancelTask)
  const pauseTask = useStore((s) => s.pauseTask)
  const resumeTask = useStore((s) => s.resumeTask)
  const runTask = useStore((s) => s.runTask)
  const confirm = useStore((s) => s.confirm)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)
  const active = task.id === selectedTaskId

  // v0.17.0 增强：计划进度（任务清单六态聚合）
  const planProgress = useMemo(() => {
    const items = task.planItems
    if (!items || items.length === 0) return null
    const done = items.filter((p) => p.status === 'done').length
    return { done, total: items.length, pct: Math.round((done / items.length) * 100) }
  }, [task.planItems])

  const submitRename = async () => {
    const trimmed = draftTitle.trim()
    if (trimmed && trimmed !== task.title) {
      await renameTask(task.id, trimmed)
    } else {
      setDraftTitle(task.title)
    }
    setRenaming(false)
  }

  return (
    <div
      className="relative group"
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
      }}
    >
      {renaming ? (
        <div className="px-2 py-1">
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={() => void submitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitRename()
              }
              if (e.key === 'Escape') {
                setDraftTitle(task.title)
                setRenaming(false)
              }
            }}
            className="w-full px-2 py-1 text-sm bg-bg-input border border-accent rounded text-text-primary outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => void selectTask(task.id)}
          className={`w-full grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-2.5 py-2 rounded-lg text-xs border transition-[background-color,border-color,color,transform] active:scale-[0.99] relative ${
            active
              ? 'bg-bg-surface border-border-default text-text-primary'
              : 'border-transparent text-text-secondary hover:bg-bg-hover hover:border-border-subtle hover:text-text-primary'
          }`}
        >
          {active && (
            <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-accent rounded-r-full" />
          )}
          <StatusPip status={task.status} />
          <span className="text-left truncate font-medium">{task.title}</span>
          <span className="text-2xs text-text-tertiary tabular flex-shrink-0 pr-4">
            {formatUpdatedAt(task.updatedAt)}
          </span>
          <span className="col-start-2 flex items-center gap-1.5 min-w-0 text-2xs text-text-tertiary">
            <span className="flex-shrink-0">{STATUS_LABEL[task.status]}</span>
            {task.starred && <Icon.Star width={12} height={12} className="text-warning flex-shrink-0" />}
            {planProgress && (
              <span
                className="inline-flex items-center gap-1 flex-shrink-0 tabular"
                title={t('panel.tasks.planProgress', { done: planProgress.done, total: planProgress.total })}
              >
                <span className="w-8 h-1 rounded-full bg-bg-elevated overflow-hidden">
                  <span
                    className="block h-full rounded-full bg-success transition-all duration-300"
                    style={{ width: `${planProgress.pct}%` }}
                  />
                </span>
                <span className="text-text-tertiary">{planProgress.done}/{planProgress.total}</span>
              </span>
            )}
          </span>
        </button>
      )}

      {/* ⋯ 菜单按钮 */}
      {!renaming && (
<Tooltip label={t('panel.tasks.moreActions')}>
        <button
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          className="absolute right-1.5 top-2 w-5 h-5 rounded flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-active opacity-50 group-hover:opacity-100 transition-opacity"

        >
          <Icon.ChevronDown width={16} height={16} />
        </button>
</Tooltip>
      )}

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-1 top-full mt-1 z-30 bg-bg-overlay border border-border-default rounded-md shadow-panel scale-in py-1 min-w-[140px]">
            <MenuButton
              icon={<Icon.Star width={16} height={16} />}
              label={task.starred ? t('panel.tasks.unstar') : t('panel.tasks.star')}
              onClick={() => {
                setMenuOpen(false)
                void toggleStar(task.id)
              }}
            />
            <MenuButton
              icon={<Icon.Edit width={16} height={16} />}
              label={t('panel.tasks.rename')}
              onClick={() => {
                setMenuOpen(false)
                setDraftTitle(task.title)
                setRenaming(true)
              }}
            />
            {(task.status === 'cancelled' || task.status === 'failed') && (
              <MenuButton
                icon={<Icon.Refresh width={16} height={16} />}
                label={t('panel.tasks.rerun')}
                onClick={() => {
                  setMenuOpen(false)
                  void runTask(task.id)
                }}
              />
            )}
            {task.status === 'running' && (
              <MenuButton
                icon={<Icon.Pause width={16} height={16} />}
                label={t('panel.tasks.pause')}
                onClick={() => {
                  setMenuOpen(false)
                  void pauseTask(task.id)
                }}
              />
            )}
            {task.status === 'paused' && (
              <MenuButton
                icon={<Icon.Play width={16} height={16} />}
                label={t('panel.tasks.resume')}
                onClick={() => {
                  setMenuOpen(false)
                  void resumeTask(task.id)
                }}
              />
            )}
            {task.status === 'running' && (
              <MenuButton
                icon={<Icon.Stop width={16} height={16} />}
                label={t('panel.tasks.stop')}
                onClick={() => {
                  setMenuOpen(false)
                  void cancelTask(task.id)
                }}
              />
            )}
            <div className="my-1 border-t border-border-subtle" />
            <MenuButton
              icon={<Icon.Trash width={16} height={16} />}
              label={t('panel.tasks.deleteTitle')}
              danger
              onClick={() => {
                setMenuOpen(false)
                void confirm({
                  title: t('panel.tasks.deleteTitle'),
                  body: t('panel.tasks.deleteBody', { title: task.title }),
                  confirmLabel: t('panel.tasks.deleteConfirm'),
                  danger: true,
                }).then((ok) => {
                  if (ok) void deleteTask(task.id)
                })
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}

function MenuButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors ${
        danger
          ? 'text-danger hover:bg-danger-soft'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

/* ============================================================
 * StatusPip — 状态指示点（STATUS_COLOR + PULSE_STATUS，title 含 STATUS_LABEL）
 * ============================================================ */
function StatusPip({ status }: { status: TaskStatus }) {
  const pulse = PULSE_STATUS.has(status)
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${pulse ? 'pulse-dot' : ''}`}
      style={{ background: STATUS_COLOR[status] }}
      title={`${STATUS_LABEL[status]} ${STATUS_CHAR[status]}`}
    />
  )
}

/* ============================================================
 * 时间分组：今天 / 更早
 * ============================================================ */
interface TimeGroup {
  key: string
  label: string
  items: Task[]
}

function groupByTime(tasks: Task[], t: (k: string) => string): TimeGroup[] {
  const today: Task[] = []
  const earlier: Task[] = []
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  for (const task of tasks) {
    if (task.updatedAt >= startOfToday) today.push(task)
    else earlier.push(task)
  }
  const groups: TimeGroup[] = []
  if (today.length) groups.push({ key: 'today', label: t('panel.tasks.group.today'), items: today })
  if (earlier.length) groups.push({ key: 'earlier', label: t('panel.tasks.group.earlier'), items: earlier })
  return groups
}
