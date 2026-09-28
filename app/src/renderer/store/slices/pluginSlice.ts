/* ============================================================
 * ArkWork — 插件注册表 slice（插件插拔能力 · v0.33.0；v0.35.0 加代码插件运行期）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §9.1 / §9.2
 *           ★ v0.35.0：docs/versions/v0.35.0/04-system-design.md §5.3 / §7
 *
 * 职责边界（硬）：
 *  ① 真源在主进程（`main/plugins/registry.ts` + `runtime/host-service.ts`），
 *     这里只缓存列表 / 忙态 / 运行期诊断 / 视图 Tab；
 *  ② 写入一律走 IPC，**不做乐观更新** —— 启停的成败由主进程决定
 *     （内置插件允许禁用但不可卸载；卸载失败要能给出原因）；
 *  ③ 启停/卸载后**必须重拉插槽** —— 插槽是面板 Tab / 渲染器覆盖 / 主题的
 *     数据源，不重拉就会出现「插件已禁用但面板还在」的假象（本版的核心纪律）；
 *  ④ ★ v0.35.0：**视图 Tab 与面板 Tab 分两路**。面板来自插槽派生
 *     （`profilePanels`），视图来自运行期（`pluginViews`）—— 合成一条会让
 *     三个派生量在「禁用一个代码插件」时各自走进不同的刷新路径，必然不同步。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import { friendlyError } from '../meta'
import { isPluginViewRef, pluginViewTabsOf, type PanelTab } from '@shared/utils/panel-model'
import type { PluginSource, PluginRuntimeStatus, PluginSummary } from '@shared/types/plugin'
import type { PluginInstallZipResult } from '@shared/types/ipc'
import type { AppState } from '../types'

/** 能力页作用域两态（决定开关写哪一级偏好；`bundled` 归入「全局」显示） */
export type PluginScopeFilter = 'workspace' | 'global'

export interface PluginState {
  /** 全部插件（随包 ∪ 全局 ∪ 本工作区） */
  plugins: PluginSummary[]
  pluginsLoaded: boolean
  /** 任一次启停/卸载/重扫在进行中（UI 禁用按钮用） */
  pluginsBusy: boolean
  /** ★ 能力页当前作用域（列表过滤 + 开关写入级别） */
  pluginScope: PluginScopeFilter
  /** ★ 启用插件贡献的代码视图 → 渲染层 Tab（顺序 = 内置 → profile → 视图） */
  pluginViews: PanelTab[]
  /** ★ 每个插件的运行期健康度（phase / 耗时 / 权限 / 最近错误） */
  pluginRuntime: PluginRuntimeStatus[]
  /** ★ 被同 id 高优先级作用域覆盖的记录（诊断页展示「被工作区覆盖」） */
  pluginShadowed: Array<{ id: string; by: PluginSource }>
  /** ★ 当前打开的插件视图会话数（诊断页用） */
  pluginOpenViews: number

  loadPlugins: () => Promise<void>
  /** 切换作用域（同时刷新列表；不写盘） */
  setPluginScope: (scope: PluginScopeFilter) => Promise<void>
  /** 启停；成功返回 true（失败会 pushToast，并把原因翻译成人话） */
  setPluginEnabled: (id: string, enabled: boolean, scope?: PluginScopeFilter) => Promise<boolean>
  uninstallPlugin: (id: string, opts?: { purgeData?: boolean }) => Promise<boolean>
  /** ★ v0.36.0（F3.2）：安装插件包（两段式；返回原始结果由面板驱动确认弹窗） */
  installPlugin: (opts?: { zipPath?: string; confirmed?: boolean; overwrite?: boolean }) => Promise<PluginInstallZipResult>
  rescanPlugins: () => Promise<void>
  openPluginsDir: (scope?: PluginScopeFilter) => Promise<void>
  /** 导出内置样例到用户插件目录（作者脚手架，P1） */
  exportPluginSample: (id: string) => Promise<void>
  /** ★ 新建插件脚手架（生成最小可运行目录：Host 半 + Client 半 + 清单） */
  scaffoldPlugin: (input: { id: string; name: string; kind: string; scope: PluginScopeFilter }) => Promise<boolean>
  /** ★ 拉取运行期诊断（phase / 耗时 / 权限 / 最近错误 / 覆盖关系） */
  loadPluginRuntime: () => Promise<void>
  /** ★ 拉取插件视图列表（→ Tab）；启停 / 工作区切换后必调 */
  refreshPluginViews: () => Promise<void>
  /** ★ 订阅「模型侧控制工具请求打开某视图」 */
  subscribeViewOpenRequest: () => () => void
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
    case 'exists':
      return '同名插件目录已存在，请换一个 id'
    case 'invalid':
      return '插件清单未通过校验，请检查 id / kind / provides'
    case 'not-activated':
      return '插件未激活（可能是校验失败或已被禁用）'
    case 'permission-denied':
      return '插件清单未声明该能力所需的权限'
    case 'activation-failed':
      return '插件装载失败，详见诊断信息'
    default:
      return fallback
  }
}

export const pluginSlice: StateCreator<AppState, [], [], PluginState> = (set, get) => ({
  plugins: [],
  pluginsLoaded: false,
  pluginsBusy: false,
  pluginScope: 'global',
  pluginViews: [],
  pluginRuntime: [],
  pluginShadowed: [],
  pluginOpenViews: 0,

  loadPlugins: async () => {
    try {
      const list = await ark.plugin.list()
      set({ plugins: Array.isArray(list) ? list : [], pluginsLoaded: true })
      // 视图 Tab 随列表一起刷新：插件被禁用后它的视图必须立刻消失，
      // 否则 Inspector 里会留一个点开就报「插件不存在」的 Tab
      await get().refreshPluginViews()
    } catch (err) {
      // 插件列表读不出来不阻断启动：空列表 + 已加载标记，UI 显示空态
      console.error('[plugin] loadPlugins failed:', err)
      set({ plugins: [], pluginsLoaded: true, pluginViews: [] })
    }
  },

  setPluginScope: async (scope) => {
    if (get().pluginScope === scope) return
    set({ pluginScope: scope })
    await get().loadPlugins()
  },

  setPluginEnabled: async (id, enabled, scope) => {
    set({ pluginsBusy: true })
    try {
      const res = await ark.plugin.setEnabled({ id, enabled, scope: scope ?? get().pluginScope })
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
      await get().loadPluginRuntime()
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
      return false
    } finally {
      set({ pluginsBusy: false })
    }
  },

  uninstallPlugin: async (id, opts) => {
    set({ pluginsBusy: true })
    try {
      const res = await ark.plugin.uninstall({ id, ...(opts?.purgeData ? { purgeData: true } : {}) })
      if (!res.ok) {
        get().pushToast({
          type: 'warning',
          message: pluginReasonText(res.reason, `插件 ${id} 卸载失败`),
          duration: 5000,
        })
        await get().loadPlugins()
        return false
      }
      await get().loadPlugins()
      await refreshSlotDerivations(get)
      await get().loadPluginRuntime()
      get().pushToast({ type: 'success', message: `已卸载插件 ${id}${opts?.purgeData ? '（含数据）' : ''}`, duration: 4000 })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
      return false
    } finally {
      set({ pluginsBusy: false })
    }
  },

  /** ★ v0.36.0（F3.2）：安装插件包。needsConfirm / 失败的确认交互由调用方（面板）接管 */
  installPlugin: async (opts) => {
    try {
      const res = await ark.plugin.installZip(opts)
      if (res.ok) {
        await get().loadPlugins()
        await refreshSlotDerivations(get)
        await get().loadPluginRuntime()
        get().pushToast({ type: 'success', message: `已安装插件 ${res.id ?? ''}（默认禁用，请在列表中启用）`, duration: 6000 })
      }
      return res
    } catch (err) {
      const out: PluginInstallZipResult = { ok: false, error: 'IPC_ERROR', message: friendlyError(err) }
      return out
    }
  },

  rescanPlugins: async () => {
    set({ pluginsBusy: true })
    try {
      const list = await ark.plugin.rescan()
      set({ plugins: Array.isArray(list) ? list : [], pluginsLoaded: true })
      await refreshSlotDerivations(get)
      await get().refreshPluginViews()
      await get().loadPluginRuntime()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
    } finally {
      set({ pluginsBusy: false })
    }
  },

  openPluginsDir: async (scope) => {
    try {
      const res = await ark.plugin.openDir({ scope: scope ?? get().pluginScope })
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

  scaffoldPlugin: async (input) => {
    set({ pluginsBusy: true })
    try {
      const res = await ark.plugin.scaffold(input)
      if (!res.ok) {
        get().pushToast({
          type: 'warning',
          message: pluginReasonText(res.reason, `新建插件 ${input.id} 失败`),
          duration: 5000,
        })
        return false
      }
      await get().loadPlugins()
      await refreshSlotDerivations(get)
      get().pushToast({
        type: 'success',
        message: `已生成插件骨架：${res.dir ?? input.id}（去改 main.js 与 renderer.js）`,
        duration: 6000,
      })
      return true
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
      return false
    } finally {
      set({ pluginsBusy: false })
    }
  },

  loadPluginRuntime: async () => {
    try {
      const report = await ark.plugin.runtimeStatus()
      set({
        pluginRuntime: Array.isArray(report?.items) ? report.items : [],
        pluginShadowed: Array.isArray(report?.shadowed) ? report.shadowed : [],
        pluginOpenViews: report?.openViews ?? 0,
      })
    } catch (err) {
      // 诊断读不到不阻断任何事：清空即可（面板显示「无数据」而不是停在旧值）
      console.error('[plugin] runtimeStatus failed:', err)
      set({ pluginRuntime: [], pluginShadowed: [], pluginOpenViews: 0 })
    }
  },

  refreshPluginViews: async () => {
    try {
      const views = await ark.plugin.views()
      set({ pluginViews: pluginViewTabsOf(Array.isArray(views) ? views : []) })
    } catch (err) {
      // 视图列表读不到 → 不显示任何插件视图 Tab（而不是显示一堆点开就报错的 Tab）
      console.error('[plugin] views failed:', err)
      set({ pluginViews: [] })
    }
  },

  subscribeViewOpenRequest: () => {
    return ark.plugin.onViewOpenRequest(async (req) => {
      // 模型侧控制工具发出「请打开某视图」。这里**不校验**插件是否合法 ——
      // 合法性的真源在主进程（`viewOpen` 会拒），渲染层重复实现一遍只会
      // 产生第二真源。渲染层只负责「把它显示出来」。
      const placement = get().pluginViews.find((t) => t.ref === req.viewRef)?.view?.placement
      if ((placement ?? 'dock') === 'float') {
        get().openPanelPreview([req.viewRef])
        return
      }
      await get().refreshPluginViews()
      // `isPluginViewRef` 既是值级校验（`view:<name>` 形状）也是类型收窄 ——
      // 主进程送来的 ref 是 `string`，直接喂给 setInspectorTab 会被类型挡住，
      // 而「随手 as 一下」就把形状校验丢掉了（这是跨进程输入，不该省）
      if (get().pluginViews.some((t) => t.ref === req.viewRef) && isPluginViewRef(req.viewRef)) {
        get().setInspectorTab(req.viewRef)
      } else {
        get().pushToast({ type: 'warning', message: `视图 ${req.viewRef} 当前不可用`, duration: 4000 })
      }
    })
  },

  subscribePluginChanges: () => {
    return ark.plugin.onChanged(async () => {
      await get().loadPlugins()
      await refreshSlotDerivations(get)
      await get().loadPluginRuntime()
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
 *
 * ★ v0.35.0：面板集合扩容到「内置 ∪ profile ∪ 插件视图」三路 ——
 *   和解判断必须看**全量**，否则禁用一个代码插件时选中的视图 Tab 不会被回落。
 */
async function refreshSlotDerivations(get: () => AppState): Promise<void> {
  try {
    get().applySlotDerivations((await ark.profile.slots()) ?? {})
    await get().refreshPluginViews()
    const all: PanelTab[] = [...get().profilePanels, ...get().pluginViews]
    const cur = get().inspectorTab
    if (cur.includes(':') && !all.some((p) => p.ref === cur)) {
      get().setInspectorTab('todos')
    }
  } catch (err) {
    console.error('[plugin] slot refresh failed:', err)
  }
}
