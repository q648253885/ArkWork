/* ============================================================
 * ArkWork — Inspector (fix-workspace-task-automation-memory Task 5 / IntelliJ-style tool window bar)
 * 右栏为最右侧垂直工具窗口栏：
 * - 标签固定 Todos / Context / Files / Logs / Browser 顺序（独立 tools 已并入 ContextPanel）
 * - 标签栏始终贴在窗口最右边（即使内容折叠也常驻）
 * - 当前标签用左侧 accent 指示条 + 图标 + 文字表达选中态
 * - 内容面板在标签栏左侧展开，宽 280–480px 可拖
 * - 点击非激活标签 → 展开/切换；再次点击激活标签 → 仅折叠内容
 * - Browser 标签不可隐藏，保证可访问
 * - ⌥1~5 快捷键激活并展开对应标签（todos/context/files/logs/browser）
 * 设计文档：specs/fix-workspace-task-automation-memory §合并后的右侧工具窗口
 * ============================================================ */
import { useCallback, useRef, useState } from 'react'
import { useStore, INSPECTOR_TAB_META, type InspectorTabId } from '../store'
import { Icon, type IconName } from '../icons'
import { Tooltip } from './ui'
import { FilesPanel } from './panels/FilesPanel'
import { ContextPanel } from './dock/ContextPanel'
import { BrowserPanel } from './dock/BrowserPanel'
import { TodoPanel } from './dock/TodoPanel'
import { LogsView } from './right/LogsView'

const TOOL_BAR_WIDTH = 44 // 垂直标签栏宽度（保持紧凑、足够容纳 16px 图标 + 文字）

export function Inspector() {
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
      aria-label="右侧工具窗口栏"
    >
      {/* 内容面板 — 仅当非折叠时渲染。
          位于标签栏左侧，宽度受 store 控制（280–480px）。 */}
      {!rightDockCollapsed && (
        <div
          id={`inspector-panel-${inspectorTab}`}
          role="tabpanel"
          aria-label={INSPECTOR_TAB_META[inspectorTab].label}
          className="responsive-inspector-panel relative flex flex-col h-full bg-bg-base border-l border-border-subtle"
          style={{ '--inspector-width': `${rightDockWidth}px` } as React.CSSProperties}
        >
          {/* 左边缘 resize handle — 拖拽调整面板宽度 */}
          <Tooltip label="拖拽调整宽度" desc="280–480px 之间自由拖动" placement="left">
            <div
              onMouseDown={startResize}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault()
                setRightDockWidth(rightDockWidth + (e.key === 'ArrowLeft' ? 16 : -16))
              }}
              role="separator"
              aria-orientation="vertical"
              aria-label="工具窗口宽度调整手柄"
              aria-valuemin={280}
              aria-valuemax={480}
              aria-valuenow={rightDockWidth}
              tabIndex={0}
              className="resize-handle resize-handle--left focus-ring"
            />
          </Tooltip>

          {/* 当前标签面板 */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {inspectorTab === 'todos' && <TodoPanel />}
            {inspectorTab === 'context' && <ContextPanel />}
            {inspectorTab === 'files' && <FilesPanel />}
            {inspectorTab === 'logs' && <LogsView />}
            {inspectorTab === 'browser' && <BrowserPanel />}
          </div>
        </div>
      )}

      {/* 垂直标签栏 — 始终常驻于窗口最右边 */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="工具窗口标签栏"
        className="inspector-toolbar"
        style={{ width: TOOL_BAR_WIDTH }}
      >
        {visibleTabs.map((tab) => {
          const meta = INSPECTOR_TAB_META[tab]
          const active = tab === inspectorTab
          const TabIcon = Icon[meta.icon as IconName] ?? Icon.Dot
          const isDragOver = dragOverTab === tab
          return (
            <Tooltip key={tab} label={meta.label} kbd={meta.shortcut} placement="left" delay={150}>
              <button
                role="tab"
                aria-selected={active}
                aria-expanded={active && !rightDockCollapsed}
                aria-controls={`inspector-panel-${tab}`}
                data-active={active}
                aria-label={`${meta.label} ${meta.shortcut}（可拖动重排，拖出工具栏可隐藏）`}
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
                <span className="inspector-toolbar__label">{meta.label}</span>
              </button>
            </Tooltip>
          )
        })}

        {/* v0.17.0 F13：已隐藏区 — 被拖出的 Tab 收纳于此，点击恢复 */}
        {hiddenInspectorTabs.length > 0 && (
          <div
            className="mt-1 pt-2 border-t border-border-subtle flex flex-col gap-1 px-1"
            aria-label="已隐藏的标签"
          >
            {hiddenInspectorTabs.map((tab) => {
              const meta = INSPECTOR_TAB_META[tab]
              const TabIcon = Icon[meta.icon as IconName] ?? Icon.Dot
              return (
                <Tooltip key={tab} label={`恢复「${meta.label}」`} placement="left" delay={150}>
                  <button
                    onClick={() => restoreInspectorTab(tab)}
                    aria-label={`恢复标签：${meta.label}`}
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
          label={rightDockCollapsed ? '展开右栏' : '折叠右栏'}
          kbd="⌘J"
          placement="left"
          delay={150}
        >
          <button
            onClick={() => toggleRightDock()}
            aria-label={rightDockCollapsed ? '展开右栏' : '折叠右栏'}
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