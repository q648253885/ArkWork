/* ============================================================
 * ArkWork — Inspector (fix-workspace-task-automation-memory Task 5 / IntelliJ-style tool window bar)
 * 右栏为最右侧垂直工具窗口栏：
 * - 标签固定 Todos / Context / Files / Logs / Browser / Terminal 顺序（独立 tools 已并入 ContextPanel）
 * - 标签栏始终贴在窗口最右边（即使内容折叠也常驻）
 * - 当前标签用左侧 accent 指示条 + 图标 + 文字表达选中态
 * - 内容面板在标签栏左侧展开，宽 280–480px 可拖
 * - 点击非激活标签 → 展开/切换；再次点击激活标签 → 仅折叠内容
 * - Browser 标签不可隐藏，保证可访问
 * - ⌥1~6 快捷键激活并展开对应标签（todos/context/files/logs/browser/terminal）
 * 设计文档：specs/fix-workspace-task-automation-memory §合并后的右侧工具窗口
 * ============================================================ */
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, INSPECTOR_TAB_META, type InspectorTabId } from '../store'
import { Icon, type IconName } from '../icons'
import { Tooltip } from './ui'
import { FilesPanel } from './panels/FilesPanel'
import { ContextPanel } from './dock/ContextPanel'
import { BrowserPanel } from './dock/BrowserPanel'
import { TodoPanel } from './dock/TodoPanel'
import { LogsView } from './right/LogsView'
// v0.27.0 r10-F14a：终端（输出查看器）纳入 Inspector —— 原 RightDock 宿主无挂载点
import { TerminalPanel } from './dock/TerminalPanel'

const TOOL_BAR_WIDTH = 44 // 垂直标签栏宽度（保持紧凑、足够容纳 16px 图标 + 文字）

export function Inspector() {
  const { t } = useTranslation()
  const inspectorTab = useStore((s) => s.inspectorTab)
  const setInspectorTab = useStore((s) => s.setInspectorTab)
  const rightDockCollapsed = useStore((s) => s.rightDockCollapsed)
  const toggleRightDock = useStore((s) => s.toggleRightDock)
  const rightDockWidth = useStore((s) => s.rightDockWidth)
  const setRightDockWidth = useStore((s) => s.setRightDockWidth)
  const inspectorTabOrder = useStore((s) => s.inspectorTabOrder)
  const hiddenInspectorTabs = useStore((s) => s.hiddenInspectorTabs)
  const setInspectorTabOrder = useStore((s) => s.setInspectorTabOrder)
  const hideInspectorTab = useStore((s) => s.hideInspectorTab)
  const restoreInspectorTab = useStore((s) => s.restoreInspectorTab)

  // 标签点击状态机（Task 9：修复「折叠后再次点击无法弹起」回归）：
  // - 折叠态：点击任意标签（含当前激活标签）→ 展开对应面板（无延迟失焦）
  // - 展开态：点击当前激活标签 → 折叠内容面板（标签栏保留）
  // - 展开态：点击非激活标签 → 仅切换内容面板
  const handleTabClick = useCallback(
    (tab: InspectorTabId) => {
      if (rightDockCollapsed) {
        // 折叠态优先展开：即使点的是当前激活标签，也必须弹起，
        // 否则会落入「tab === inspectorTab && collapsed → 无操作」的死区
        setInspectorTab(tab)
        toggleRightDock()
        return
      }
      if (tab === inspectorTab) {
        // 展开态点击当前激活标签 → 仅折叠，标签栏保持可见
        toggleRightDock()
        return
      }
      // 展开态点击非激活标签 → 切换内容，不折叠
      setInspectorTab(tab)
    },
    [inspectorTab, rightDockCollapsed, setInspectorTab, toggleRightDock],
  )

  // 拖拽手柄：向左侧拖动增加面板宽度，向右拖动减小
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = rightDockWidth
      const move = (mv: MouseEvent) => setRightDockWidth(startW + (startX - mv.clientX))
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [rightDockWidth, setRightDockWidth],
  )

  // v0.17.0 F13：Tab 拖动重排 + 拖出隐藏
  const [dragOverTab, setDragOverTab] = useState<InspectorTabId | null>(null)
  const draggedRef = useRef<InspectorTabId | null>(null)
  const didDropRef = useRef(false)

  const visibleTabs = inspectorTabOrder.filter((t) => !hiddenInspectorTabs.includes(t))

  const handleDragStart = useCallback((e: React.DragEvent, tab: InspectorTabId) => {
    draggedRef.current = tab
    didDropRef.current = false
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tab)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, tab: InspectorTabId) => {
      if (!draggedRef.current || draggedRef.current === tab) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverTab(tab)
    },
    [],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent, tab: InspectorTabId) => {
      e.preventDefault()
      const from = draggedRef.current
      setDragOverTab(null)
      if (!from || from === tab) return
      const order = [...inspectorTabOrder]
      const fromIdx = order.indexOf(from)
      const toIdx = order.indexOf(tab)
      if (fromIdx < 0 || toIdx < 0) return
      order.splice(fromIdx, 1)
      order.splice(toIdx, 0, from)
      setInspectorTabOrder(order)
      didDropRef.current = true
    },
    [inspectorTabOrder, setInspectorTabOrder],
  )

  const handleDragEnd = useCallback(() => {
    const from = draggedRef.current
    // 拖到工具栏之外（未落在任何 Tab 上）→ 隐藏该 Tab
    if (from && !didDropRef.current) hideInspectorTab(from)
    draggedRef.current = null
    didDropRef.current = false
    setDragOverTab(null)
  }, [hideInspectorTab])

  return (
    <div
      className="flex h-full flex-shrink-0 select-none"
      aria-label={t('inspector.toolWindowBar')}
    >
      {/* 内容面板 —— v0.25.0 F2 P1：始终挂载（折叠时容器隐藏），保证 BrowserPanel 内
          view-manager bounds 同步不停。否则折叠/隐藏时 React 卸载 → ResizeObserver 断开 →
          webContents 卡在旧 bounds → 再次展开出现漂浮/错位。
          隐藏方式用 visibility:hidden + width:0（占位为 0 不抢空间），而非 display:none，
          否则内部 width:100% 计算会塌陷。 */}
      <div
        id={`inspector-panel-${inspectorTab}`}
        role="tabpanel"
        aria-label={t(INSPECTOR_TAB_META[inspectorTab].label)}
        aria-hidden={rightDockCollapsed}
        className="responsive-inspector-panel relative flex flex-col h-full bg-bg-base border-l border-border-subtle flex-shrink-0"
        style={{
          '--inspector-width': `${rightDockWidth}px`,
          width: rightDockCollapsed ? 0 : `${rightDockWidth}px`,
          minWidth: rightDockCollapsed ? 0 : `${rightDockWidth}px`,
          overflow: 'hidden',
          borderLeftWidth: rightDockCollapsed ? 0 : undefined,
          transition: 'width 160ms var(--ease-out)',
        } as React.CSSProperties}
      >
        <div
          className="flex flex-col h-full"
          style={{
            visibility: rightDockCollapsed ? 'hidden' : 'visible',
            width: `${rightDockWidth}px`,
            position: rightDockCollapsed ? 'absolute' : 'static',
          }}
        >
          {/* 左边缘 resize handle — 拖拽调整面板宽度 */}
          <Tooltip label={t('inspector.resize')} desc={t('inspector.resizeDesc')} placement="left">
            <div
              onMouseDown={startResize}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault()
                setRightDockWidth(rightDockWidth + (e.key === 'ArrowLeft' ? 16 : -16))
              }}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('inspector.resizeHandleAria')}
              aria-valuemin={280}
              aria-valuemax={480}
              aria-valuenow={rightDockWidth}
              tabIndex={0}
              className="resize-handle resize-handle--left focus-ring"
            />
          </Tooltip>

          {/* 当前标签面板 —— v0.25.0 F2 P1：BrowserPanel 始终挂载，避免切走销毁 webContents */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            {/* 始终挂载 BrowserPanel（display:none 隐藏），webContents 不销毁。
                v0.25.0 F2 P1 bug-fix：display 同时受 右栏折叠 约束 —— 折叠时也归零，
                否则 placeholder 仍保有宽度（父节点只做 visibility:hidden），占位区的
                getBoundingClientRect 继续返回真实尺寸 → 原生 WebContentsView 不会被隐藏，
                会盖在"折叠后向左扩展的会话区"上（侧栏浏览器遮挡内容）。 */}
            <div
              className="absolute inset-0 flex flex-col"
              style={{ display: inspectorTab === 'browser' && !rightDockCollapsed ? 'flex' : 'none' }}
            >
              <BrowserPanel />
            </div>
            {inspectorTab === 'todos' && <TodoPanel />}
            {inspectorTab === 'context' && <ContextPanel />}
            {inspectorTab === 'files' && <FilesPanel />}
            {inspectorTab === 'logs' && <LogsView />}
        {/* v0.27.0 r10-F14a：终端（输出查看器）—— F14 文案宿主，原 RightDock 无挂载点 */}
        {inspectorTab === 'terminal' && <TerminalPanel />}
          </div>
        </div>
      </div>

      {/* 垂直标签栏 — 始终常驻于窗口最右边 */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('inspector.tabBar')}
        className="inspector-toolbar"
        style={{ width: TOOL_BAR_WIDTH }}
      >
        {visibleTabs.map((tab) => {
          const meta = INSPECTOR_TAB_META[tab]
          const active = tab === inspectorTab
          const TabIcon = Icon[meta.icon as IconName] ?? Icon.Dot
          const isDragOver = dragOverTab === tab
          return (
            <Tooltip key={tab} label={t(meta.label)} kbd={meta.shortcut} placement="left" delay={150}>
              <button
                role="tab"
                aria-selected={active}
                aria-expanded={active && !rightDockCollapsed}
                aria-controls={`inspector-panel-${tab}`}
                data-active={active}
                aria-label={t('inspector.tabAria', { label: t(meta.label), kbd: meta.shortcut })}
                onClick={() => handleTabClick(tab)}
                draggable
                onDragStart={(e) => handleDragStart(e, tab)}
                onDragOver={(e) => handleDragOver(e, tab)}
                onDrop={(e) => handleDrop(e, tab)}
                onDragEnd={handleDragEnd}
                className="inspector-toolbar__item"
                style={{
                  cursor: 'grab',
                  ...(isDragOver
                    ? { outline: '1px dashed var(--accent)', outlineOffset: '-2px' }
                    : null),
                }}
              >
                <span className="inspector-toolbar__indicator" aria-hidden="true" />
                <TabIcon width={16} height={16} aria-hidden="true" className="flex-shrink-0" />
                <span className="inspector-toolbar__label">{t(meta.label)}</span>
              </button>
            </Tooltip>
          )
        })}

        {/* v0.17.0 F13：已隐藏区 — 被拖出的 Tab 收纳于此，点击恢复 */}
        {hiddenInspectorTabs.length > 0 && (
          <div
            className="mt-1 pt-2 border-t border-border-subtle flex flex-col gap-1 px-1"
            aria-label={t('inspector.hiddenLabel')}
          >
            {hiddenInspectorTabs.map((tab) => {
              const meta = INSPECTOR_TAB_META[tab]
              const TabIcon = Icon[meta.icon as IconName] ?? Icon.Dot
              return (
                <Tooltip key={tab} label={t('inspector.restoreTab', { label: t(meta.label) })} placement="left" delay={150}>
                  <button
                    onClick={() => restoreInspectorTab(tab)}
                    aria-label={t('inspector.restoreTabAria', { label: t(meta.label) })}
                    className="flex items-center justify-center h-9 rounded-sm text-text-tertiary opacity-60 hover:opacity-100 hover:bg-bg-hover hover:text-text-primary transition-all focus-ring"
                  >
                    <TabIcon width={14} height={14} aria-hidden="true" />
                  </button>
                </Tooltip>
              )
            })}
          </div>
        )}

        {/* v0.17.0 F13：整栏折叠/展开 */}
        <Tooltip
          label={rightDockCollapsed ? t('inspector.expand') : t('inspector.collapse')}
          kbd="⌘J"
          placement="left"
          delay={150}
        >
          <button
            onClick={() => toggleRightDock()}
            aria-label={rightDockCollapsed ? t('inspector.expand') : t('inspector.collapse')}
            className="mt-auto flex items-center justify-center h-9 rounded-sm text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
          >
            {rightDockCollapsed ? (
              <Icon.ChevronLeft width={16} height={16} />
            ) : (
              <Icon.ChevronRight width={16} height={16} />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}