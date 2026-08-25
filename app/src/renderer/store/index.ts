/* ============================================================
 * ArkWork — Renderer Global Store（v0.27.0 R3 slice 化装配层）
 * AppState 由 8 个 slice 组合（TS 结构化校验字段覆盖完整性）；
 * init / subscribeAll 在此收口；对外 API 与拆分前完全一致。
 *
 * 设计文档：docs/versions/v0.27.0/03-system-design.md §4
 * ============================================================ */
import { create } from 'zustand'
import { saveActiveWorkspace } from './persist'
import { applyThemeClass, friendlyError } from './meta'
import { detectSystemLocale, normalizeLocale } from '../i18n'
import i18n from '../i18n'
import { subscribeAll as subscribeAllImpl } from './subscriptions'
import { uiSlice } from './slices/uiSlice'
import { feedbackSlice } from './slices/feedbackSlice'
import { tasksSlice } from './slices/tasksSlice'
import { kbMemorySlice } from './slices/kbMemorySlice'
import { conversationSlice } from './slices/conversationSlice'
import { catalogSlice } from './slices/catalogSlice'
import { marketSlice } from './slices/marketSlice'
import { permissionSlice } from './slices/permissionSlice'
import type { AppState } from './types'

export const useStore = create<AppState>((set, get, api) => ({
  ...uiSlice(set, get, api),
  ...feedbackSlice(set, get, api),
  ...tasksSlice(set, get, api),
  ...kbMemorySlice(set, get, api),
  ...conversationSlice(set, get, api),
  ...catalogSlice(set, get, api),
  ...marketSlice(set, get, api),
  ...permissionSlice(set, get, api),


  // 初始化 — 启动时调用
  init: async () => {
    set({ loading: true })
    try {
      // v0.4.0：初始化主题（读 settings.json 校正 localStorage，并订阅系统主题变化）
      try {
        const settings = await window.ark.settings.get()
        const persistedTheme = settings.theme
        // settings.json 与 localStorage 不一致时以 settings.json 为准（跨设备同步）
        const localTheme = get().theme
        if (persistedTheme && persistedTheme !== localTheme) {
          try { localStorage.setItem('arkwork:theme', persistedTheme) } catch { /* ignore */ }
        }
        const theme = persistedTheme || localTheme
        const systemTheme = await window.ark.theme.getSystemTheme()
        const resolved = applyThemeClass(theme, systemTheme)
        set({ theme, systemTheme, resolvedTheme: resolved })
        // 同步原生界面
        await window.ark.theme.apply(theme)
        // Task 8：同步全局 KB 开关（缺省 true）
        set({ globalKbEnabled: settings.kbEnabled !== false })

        // v0.29.0：界面语言启动决策流
        // settings.json 有记录 → 以其为准；无记录 → 全新安装跟随系统语言、存量用户保持现状。
        const persistedLocale = normalizeLocale(settings.language)
        let freshInstall = false
        try {
          freshInstall = !localStorage.getItem('arkwork:hasRun')
          localStorage.setItem('arkwork:hasRun', '1')
        } catch { /* ignore */ }
        const targetLocale =
          persistedLocale ?? (freshInstall ? detectSystemLocale() : get().language)
        if (targetLocale !== get().language) {
          await get().setLanguage(targetLocale)
        }
      } catch (err) {
        get().pushToast({ type: 'warning', message: friendlyError(err, i18n.t('slice.init.themeInitFailed')), duration: 4000 })
      }

      // 同步后端 workspaceDir（确保 persisted active workspace 的路径生效）
      const activeWs = get().workspaces.find((w) => w.id === get().activeWorkspaceId)
      if (activeWs) {
        try {
          await window.ark.settings.activateWorkspace(activeWs.path)
        } catch {
          // 激活失败（路径不存在等），回退到 default
          saveActiveWorkspace('default')
          set({ activeWorkspaceId: 'default' })
        }
      }
      await get().refreshCatalog()
      await get().refreshTasks()
      // Task 9：从主进程缓存恢复任务进度（页面切换 / 重启后保持进度不丢）
      await get().refreshTaskProgress()
      // v0.6.4：加载自动化和知识库数据
      void get().refreshAutomations()
      void get().refreshKnowledge()
      // v0.6.1：初始化 SkillHub CLI 状态
      void get().checkMarketCli()
      // v0.15.0：初始化会话权限模式与规则
      void get().getPermissionMode()
      void get().refreshPermissionRules()
      // 自动选中第一个任务
      const first = get().tasks[0]
      if (first) {
        await get().selectTask(first.id)
      } else {
        await get().refreshFiles()
      }
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    } finally {
      set({ loading: false })
    }
  },
  subscribeAll: () => subscribeAllImpl(set, get),
}))

/* ---------- 对外导出（保持拆分前的公共 API 面） ---------- */
export {
  friendlyError,
  computeModelHealth,
  classifyLlmError,
  detectRenderer,
  INSPECTOR_TAB_META,
  INSPECTOR_TAB_ORDER,
  DEFAULT_INSPECTOR_TAB,
  DEFAULT_PRESET,
  AGENT_DOCK_PRESETS,
  DOCK_TAB_META,
  DOCK_TAB_ORDER,
} from './meta'
export { derivePlanItems } from '../utils/plan-status'
export { shortTaskId, formatUpdatedAt } from '../types'
export type { Task, TaskStatus } from '@shared/types/task'
export type {
  Activity,
  LeftView,
  RightTab,
  PickerKind,
  ModulePage,
  SettingsTab,
  InspectorTabId,
  DockPrefs,
  ModelHealth,
  RendererKind,
  PreviewTab,
  PreviewWindowState,
  MinimizedCapsule,
  Workspace,
  ToastLevel,
  Toast,
  CtxChip,
  ConfirmDialogOpts,
  ConfirmDialogState,
  AppState,
} from './types'
