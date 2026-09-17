/* ============================================================
 * ArkWork — Renderer Root App (v0.13.0)
 * 新信息架构：三栏布局（Sidebar / Center / Inspector）
 *   - Sidebar（240px，可折叠为 64px）：任务线程 + 能力入口（不提供模块页导航）
 *   - CenterStage：任务对话（TaskHeader → PlanChecklist → Conversation → Composer）
 *   - Inspector（360px，可拖 280–480px）：诊断面板（Tools / Files / Context / Todos / Logs / Browser）
 *
 * 快捷键（v0.31.0 B0 起**已中央化**）：
 *   全部全局键位声明在 `renderer/keymap/spec.ts`，处理函数在 `renderer/keymap/actions.ts`，
 *   本文件只负责注册与挂监听。**不要在本文件（或任何组件）里再加 keydown 判定** ——
 *   需要新键位时改注册表，展示时用 `useChord()`。
 *   （逐条对应关系与迁移偏差见 docs/versions/v0.31.0/04-system-design.md）
 * ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from './store'
// B0：键位提示一律经 keymap 产出（chordText/useChord），不得在 JSX 内写裸修饰键符号
import { chordText, IS_MAC, registerDefaultKeybindings, runDispatch, snapshotContext } from './keymap'
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

  // 全局快捷键（v0.31.0 B0：中央化到 renderer/keymap 注册表）
  //
  // 迁移前的 13 分支 if 链已逐条搬入 keymap/spec.ts（声明）与 keymap/actions.ts（处理），
  // 此处只剩「注册一次 + 挂一个监听」，不再有任何和弦判定。
  // 分层原因：`when` 门控、优先级消歧、平台归一都需要在同一处实现，
  // 否则 B2 起的编辑器键位会再次回到"各组件自己 addEventListener"的老路（03-interaction §5.4 明令禁止）。
  useEffect(() => {
    const unregister = registerDefaultKeybindings({
      // Esc 链的暂停确认弹窗是 App 组件局部态，故经宿主回调解耦（不把 React 组件塞进注册表）
      isPauseConfirmOpen: () => escPauseRef.current !== null,
      closePauseConfirm: () => setEscPauseTask(null),
      openPauseConfirm: (task) => setEscPauseTask(task),
    })
    const handler = (e: KeyboardEvent): void => {
      // handler 自持 preventDefault（迁移前各分支的拦截时机各不相同，统一拦会吃掉原生行为），
      // 这里只负责送进注册表；返回值是冒泡语义，调用方无需使用。
      runDispatch(e, snapshotContext(), IS_MAC)
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      unregister()
    }
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

      {/* v0.13.0：QuickAction（Mod+K，四源 / > @ #）取代 CommandPalette */}
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

      {/* Task 14：HelpCenter 全局帮助（Mod+? / Mod+/ 触发） */}
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
      <Tooltip label={t('app.collapsed.expand')} kbd={chordText('Mod+B')} placement="right">
        <button
          onClick={onExpand}
          aria-label={t('app.collapsed.expand')}
          className="w-9 h-9 mt-2 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors focus-ring"
        >
          <Icon.ChevronRight width={18} height={18} />
        </button>
      </Tooltip>
      <Tooltip label={t('app.collapsed.newTask')} kbd={chordText('Mod+N')} placement="right">
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
      <Tooltip label={leftNavCollapsed ? t('app.status.expandLeft') : t('app.status.collapseLeft')} kbd={chordText('Mod+B')} delay={150}>
        <button
          onClick={() => toggleLeftNav()}
          aria-label={
            leftNavCollapsed
              ? t('app.status.expandLeftAria', { kbd: chordText('Mod+B') })
              : t('app.status.collapseLeftAria', { kbd: chordText('Mod+B') })
          }
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
      <Tooltip label={rightDockCollapsed ? t('app.status.expandRight') : t('app.status.collapseRight')} kbd={chordText('Mod+J')} delay={150}>
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
      <Tooltip label="Quick Action" kbd={chordText('Mod+K')} placement="top">
        <span className="cursor-help">
          <span className="text-accent">{chordText('Mod+K')}</span> {t('app.status.panel')}
        </span>
      </Tooltip>
    </div>
  )
}
