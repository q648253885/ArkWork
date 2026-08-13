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
import { useCallback } from 'react'
import { useStore, INSPECTOR_TAB_META, INSPECTOR_TAB_ORDER, type InspectorTabId } from '../store'
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
        {INSPECTOR_TAB_ORDER.map((tab) => {
          const meta = INSPECTOR_TAB_META[tab]
          const active = tab === inspectorTab
          const TabIcon = Icon[meta.icon as IconName] ?? Icon.Dot
          // Browser 永远不隐藏（spec: Browser 始终可访问，不允许被隐藏或自定义移除）
          return (
            <Tooltip key={tab} label={meta.label} kbd={meta.shortcut} placement="left" delay={150}>
              <button
                role="tab"
                aria-selected={active}
                aria-expanded={active && !rightDockCollapsed}
                aria-controls={`inspector-panel-${tab}`}
                data-active={active}
                aria-label={`${meta.label} ${meta.shortcut}`}
                onClick={() => handleTabClick(tab as InspectorTabId)}
                className="inspector-toolbar__item"
              >
                <span className="inspector-toolbar__indicator" aria-hidden="true" />
                <TabIcon width={16} height={16} aria-hidden="true" className="flex-shrink-0" />
                <span className="inspector-toolbar__label">{meta.label}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}