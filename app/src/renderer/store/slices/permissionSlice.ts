/* ============================================================
 * ArkWork — 会话权限 slice（v0.27.0 R3：自 store.ts 纯移动）
 * permissionMode / permissionRules（v0.15.0 权限模型）
 *
 * ★ v0.36.0（F6.1 / P9）：新增 `permissionRuleEntries`（带来源与生效态的条目）
 *   与三个逐行操作。**为什么两套数据并存**：
 *     · `permissionRules`（ResolvedRules）= 合并后用于评估的集合；
 *     · `permissionRuleEntries`（条目）= 面板的逐行数据，带 scope / enabled / editable。
 *   合并结果把「这条谁写的」「这条生效吗」丢掉了，无法反推，因此不可二选一。
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import { friendlyError } from '../meta'
import type { AppState } from '../types'
import type { PermissionRuleBehavior, PermissionRuleEntry } from '@shared/types/permission'

export const permissionSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'permissionMode'
    | 'permissionRules'
    | 'permissionRuleEntries'
    | 'permissionRulesLoading'
    | 'getPermissionMode'
    | 'setPermissionMode'
    | 'refreshPermissionRules'
    | 'addPermissionRule'
    | 'removePermissionRule'
    | 'setPermissionRuleEnabled'
  >
> = (set, get) => ({

  // ---- v0.15.0 权限模型 ----
  permissionMode: 'default',
  permissionRules: null,
  permissionRuleEntries: [],
  permissionRulesLoading: false,
  getPermissionMode: async () => {
    try {
      const mode = await ark.permission.getMode()
      set({ permissionMode: mode })
    } catch {
      // 忽略：主进程未就绪时保持默认
    }
  },
  setPermissionMode: async (mode) => {
    try {
      const applied = await ark.permission.setMode(mode)
      set({ permissionMode: applied })
      await get().refreshPermissionRules()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  /**
   * 拉取规则（合并集 + 条目集）。
   *
   * 失败语义（P9 五态之「错误」）：**保留上一次的条目**，只把 loading 落下；
   * 面板据 `permissionRules === null` 判「从未成功过」。
   * 把条目清成 `[]` 会让「读取失败」伪装成「一条规则都没有」—— 最糟的静默退化。
   */
  refreshPermissionRules: async () => {
    set({ permissionRulesLoading: true })
    try {
      const [rules, entries] = await Promise.all([
        ark.permission.resolveRules(),
        ark.permission.listRules(),
      ])
      set({ permissionRules: rules, permissionRuleEntries: entries, permissionRulesLoading: false })
    } catch {
      set({ permissionRules: null, permissionRulesLoading: false })
    }
  },
  addPermissionRule: async (rule, behavior: PermissionRuleBehavior = 'allow') => {
    try {
      await ark.permission.addRule(rule, behavior)
      await get().refreshPermissionRules()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  removePermissionRule: async (entry: PermissionRuleEntry) => {
    try {
      await ark.permission.removeRule({ rule: entry.raw, behavior: entry.behavior })
      await get().refreshPermissionRules()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },
  setPermissionRuleEnabled: async (entry: PermissionRuleEntry, enabled: boolean) => {
    // 乐观更新：开关是高频微交互，等一次 IPC + 一次全量刷新会让拨动「粘手」。
    // 失败时 finally 里的 refresh 会以磁盘真值覆盖回来 —— 不做假象。
    set({
      permissionRuleEntries: get().permissionRuleEntries.map((e) =>
        e.raw === entry.raw && e.behavior === entry.behavior && e.scope === entry.scope
          ? { ...e, enabled }
          : e,
      ),
    })
    try {
      await ark.permission.setRuleEnabled({ rule: entry.raw, behavior: entry.behavior, enabled })
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    } finally {
      await get().refreshPermissionRules()
    }
  },

});
