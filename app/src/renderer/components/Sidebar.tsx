/* ============================================================
 * ArkWork — Sidebar (fix-workspace-task-automation-memory Task 1)
 * 替代 v0.13.0 折叠区二级展开：能力入口全部单击直达 modulePage
 *
 * v0.13.1 — 主操作视觉与功能入口对齐
 *   - 新建任务主按钮：SVG Icon.Plus + 「新建任务」文字，扁平细长、
 *     居中铺满 Sidebar 可用宽度（去掉 + 字符）
 *   - 折叠态 Sidebar 同步使用 Icon.Plus 居中按钮（同一份数据）
 *   - 六个功能入口（智能体 / 技能 / 知识 / 记忆 / 自动化 / 设置）
 *     统一 h-8 + 16px 图标 + 一致字号 + 1px 顶部行高修正，
 *     中心/基线对齐；快捷键列右对齐等宽
 *   - 折叠态与展开态入口同源（共享 CAPABILITY_ENTRIES 数据）
 * - 顶部 96px：New Task 主按钮 + Search threads
 * - Threads 分组：Pinned / Today / This week / Earlier（默认折叠）
 * - 底部：仅 Help（⌘/）；设置已迁移为一级入口，此处不再重复。
 * - 240px 宽，64–320px 可拖
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, type ModulePage } from '../store'
import { Icon, type IconName } from '../icons'
import { Tooltip } from './ui'
import { formatUpdatedAt } from '../types'
import type { Task } from '@shared/types/task'
import { PLAN_STATUS_META, aggregatePlanStatus } from '../utils/plan-status'

interface SidebarProps {
  width: number
  onResizeStart: (e: React.MouseEvent) => void
}

export function Sidebar({ width, onResizeStart }: SidebarProps) {
  const setSidebarWidth = useStore((s) => s.setSidePanelWidth)
  const { t } = useTranslation()

  return (
    <div
      className="responsive-sidebar relative flex flex-col h-full bg-bg-base border-r border-border-subtle flex-shrink-0 select-none min-w-0"
      style={{ '--sidebar-width': `${width}px` } as React.CSSProperties}
    >
      {/* 右边缘 resize handle */}
      <Tooltip
        label={t('sidebar.resizeHandle.label')}
        desc={t('sidebar.resizeHandle.desc')}
        placement="right"
      >
        <div
          onMouseDown={onResizeStart}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            setSidebarWidth(width + (e.key === 'ArrowRight' ? 16 : -16))
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('sidebar.resizeHandle.aria')}
          aria-valuemin={64}
          aria-valuemax={320}
          aria-valuenow={width}
          tabIndex={0}
          className="resize-handle resize-handle--right focus-ring"
        />
      </Tooltip>

      {/* 顶部：主按钮 + 搜索 */}
      <SidebarTop />

      {/* Threads 分组 */}
      <Threads />

      {/* 底部能力入口（折叠区）+ Help / Settings */}
      <CapabilityEntries />
      <SidebarFooter />
    </div>
  )
}

/* ============================================================
 * SidebarTop — 主操作 + Search threads
 * ============================================================
 * 新建任务主按钮（v0.13.1）：
 *   - 使用 SVG Icon.Plus，不使用 + 字符
 *   - 扁平细长、居中铺满 Sidebar 可用宽度
 *   - 视觉高度与六个功能入口的 h-8 对齐（统一 32px）
 */
function SidebarTop() {
  const createTask = useStore((s) => s.createTask)
  const { t } = useTranslation()
  return (
    /* v0.21.0 — DSH 风格 newSession（figma 133:7634）：
       38px 高度、12px 圆角、elevated fill（白底）+ l2 border */
    <div className="sidebar-top p-2 pb-2 flex-shrink-0">
      <Tooltip label={t('sidebar.newTask.title')} kbd="⌘N" desc={t('sidebar.newTask.desc')} block>
        <button
          onClick={() => void createTask({ title: '', text: '' })}
          className="sidebar-new-task w-full flex items-center justify-center gap-1.5 h-[38px] px-4 rounded-xl bg-bg-overlay border border-border-default hover:bg-bg-surface active:scale-[0.98] text-text-primary text-sm font-medium transition-[background-color,color,transform] focus-ring"
        >
          <Icon.Plus width={16} height={16} aria-hidden="true" />
          <span className="sidebar-new-task__label">{t('sidebar.newTask.title')}</span>
        </button>
      </Tooltip>
      <ThreadSearch />
    </div>
  )
}

function ThreadSearch() {
  const tasks = useStore((s) => s.tasks)
  const selectTask = useStore((s) => s.selectTask)
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    // v0.13.0：搜索同时匹配标题与格式化时间（formatUpdatedAt）
    return tasks
      .filter((t) => {
        const titleHit = t.title.toLowerCase().includes(q)
        const timeHit = formatUpdatedAt(t.updatedAt).toLowerCase().includes(q)
        return titleHit || timeHit
      })
      .slice(0, 5)
  }, [tasks, query])

  return (
    <div className="relative mt-2">
      <input
        aria-label={t('sidebar.search.aria')}
        name="thread-search"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('sidebar.search.placeholder')}
        className="w-full h-8 pl-7 pr-2 text-xs bg-bg-surface border border-border-subtle rounded-md text-text-primary placeholder:text-text-secondary focus-ring focus:border-accent transition-colors"
      />
      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary">
        <Icon.Search width={14} height={14} aria-hidden="true" />
      </span>
      {matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-bg-overlay border border-border-default rounded-md shadow-panel z-30 max-h-[280px] overflow-y-auto">
          {matches.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                void selectTask(t.id)
                setQuery('')
              }}
              className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <span className="block truncate">{t.title}</span>
              <span className="block text-2xs text-text-tertiary tabular mt-0.5">
                {formatUpdatedAt(t.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * Threads — Pinned / Today / This week / Earlier
 * ============================================================ */
function Threads() {
  const tasks = useStore((s) => s.tasks)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const selectTask = useStore((s) => s.selectTask)
  const { t } = useTranslation()

  const groups = useMemo(() => groupTasks(tasks, (k) => t(k)), [tasks, t])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto border-t border-border-subtle">
      {groups.map((g) => (
        <ThreadGroup
          key={g.key}
          label={g.label}
          items={g.items}
          defaultOpen={g.defaultOpen}
          selectedId={selectedTaskId}
          onPick={(id) => void selectTask(id)}
        />
      ))}
      {tasks.length === 0 && (
        <div className="px-3 py-6 text-xs text-text-tertiary text-center">
          {t('sidebar.threads.empty')}
        </div>
      )}
    </div>
  )
}

function ThreadGroup({
  label,
  items,
  defaultOpen,
  selectedId,
  onPick,
}: {
  label: string
  items: Task[]
  defaultOpen: boolean
  selectedId: string | null
  onPick: (id: string) => void
}) {
  // v0.13.0：Threads 分组默认折叠（对齐 01-information-architecture.md §3）。
  // 严格文档：Pinned/Today/This week/Earlier 全部默认折叠。
  const [open, setOpen] = useState(defaultOpen)
  // 标记用户是否在本组手动切换过折叠态。仅 selectedTaskId 由外部新落到本组时强制展开；
  // 用户已手动折叠且 selectedTaskId 未变时，绝不重新展开。
  const userToggledRef = useRef(false)
  // 上一个被选中的任务 id。初始为 null：首次选中 / 新建任务均视为"新落组"，
  // 避免旧选中任务也在本组（如 today 组连续建第二个任务）时误判为已在组内而不展开。
  const prevSelectedIdRef = useRef<string | null>(null)

  // selectedTaskId 变化（与上一个选中不同）时重置"用户手动折叠"标记：
  // 手动折叠仅针对当前选中任务生效，切换选中后允许新任务再次自动展开。
  useEffect(() => {
    if (selectedId !== prevSelectedIdRef.current) {
      userToggledRef.current = false
    }
  }, [selectedId])

  // 响应 selectedTaskId 变化：仅当选中任务新落到本组（与上一个选中不同）且组未展开 → 强制展开。
  // 用户已手动折叠且选中项未变时保持用户选择。
  useEffect(() => {
    if (!selectedId) {
      prevSelectedIdRef.current = selectedId
      return
    }
    const contains = items.some((t) => t.id === selectedId)
    if (contains && selectedId !== prevSelectedIdRef.current && !open) {
      setOpen(true)
    }
    prevSelectedIdRef.current = selectedId
  }, [selectedId, items, open])

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          userToggledRef.current = true
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        className="sidebar-group w-full focus-ring"
      >
        <span>
          {label} <span className="ml-1 text-text-secondary tabular normal-case">({items.length})</span>
        </span>
        <span className="text-text-tertiary text-2xs">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-0.5 px-1.5 pb-2">
          {items.map((t) => (
            <ThreadRow
              key={t.id}
              task={t}
              selected={selectedId === t.id}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * ThreadRow — 单条任务行（含 ⋯ 菜单：选择/收藏/重命名/运行/停止/删除）
 * fix-workspace-task-automation-memory Task 2：将 Sidebar Threads 行补齐 CRUD。
 * 设计目标：hover/focus 显式触发 ⋯，菜单与 TasksPanel TaskRow 同语义，
 * 避免 TasksPanel 与 Sidebar Threads 维护两份不一致的状态。
 * ============================================================ */
function ThreadRow({
  task,
  selected,
  onPick,
}: {
  task: Task
  selected: boolean
  onPick: (id: string) => void
}) {
  const toggleStar = useStore((s) => s.toggleStar)
  const renameTask = useStore((s) => s.renameTask)
  const runTask = useStore((s) => s.runTask)
  const pauseTask = useStore((s) => s.pauseTask)
  const resumeTask = useStore((s) => s.resumeTask)
  const cancelTask = useStore((s) => s.cancelTask)
  const deleteTask = useStore((s) => s.deleteTask)
  const confirm = useStore((s) => s.confirm)
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)
  // polish3 §Task 1.3：新建任务选中后 0.6s pulse
  const [pulse, setPulse] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 每次 selected 由 false → true 触发一次性 pulse
  const prevSelectedRef = useRef(selected)
  useEffect(() => {
    if (selected && !prevSelectedRef.current) {
      setPulse(true)
      const t = window.setTimeout(() => setPulse(false), 650)
      prevSelectedRef.current = true
      return () => window.clearTimeout(t)
    }
    prevSelectedRef.current = selected
  }, [selected])

  // 选中后滚动到可视区域，避免侧栏过长时选中行被遮挡。
  // 用 block: 'nearest' 避免外层页面整体滚动，只在容器内调整。
  useEffect(() => {
    if (selected && wrapRef.current) {
      wrapRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selected])

  // v0.14.0 Task 8：任务行与清单六态联动 —
  // 全部 done → 任务行视为 done；任一 failed → warning 角标（见下方渲染）；
  // 状态点颜色取六态映射（planItems 缺失/为空时回退任务级状态，保持旧行为）
  // v0.21.0：running 态颜色由 accent（紫罗兰）改用 business-primary（业务蓝），与 DSH 风格对齐
  const planStatus = aggregatePlanStatus(task.planItems?.map((p) => p.status))
  const statusColor = planStatus
    ? PLAN_STATUS_META[planStatus].color
    : task.status === 'running'
      ? 'var(--business-primary)'
      : task.status === 'failed'
        ? 'var(--danger)'
        : 'var(--text-tertiary)'

  const submitRename = async () => {
    const trimmed = draftTitle.trim()
    if (trimmed && trimmed !== task.title) {
      await renameTask(task.id, trimmed)
    } else {
      setDraftTitle(task.title)
    }
    setRenaming(false)
  }

  // 点击外部 / Escape 关闭菜单
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div ref={wrapRef} className="relative group">
      {renaming ? (
        <div className="px-2 py-1">
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={() => void submitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void submitRename() }
              if (e.key === 'Escape') { setDraftTitle(task.title); setRenaming(false) }
            }}
            className="w-full h-7 px-2 text-xs bg-bg-input border border-accent rounded text-text-primary outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => onPick(task.id)}
          data-thread-row={task.id}
          data-selected={selected ? 'true' : 'false'}
          /* v0.21.0 — DSH 风格 ThreadRow 选中态：业务蓝淡底 + 业务蓝左条 + 业务蓝外环 */
          className={`relative w-full flex items-center gap-2 h-8 pl-3 pr-2.5 rounded-md text-xs text-left transition-colors ${
            selected
              ? 'bg-business-primary-soft text-business-primary font-medium'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
          } ${pulse ? 'pulse-new-task' : ''}`}
        >
          {/* v0.21.0：左侧 2px 业务蓝条（DSH 风格左 indicator） */}
          {selected && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-business-primary"
            />
          )}
          {/* v0.14.0 Task 8：与清单六态联动 — planItems 存在时颜色取六态映射，
              否则回退任务级状态（保持旧行为） */}
          <span
            aria-hidden="true"
            className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${selected ? 'ring-2 ring-business-ring' : ''}`}
            style={{ background: statusColor }}
          />
          {task.automationId ? (
            <span className="flex items-center gap-1 flex-1 min-w-0">
              <Icon.Clock width={12} height={12} className="text-text-tertiary flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{task.title}</span>
            </span>
          ) : (
            <span className="truncate flex-1 min-w-0">{task.title}</span>
          )}
          {/* v0.14.0 Task 8：清单存在失败步骤 → warning 角标 */}
          {planStatus === 'failed' && (
            <Icon.Warning
              width={12}
              height={12}
              className="text-warning flex-shrink-0"
              aria-label={t('sidebar.threadRow.failedBadge')}
            />
          )}
          <span className="text-2xs text-text-tertiary tabular flex-shrink-0">
            {formatUpdatedAt(task.updatedAt)}
          </span>
        </button>
      )}

      {/* ⋯ 按钮 — hover/focus 可见 */}
      {!renaming && (
        <button
          aria-label={t('sidebar.menu.moreActions', { title: task.title })}
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setMenuOpen((v) => !v)
            }
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-active opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity"
        >
          <Icon.ChevronDown width={14} height={14} />
        </button>
      )}

      {menuOpen && (
        <div
          role="menu"
          aria-label={t('sidebar.menu.menuLabel', { title: task.title })}
          className="absolute right-1 top-full mt-1 z-40 min-w-[140px] bg-bg-overlay border border-border-default rounded-md shadow-panel py-1"
        >
          <MenuRow
            icon={<Icon.Star width={14} height={14} />}
            label={task.starred ? t('sidebar.menu.unstar') : t('sidebar.menu.star')}
            onClick={() => { setMenuOpen(false); void toggleStar(task.id) }}
          />
          <MenuRow
            icon={<Icon.Edit width={14} height={14} />}
            label={t('sidebar.menu.rename')}
            onClick={() => { setMenuOpen(false); setDraftTitle(task.title); setRenaming(true) }}
          />
          {(task.status === 'pending' || task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') && (
            <MenuRow
              icon={<Icon.Refresh width={14} height={14} />}
              label={task.status === 'pending' ? t('sidebar.menu.run') : t('sidebar.menu.rerun')}
              onClick={() => { setMenuOpen(false); void runTask(task.id) }}
            />
          )}
          {task.status === 'running' && (
            <MenuRow
              icon={<Icon.Pause width={14} height={14} />}
              label={t('sidebar.menu.pause')}
              onClick={() => { setMenuOpen(false); void pauseTask(task.id) }}
            />
          )}
          {task.status === 'paused' && (
            <MenuRow
              icon={<Icon.Play width={14} height={14} />}
              label={t('sidebar.menu.resume')}
              onClick={() => { setMenuOpen(false); void resumeTask(task.id) }}
            />
          )}
          {task.status === 'running' && (
            <MenuRow
              icon={<Icon.Stop width={14} height={14} />}
              label={t('sidebar.menu.stop')}
              onClick={() => { setMenuOpen(false); void cancelTask(task.id) }}
            />
          )}
          <div className="my-1 border-t border-border-subtle" />
          <MenuRow
            icon={<Icon.Trash width={14} height={14} />}
            label={t('sidebar.menu.delete')}
            danger
            onClick={() => {
              setMenuOpen(false)
              void confirm({
                title: t('sidebar.confirmDelete.title'),
                body: t('sidebar.confirmDelete.body', { title: task.title }),
                confirmLabel: t('sidebar.confirmDelete.confirm'),
                danger: true,
              }).then((ok) => { if (ok) void deleteTask(task.id) })
            }}
          />
        </div>
      )}
    </div>
  )
}

function MenuRow({
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
      role="menuitem"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs transition-colors ${
        danger
          ? 'text-danger hover:bg-danger-soft'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
    </button>
  )
}

/* ============================================================
 * 能力入口（一级 — 单击直达 modulePage）
 * - 智能体 / 技能 / 知识 / 记忆 / 自动化 / 设置
 * - 单击立即调用 openModulePage；重复点击同一切换（store 内 toggle 行为）
 * - 当前入口通过 modulePage === page 显示选中态
 * - v0.13.1 视觉契约（fix-workspace-task-automation-memory Task 1）：
 *     h-8 + 16px 图标 + 14px 字号 + 1px 顶部行高修正
 *     + 快捷键列右对齐等宽（ml-auto + min-w 固定列宽）
 *     + 中心/基线对齐（align-items: center）
 *     + 图标、label 与右侧 shortcut 三段式 flex 平铺
 * ============================================================ */
// v0.13.1 fix-workspace-task-automation-memory Task 1：能力入口数据同源
// 导出供 App.tsx 的 CollapsedSidebar 共用，确保折叠/展开态顺序与文案一致
// v0.25：label 字段为 i18n key，渲染处通过 t(label) 取译文
export const CAPABILITY_ENTRIES: { page: ModulePage; icon: IconName; label: string; shortcut: string }[] = [
  { page: 'agents',      icon: 'Bot',      label: 'sidebar.capability.agents', shortcut: '⌘1' },
  // v0.24.2：能力中心统一收纳技能 + 插件，label 与 LeftNav / ModulePage 对齐
  { page: 'skills',      icon: 'Bolt',     label: 'sidebar.capability.skills', shortcut: '⌘2' },
  { page: 'kb',          icon: 'Book',     label: 'sidebar.capability.kb',       shortcut: '⌘3' },
  { page: 'memory',      icon: 'Brain',    label: 'sidebar.capability.memory',   shortcut: '⌘4' },
  { page: 'automations', icon: 'Clock',    label: 'sidebar.capability.automations', shortcut: '⌘5' },
  { page: 'settings',    icon: 'Settings', label: 'sidebar.capability.settings', shortcut: '⌘6' },
]

function CapabilityEntries() {
  const openModulePage = useStore((s) => s.openModulePage)
  const modulePage = useStore((s) => s.modulePage)
  const { t } = useTranslation()

  return (
    /* v0.21.0 — DSH 风格 Sidebar 能力入口：
       - active：业务蓝文字 + 蓝色淡背景（DSH --dsw-alias-interactive-bg-hover-accent）
       - 整体保留 Sidebar 留白与 8px gap 节奏 */
    <div className="sidebar-capability border-t border-border-subtle py-1.5 px-1.5 flex-shrink-0">
      {CAPABILITY_ENTRIES.map((m) => {
        const active = modulePage === m.page
        const EntryIcon = Icon[m.icon]
        const entryLabel = t(m.label)
        return (
          // v0.13.1 修复：Tooltip 默认 wrapper 为 inline-flex，会导致按钮按行内元素
          // 流动并换行成两列；这里显式 block，保证六个入口在展开态垂直堆叠、铺满整行。
          <Tooltip key={m.page} label={entryLabel} kbd={m.shortcut} desc={t('sidebar.capability.desc', { label: entryLabel })} delay={150} block>
            <button
              onClick={() => openModulePage(m.page)}
              aria-current={active ? 'page' : undefined}
              aria-label={`${entryLabel} ${m.shortcut}`}
              className={`sidebar-capability__item w-full flex items-center gap-2 h-8 px-2.5 rounded-md text-sm transition-colors focus-ring mb-0.5 ${
                active
                  ? 'bg-business-primary-soft text-business-primary font-medium'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span className="sidebar-capability__icon-box w-5 h-5 flex items-center justify-center flex-shrink-0">
                <EntryIcon
                  width={16}
                  height={16}
                  className={`flex-shrink-0 ${active ? 'text-business-primary' : ''}`}
                  aria-hidden="true"
                />
              </span>
              <span className="sidebar-capability__label flex-1 text-left truncate">{entryLabel}</span>
              <span className="sidebar-capability__shortcut text-2xs text-text-tertiary tabular text-right">{m.shortcut}</span>
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

/* ============================================================
 * Sidebar 底部：仅 Help（⌘/）
 * 设置已迁移为一级功能入口（见 CapabilityEntries），此处不再重复
 * ============================================================ */
function SidebarFooter() {
  const toggleHelp = useStore((s) => s.toggleHelp)
  const { t } = useTranslation()
  return (
    <div className="sidebar-footer-row">
      <Tooltip label={t('sidebar.help.title')} kbd="⌘/" desc={t('sidebar.help.desc')}>
        <button className="focus-ring" aria-label={t('sidebar.help.aria')} onClick={() => toggleHelp()}>
          <Icon.Info width={14} height={14} aria-hidden="true" />
          <span>{t('sidebar.help.title')}</span>
        </button>
      </Tooltip>
      <span className="text-2xs text-text-tertiary tabular">v0.13.0+</span>
    </div>
  )
}

/* ============================================================
 * 时间分组：Pinned / Today / This week / Earlier
 * ============================================================ */
interface TaskGroup {
  key: string
  label: string
  items: Task[]
  defaultOpen: boolean
}

function groupTasks(tasks: Task[], t: (key: string) => string): TaskGroup[] {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfWeek = startOfDay - 7 * 24 * 3600 * 1000

  const pinned: Task[] = []
  const today: Task[] = []
  const week: Task[] = []
  const earlier: Task[] = []

  for (const t of tasks) {
    if (t.starred) pinned.push(t)
    if (t.updatedAt >= startOfDay) today.push(t)
    else if (t.updatedAt >= startOfWeek) week.push(t)
    else earlier.push(t)
  }

  // 去重（pinned 已经单独归到第一组，避免重复显示）
  const pinnedIds = new Set(pinned.map((t) => t.id))
  const filteredToday = today.filter((t) => !pinnedIds.has(t.id))
  const seen = new Set([...pinnedIds, ...filteredToday.map((t) => t.id)])
  const filteredWeek = week.filter((t) => !seen.has(t.id))
  const filteredEarlier = earlier

  // v0.13.0：严格文档（01-information-architecture.md §3）—— Threads 分组默认折叠
  const groups: TaskGroup[] = []
  if (pinned.length > 0) groups.push({ key: 'pinned', label: t('sidebar.threads.group.pinned'), items: pinned, defaultOpen: false })
  if (filteredToday.length > 0) groups.push({ key: 'today', label: t('sidebar.threads.group.today'), items: filteredToday, defaultOpen: false })
  if (filteredWeek.length > 0) groups.push({ key: 'week', label: t('sidebar.threads.group.week'), items: filteredWeek, defaultOpen: false })
  if (filteredEarlier.length > 0) groups.push({ key: 'earlier', label: t('sidebar.threads.group.earlier'), items: filteredEarlier, defaultOpen: false })
  return groups
}