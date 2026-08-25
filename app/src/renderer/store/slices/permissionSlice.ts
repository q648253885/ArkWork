/* ============================================================
 * ArkWork — 会话权限 slice（v0.27.0 R3：自 store.ts 纯移动）
 * permissionMode / permissionRules（v0.15.0 权限模型）
 * ============================================================ */
import type { StateCreator } from 'zustand'
import { ark } from '../../ipc/client'
import { friendlyError } from '../meta'
import type { AppState } from '../types'

export const permissionSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<
    AppState,
    | 'permissionMode'
    | 'permissionRules'
    | 'getPermissionMode'
    | 'setPermissionMode'
    | 'refreshPermissionRules'
    | 'addPermissionRule'
  >
> = (set, get) => ({

  // ---- v0.15.0 权限模型 ----
  permissionMode: 'default',
  permissionRules: null,
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
  refreshPermissionRules: async () => {
    try {
      const rules = await ark.permission.resolveRules()
      set({ permissionRules: rules })
    } catch {
      set({ permissionRules: null })
    }
  },
  addPermissionRule: async (rule) => {
    try {
      await ark.permission.addRule(rule, 'allow')
      await get().refreshPermissionRules()
    } catch (err) {
      get().pushToast({ type: 'danger', message: friendlyError(err), duration: 0 })
    }
  },

});
