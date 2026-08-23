/* ============================================================
 * ArkWork — RightDock (v0.9.0 F901 + F905)
 * 任务上下文 Dock：文件 / 上下文 / 终端 / 浏览器 / 任务清单
 * - 默认宽度 320px，拖拽 300–520px，⌘J 开关（按工作区持久化）
 * - Tab 集合/排序/默认选中随智能体自适应（预设 × 用户偏好覆盖，doc 03）
 * - 切换智能体：200ms 交叠动画 + 一次性轻提示条（[还原][自定义…]）
 * - context Tab 不可移除；用户隐藏 Tab 后 customized 置位，预设不再覆盖
 * - 无任务/模块页模式不渲染（由 App 控制）
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { useStore, DOCK_TAB_META, AGENT_DOCK_PRESETS, DEFAULT_PRESET, type DockPrefs } from '../store'
import type { DockTabId } from '@shared/types/agent'
import { Tooltip } from './ui'
import { Icon, type IconName } from '../icons'
import { getEnabledDockTabIds, DOCK_TAB_WIDGET } from './sidebarRegistry'

export function RightDock() {
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const agents = useStore((s) => s.agents)
  const activeDockTab = useStore((s) => s.activeDockTab)
  const setActiveDockTab = useStore((s) => s.setActiveDockTab)
  const dockTabs = useStore((s) => s.dockTabs)
  const dockPrefs = useStore((s) => s.dockPrefs)
  const setDockPrefs = useStore((s) => s.setDockPrefs)
  const resetDockPrefs = useStore((s) => s.resetDockPrefs)
  const dockNotice = useStore((s) => s.dockNotice)
  const setDockNotice = useStore((s) => s.setDockNotice)
  const rightDockWidth = useStore((s) => s.rightDockWidth)
  const setRightDockWidth = useStore((s) => s.setRightDockWidth)

  const [menuAgent, setMenuAgent] = useState<DockTabId | null>(null) // 右键自定义菜单归属

  const agent = agents.find((a) => a.id === selectedAgentId)
  // Task 2：按智能体启用的侧边栏 widget 过滤 Dock Tab（widget 可用性层）
  // dockTabs（store，预设×用户偏好）→ visibleTabs（再交 enabledSidebarWidgetIds 过滤）
  const enabledDockTabIds = getEnabledDockTabIds(agent)
  const visibleTabs: DockTabId[] = dockTabs.filter((t) => enabledDockTabIds.has(t))
  const visibleTabsKey = visibleTabs.join(',')
  const prevTabsRef = useRef<string>(visibleTabsKey)
  // 当前选中 Tab 被该智能体禁用时 → 回落到首个可见 Tab（store 的 activeDockTab 可能暂未同步）
  const effectiveActiveTab: DockTabId | undefined =
    visibleTabs.length > 0
      ? (visibleTabs.includes(activeDockTab) ? activeDockTab : visibleTabs[0])
      : undefined

  const prefs: DockPrefs | undefined = dockPrefs[selectedAgentId]
  const isCustomized = !!prefs?.customized

  // F905 §5.2：智能体切换 → 布局变化 → 一次性轻提示条（3s 自动消失）
  useEffect(() => {
    const prev = prevTabsRef.current
    if (prev !== visibleTabsKey) {
      prevTabsRef.current = visibleTabsKey
      const topTab = visibleTabs[0]
      const topLabel = topTab ? DOCK_TAB_META[topTab].label : ''
      const name = agent?.name ?? selectedAgentId.replace('@', '')
      setDockNotice(`已为 @${name} 调整工作台 · ${topLabel}已置顶`)
    }
    const timer = setTimeout(() => setDockNotice(null), 3000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabsKey, selectedAgentId, agent?.name, setDockNotice])

  // F905 §5.3 兜底：当前选中 Tab 不在集合 → 默认选中 defaultTab（store 已处理）

  const hideTab = (tab: DockTabId) => {
    if (tab === 'context' || tab === 'browser') return // context 与 browser 为核心入口，不可移除
    if (visibleTabs.length <= 2) return // 最少 2 个（按可见 Tab 计）
    const next = dockTabs.filter((t) => t !== tab)
    const prefsForAgent: DockPrefs = {
      tabs: next,
      defaultTab: next.includes(prefs?.defaultTab ?? '')
        ? (prefs?.defaultTab ?? next[0])
        : next[0],
      customized: true,
    }
    setDockPrefs(selectedAgentId, prefsForAgent)
    setMenuAgent(null)
  }

  const openCustomize = (tab: DockTabId) => {
    setActiveDockTab(tab)
    setMenuAgent(null)
  }

  const startResize = (e: React.MouseEvent) => {
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
  }

  return (
    <div
      className="relative flex flex-col h-full bg-bg-base border-l border-border-subtle flex-shrink-0 select-none"
      style={{ width: rightDockWidth }}
    >
      {/* 左边缘 resize handle */}
      <Tooltip label="拖拽调整宽度" desc="300–520px 之间自由拖动" placement="left">
        <div
          onMouseDown={startResize}
          className="absolute left-0 top-0 bottom-0 w-px cursor-col-resize bg-border-subtle hover:bg-accent hover:w-[2px] transition-all z-10"
        />
      </Tooltip>

      {/* Tab 条（图标 + 文字，随智能体自适应；右键自定义） */}
      <div className="flex items-stretch h-9 flex-shrink-0 border-b border-border-subtle overflow-hidden">
        {visibleTabs.map((tab, i) => {
          const meta = DOCK_TAB_META[tab]
          const active = tab === effectiveActiveTab
          return (
            <Tooltip
              key={tab}
              label={meta.label}
              kbd={meta.shortcut}
              desc="右键可自定义此 Tab"
              delay={150}
            >
              <button
                onClick={() => setActiveDockTab(tab)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenuAgent(tab)
                }}
                aria-label={`${meta.label} ${meta.shortcut}（右键自定义）`}
                className={`relative flex items-center gap-1.5 px-2.5 h-9 text-xs font-medium transition-all duration-200 whitespace-nowrap ${
                  active
                    ? 'text-text-primary'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
                }`}
                style={{ animation: active ? 'fade-in-up 0.2s ease' : undefined }}
              >
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {(() => {
                    const IconComp = Icon[meta.icon as IconName]
                    return IconComp ? (
                      <IconComp width={14} height={14} aria-hidden="true" />
                    ) : (
                      <span>{meta.icon}</span>
                    )
                  })()}
                  <span>{meta.label}</span>
                </span>
                {active && (
                  <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-accent rounded-full" />
                )}
                {/* 视觉序号（⌥1~5 按所见顺序映射） */}
                <span className="text-2xs text-text-tertiary tabular hidden">{i + 1}</span>
              </button>
            </Tooltip>
          )
        })}

        {/* 右侧：自定义 / 还原 */}
        <div className="flex-1" />
        {isCustomized && (
          <Tooltip label="还原默认布局" desc="撤销对该智能体的面板顺序自定义">
            <button
              onClick={() => resetDockPrefs(selectedAgentId)}
              className="px-2 text-2xs text-text-tertiary hover:text-accent transition-colors"
            >
              还原
            </button>
          </Tooltip>
        )}
      </div>

      {/* 智能体切换轻提示条 */}
      {dockNotice && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-2xs text-text-secondary bg-accent-soft border-b border-border-subtle slide-in">
          <span className="flex-1 truncate">{dockNotice}</span>
          <button
            onClick={() => resetDockPrefs(selectedAgentId)}
            className="text-accent hover:underline"
          >
            还原
          </button>
          <button
            onClick={() => setMenuAgent(effectiveActiveTab ?? activeDockTab)}
            className="text-text-tertiary hover:text-text-primary"
          >
            自定义…
          </button>
        </div>
      )}

      {/* 当前 Tab 面板（Task 2：经 sidebarRegistry 渲染，替代硬编码 switch） */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {(() => {
          const widget = effectiveActiveTab ? DOCK_TAB_WIDGET[effectiveActiveTab] : undefined
          if (!widget) return null
          const Panel = widget.component
          return <Panel />
        })()}
      </div>

      {/* 右键自定义菜单 */}
      {menuAgent && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenuAgent(null)} />
          <div className="absolute right-2 top-9 z-30 w-44 py-1 bg-bg-overlay border border-border-subtle rounded-md shadow-panel scale-in">
            <div className="px-3 py-1.5 text-2xs text-text-tertiary uppercase tracking-wider font-medium">
              {DOCK_TAB_META[menuAgent].label} Tab
            </div>
            <button
              onClick={() => hideTab(menuAgent)}
              disabled={menuAgent === 'context' || menuAgent === 'browser' || visibleTabs.length <= 2}
              className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              隐藏此 Tab
              {(menuAgent === 'context' || menuAgent === 'browser') && <span className="text-2xs text-text-tertiary ml-1">（固定）</span>}
            </button>
            <button
              onClick={() => openCustomize(menuAgent)}
              className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              打开面板
            </button>
            <div className="my-1 border-t border-border-subtle" />
            <button
              onClick={() => { resetDockPrefs(selectedAgentId); setMenuAgent(null) }}
              className="w-full text-left px-3 py-2 text-sm text-accent hover:bg-accent-soft transition-colors"
            >
              还原默认布局
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** 供外部使用：某智能体的预设（未定制时） */
export function presetOf(agentId: string): typeof DEFAULT_PRESET {
  return AGENT_DOCK_PRESETS[agentId] ?? DEFAULT_PRESET
}
