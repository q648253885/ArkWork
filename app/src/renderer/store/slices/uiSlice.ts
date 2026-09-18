/* ============================================================
 * ArkWork — UI 布局 slice（v0.27.0 R3：自 store.ts 纯移动）
 * 面板/导航/Dock/Inspector/预览窗/模块页/设置弹窗/主题/命令面板等纯界面状态
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import {
  applyThemeClass,
  clampWidth,
  DEFAULT_INSPECTOR_TAB,
  detectRenderer,
  friendlyError,
  INSPECTOR_TAB_ORDER,
  resolveDockLayout,
  sanitizeHiddenTabs,
  sanitizeInspectorOrder,
} from '../meta'
import { loadActiveWorkspace, loadUiState, saveUiState } from '../persist'
// v0.32.0：折叠切换语义（纯函数；缺陷 D33 的唯一修正点）
import { applyUserFoldToggle } from '@shared/utils/flow-fold'
import { findFileTab } from '../../services/previewTabs'
import i18n from '../../i18n'
import {
  applyLocaleDocument,
  localeFromStorage,
  setActiveLocale,
} from '../../i18n'
import type { DockTabId } from '@shared/types/agent'
import type { ThemeMode, ResolvedTheme, Locale } from '@shared/types/ipc'
import type { AppState } from '../types'
import type {
  Activity,
  DockPrefs,
  InspectorTabId,
  LeftView,
  MinimizedCapsule,
  ModulePage,
  PreviewTab,
  PreviewWindowState,
  RightTab,
  SettingsTab,
} from '../types'

/**
 * v0.31.0 C3：由整窗状态构造最小化胶囊。
 * 快照留存 tabs / activeTabId / bounds / pinned，恢复时按此重建；
 * title/icon/tabCount 仅供胶囊条渲染。
 */
const capsuleOf = (pw: PreviewWindowState): MinimizedCapsule => {
  const activeTab = pw.tabs.find((t) => t.id === pw.activeTabId)
  return {
    id: pw.id,
    title: activeTab?.target.kind === 'file' ? activeTab.target.path.split('/').pop() || i18n.t('slice.ui.preview') : i18n.t('slice.ui.preview'),
    icon: 'File',
    tabCount: pw.tabs.length,
    snapshot: { ...pw, tabs: [...pw.tabs] },
  }
}

export const uiSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'sidePanelWidth'
    | 'sidePanelCollapsed'
    | 'activeActivity'
    | 'setSidePanelWidth'
    | 'toggleSidePanel'
    | 'setActiveActivity'
    | 'toggleLeft'
    | 'leftCollapsed'
    | 'leftWidth'
    | 'setLeftWidth'
    | 'rightCollapsed'
    | 'rightWidth'
    | 'setRightWidth'
    | 'toggleRight'
    | 'openRight'
    | 'closeRight'
    | 'leftNavCollapsed'
    | 'toggleLeftNav'
    | 'setLeftNavCollapsed'
    | 'rightDockCollapsed'
    | 'rightDockWidth'
    | 'activeDockTab'
    | 'toggleRightDock'
    | 'setRightDockWidth'
    | 'setActiveDockTab'
    | 'openDockTab'
    | 'dockTabs'
    | 'dockDefaultTab'
    | 'dockPrefs'
    | 'setDockPrefs'
    | 'resetDockPrefs'
    | 'dockNotice'
    | 'setDockNotice'
    | 'inspectorTab'
    | 'setInspectorTab'
    | 'inspectorTabOrder'
    | 'hiddenInspectorTabs'
    | 'setInspectorTabOrder'
    | 'hideInspectorTab'
    | 'restoreInspectorTab'
    | 'modulePage'
    | 'openModulePage'
    | 'closeModulePage'
    | 'prevRightDockOpen'
    | 'previewWindow'
    | 'minimizedPreviews'
    | 'openPreview'
    | 'openPreviewUrl'
    | 'closePreview'
    | 'togglePreviewPin'
    | 'minimizePreview'
    | 'restoreMinimized'
    | 'discardMinimized'
    | 'closePreviewTab'
    | 'setActivePreviewTab'
    | 'updatePreviewBounds'
    | 'quickOpenOpen'
    | 'setQuickOpenOpen'
    | 'helpOpen'
    | 'setHelpOpen'
    | 'toggleHelp'
    | 'leftView'
    | 'setLeftView'
    | 'rightTab'
    | 'setRightTab'
    | 'loading'
    | 'error'
    | 'cmdPaletteOpen'
    | 'setCmdPaletteOpen'
    | 'settingsOpen'
    | 'setSettingsOpen'
    | 'settingsTab'
    | 'setSettingsTab'
    | 'theme'
    | 'systemTheme'
    | 'resolvedTheme'
    | 'setTheme'
    | 'cycleTheme'
    | 'language'
    | 'setLanguage'
    | 'flow'
    | 'setFlowViewMode'
    | 'setFlowShowThinking'
    | 'setBlockOpen'
    | 'setTurnCollapsed'
  >
> = (set, get) => ({
  // v0.7.0 布局：Activity Bar + SidePanel
  // v0.13.0：Sidebar 默认 240（对齐 01-information-architecture.md §2），范围 64–320
  sidePanelWidth: clampWidth(loadUiState('sidepanel-w', 240), 64, 320),
  sidePanelCollapsed: false,
  activeActivity: 'tasks',
  setSidePanelWidth: (w) => {
    const clamped = Math.min(320, Math.max(64, Math.round(w))) // v0.13.0：64–320
    saveUiState('sidepanel-w', clamped)
    set({ sidePanelWidth: clamped })
  },
  toggleSidePanel: () => set((s) => ({ sidePanelCollapsed: !s.sidePanelCollapsed })),
  setActiveActivity: (a) =>
    set((s) => ({
      // 点击当前已激活的 activity 时 toggle 折叠
      activeActivity: s.activeActivity === a && !s.sidePanelCollapsed ? s.activeActivity : a,
      sidePanelCollapsed: s.activeActivity === a ? !s.sidePanelCollapsed : false,
    })),
  // 兼容旧代码（leftWidth 也钳制到 Sidebar 范围 64–320，绝不可反向扩张到 480）
  leftWidth: 240,
  leftCollapsed: false,
  setLeftWidth: (w) => {
    const clamped = Math.min(320, Math.max(64, Math.round(w))) // v0.13.0：必须与 Sidebar 一致 64–320
    saveUiState('sidepanel-w', clamped)
    set({ sidePanelWidth: clamped })
  },
  toggleLeft: () => set((s) => ({ sidePanelCollapsed: !s.sidePanelCollapsed, leftCollapsed: !s.leftCollapsed })),
  rightCollapsed: true,  // v0.7.0：右栏已下线
  rightWidth: 360,
  setRightWidth: (w) => set({ rightWidth: Math.min(560, Math.max(320, w)) }),
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
  openRight: (tab) => set((s) => ({ rightCollapsed: false, rightTab: tab ?? s.rightTab })),
  closeRight: () => set({ rightCollapsed: true }),

  // ============================================================
  // v0.9.0 F900 — LeftNav
  // ============================================================
  leftNavCollapsed: loadUiState('leftnav', false),
  toggleLeftNav: () =>
    set((s) => {
      const next = !s.leftNavCollapsed
      saveUiState('leftnav', next)
      return { leftNavCollapsed: next }
    }),
  setLeftNavCollapsed: (b) => {
    saveUiState('leftnav', b)
    set({ leftNavCollapsed: b })
  },

  // ============================================================
  // v0.9.0 F901 — RightDock
  rightDockCollapsed: loadUiState('rightdock', false),
  // v0.13.0：Inspector 默认 360（对齐 01-information-architecture.md §2），范围 280–480
  rightDockWidth: clampWidth(loadUiState('rightdock-w', 360), 280, 480),
  activeDockTab: 'files',
  // fix-workspace-task-automation-memory Task 5：Inspector 默认 Todos
  inspectorTab: DEFAULT_INSPECTOR_TAB,
  setInspectorTab: (t) => set({ inspectorTab: t }),
  inspectorTabOrder: sanitizeInspectorOrder(loadUiState('inspector-tab-order', INSPECTOR_TAB_ORDER)),
  hiddenInspectorTabs: sanitizeHiddenTabs(loadUiState('inspector-tab-hidden', [])),
  setInspectorTabOrder: (order) => {
    const clean = sanitizeInspectorOrder(order)
    saveUiState('inspector-tab-order', clean)
    set({ inspectorTabOrder: clean })
  },
  hideInspectorTab: (tab) =>
    set((s) => {
      if (tab === 'browser' || s.hiddenInspectorTabs.includes(tab)) return {}
      const hidden = [...s.hiddenInspectorTabs, tab]
      saveUiState('inspector-tab-hidden', hidden)
      // 隐藏当前激活 Tab 时，切到首个仍可见的 Tab
      const nextInspectorTab =
        s.inspectorTab === tab
          ? (s.inspectorTabOrder.find((t) => t !== tab && !hidden.includes(t)) ?? 'todos')
          : s.inspectorTab
      return { hiddenInspectorTabs: hidden, inspectorTab: nextInspectorTab }
    }),
  restoreInspectorTab: (tab) =>
    set((s) => {
      const hidden = s.hiddenInspectorTabs.filter((t) => t !== tab)
      saveUiState('inspector-tab-hidden', hidden)
      return { hiddenInspectorTabs: hidden }
    }),
  toggleRightDock: () =>
    set((s) => {
      const next = !s.rightDockCollapsed
      saveUiState('rightdock', next)
      return { rightDockCollapsed: next }
    }),
  setRightDockWidth: (w) => {
    const clamped = Math.min(480, Math.max(280, Math.round(w))) // v0.13.0：280–480px
    saveUiState('rightdock-w', clamped)
    set({ rightDockWidth: clamped })
  },
  setActiveDockTab: (t) => set({ activeDockTab: t }),
  openDockTab: (t) =>
    set((s) => {
      // Tab 不在当前智能体的有效集合中则忽略
      if (!s.dockTabs.includes(t)) return {}
      return { rightDockCollapsed: false, activeDockTab: t }
    }),
  dockTabs: resolveDockLayout(loadActiveWorkspace() === '' ? '' : '', undefined).tabs,
  dockDefaultTab: resolveDockLayout(loadActiveWorkspace() === '' ? '' : '', undefined).defaultTab,
  dockPrefs: loadUiState<Record<string, DockPrefs>>('dockprefs', {}),
  setDockPrefs: (agentId, prefs) =>
    set((s) => {
      const next = { ...s.dockPrefs, [agentId]: prefs }
      saveUiState('dockprefs', next)
      // 更新生效布局
      const layout = resolveDockLayout(agentId, prefs)
      return {
        dockPrefs: next,
        dockTabs: layout.tabs,
        dockDefaultTab: layout.defaultTab,
      }
    }),
  resetDockPrefs: (agentId) =>
    set((s) => {
      const next = { ...s.dockPrefs }
      delete next[agentId]
      saveUiState('dockprefs', next)
      const layout = resolveDockLayout(agentId, undefined)
      return {
        dockPrefs: next,
        dockTabs: layout.tabs,
        dockDefaultTab: layout.defaultTab,
      }
    }),
  dockNotice: null,
  setDockNotice: (msg) => set({ dockNotice: msg }),

  // ============================================================
  // v0.9.0 F900 — 全局模块页
  // ============================================================
  modulePage: null,
  prevRightDockOpen: true,
  // redesign-workspace-navigation Task 3：
  //  - 切换到不同 page → 打开新页面
  //  - 单击当前 page → 保持打开（spec：再次单击当前入口 → 页面保持打开，
  //    不出现无意义折叠层或空白状态）。如需关闭请用 closeModulePage 或右上角关闭按钮。
  openModulePage: (page) =>
    set((s) => {
      if (s.modulePage === page) return {} // 重复点击：保持打开
      return {
        modulePage: page,
        // 从无 page 打开 → 记录"用户原本的 rightDock 状态"（模块页内强制折叠）
        // 从已有 page 切换 → 保留之前的 prevRightDockOpen，避免被中间折叠态覆盖
        prevRightDockOpen: s.modulePage === null ? !s.rightDockCollapsed : s.prevRightDockOpen,
        rightDockCollapsed: true,
      }
    }),
  closeModulePage: () =>
    set((s) => ({
      modulePage: null,
      // 回任务时恢复 RightDock
      rightDockCollapsed: s.prevRightDockOpen ? false : s.rightDockCollapsed,
    })),

  previewWindow: null,
  minimizedPreviews: [],
  openPreview: async (path, opts) => {
    // v0.31.0 B2：`rendererOverride` 让调用方（fsSlice.openDoc）决定 Tab 进编辑态还是只读渲染态。
    // 设计依据 §3.5：RendererKind 只增 'editor'，语义是「这个 Tab 当前处于编辑态」；
    // 是否编辑由 `EditorDocMeta.editable`（= probe.readonlyReason === null）决定。
    const renderer = opts?.rendererOverride ?? detectRenderer(path)

    // v0.31.0 B2 修复：**同一文件路径必须复用已有 Tab**（见 services/previewTabs 的不变量说明）。
    // 修复前每次打开都 `tab-${Date.now()}` 新建 → 同路径两个 Tab 争用同一个
    // `registerEditorHandle(path)` 槽位，出现「保存 A 写出 B 的缓冲」。
    // 复用时**让新的 renderer 生效**：这正是「已只读打开过的文件再次走 openDoc 升级为编辑器」的通路。
    const existing = get().previewWindow
    const dup = existing ? findFileTab(existing.tabs, path) : undefined
    if (existing && dup) {
      set({
        previewWindow: {
          ...existing,
          tabs: existing.tabs.map((t) =>
            // 不把已固定的 Tab 降级回 preview；只在本次要求固定时升级
            t.id === dup.id ? { ...t, renderer, mode: opts?.pinned ? 'pinned' : t.mode } : t,
          ),
          activeTabId: dup.id,
        },
      })
      return
    }

    const tabId = `tab-${Date.now()}`
    if (existing) {
      // 已有浮窗：添加 Tab
      const newTab: PreviewTab = {
        id: tabId,
        target: { kind: 'file', path },
        renderer,
        mode: opts?.pinned ? 'pinned' : 'preview',
      }
      set({
        previewWindow: {
          ...existing,
          tabs: [...existing.tabs, newTab],
          activeTabId: tabId,
        },
      })
    } else {
      // 新建浮窗
      set({
        previewWindow: {
          id: `pw-${Date.now()}`,
          bounds: { x: 120, y: 80, w: 720, h: 520 },
          pinned: false,
          tabs: [{
            id: tabId,
            target: { kind: 'file', path },
            renderer,
            mode: opts?.pinned ? 'pinned' : 'preview',
          }],
          activeTabId: tabId,
        },
      })
    }
  },
  closePreview: () => set({ previewWindow: null }),
  /** v0.9.0 F903：以 URL 打开 PreviewWindow 浮窗（浏览器面板「在浮窗打开」） */
  openPreviewUrl: (url: string) =>
    set((s) => {
      const tabId = `tab-${Date.now()}`
      const tab: PreviewTab = { id: tabId, target: { kind: 'url', url }, renderer: 'browser', mode: 'preview' }
      if (s.previewWindow) {
        return {
          previewWindow: {
            ...s.previewWindow,
            tabs: [...s.previewWindow.tabs, tab],
            activeTabId: tabId,
          },
        }
      }
      return {
        previewWindow: {
          id: `pw-${Date.now()}`,
          bounds: { x: 120, y: 80, w: 720, h: 520 },
          pinned: false,
          tabs: [tab],
          activeTabId: tabId,
        },
      }
    }),
  togglePreviewPin: () =>
    set((s) => ({
      previewWindow: s.previewWindow ? { ...s.previewWindow, pinned: !s.previewWindow.pinned } : null,
    })),
  minimizePreview: () =>
    set((s) => {
      if (!s.previewWindow) return {}
      const capsule = capsuleOf(s.previewWindow)
      return {
        previewWindow: null,
        minimizedPreviews: [...s.minimizedPreviews, capsule],
      }
    }),
  restoreMinimized: (id) =>
    set((s) => {
      const capsule = s.minimizedPreviews.find((c) => c.id === id)
      if (!capsule) return {}
      // v0.31.0 C3：按快照完整恢复（tabs / activeTabId / bounds / pinned）——
      // 旧实现写死 `tabs: []`，整窗 Tab 列表在最小化时被丢弃，点胶囊只能得到空窗。
      // 若此刻已有其他浮窗：先将其同样收进最小化列表（交换），两边都不丢。
      const rest = s.minimizedPreviews.filter((c) => c.id !== id)
      return {
        minimizedPreviews: s.previewWindow ? [...rest, capsuleOf(s.previewWindow)] : rest,
        previewWindow: capsule.snapshot,
      }
    }),
  /** v0.31.0 C3：胶囊 ✕ = 丢弃该最小化窗（仅移除胶囊；不恢复、不动现窗）。
   *  旧实现「restoreMinimized + closePreview」两步在交换语义下会误把现窗最小化。 */
  discardMinimized: (id) =>
    set((s) => ({ minimizedPreviews: s.minimizedPreviews.filter((c) => c.id !== id) })),
  closePreviewTab: (tabId) =>
    set((s) => {
      if (!s.previewWindow) return {}
      const tabs = s.previewWindow.tabs.filter((t) => t.id !== tabId)
      if (tabs.length === 0) return { previewWindow: null }
      const activeTabId = s.previewWindow.activeTabId === tabId ? tabs[0].id : s.previewWindow.activeTabId
      return { previewWindow: { ...s.previewWindow, tabs, activeTabId } }
    }),
  setActivePreviewTab: (tabId) =>
    set((s) => ({
      previewWindow: s.previewWindow ? { ...s.previewWindow, activeTabId: tabId } : null,
    })),
  updatePreviewBounds: (bounds) =>
    set((s) => ({
      previewWindow: s.previewWindow ? { ...s.previewWindow, bounds } : null,
    })),

  // v0.7.0 F714：⌘P 快速打开
  quickOpenOpen: false,
  setQuickOpenOpen: (b) => set({ quickOpenOpen: b }),

  // Task 14：HelpCenter 全局浮层（⌘? / ⌘/ 触发）
  helpOpen: false,
  setHelpOpen: (b) => set({ helpOpen: b }),
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),

  // 导航 — 点击当前已激活的视图时 toggle 回 tasks（对标 Trae Work）
  leftView: 'tasks',
  setLeftView: (v) =>
    set((s) => ({
      leftView: s.leftView === v ? 'tasks' : v,
    })),
  rightTab: 'files',
  setRightTab: (t) =>
    set((s) => ({
      rightTab: s.rightTab === t ? 'files' : t,
    })),

  // 加载状态
  loading: false,
  error: null,


  // Settings
  settingsOpen: false,
  setSettingsOpen: (b) => set({ settingsOpen: b }),
  settingsTab: 'models',
  setSettingsTab: (t) => set({ settingsTab: t }),

  // ---- 主题（v0.4.0） ----
  // 初始值：优先 localStorage（无闪烁脚本已设），否则 'dark'
  theme: ((): ThemeMode => {
    try {
      const t = localStorage.getItem('arkwork:theme') as ThemeMode | null
      if (t === 'light' || t === 'dark' || t === 'system') return t
    } catch { /* ignore */ }
    return 'dark'
  })(),
  systemTheme: 'dark',
  resolvedTheme: 'dark',
  setTheme: async (t) => {
    // 1. 更新状态
    const systemTheme = get().systemTheme
    const resolved = applyThemeClass(t, systemTheme)
    set({ theme: t, resolvedTheme: resolved })
    // 2. 持久化到 localStorage（供下次启动无闪烁脚本读取）
    try { localStorage.setItem('arkwork:theme', t) } catch { /* ignore */ }
    // 3. 保存到 settings.json
    try {
      await window.ark.settings.set({ theme: t })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err, i18n.t('slice.ui.themePersistFailed')), duration: 0 })
    }
    // 4. 同步原生界面（文件选择器/对话框/上下文菜单）
    try {
      await window.ark.theme.apply(t)
    } catch (err) {
      // 原生同步失败不影响 DOM 已生效，仅记录
      get().pushToast({ type: 'warning', message: friendlyError(err, i18n.t('slice.ui.themeSyncFailed')), duration: 4000 })
    }
  },
  cycleTheme: async () => {
    const order: ThemeMode[] = ['light', 'dark', 'system']
    const cur = get().theme
    const next = order[(order.indexOf(cur) + 1) % order.length]
    await get().setTheme(next)
  },

  // ---- 界面语言（v0.29.0） ----
  // 初始值：localStorage 预读（i18n/index 已同步应用到 <html>），无记录回退 zh；
  // settings.json 校正由 init() 启动决策流完成（全新安装跟随系统、存量保持现状）。
  language: localeFromStorage() ?? 'zh',
  setLanguage: async (l) => {
    // 1. 切换 i18next 语言 + 文档属性（html lang / data-locale → CSS 字体栈与行高）
    await setActiveLocale(l)
    set({ language: l })
    // 2. 持久化到 localStorage（供下次启动无闪烁预读）
    try { localStorage.setItem('arkwork:language', l) } catch { /* ignore */ }
    // 3. 保存到 settings.json
    try {
      await window.ark.settings.set({ language: l })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err, i18n.t('slice.ui.languageSaveFailed')), duration: 0 })
    }
  },
  // Command Palette（v0.16.0 F902；v0.27.0 R3 自 pickers 区归位 UI 域）
  cmdPaletteOpen: false,
  setCmdPaletteOpen: (b) => set({ cmdPaletteOpen: b }),

  // ============================================================
  // v0.31.0 B3 — 交互区 flow 子状态（正本 interaction 07 §2.2）
  // viewMode / showThinking 持久化；block/turn 展开态会话内有效（虚拟化后仍存活）
  // ============================================================
  flow: {
    viewMode: loadUiState('flow-view-mode', 'standard'),
    showThinking: loadUiState('flow-show-thinking', true),
    blockUiState: {},
    turnUiState: {},
    scrollAnchorByTask: {},
  },
  setFlowViewMode: (mode) => {
    saveUiState('flow-view-mode', mode)
    set((s) => ({ flow: { ...s.flow, viewMode: mode } }))
  },
  setFlowShowThinking: (b) => {
    saveUiState('flow-show-thinking', b)
    set((s) => ({ flow: { ...s.flow, showThinking: b } }))
  },
  // v0.32.0 缺陷 D33：这里此前恒写 `userOpen: true`，而 ProcessFold 又把
  // `userOpen` 当展示态读 → 「点开后收不起来」。现改为经纯函数写入真实意图，
  // 并与投影层 blockOpenOf 的三态语义对齐（open = 应用态 / userOpen = 门闩）。
  setBlockOpen: (blockId, open) =>
    set((s) => ({
      flow: {
        ...s.flow,
        blockUiState: {
          ...s.flow.blockUiState,
          [blockId]: {
            ...(s.flow.blockUiState[blockId] ?? { open: false, userOpen: null }),
            ...applyUserFoldToggle(s.flow.blockUiState[blockId], open),
          },
        },
      },
    })),
  setTurnCollapsed: (turnId, collapsed) =>
    set((s) => ({
      flow: {
        ...s.flow,
        turnUiState: { ...s.flow.turnUiState, [turnId]: { collapsed } },
      },
    })),
});
