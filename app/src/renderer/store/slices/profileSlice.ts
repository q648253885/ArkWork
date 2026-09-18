/* ============================================================
 * ArkWork — Workbench Profile slice（插件模式 · v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.12
 *
 * 职责边界（硬）：
 *  ① 本 slice 是**渲染侧 profile 状态的唯一持有者** —— 组件不得自持列表副本；
 *  ② 真源在主进程（`main/profile/store.ts`），这里只缓存查询结果与最后一份
 *     激活报告；写入一律走 IPC，不做乐观更新（避免 UI 与磁盘短暂不一致却无回滚）；
 *  ③ UI 落地（dockTabs / homeModule / composerChips）由本 slice **派生**为
 *     三个只读字段，消费者各自读取，互不反向赋值（`dockPrefs` 不被改写 ——
 *     用户手动排过 Tab 的偏好不能被 profile 悄悄覆盖）。
 *
 * ⚠️ 与既有 `dockPrefs` 的关系（并记录为遗留 L10）：
 * profile 的 dockTabs 是**视图层覆盖**（`profileDockTabs`），不写进
 * `dockPrefs.customized`。好处：切回通用台立即恢复用户原偏好；代价是
 * profile Tab 顺序无法被用户拖拽持久化。v2 若需要「profile 内自定义」，
 * 应新增 `Record<profileId, DockPrefs>` 而非复用既有键。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import { friendlyError } from '../meta'
import type { DockTabId } from '@shared/types/agent'
import type {
  ActivationReport,
  CompositionSnapshot,
  Degradation,
  ProfileSummary,
} from '@shared/types/profile'
import type { AppState, ModulePage } from '../types'
// v0.32.0：视图投影是纯函数，独立成模块以便 node:test 密闭覆盖
import { projectUiLayer } from '../../utils/profile-view'
export { projectUiLayer, blockingDegradations, warningCount } from '../../utils/profile-view'

export interface ProfileState {
  /** 全部可安装工作台（含内置与用户导入） */
  profiles: ProfileSummary[]
  /** 当前生效 id（永远非空；主进程保证回落 wb.base） */
  activeProfileId: string
  /** 当前生效工作台的装配快照 */
  profileSnapshot: CompositionSnapshot | null
  /** 降级明细：`report.degraded` 的扁平副本（UI 逐条可见用） */
  profileDegraded: Degradation[]
  /** 最后一次激活的整份报告（含校验问题，供「为什么没切过去」追问） */
  profileLastReport: ActivationReport | null
  profileBusy: boolean
  profileLoaded: boolean

  /* 派生（只读）—— 由 applyProfileToView 落地 */
  /** profile 声明的 Dock 面板顺序；null = 不覆盖（沿用用户/智能体偏好） */
  profileDockTabs: DockTabId[] | null
  /** profile 声明的无任务首页模块页；null = 不覆盖 */
  profileHomeModule: ModulePage | null
  /** profile 声明的 Composer chips */
  profileComposerChips: string[]

  loadProfiles: () => Promise<void>
  switchProfile: (id: string) => Promise<boolean>
  /** 把快照里的 ui 层投影到视图字段（纯 set，不发 IPC） */
  applyProfileToView: (snapshot: CompositionSnapshot | null) => void
  /** 订阅主进程广播（App 挂载时调一次） */
  subscribeProfileChanges: () => () => void
}

export const profileSlice: StateCreator<AppState, [], [], ProfileState> = (set, get) => ({
  profiles: [],
  activeProfileId: 'wb.base',
  profileSnapshot: null,
  profileDegraded: [],
  profileLastReport: null,
  profileBusy: false,
  profileLoaded: false,

  profileDockTabs: null,
  profileHomeModule: null,
  profileComposerChips: [],

  loadProfiles: async () => {
    try {
      const [list, active] = await Promise.all([ark.profile.list(), ark.profile.getActive()])
      const snapshot = active.snapshot
      set({
        profiles: Array.isArray(list) ? list : [],
        activeProfileId: active.profileId || 'wb.base',
        profileSnapshot: snapshot ?? null,
        profileDegraded: snapshot?.degraded ?? [],
        profileLoaded: true,
      })
      get().applyProfileToView(snapshot ?? null)
    } catch (err) {
      // 列表读不出来不算致命：留空列表，UI 显示「未知工作台」而非整页崩
      console.error('[profile] loadProfiles failed:', err)
      set({ profileLoaded: true })
    }
  },

  switchProfile: async (id) => {
    const current = get().activeProfileId
    if (id === current) return true
    set({ profileBusy: true })
    try {
      const report = await ark.profile.activate({ id })
      set({ profileBusy: false, profileLastReport: report })
      if (!report.ok) {
        // 失败不改任何视图态（事务性：主进程也没切成）
        const first = report.validation.issues.find((i) => i.level === 'error')
        get().pushToast({
          type: 'danger',
          message: first?.message ?? `工作台 ${id} 激活失败`,
          duration: 5000,
        })
        return false
      }
      const snapshot = report.snapshot ?? null
      set({
        activeProfileId: report.profileId,
        profileSnapshot: snapshot,
        profileDegraded: snapshot?.degraded ?? [],
        profiles: get().profiles.map((p) => ({ ...p, active: p.id === report.profileId })),
      })
      get().applyProfileToView(snapshot)
      const degradedCount = snapshot?.degraded.length ?? 0
      if (degradedCount > 0) {
        get().pushToast({
          type: 'warning',
          message: `已切换到工作台，但有 ${degradedCount} 项能力未生效`,
          duration: 5000,
        })
      }
      return true
    } catch (err) {
      set({ profileBusy: false })
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 5000 })
      return false
    }
  },

  applyProfileToView: (snapshot) => {
    const { dockTabs, homeModule, composerChips } = projectUiLayer(snapshot)
    set({ profileDockTabs: dockTabs, profileHomeModule: homeModule, profileComposerChips: composerChips })
  },

  subscribeProfileChanges: () => {
    return ark.profile.onChanged(async () => {
      // 广播只说「变了」，具体状态重新拉 —— 多窗口不会各算一份
      await get().loadProfiles()
    })
  },
})
