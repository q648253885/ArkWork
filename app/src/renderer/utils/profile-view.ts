/* ============================================================
 * ArkWork — Profile 视图投影（纯函数 · v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §2.12
 *
 * 为什么独立成纯模块（沿用 `shared/utils/flow-fold.ts` 与
 * `renderer/utils/plan-status.ts` 的同一先例）：
 *  - `store/slices/profileSlice.ts` 经 `ipc/client` 顶层读 window、
 *    经 `store/meta` 顶层读 `import.meta.env` —— node:test 无法导入；
 *  - 而「快照 ui 层 → 视图三字段」恰恰是最容易被写错的转换
 *    （字符串逗号分隔 / homeModule 白名单 / applied=false 要跳过），
 *    必须能被密闭单测逐条把守。
 * ============================================================ */
import type { DockTabId } from '@shared/types/agent'
import type { CompositionSnapshot, Degradation } from '@shared/types/profile'
import type { ModulePage } from '../store/types'

export interface ProjectedProfileView {
  /** null = 不覆盖（沿用用户/智能体原有偏好） */
  dockTabs: DockTabId[] | null
  homeModule: ModulePage | null
  composerChips: string[]
}

/** 合法的 CenterStage 首页模块白名单（与 store ModulePage 同源，值级校验） */
const HOME_MODULES: readonly ModulePage[] = ['automations', 'skills', 'agents', 'kb', 'memory', 'settings']

/**
 * 装配快照 → 视图字段。
 *
 * 三条纪律：
 *  ① `applied=false` 的项**必须跳过** —— 快照里带上没生效的值等于骗用户；
 *  ② dockTabs 空串不可用：声明了却为空数组时不覆盖（留给用户/智能体偏好）；
 *  ③ composerChips 上限 8 条（manifest 解析层已截断，这里再兜一次防御）。
 */
export function projectUiLayer(snapshot: CompositionSnapshot | null): ProjectedProfileView {
  if (!snapshot) return { dockTabs: null, homeModule: null, composerChips: [] }
  let dockTabs: DockTabId[] | null = null
  let homeModule: ModulePage | null = null
  let composerChips: string[] = []
  for (const item of snapshot.layers.ui) {
    if (!item.applied) continue
    if (item.slot === 'ui.dockTabs' && item.value) {
      const tabs = item.value.split(',').filter(Boolean) as DockTabId[]
      if (tabs.length > 0) dockTabs = tabs
    } else if (item.slot === 'ui.homeModule' && item.value) {
      if (HOME_MODULES.includes(item.value as ModulePage)) homeModule = item.value as ModulePage
    } else if (item.slot === 'ui.composerChips' && item.value) {
      composerChips = item.value.split(',').filter(Boolean).slice(0, 8)
    }
  }
  return { dockTabs, homeModule, composerChips }
}

/** 阻断项：这类降级意味着「这次没切成」，必须能被 UI 追问 */
export function blockingDegradations(snapshot: CompositionSnapshot | null): Degradation[] {
  return (snapshot?.degraded ?? []).filter((d) => d.blocking)
}

/** 非阻断降级计数（UI 橙点用；阻断用红点，两者互斥展示） */
export function warningCount(snapshot: CompositionSnapshot | null): number {
  return (snapshot?.degraded ?? []).filter((d) => !d.blocking).length
}
