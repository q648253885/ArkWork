/* ============================================================
 * ArkWork — Renderer Root App (v0.13.0)
 * 新信息架构：三栏布局（Sidebar / Center / Inspector）
 *   - Sidebar（240px，可折叠为 64px）：任务线程 + 能力入口（不提供模块页导航）
 *   - CenterStage：任务对话（TaskHeader → PlanChecklist → Conversation → Composer）
 *   - Inspector（360px，可拖 280–480px）：诊断面板（Tools / Files / Context / Todos / Logs / Browser）
 *
 * 快捷键（v0.13.0）：
 *   ⌘K    Quick Action（四源：/ > @ #）
 *   ⌘P    快速打开（QuickOpen）
 *   ⌘N    新建任务
 *   ⌘B    折叠 / 展开 Sidebar
 *   ⌘J    折叠 / 展开 Inspector
 *   ⌘E    PreviewWindow 浮窗
 *   ⌘,    设置
 *   ⌘?    HelpCenter（Task 14 全局帮助）
 *   ⌘/    HelpCenter 备选快捷键
 *   ⌘1~6  Sidebar 能力入口直达（Agents/Skills/KB/Memory/Automations/Settings）
 *   ⌥1~5  Inspector Tab 直达（Todos/Context/Files/Logs/Browser）
 *   Esc    按优先级关闭浮层
 * ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, type InspectorTabId, type ModulePage } from './store'
import type { PermissionMode } from '@shared/types/permission'
import { Icon } from './icons'
import { Tooltip } from './components/ui'
import { CenterStage } from './components/CenterStage'
import { QuickAction } from './components/QuickAction'
import { Sidebar, CAPABILITY_ENTRIES } from './components/Sidebar'
import { Inspector } from './components/Inspector'
import { TopBar } from './components/TopBar'
import { ToastLayer } from './components/ToastLayer'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Editors } from './components/Editors'
import { OnboardingLayer } from './components/OnboardingLayer'
import { PreviewWindow } from './components/preview/PreviewWindow'
import { QuickOpen } from './components/QuickOpen'
import { HelpCenter } from './components/HelpCenter'
import { ToolConfirmLayer } from './components/ToolConfirmLayer'

export default function App() {
  const { t } = useTranslation()
  const settingsOpen = useStore((s) => s.settingsOpen)
  // redesign-workspace-navigation Task 3：settingsOpen Modal 已下线（settings 走 modulePage），
  // 保留订阅仅为兼容旧代码读取；渲染层不再出现 SettingsDialog。
  void settingsOpen
  const init = useStore((s) => s.init)
  const subscribeAll = useStore((s) => s.subscribeAll)
  const leftNavCollapsed = useStore((s) => s.leftNavCollapsed)
  const setLeftNavCollapsed = useStore((s) => s.setLeftNavCollapsed)
  const sidebarWidth = useStore((s) => s.sidePanelWidth)
  const setSidebarWidth = useStore((s) => s.setSidePanelWidth)
  const rightDockCollapsed = useStore((s) => s.rightDockCollapsed)

  // v0.14.0 Task 9：Esc 暂停/停止确认弹窗（任务 running 期间按 Esc 触发，避免误触）
  const [escPauseTask, setEscPauseTask] = useState<{ id: string; title: string } | null>(null)
  const escPauseRef = useRef(escPauseTask)
  escPauseRef.current = escPauseTask

  // 启动时初始化数据 & 订阅事件
  useEffect(() => {
    void init()
    const unsub = subscribeAll()
    return unsub
  }, [init, subscribeAll])

  // 全局快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const alt = e.altKey

      // Task 14：⌘? / ⌘/ — 打开 / 关闭 HelpCenter
      // 与 ⌘, 设置并列；Esc 由组件自身处理关闭。
      if (meta && !alt && !e.shiftKey && (key === '?' || key === '/')) {
        e.preventDefault()
        useStore.getState().toggleHelp()
        return
      }

      // ⌘K — Quick Action（v0.13.0 替代 CommandPalette）
      if (meta && key === 'k') {
        e.preventDefault()
        const s = useStore.getState()
        s.setCmdPaletteOpen(!s.cmdPaletteOpen)
        return
      }

      // ⌘P — QuickOpen（文件快速切换）
      if (meta && key === 'p' && !e.shiftKey) {
        e.preventDefault()
        const s = useStore.getState()
        s.setQuickOpenOpen(!s.quickOpenOpen)
        return
      }

      // ⌘N — 新建任务
      if (meta && key === 'n' && !e.shiftKey) {
        e.preventDefault()
        const s = useStore.getState()
        if (s.modulePage) s.closeModulePage()
        void s.createTask({ title: '', text: '' })
        window.dispatchEvent(new Event('composer:focus'))
        return
      }

      // ⌘B — 折叠 Sidebar（v0.13.0）
      if (meta && key === 'b') {
        e.preventDefault()
        useStore.getState().toggleLeftNav()
        return
      }

      // ⌘J — 折叠 Inspector（v0.13.0）
      if (meta && key === 'j') {
        e.preventDefault()
        const s = useStore.getState()
        s.toggleRightDock()
        return
      }

      // ⌘E — 开关 PreviewWindow 浮窗
      if (meta && key === 'e') {
        e.preventDefault()
        const s = useStore.getState()
        if (s.previewWindow) s.closePreview()
        else s.openPreview('').catch(() => { /* 占位，无害 */ })
        return
      }

      // ⌘, — 设置页面（redesign Task 3：替代旧 Modal）
      if (meta && key === ',') {
        e.preventDefault()
        const s = useStore.getState()
        if (s.modulePage === 'settings') s.closeModulePage()
        else s.openModulePage('settings')
        return
      }

      // ⌘⇧W — 打开工作区切换器
      if (meta && key === 'w' && e.shiftKey) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('topbar:open-workspace'))
        return
      }

      // redesign-workspace-navigation Task 3：⌘1~6 — Sidebar 能力入口直达
      // （Agents / Skills / KB / Memory / Automations / Settings）
      // 设置已迁移为 modulePage='settings'，不再打开 Modal。
      if (meta && !alt && /^[1-6]$/.test(e.key)) {
        e.preventDefault()
        const s = useStore.getState()
        const idx = Number(e.key)
        const pages: ModulePage[] = ['agents', 'skills', 'kb', 'memory', 'automations', 'settings']
        const page = pages[idx - 1]
        if (page) s.openModulePage(page)
        return
      }

      // v0.13.0：⌥1~6 Inspector 直达 → fix-workspace-task-automation-memory Task 5：⌥1~5
      // v0.27.0 r10-F14a：终端纳入 Inspector 后扩展 ⌥6
      // ⌥N 命中时同步展开内容面板（即使之前是折叠态）。
      if (alt && !meta && /^[1-6]$/.test(e.key)) {
        e.preventDefault()
        const s = useStore.getState()
        const idx = Number(e.key) - 1
        const tab = s.inspectorTabOrder.filter((t) => !s.hiddenInspectorTabs.includes(t))[idx] as
          | InspectorTabId
          | undefined
        if (tab) {
          s.setInspectorTab(tab)
          if (s.rightDockCollapsed) s.toggleRightDock()
        }
        return
      }

      // v0.15.0：Shift+Tab — 循环切换权限模式
      // 表单内（input/textarea/select/contentEditable）保留原生 Shift+Tab 行为。
      // v0.28.0（F6）：循环扩为四态（默认→自动放行→接受编辑→只读）；
      // bypassPermissions 不参与循环 —— 只能经 Composer 下拉/设置页二次确认进入；
      // 处于 bypass 时按 Shift+Tab 回到 default（indexOf=-1 → 0）。
      if (e.key === 'Tab' && e.shiftKey && !(e.metaKey || e.ctrlKey || e.altKey)) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (target && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable)) {
          return
        }
        e.preventDefault()
        const s = useStore.getState()
        const ORDER: PermissionMode[] = ['default', 'autoApprove', 'acceptEdits', 'plan']
        const next = ORDER[(ORDER.indexOf(s.permissionMode) + 1) % ORDER.length]
        void s.setPermissionMode(next)
        const LABELS: Record<PermissionMode, string> = {
          default: t('app.permissionMode.default'),
          autoApprove: t('app.permissionMode.autoApprove'),
          acceptEdits: t('app.permissionMode.acceptEdits'),
          plan: t('app.permissionMode.plan'),
          bypassPermissions: t('app.permissionMode.bypass'),
        }
        s.pushToast({ type: 'success', message: LABELS[next], duration: 2000 })
        return
      }

      // Escape — 按优先级关闭（设置 Modal 已下线，settings 走 modulePage 路径）
      if (e.key === 'Escape') {
        const s = useStore.getState()
        // Task 14：HelpCenter 最高优先级（任何浮层之先）
        if (s.helpOpen) { s.setHelpOpen(false); return }
        if (s.quickOpenOpen) { s.setQuickOpenOpen(false); return }
        if (s.cmdPaletteOpen) { s.setCmdPaletteOpen(false); return }
        if (s.confirmDialog.open) { return }
        if (s.pendingConfirm) { return }   // 工具确认层自处理 Esc（dismissed）
        if (s.previewWindow) { s.closePreview(); return }
        if (s.modulePage) { s.closeModulePage(); return }
        // v0.14.0 Task 9：Esc 暂停/停止确认 —— 任务 running 期间按 Esc 弹出
        // 确认（暂停/停止二选一），避免误触；弹窗已打开时再次 Esc 关闭它。
        if (escPauseRef.current) { setEscPauseTask(null); return }
        const runningTask = s.tasks.find((t) => t.status === 'running')
        if (runningTask) {
          e.preventDefault()
          setEscPauseTask({ id: runningTask.id, title: runningTask.title })
          return
        }
        if (!s.rightDockCollapsed) {
          s.toggleRightDock()
          return
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Sidebar 拖拽
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    const move = (mv: MouseEvent) => setSidebarWidth(startW + (mv.clientX - startX))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [sidebarWidth, setSidebarWidth])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-base text-text-primary">
      <TopBar />
      <div className="flex flex-1 min-h-0 relative">
        {/* v0.13.0 Sidebar — 可折叠为 64px 图标栏 */}
        {leftNavCollapsed ? (
          <CollapsedSidebar onExpand={() => setLeftNavCollapsed(false)} />
        ) : (
          <Sidebar width={sidebarWidth} onResizeStart={startSidebarResize} />
        )}

        {/* 中栏 — 任务对话 / 模块页，二者互斥 */}
        <div className="flex-1 min-w-0 min-h-0 relative flex flex-col overflow-hidden">
          <CenterStage />
        </div>

        {/* Task 5 — IntelliJ 式右侧工具窗口栏始终常驻；模块页打开时仅折叠内容，
            Browser 等标签仍保持可访问。 */}
        <Inspector />

        {/* v0.7.0 F710：PreviewWindow 浮窗 */}
        <PreviewWindow />
      </div>

      {/* v0.13.0：QuickAction（⌘K，四源 / > @ #）取代 CommandPalette */}
      <QuickAction />
      <QuickOpen />

      {/* 全局浮层 */}
      <ToastLayer />
      <ConfirmDialog />
      {/* v0.8.1：工具执行确认浮层（Agent 请求执行 shell/写命令时展示，必须挂载，
          否则 pendingConfirm 只在 store 中设置、无组件渲染 → 写命令等满 60s 超时
          → 模型重试 → 看起来"一直卡住"且永远无法写入） */}
      <ToolConfirmLayer />
      {escPauseTask && (
        <EscPauseDialog task={escPauseTask} onClose={() => setEscPauseTask(null)} />
      )}
      <Editors />
      <OnboardingLayer />

      {/* redesign-workspace-navigation Task 3：Settings Modal 已下线，
          设置改走 modulePage='settings'（ModulePage 渲染）。Task 4 将接入五分区。 */}

      {/* Task 14：HelpCenter 全局帮助（⌘? / ⌘/ 触发） */}
      <HelpCenter />

      <StatusBar />
    </div>
  )
}

/* ============================================================
 * EscPauseDialog — v0.14.0 Task 9（US10）
 * 任务 running 期间按 Esc 弹出的「暂停/停止」二选一确认弹窗，避免误触。
 *  - 暂停 → store.pauseTask（主进程落盘 checkpoint + 置 paused）
 *  - 停止 → store.cancelTask（终止任务）
 *  - 取消 / Esc / 点击背景 → 关闭，任务继续运行
 * ============================================================ */
function EscPauseDialog({
  task,
  onClose,
}: {
  task: { id: string; title: string }
  onClose: () => void
}) {
  const pauseTask = useStore((s) => s.pauseTask)
  const cancelTask = useStore((s) => s.cancelTask)
  const { t } = useTranslation()

  return (
    // Phase A Task 3：EscPauseDialog 背景不再点击关闭（防误触），仅 Esc 与按钮关闭
    <div className="dialog-backdrop" onClick={(e) => e.stopPropagation()} role="presentation">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="esc-pause-dialog-title"
      >
        <div id="esc-pause-dialog-title" className="dialog__title">
          {t('app.escPause.running')}
        </div>
        <div className="dialog__body">
          {t('app.escPause.body', { title: task.title })}
        </div>
        <div className="dialog__actions">
          <button className="btn-ghost" onClick={onClose}>
            {t('app.escPause.cancel')}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              onClose()
              void pauseTask(task.id)
            }}
          >
            {t('app.escPause.pause')}
          </button>
          <button
            className="btn-danger"
            onClick={() => {
              onClose()
              void cancelTask(task.id)
            }}
          >
            {t('app.escPause.stop')}
          </button>
        </div>
        {/* Phase A Task 3：明确告知用户关闭方式，避免误以为背景点击可关 */}
        <div className="text-2xs text-text-tertiary text-center mt-2">
          {t('app.escPause.closeHint')}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
 * 折叠态 Sidebar（64px 图标栏）：
 * - 顶部展开按钮 + Icon.Plus 居中新建任务（与展开态共享同一份数据）
 * - 下方能力入口图标（与展开态 CAPABILITY_ENTRIES 同源，
 *   顺序一致：智能体 / 技能 / 知识 / 记忆 / 自动化 / 设置）
 * ============================================================ */
function CollapsedSidebar({ onExpand }: { onExpand: () => void }) {
  const createTask = useStore((s) => s.createTask)
  const openModulePage = useStore((s) => s.openModulePage)
  const modulePage = useStore((s) => s.modulePage)
  const { t } = useTranslation()
  // v0.13.1 fix-workspace-task-automation-memory Task 1：
  // 折叠态入口顺序与展开态完全同源（CAPABILITY_ENTRIES）。
  const collapsedEntries = CAPABILITY_ENTRIES.map((e) => ({
    page: e.page,
    icon: e.icon,
    label: e.label,
    shortcut: e.shortcut,
  }))
  return (
    <div className="collapsed-sidebar flex flex-col items-center w-16 h-full bg-bg-base border-r border-border-subtle select-none flex-shrink-0">
      <Tooltip label={t('app.collapsed.expand')} kbd="⌘B" placement="right">
        <button
          onClick={onExpand}
          aria-label={t('app.collapsed.expand')}
          className="w-9 h-9 mt-2 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
        >
          <Icon.ChevronRight width={18} height={18} />
        </button>
      </Tooltip>
      <Tooltip label={t('app.collapsed.newTask')} kbd="⌘N" placement="right">
        <button
          onClick={() => void createTask({ title: '', text: '' })}
          className="collapsed-sidebar__new-task mt-1 w-9 h-9 flex items-center justify-center rounded-md bg-accent hover:bg-accent-hover text-text-inverse transition-colors focus-ring"
          aria-label={t('app.collapsed.newTask')}
        >
          <Icon.Plus width={18} height={18} />
        </button>
      </Tooltip>
      <div className="w-8 h-px bg-border-subtle my-2" />
      {collapsedEntries.map((m) => {
        const active = modulePage === m.page
        const ModuleIcon = Icon[m.icon]
        const entryLabel = t(m.label)
        return (
          <Tooltip key={m.page} label={`${entryLabel} ${m.shortcut}`} placement="right" delay={150}>
            <button
              onClick={() => openModulePage(m.page)}
              aria-label={entryLabel}
              className={`collapsed-sidebar__entry w-9 h-9 my-0.5 flex items-center justify-center rounded-md transition-colors focus-ring ${
                active ? 'bg-accent-soft text-accent' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <ModuleIcon width={18} height={18} />
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

/* ============================================================
 * StatusBar — v0.13.0 简化：就绪指示 / 当前任务 / 记忆预算 / 主题 / 折叠
 * ============================================================ */
function StatusBar() {
  const { t } = useTranslation()
  const tasks = useStore((s) => s.tasks)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const memory = useStore((s) => s.memory)
  const theme = useStore((s) => s.theme)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const cycleTheme = useStore((s) => s.cycleTheme)
  const rightDockCollapsed = useStore((s) => s.rightDockCollapsed)
  const leftNavCollapsed = useStore((s) => s.leftNavCollapsed)
  const toggleRightDock = useStore((s) => s.toggleRightDock)
  const toggleLeftNav = useStore((s) => s.toggleLeftNav)
  const models = useStore((s) => s.models)
  const selectedModelId = useStore((s) => s.selectedModelId)
  const task = tasks.find((t) => t.id === selectedTaskId)
  const model = models.find((m) => m.id === selectedModelId)

  const runningCount = tasks.filter((t) => t.status === 'running').length
  const contextSize = useStore((s) => s.contextSize)
  const injectedTokens = contextSize?.payloadTokens
    ?? memory
      .filter((m) => m.enabled && !m.archivedAt && (m.layer === 'L1' || m.layer === 'L3'))
      .reduce((sum, m) => sum + m.tokens, 0)
  // 百分比分母用引擎真实预算（≈窗口×85%，封顶 64K），对齐压缩触发线
  const ctxBudget = contextSize?.budget ?? model?.contextWindow ?? 128_000
  const ctxWindow = contextSize?.modelContextWindow ?? model?.contextWindow ?? ctxBudget
  const memPct = Math.min(100, Math.round((injectedTokens / ctxBudget) * 100))

  const themeIcon = theme === 'light' ? 'Sun' : theme === 'dark' ? 'Moon' : 'System'
  const themeLabel = theme === 'light'
    ? t('app.status.theme.light')
    : theme === 'dark'
    ? t('app.status.theme.dark')
    : t('app.status.theme.system', { resolved: resolvedTheme === 'dark' ? t('app.status.theme.systemDark') : t('app.status.theme.systemLight') })

  return (
    <div className="flex items-center gap-2 h-6 px-3 border-t border-border-subtle bg-bg-base text-2xs text-text-tertiary flex-shrink-0">
      <Tooltip label={t('app.status.systemReady')} desc={t('app.status.systemReadyDesc')}>
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-success flex-shrink-0 cursor-help" />
      </Tooltip>
      <span>{t('app.status.ready')}</span>

      {runningCount > 0 && (
        <span className="flex items-center gap-1 text-accent">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent pulse-dot" />
          {t('app.status.running', { count: runningCount })}
        </span>
      )}

      {task && (
        <span className="truncate max-w-[240px]">
          <span className="text-text-secondary">{t('app.status.taskPrefix', { title: task.title })}</span>
        </span>
      )}

      <Tooltip label={t('app.status.memoryCtxLabel')} desc={t('app.status.memoryCtxDesc', { used: injectedTokens.toLocaleString(), budget: ctxBudget.toLocaleString(), pct: memPct, window: ctxWindow.toLocaleString() })}>
        <span className="hidden md:inline truncate max-w-[200px] cursor-help">
          <span className="text-text-tertiary">{t('app.status.memory')} </span>
          <span className="tabular" style={{ color: memPct > 80 ? 'var(--warning)' : 'var(--text-secondary)' }}>
            {memPct}%
          </span>
        </span>
      </Tooltip>

      {model && (
        <Tooltip label={t('app.status.currentModel')} desc={`${model.name || model.id} · ${model.kind}`}>
          <span className="truncate max-w-[180px] hidden lg:inline cursor-help">
            <span className="text-text-secondary">{model.name || model.id}</span>
          </span>
        </Tooltip>
      )}

      <div className="flex-1" />

      {/* v0.13.0：左右栏折叠按钮（图标 + 快捷键） */}
      <Tooltip label={leftNavCollapsed ? t('app.status.expandLeft') : t('app.status.collapseLeft')} kbd="⌘B" delay={150}>
        <button
          onClick={() => toggleLeftNav()}
          aria-label={leftNavCollapsed ? t('app.status.expandLeftAria') : t('app.status.collapseLeftAria')}
          className="hidden md:flex items-center gap-1 h-6 min-w-8 px-1.5 rounded hover:text-text-primary transition-colors focus-ring"
        >
          <Icon.ChevronLeft
            width={14}
            height={14}
            className={leftNavCollapsed ? 'text-text-tertiary' : 'text-accent'}
          />
          <span>{t('app.status.left')}</span>
        </button>
      </Tooltip>
      <Tooltip label={rightDockCollapsed ? t('app.status.expandRight') : t('app.status.collapseRight')} kbd="⌘J" delay={150}>
        <button
          onClick={() => toggleRightDock()}
          aria-label={rightDockCollapsed ? t('app.status.expandRightAria') : t('app.status.collapseRightAria')}
          className="hidden md:flex items-center gap-1 h-8 min-w-8 px-1.5 rounded hover:text-text-primary transition-colors focus-ring"
        >
          <Icon.ChevronRight
            width={14}
            height={14}
            className={rightDockCollapsed ? 'text-text-tertiary' : 'text-accent'}
          />
          <span>{t('app.status.right')}</span>
        </button>
      </Tooltip>

      <Tooltip label={t('app.status.theme')} desc={t('app.status.themeDesc', { theme: themeLabel })} delay={150}>
        <button
          onClick={() => void cycleTheme()}
          aria-label={t('app.status.theme.aria')}
          className="flex items-center gap-1 h-6 px-1.5 rounded hover:text-text-primary transition-colors focus-ring"
        >
          {themeIcon === 'Sun' ? <Icon.Sun width={14} height={14} />
            : themeIcon === 'Moon' ? <Icon.Moon width={14} height={14} />
            : <Icon.System width={14} height={14} />}
          <span>{theme === 'system' ? t('app.status.theme.systemShort') : themeLabel}</span>
        </button>
      </Tooltip>

      <span className="text-border-default">│</span>
      <Tooltip label="Quick Action" kbd="⌘K" placement="top">
        <span className="cursor-help">
          <span className="text-accent">⌘K</span> {t('app.status.panel')}
        </span>
      </Tooltip>
    </div>
  )
}
