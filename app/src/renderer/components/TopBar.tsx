/* ============================================================
 * ArkWork — TopBar (fix-workspace-task-automation-memory Task 1)
 * 跨平台标题栏：mac 交通灯左、Win/Linux 自定义控件右
 *
 * v0.13.1 — 工作区识别区平铺
 *   - 工作区图标 + 「Agent 工作区」label + 当前工作区名 + 任务数状态
 *     四项稳定不重叠，水平 8px 间距
 *   - 任一子元素不得覆盖或叠在搜索框上
 *   - 搜索仍绝对居中（left-1/2 + -translate-x-1/2）
 *   - 1024–1180 与 <1024 断点下收缩次要信息（先收状态，再收名称），
 *     但图标 + 「Agent 工作区」label 必须保留，确保搜索不被遮挡
 *   - 保留切换工作区下拉、跨平台拖拽区与模型/设置入口
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { useStore } from '../store'
import { Tooltip } from './ui'
import { ark } from '../ipc/client'

const isMac = ark.platform === 'darwin'
const isWin = ark.platform === 'win32'

// macOS 交通灯预留宽度（3 个按钮 + 边距）
const MAC_TRAFFIC_WIDTH = 76
// Windows 原生 overlay 控件预留宽度（titleBarOverlay height=40）
const WIN_OVERLAY_WIDTH = 152

export function TopBar() {
  const setCmdPaletteOpen = useStore((s) => s.setCmdPaletteOpen)
  const openModulePage = useStore((s) => s.openModulePage)
  const { t } = useTranslation()

  return (
    /* v0.21.0 — DSH 风格 TopBar：
       - 高度 48px（h-12，与 DSH mac caption row 32px+ 内边距对齐）
       - 搜索按钮更轻量：l2 border、subtle 底色、hover 提亮 */
    <div
      className="relative flex items-center h-12 border-b border-border-subtle bg-bg-base flex-shrink-0 select-none"
      style={{
        WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion'],
        paddingLeft: isMac ? MAC_TRAFFIC_WIDTH : 14,
        paddingRight: isWin ? WIN_OVERLAY_WIDTH : 14,
      }}
    >
      {/* 左：工作区识别区（平铺、8px 间距、常驻） */}
      <WorkspaceIdentifier />

      {/* 中：⌘K 搜索 — 窗口绝对居中（不参与左右 flex 推挤） */}
      <div
        className="topbar-search absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
      >
        <Tooltip label="Quick Action" kbd="⌘K" desc={t('topbar.search.desc')}>
          <button
            onClick={() => setCmdPaletteOpen(true)}
            aria-label={t('topbar.search.aria')}
            className="topbar-search__button flex items-center gap-2 h-9 px-3.5 rounded-full bg-bg-surface border border-border-subtle hover:border-border-default text-text-secondary hover:text-text-primary transition-colors focus-ring min-w-[280px] max-w-[440px] justify-center"
          >
            <Icon.Search width={15} height={15} aria-hidden="true" />
            <span className="topbar-search__label text-xs">{t('topbar.search.hint')}</span>
            <span className="text-2xs text-text-tertiary font-mono ml-2" aria-hidden="true">⌘K</span>
          </button>
        </Tooltip>
      </div>

      {/* 右：设置（页面化入口）。polish-workspace-task-title-skills-context-help §Task 5.2:
          大模型显示已收敛到 Composer 唯一入口，TopBar 不再展示。 */}
      <div
        className="flex items-center gap-1 ml-auto pl-2"
        style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
      >
        <Tooltip
          label={t('topbar.settings.label')}
          kbd="⌘,"
          desc={t('topbar.settings.desc')}
        >
          <button
            onClick={() => openModulePage('settings')}
            aria-label={t('topbar.settings.aria')}
            className="h-12 w-12 flex items-center justify-center rounded-lg text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
          >
            <Icon.Settings width={18} height={18} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

/* ============================================================
 * WorkspaceIdentifier — 工作区识别区（平铺、不重叠）
 *
 * v0.13.1 布局契约：
 *   - 四项水平平铺：图标 16px + 8px + 「Agent 工作区」label + 8px +
 *     当前工作区名 + 8px + 任务数状态
 *   - 任一子元素以独立元素渲染，互不嵌套覆盖
 *   - 子元素使用 flex-shrink-0 / truncate 防止挤压搜索框
 *   - 整体按钮（点击下拉）仅负责打开下拉与聚焦；具体可见内容在按钮内
 *     平铺展示，按钮框不堆叠其他装饰
 *   - 响应式：
 *       ≥1180px：图标 + label + 名称 + 状态（全显）
 *       1024–1180px：图标 + label + 名称（隐藏状态）
 *       <1024px：图标 + label（隐藏名称与状态）
 *     三档断点下搜索框绝对居中且不被任何子元素覆盖
 * ============================================================ */
function WorkspaceIdentifier() {
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const switchWorkspace = useStore((s) => s.switchWorkspace)
  const removeWorkspace = useStore((s) => s.removeWorkspace)
  const createWorkspace = useStore((s) => s.createWorkspace)
  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0]

  // polish-workspace-task-title-skills-context-help §Task 1 + polish2 Task 1：
  // 顶部 chip 不再展示任务数 / 运行态;仅展示工作区名;tooltip 改为路径与切换说明。
  const wsCap = useMemo(() => {
    const path = activeWs?.path
    return path ? t('topbar.workspace.switchCap', { path }) : t('topbar.workspace.switch')
  }, [activeWs?.path, t])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  // ⌘⇧W 全局快捷键 → 打开工作区下拉
  useEffect(() => {
    const handler = () => setOpen((v) => !v)
    window.addEventListener('topbar:open-workspace', handler)
    return () => window.removeEventListener('topbar:open-workspace', handler)
  }, [])

  const handleOpenFolder = async () => {
    if (!activeWs) return
    try {
      if (activeWs.path) {
        await ark.fs.revealInFolder(activeWs.path)
      } else {
        pushToast({ type: 'warning', message: t('topbar.workspace.noFolderToast'), duration: 2500 })
      }
    } catch (e) {
      pushToast({ type: 'danger', message: t('topbar.workspace.openFail', { message: (e as Error).message }), duration: 3000 })
    }
    setOpen(false)
  }

  const handleRemove = async (id: string, name: string) => {
    setOpen(false)
    const ok = await confirm({
      title: t('topbar.workspace.remove'),
      body: t('topbar.workspace.removeConfirmBody', { name }),
      confirmLabel: t('topbar.workspace.removeConfirm'),
      danger: true,
    })
    if (ok) removeWorkspace(id)
  }

  return (
    <div
      className="workspace-identifier relative flex items-center min-w-0 max-w-[60%]"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
        }
      }}
    >
      <Tooltip
        label={t('topbar.workspace.switch')}
        kbd="⌘⇧W"
        desc={t('topbar.workspace.desc')}
        cap={wsCap}
      >
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
          aria-label={t('topbar.workspace.aria')}
          aria-expanded={open}
          aria-haspopup="menu"
          className="workspace-identifier__button group flex items-center gap-2 h-9 pl-2.5 pr-3 rounded-lg bg-bg-surface border border-border-subtle hover:bg-bg-hover hover:border-border-default transition-colors focus-ring"
        >
          {/* (1) 原创工作区图形（不缩放，16px 稳定占据） */}
          <Icon.Workspace
            width={16}
            height={16}
            className="workspace-identifier__icon text-accent flex-shrink-0"
            aria-hidden="true"
          />
          {/* (2) 「Agent 工作区」标签（始终显示）——Task 3 强化：更高字重与对比 */}
          <span className="workspace-identifier__label text-2xs uppercase tracking-wider text-text-secondary font-semibold flex-shrink-0">
            {t('topbar.workspace.wsLabel')}
          </span>
          {/* (3) 当前工作区名（1024–1180 保留，<1024 隐藏）——Task 3 强化：加粗提升层级 */}
          <span className="workspace-identifier__name flex items-center gap-1 min-w-0 max-w-[180px]">
            <span className="text-sm text-text-primary font-semibold truncate">
              {activeWs?.name ?? t('topbar.workspace.select')}
            </span>
          </span>
          {/* 任务数 / 运行态 chip 已下线（polish2 §Task 1）：
              工作区标识仅展示工作区名，保持顶部 chip 简洁。 */}
          {/* 下拉箭头（小、不抢戏，与四项并列） */}
          <Icon.ChevronDown
            width={12}
            height={12}
            className={`workspace-identifier__chevron text-text-tertiary flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
      </Tooltip>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-[300px] bg-bg-overlay border border-border-default rounded-lg shadow-panel py-1 scale-in">
          {/* 工作区列表 */}
          <div className="px-2 py-1 text-2xs text-text-tertiary uppercase tracking-wider font-medium">
            {t('topbar.workspace.listTitle')}
          </div>
          {workspaces.map((ws) => {
            const active = ws.id === activeWorkspaceId
            return (
              <div
                key={ws.id}
                className={`group flex items-center px-1.5 transition-colors ${
                  active ? 'bg-bg-active' : 'hover:bg-bg-hover'
                }`}
              >
                <button
                  onClick={() => {
                    if (!active) void switchWorkspace(ws.id)
                    setOpen(false)
                  }}
                  aria-current={active ? 'true' : undefined}
                  className="flex flex-1 min-w-0 min-h-8 items-center gap-2 px-1 py-1.5 text-left focus-ring"
                >
                  <Icon.Box width={15} height={15} aria-hidden="true" className={active ? 'text-accent' : 'text-text-tertiary'} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-text-primary truncate">{ws.name}</span>
                    {ws.path && (
                      <span className="block text-2xs text-text-tertiary truncate font-mono">{ws.path}</span>
                    )}
                  </span>
                  {active && <Icon.Check width={14} height={14} aria-hidden="true" className="text-accent flex-shrink-0" />}
                </button>
                {!active && ws.id !== 'default' && (
                  <Tooltip label={t('topbar.workspace.remove')} desc={t('topbar.workspace.removeDesc')} placement="left">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleRemove(ws.id, ws.name)
                      }}
                      aria-label={t('topbar.workspace.removeAria', { name: ws.name })}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 w-8 h-8 flex-shrink-0 flex items-center justify-center rounded text-text-tertiary hover:bg-danger hover:text-white transition-[opacity,color,background-color] focus-ring"
                    >
                      <Icon.X width={12} height={12} aria-hidden="true" />
                    </button>
                  </Tooltip>
                )}
              </div>
            )
          })}

          <div className="my-1 border-t border-border-subtle" />

          {/* 操作按钮 */}
          <button
            onClick={handleOpenFolder}
            className="w-full flex min-h-8 items-center gap-2 px-2.5 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
          >
            <Icon.FolderOpen width={15} height={15} className="text-text-tertiary" />
            {t('topbar.workspace.showInFolder')}
          </button>
          <button
            onClick={() => {
              setOpen(false)
              void createWorkspace()
            }}
            className="w-full flex min-h-8 items-center gap-2 px-2.5 py-1.5 text-sm text-accent hover:bg-accent-soft transition-colors focus-ring"
          >
            <Icon.Plus width={15} height={15} />
            {t('topbar.workspace.add')}
          </button>
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * ModelIndicator 已下线（polish-workspace-task-title-skills-context-help §Task 5.2）：
 * 当前模型仅在 Composer 唯一展示，TopBar / StatusBar / TaskHeader 元数据均不再展示。
 * 函数保留占位以避免被旧 import 误删（已无渲染调用）。
 * ============================================================ */
function ModelIndicator(): null {
  return null
}