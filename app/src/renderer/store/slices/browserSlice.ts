/* ============================================================
 * ArkWork — 浏览器加载状态 slice（v0.27.0 R3：自 store.ts 纯移动）
 * Inspector「浏览器」Tab 的加载请求（BrowserLoadRequest）
 * ============================================================ */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

export const browserSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<AppState, 'browserLoad' | 'setBrowserLoad'>
> = (set) => ({
  browserLoad: null,
  setBrowserLoad: (req) => set({ browserLoad: req }),
})
