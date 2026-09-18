/* ============================================================
 * ArkWork — Inspector（右栏工具窗口栏 · v0.33.0 面板宿主化）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §7.2
 *           docs/versions/v0.33.0/03-interaction.md §「Inspector 面板 Tab 规格」
 *
 * 结构（自 IntelliJ 式垂直工具窗口栏演进）：
 *  - 标签栏常驻窗口最右；内容面板在其左侧展开，宽 280–480px 可拖
 *  - 内置六 Tab：Todos / Context / Files / Logs / Browser / Terminal
 *  - ★ v0.33.0：**工作台与插件贡献的面板**（`ui.panel` 插槽）并入同一标签栏
 *  - 点击非激活标签 → 展开/切换；再次点击激活标签 → 仅折叠内容
 *  - Browser 不可隐藏（保证可访问）
 *  - ⌥1~6 快捷键激活并展开对应内置标签
 *
 * ★ v0.33.0 三条新纪律（对齐 04-system-design.md §12）：
 *  ① **顺序真源唯一 = manifest `position`**（`mergePanelOrder`）—— 用户偏好只
 *     管辖内置六 Tab 的相对顺序，面板插入点只认 manifest，不引入第二真源；
 *  ② **面板 Tab 不可拖拽、不可隐藏** —— 它不属于用户偏好域（同上）；
 *  ③ **归属可见** —— 面板 Tab 的 title 来自贡献者，`PanelHost` 再标出插件 id。
 * ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, INSPECTOR_TAB_META, DEFAULT_INSPECTOR_TAB, type InspectorTabId, type InspectorTabRef } from '../store'
import { Icon, type IconName } from '../icons'
import { Tooltip } from './ui'
import { FilesPanel } from './panels/FilesPanel'
import { ContextPanel } from './dock/ContextPanel'
import { BrowserPanel } from './dock/BrowserPanel'
import { TaskPanel } from './dock/TaskPanel'
import { LogsView } from './right/LogsView'
// v0.27.0 r10-F14a：终端（输出查看器）纳入 Inspector —— 原 RightDock 宿主无挂载点
import { TerminalPanel } from './dock/TerminalPanel'
// v0.33.0：面板宿主（工作台 / 插件贡献的 ui.panel 插槽）
import { PanelHost } from './vlib/PanelHost'
import {
  builtinTabsOf,
  mergePanelOrder,
  isPanelTabRef,
  INSPECTOR_TAB_REFS,
  type PanelTab,
} from '@shared/utils/panel-model'
// v0.34.0（D54）：插件面板溢出收纳 —— 竖排栏插件名称不超过 3 个
import { splitPluginTabs, MAX_VISIBLE_PLUGIN_TABS } from '../utils/plugin-tab-overflow'
// v0.34.0（D54）：展示名防御（未解析模板串 + 超长名）—— 竖排栏与面板宿主共用同一真源
import { guardLabel } from '../utils/label-guard'

const TOOL_BAR_WIDTH = 44 // 垂直标签栏宽度（保持紧凑、足够容纳 16px 图标 + 文字）

/**
 * v0.34.0（D54）：展示层防御（真源在 `utils/label-guard.ts`，此处转出便于既有调用点与测试复用）。
 * 竖排栏用 `guardLabel`（模板防御 + 8 字符截断）。
 */
export { guardLabel }

/** 内置 Tab 的内容分支（六项穷尽；面板走 PanelHost） */
function BuiltinBody({ tab }: { tab: InspectorTabId }) {
  switch (tab) {
    case 'todos':
      return <TaskPanel />
    case 'context':
      return <ContextPanel />
    case 'files':
      return <FilesPanel />
    case 'logs':
      return <LogsView />
    case 'terminal':
      return <TerminalPanel />
    // Browser 单独处理（必须始终挂载，见下方说明）
    case 'browser':
      return null
  }
}

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
  // v0.33.0：工作台 / 插件贡献的面板（来自 profile:slots 的 ui.panel 条目）
  const profilePanels = useStore((s) => s.profilePanels)

  const isBuiltin = useCallback((ref: string): ref is InspectorTabId => {
    return (INSPECTOR_TAB_REFS as readonly string[]).includes(ref)
  }, [])

  /* ---------- Tab 序列：内置（用户顺序）× 面板（manifest position） ---------- */
  const visibleBuiltin = useMemo(
    () => inspectorTabOrder.filter((t) => !hiddenInspectorTabs.includes(t)),
    [inspectorTabOrder, hiddenInspectorTabs],
  )
  const tabs: PanelTab[] = useMemo(
    () => mergePanelOrder(builtinTabsOf(visibleBuiltin), profilePanels),
    [visibleBuiltin, profilePanels],
  )
  /* v0.34.0（D54）：插件面板可见上限 —— 内置全留，插件只留前 3 个，其余进「更多」弹层 */
  const { visible: railTabs, hidden: overflowTabList } = useMemo(() => splitPluginTabs(tabs), [tabs])
  const [overflowOpen, setOverflowOpen] = useState(false)
  useEffect(() => {
    if (!overflowOpen) return
    const close = () => setOverflowOpen(false)
    // 点击任意处关闭（capture 阶段，避免被内部点击 stopPropagation 拦掉）
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [overflowOpen])

  /** 当前 Tab 的展示元信息（内置取 i18n，面板取贡献者标题） */
  const currentTab = useMemo(() => tabs.find((x) => x.ref === inspectorTab) ?? null, [tabs, inspectorTab])
  const currentLabel = currentTab
    ? currentTab.builtin
      ? t(currentTab.title)
      : currentTab.title
    : t(INSPECTOR_TAB_META[DEFAULT_INSPECTOR_TAB].label)

  /* ---------- 标签点击状态机（Task 9：修复「折叠后再次点击无法弹起」回归） ----------
   * - 折叠态：点击任意标签（含当前激活标签）→ 展开对应面板（无延迟失焦）
   * - 展开态：点击当前激活标签 → 折叠内容面板（标签栏保留）
   * - 展开态：点击非激活标签 → 仅切换内容面板 */
  const handleTabClick = useCallback(
    (tab: string) => {
      const ref = tab as InspectorTabRef
      if (rightDockCollapsed) {
        // 折叠态优先展开：即使点的是当前激活标签，也必须弹起，
        // 否则会落入「tab === inspectorTab && collapsed → 无操作」的死区
        setInspectorTab(ref)
        toggleRightDock()
        return
      }
      if (tab === inspectorTab) {
        // 展开态点击当前激活标签 → 仅折叠，标签栏保持可见
        toggleRightDock()
        return
      }
      // 展开态点击非激活标签 → 切换内容，不折叠
      setInspectorTab(ref)
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

  /* ---------- v0.17.0 F13：Tab 拖动重排 + 拖出隐藏（**仅内置**） ---------- */
  const [dragOverTab, setDragOverTab] = useState<InspectorTabId | null>(null)
  const draggedRef = useRef<InspectorTabId | null>(null)
  const didDropRef = useRef(false)

  const handleDragStart = useCallback((e: React.DragEvent, tab: InspectorTabId) => {
    draggedRef.current = tab
    didDropRef.current = false
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tab)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, tab: InspectorTabId) => {
    if (!draggedRef.current || draggedRef.current === tab) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverTab(tab)
  }, [])

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
        aria-label={currentLabel}
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
            {/* 内置面板：按 ref 分支渲染 */}
            {isBuiltin(inspectorTab) && inspectorTab !== 'browser' && <BuiltinBody tab={inspectorTab} />}
            {/* v0.33.0：工作台 / 插件贡献的面板（四态渲染 + 组件白名单） */}
            {!isBuiltin(inspectorTab) && currentTab && !currentTab.builtin && <PanelHost tab={currentTab} />}
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
        {railTabs.map((tab) => {
          const builtin = tab.builtin
          const meta = builtin ? INSPECTOR_TAB_META[tab.ref as InspectorTabId] : null
          const label = builtin && meta ? t(meta.label) : tab.title
          // v0.34.0（D54）：竖排栏展示名强制截断（含未解析模板串的情况），
          // tooltip / aria 仍用完整的 label，信息不丢
          const railLabel = builtin && meta ? label : guardLabel(label)
          const iconName = builtin && meta ? meta.icon : (tab.icon ?? 'Plug')
          const TabIcon = Icon[iconName as IconName] ?? Icon.Dot
          const active = tab.ref === inspectorTab
          const isDragOver = dragOverTab === tab.ref
          // 面板 Tab 不参与拖拽重排/隐藏（纪律 ②）
          const draggable = builtin && isBuiltin(tab.ref)
          return (
            <Tooltip
              key={tab.ref}
              label={tab.pluginId ? t('inspector.panelTabTooltip', { label, id: tab.pluginId }) : label}
              kbd={meta?.shortcut}
              placement="left"
              delay={150}
            >
              <button
                role="tab"
                aria-selected={active}
                aria-expanded={active && !rightDockCollapsed}
                aria-controls={`inspector-panel-${tab.ref}`}
                data-active={active}
                data-panel-tab={isPanelTabRef(tab.ref) ? 'true' : undefined}
                aria-label={
                  meta
                    ? t('inspector.tabAria', { label, kbd: meta.shortcut })
                    : t('inspector.panelTabAria', { label })
                }
                onClick={() => handleTabClick(tab.ref)}
                draggable={draggable}
                onDragStart={draggable ? (e) => handleDragStart(e, tab.ref as InspectorTabId) : undefined}
                onDragOver={draggable ? (e) => handleDragOver(e, tab.ref as InspectorTabId) : undefined}
                onDrop={draggable ? (e) => handleDrop(e, tab.ref as InspectorTabId) : undefined}
                onDragEnd={draggable ? handleDragEnd : undefined}
                className="inspector-toolbar__item"
                style={{
                  cursor: draggable ? 'grab' : 'pointer',
                  ...(isDragOver
                    ? { outline: '1px dashed var(--accent)', outlineOffset: '-2px' }
                    : null),
                }}
              >
                <span className="inspector-toolbar__indicator" aria-hidden="true" />
                <TabIcon width={16} height={16} aria-hidden="true" className="flex-shrink-0" />
                <span className="inspector-toolbar__label">{railLabel}</span>
              </button>
            </Tooltip>
          )
        })}

        {/* v0.34.0（D54）：插件面板溢出收纳 —— 超过 3 个时其余收进「更多」弹层 */}
        {overflowTabList.length > 0 && (
          <div className="relative mt-1 pt-2 border-t border-border-subtle px-1">
            <Tooltip
              label={t('inspector.morePluginTabs', { count: overflowTabList.length })}
              placement="left"
              delay={150}
            >
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label={t('inspector.morePluginTabsAria', { count: overflowTabList.length })}
                onClick={() => setOverflowOpen((v) => !v)}
                className="w-full flex items-center justify-center h-9 rounded-sm text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-all focus-ring"
                data-testid="inspector-more-plugin-tabs"
              >
                <Icon.MoreHorizontal width={14} height={14} aria-hidden="true" />
              </button>
            </Tooltip>
            {overflowOpen && (
              <div
                role="menu"
                aria-label={t('inspector.morePluginTabsAria', { count: overflowTabList.length })}
                data-testid="inspector-plugin-tabs-menu"
                className="absolute right-full top-0 mr-1 z-50 min-w-[160px] max-w-[240px] rounded-md border border-border-subtle bg-bg-overlay shadow-panel py-1"
              >
                {overflowTabList.map((tab) => {
                  const TabIcon = Icon[(tab.icon ?? 'Plug') as IconName] ?? Icon.Dot
                  const active = tab.ref === inspectorTab
                  return (
                    <button
                      key={tab.ref}
                      type="button"
                      role="menuitem"
                      data-active={active}
                      onClick={() => {
                        setInspectorTab(tab.ref as InspectorTabRef)
                        if (rightDockCollapsed) toggleRightDock()
                        setOverflowOpen(false)
                      }}
                      className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                    >
                      <TabIcon width={14} height={14} aria-hidden="true" className="flex-shrink-0" />
                      <span className="truncate">{tab.title}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* v0.17.0 F13：已隐藏区 — 被拖出的**内置** Tab 收纳于此，点击恢复。
            v0.33.0：面板 Tab 不参与隐藏，因此这里天然只列内置。 */}
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
