/* ============================================================
 * ArkWork — 插件注册表 slice（插件插拔能力 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §9.1 / §9.2
 *
 * 职责边界（硬）：
 *  ① 真源在主进程（`main/plugins/registry.ts`），这里只缓存列表与忙态；
 *  ② 写入一律走 IPC，**不做乐观更新** —— 启停的成败由主进程决定
 *     （内置插件允许禁用但不可卸载；卸载失败要能给出原因）；
 *  ③ 启停/卸载后**必须重拉插槽** —— 插槽是面板 Tab / 渲染器覆盖 / 主题的
 *     数据源，不重拉就会出现「插件已禁用但面板还在」的假象（本版的核心纪律）。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import { friendlyError } from '../meta'
import type { PluginSummary } from '@shared/types/plugin'
import type { AppState } from '../types'

export interface PluginState {
  /** 全部插件（内置 ∪ 用户目录扫描） */
  plugins: PluginSummary[]
  pluginsLoaded: boolean
  /** 任一次启停/卸载/重扫在进行中（UI 禁用按钮用） */
  pluginsBusy: boolean

  loadPlugins: () => Promise<void>
  /** 启停；成功返回 true（失败会 pushToast，并把原因翻译成人话） */
  setPluginEnabled: (id: string, enabled: boolean) => Promise<boolean>
  uninstallPlugin: (id: string) => Promise<boolean>
  rescanPlugins: () => Promise<void>
  openPluginsDir: () => Promise<void>
  /** 导出内置样例到用户插件目录（作者脚手架，P1） */
  exportPluginSample: (id: string) => Promise<void>
  subscribePluginChanges: () => () => void
}

/** 主进程 reason → 用户可读文案（缺省回落原文，保留可调试性） */
function pluginReasonText(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'builtin':
      return '内置示例插件不可卸载（可以禁用）'
    case 'not-found':
      return '插件不存在，可能已被删除'
    case 'dir-missing':
      return '插件目录已不存在，已刷新列表'
    case 'fs-error':
      return '文件系统操作失败，请检查目录权限'
    case 'bad-args':
      return '参数不合法'
    default:
      return fallback
  }
}

export const pluginSlice: StateCreator<AppState, [], [], PluginState> = (set, get) => ({
  plugins: [],
  pluginsLoaded: false,
  pluginsBusy: false,

  loadPlugins: async () => {
    try {
      const list = await ark.plugin.list()
      set({ plugins: Array.isArray(list) ? list : [], pluginsLoaded: true })
    } catch (err) {
      // 插件列表读不出来不阻断启动：空列表 + 已加载标记，UI 显示空态
      console.error('[plugin] loadPlugins failed:', err)
      set({ plugins: [], pluginsLoaded: true })
    }
  },

  setPluginEnabled: async (id, enabled) => {
    set({ pluginsBusy: true })
    try {
      const res = await ark.plugin.setEnabled({ id, enabled })
      if (!res.ok) {
        get().pushToast({
          type: 'danger',
          message: pluginReasonText(res.reason, `插件 ${id} 操作失败`),
          duration: 5000,
        })
        return false
      }
      // 插槽已由主进程重建 → 重拉列表与派生量（否则面板 Tab 会滞留）
      await get().loadPlugins()
      await refreshSlotDerivations(get)
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
      return false
    } finally {
      set({ pluginsBusy: false })
    }
  },

  uninstallPlugin: async (id) => {
    set({ pluginsBusy: true })
    try {
      const res = await ark.plugin.uninstall({ id })
      if (!res.ok) {
        get().pushToast({
          type: 'warning',
          message: pluginReasonText(res.reason, `插件 ${id} 卸载失败`),
          duration: 5000,
        })
        await get().loadPlugins()
        return false
      }
      await       get().loadPlugins()
      await refreshSlotDerivations(get)
      get().pushToast({ type: 'success', message: `已卸载插件 ${id}`, duration: 4000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
      return false
    } finally {
      set({ pluginsBusy: false })
    }
  },

  rescanPlugins: async () => {
    set({ pluginsBusy: true })
    try {
      const list = await ark.plugin.rescan()
      set({ plugins: Array.isArray(list) ? list : [], pluginsLoaded: true })
      await refreshSlotDerivations(get)
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
    } finally {
      set({ pluginsBusy: false })
    }
  },

  openPluginsDir: async () => {
    try {
      const res = await ark.plugin.openDir()
      if (!res.ok) {
        get().pushToast({ type: 'warning', message: `无法打开插件目录：${res.path}`, duration: 5000 })
        return
      }
      get().pushToast({ type: 'success', message: `已打开插件目录：${res.path}`, duration: 4000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
    }
  },

  exportPluginSample: async (id) => {
    try {
      const res = await ark.plugin.exportSample({ id })
      if (!res.ok) {
        get().pushToast({
          type: 'warning',
          message: pluginReasonText(res.reason, `导出样例 ${id} 失败`),
          duration: 5000,
        })
        return
      }
      await get().loadPlugins()
      get().pushToast({ type: 'success', message: `样例已导出到：${res.path ?? ''}`, duration: 5000 })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
    }
  },

  subscribePluginChanges: () => {
    return ark.plugin.onChanged(async () => {
      await get().loadPlugins()
      await refreshSlotDerivations(get)
    })
  },
})

/**
 * 启停 / 卸载 / 重扫 / 外部广播之后，插槽集合都会变 → 重新派生。
 *
 * 抽成模块级函数（而非 slice 方法）：它在 4 处被调用，且必须**总是**成对出现
 * （漏一处就会出现「插件没了但面板还在」）。写成一个函数就无法漏。
 *
 * 顺带做**选中 Tab 的和解**：当前选中的面板 Tab 若已不在新面板集合里
 * （贡献它的插件被禁用/卸载了），回落内置默认 Tab —— 否则 Inspector 会
 * 停在一个永远渲染不出内容的 Tab 上（用户看不到任何解释）。
 */
async function refreshSlotDerivations(get: () => AppState): Promise<void> {
  try {
    get().applySlotDerivations((await ark.profile.slots()) ?? {})
    const cur = get().inspectorTab
    if (cur.startsWith('panel:') && !get().profilePanels.some((p) => p.ref === cur)) {
      get().setInspectorTab('todos')
    }
  } catch (err) {
    console.error('[plugin] slot refresh failed:', err)
  }
}
