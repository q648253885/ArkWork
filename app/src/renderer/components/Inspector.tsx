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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
// ★ v0.35.0：插件**代码视图**宿主（iframe 沙箱 + postMessage 桥）
import { PluginViewHost } from './plugins/PluginViewHost'
import {
  builtinTabsOf,
  mergePanelOrder,
  isPanelTabRef,
  INSPECTOR_TAB_REFS,
  type PanelTab,
} from '@shared/utils/panel-model'
// v0.34.2（D56-c）→ v0.34.3（D58）：竖排栏**纯高度驱动折叠** ——
// 只有放不下才折叠，折叠出来的部分才进「更多」弹层。
import { computeRailLayout, hiddenBlockHeight, pickVisibleTabs } from '../utils/rail-tab-overflow'
// v0.34.3（D59）：弹层定位纯函数 —— 弹层用 Portal 逃出栏盒（栏是 overflow-x: hidden），
// 坐标由它按触发器矩形现算（见 utils/anchored-menu.ts 文件头）
import { computeAnchoredMenu, type AnchoredMenuStyle } from '../utils/anchored-menu'
// v0.34.0（D54）：展示名防御（未解析模板串 + 超长名）—— 竖排栏与面板宿主共用同一真源
import { guardLabel } from '../utils/label-guard'

const TOOL_BAR_WIDTH = 44 // 垂直标签栏宽度（保持紧凑、足够容纳 16px 图标 + 文字）

/**
 * v0.34.3（D60）：「更多」弹层的 DOM id。
 * 触发器 `aria-controls` 与弹层 `id` **必须同源**（一处常量），否则屏幕阅读器关联断掉。
 */
const MORE_MENU_ID = 'inspector-more-tabs-menu'

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
  // ★ v0.35.0：插件**代码视图**（运行期来的，与 profilePanels 分两路 —— 见 pluginSlice 头注释）
  const pluginViews = useStore((s) => s.pluginViews)

  const isBuiltin = useCallback((ref: string): ref is InspectorTabId => {
    return (INSPECTOR_TAB_REFS as readonly string[]).includes(ref)
  }, [])

  /* ---------- Tab 序列：内置（用户顺序）× 面板（manifest position） ---------- */
  const visibleBuiltin = useMemo(
    () => inspectorTabOrder.filter((t) => !hiddenInspectorTabs.includes(t)),
    [inspectorTabOrder, hiddenInspectorTabs],
  )
  const tabs: PanelTab[] = useMemo(
    () =>
      // ★ v0.35.0：三层拼接 —— 内置（用户顺序）→ 工作台面板（manifest position）
      //   → 插件代码视图（运行期 order）。第二层合并已完成一次「不重复插入」，
      //   第三层再走一次 `mergePanelOrder` 复用同一条去重与插入规则。
      mergePanelOrder(mergePanelOrder(builtinTabsOf(visibleBuiltin), profilePanels), pluginViews),
    [visibleBuiltin, profilePanels, pluginViews],
  )
  /* v0.34.3（D58）：竖排栏高度 → 可见条数
   * 用户口径（本版纠正）：「**在铺满的时候才有更多**」——
   * 只有放不下才折叠；放得下就一条都不收，数量不再是判据。
   * 高度用 ResizeObserver 实测（窗口缩放 / 左右栏拖拽都会触发）；
   * 未测量（首帧 / jsdom 无 RO）时**不折叠** —— 规则既然是「铺满才折叠」，
   * 那「还没量到高度」就绝不能假定已铺满。
   *
   * 用 `useLayoutEffect` 而非 `useEffect`：它在 DOM 变更后、**浏览器绘制前**同步跑，
   * 因此首帧拿到的就是真实高度 —— 不会出现「先渲染 9 条、下一帧才折叠」的闪跳。 */
  const railRef = useRef<HTMLDivElement | null>(null)
  const [railHeight, setRailHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = railRef.current
    if (!el) return
    const sync = () => setRailHeight(el.clientHeight)
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const reservedHeight = hiddenBlockHeight(hiddenInspectorTabs.length)
  const layout = useMemo(
    () => computeRailLayout({ total: tabs.length, availableHeight: railHeight, reservedHeight }),
    [tabs.length, railHeight, reservedHeight],
  )
  /* 可见段选取：激活面板的入口**永远可见**（否则在「更多」里点完找不到自己点了哪个） */
  const { visible: railTabs, hidden: overflowTabList } = useMemo(
    () => pickVisibleTabs(tabs, layout.visibleCount, inspectorTab),
    [tabs, layout.visibleCount, inspectorTab],
  )

  /* ---------- v0.34.3（D59 + D60）：「更多」弹层 ----------
   * D59：弹层用 createPortal 渲染到 document.body + position:fixed —— 栏盒是
   *      `overflow-x: hidden` 且仅 44px 宽，任何留在栏内的 absolute 弹层都会
   *      向左侧伸出容器盒之外、被裁成零宽（v0.34.2 的「点不开」根因）。
   * D60：开关 / 键盘 / 焦点 / aria 的完整交互契约见 04-system-design.md §D60。 */
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  /* 位置由纯函数算好再渲染 —— 避免弹层先出现在 (0,0) 再跳过去的闪帧 */
  const [moreMenuStyle, setMoreMenuStyle] = useState<AnchoredMenuStyle | null>(null)

  /** 按当前触发器矩形重算弹层位置（打开时 + 视口变化时调用） */
  const repositionMoreMenu = useCallback(() => {
    const btn = moreBtnRef.current
    if (!btn) return
    const { style } = computeAnchoredMenu(btn.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    })
    setMoreMenuStyle(style)
  }, [])

  const openMoreMenu = useCallback(() => {
    repositionMoreMenu()
    setOverflowOpen(true)
  }, [repositionMoreMenu])

  /** 收起弹层；`refocus` = 是否把焦点还给触发器（Esc 走这条） */
  const closeMoreMenu = useCallback((refocus = false) => {
    setOverflowOpen(false)
    if (refocus) moreBtnRef.current?.focus()
  }, [])

  /** 触发器点击 = 开关（E2：必须能关，否则「点了不切换」） */
  const toggleMoreMenu = useCallback(() => {
    if (overflowOpen) closeMoreMenu()
    else openMoreMenu()
  }, [overflowOpen, openMoreMenu, closeMoreMenu])

  useEffect(() => {
    if (!overflowOpen) return

    /* 关闭：外部按下才关 —— **排除触发器与弹层自身**。
     * 不排除触发器会踩到一个经典时序坑：触发器 mousedown 先把它关掉、
     * 紧接着同一手势的 click 又把它打开 ⇒ 用户看到的是「点了没反应」。 */
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (moreBtnRef.current?.contains(target)) return
      if (moreMenuRef.current?.contains(target)) return
      setOverflowOpen(false)
    }

    /* 键盘：**白名单**。
     * v0.34.2 的 `keydown → close` 是「任意键都关」—— 键盘导航会被自己人打断。 */
    const onKeyDown = (e: KeyboardEvent) => {
      const items = Array.from(
        moreMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
      )
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMoreMenu(true)
        return
      }
      if (e.key === 'Tab') {
        // 焦点要离开菜单了 → 收起（不拦截默认行为，让 Tab 正常走）
        setOverflowOpen(false)
        return
      }
      const isNav =
        e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End'
      if (!isNav) return // 其余按键一律不干预
      if (items.length === 0) return
      e.preventDefault()
      const idx = items.findIndex((node) => node === document.activeElement)
      let next: number
      if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % items.length
      else if (e.key === 'ArrowUp') next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length
      else if (e.key === 'Home') next = 0
      else next = items.length - 1
      items[next]?.focus({ preventScroll: true })
    }

    const onViewportChange = () => repositionMoreMenu()

    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    // capture：scroll 不冒泡到 window，但栏自身（overflow-y: auto）会滚动
    window.addEventListener('scroll', onViewportChange, true)

    // 打开后把焦点移到「当前激活项」（无则首项）—— 键盘打开时立刻可导航
    const items = Array.from(
      moreMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    const target = items.find((n) => n.dataset.active === 'true') ?? items[0]
    target?.focus({ preventScroll: true })

    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [overflowOpen, closeMoreMenu, repositionMoreMenu])

  /* 折叠项被「吃光」（例如窗口拉高后不再溢出）→ 顺手复位开关状态。
   * 不复位的话：触发器随 `overflowTabList.length > 0` 一起卸载、`overflowOpen`
   * 却停在 true —— 下次再溢出时触发器一出现就是「已展开」的假象。 */
  useEffect(() => {
    if (overflowOpen && overflowTabList.length === 0) setOverflowOpen(false)
  }, [overflowOpen, overflowTabList.length])

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
            {!isBuiltin(inspectorTab) && currentTab && !currentTab.builtin && !currentTab.view && (
              <PanelHost tab={currentTab} />
            )}
            {/* ★ v0.35.0：插件代码视图（iframe 沙箱 + 桥；**不复用 PanelHost** —— 两者的
                内容来源与安全模型都不同，合并会让「白名单组件」与「任意插件 HTML」
                共用一条渲染路径，安全边界就没了） */}
            {!isBuiltin(inspectorTab) && currentTab?.view && <PluginViewHost tab={currentTab} />}
          </div>
        </div>
      </div>

      {/* 垂直标签栏 — 始终常驻于窗口最右边 */}
      <div
        ref={railRef}
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

        {/* v0.34.3（D58/D59/D60）：被折叠的项（内置与面板一视同仁）进「更多」弹层。
            D59：弹层用 createPortal 渲染到 document.body + position:fixed ——
                 栏盒是 `overflow-x: hidden` 且仅 44px 宽，任何留在栏内的 absolute
                 弹层都会向容器左侧之外伸出、被裁成零宽（用户实测「更多点不开」的根因）。
            D60：内置项附快捷键提示（位置折叠了、键位仍记得住）；激活项有可见选中态。 */}
        {overflowTabList.length > 0 && (
          <div className="relative mt-1 pt-2 border-t border-border-subtle px-1">
            <Tooltip
              label={t('inspector.moreTabs', { count: overflowTabList.length })}
              placement="left"
              delay={150}
            >
              <button
                ref={moreBtnRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-controls={overflowOpen ? MORE_MENU_ID : undefined}
                aria-label={t('inspector.moreTabsAria', { count: overflowTabList.length })}
                onClick={toggleMoreMenu}
                className="w-full flex items-center justify-center h-9 rounded-sm text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-all focus-ring"
                data-testid="inspector-more-tabs"
              >
                <Icon.MoreHorizontal width={14} height={14} aria-hidden="true" />
              </button>
            </Tooltip>
            {overflowOpen &&
              moreMenuStyle &&
              createPortal(
                <div
                  ref={moreMenuRef}
                  id={MORE_MENU_ID}
                  role="menu"
                  aria-label={t('inspector.moreTabsAria', { count: overflowTabList.length })}
                  data-testid="inspector-more-tabs-menu"
                  style={moreMenuStyle}
                  className="z-50 overflow-y-auto min-w-[160px] max-w-[240px] rounded-md border border-border-subtle bg-bg-overlay shadow-panel py-1"
                >
                  {overflowTabList.map((tab) => {
                    const meta = tab.builtin ? INSPECTOR_TAB_META[tab.ref as InspectorTabId] : null
                    const label = meta ? t(meta.label) : guardLabel(tab.title)
                    const TabIcon = Icon[(meta?.icon ?? tab.icon ?? 'Plug') as IconName] ?? Icon.Dot
                    const active = tab.ref === inspectorTab
                    return (
                      <button
                        key={tab.ref}
                        type="button"
                        role="menuitem"
                        data-active={active}
                        tabIndex={-1}
                        title={label}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => {
                          setInspectorTab(tab.ref as InspectorTabRef)
                          if (rightDockCollapsed) toggleRightDock()
                          setOverflowOpen(false)
                        }}
                        className={`w-full flex items-center gap-1.5 pl-1.5 pr-2 py-1.5 text-left text-xs transition-colors ${
                          active
                            ? 'bg-bg-overlay-l2 text-text-primary'
                            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        {/* 激活指示条 —— 与竖排栏 `.inspector-toolbar__indicator` 同一视觉语言
                            （2px `--accent`）。用显式条件类而非 data-* 变体：契约用例要能断言
                            「除了属性之外，确实存在样式绑定」。 */}
                        <span
                          aria-hidden="true"
                          className={`w-[2px] h-4 rounded-full flex-shrink-0 ${active ? 'bg-accent' : 'bg-transparent'}`}
                        />
                        <TabIcon width={14} height={14} aria-hidden="true" className="flex-shrink-0" />
                        <span className="truncate">{label}</span>
                        {meta && (
                          <span className="ml-auto flex-shrink-0 text-2xs text-text-faint">{meta.shortcut}</span>
                        )}
                      </button>
                    )
                  })}
                </div>,
                document.body,
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
