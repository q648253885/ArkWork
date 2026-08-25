/* ============================================================
 * ArkWork — Renderer Store 持久化辅助（v0.27.0 R3：自 store.ts 纯移动）
 * workspaces / active workspace / 按工作区隔离的 UI 偏好（localStorage）
 * ============================================================ */
import type { Workspace } from './types'
import i18n from '../i18n'


const WORKSPACES_KEY = 'arkwork:workspaces'
const ACTIVE_WS_KEY = 'arkwork:active-workspace'

export function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Workspace[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        // 兼容旧数据：无 path 字段补空字符串
        return parsed.map((w) => ({ ...w, path: w.path ?? '' }))
      }
    }
  } catch { /* fall through */ }
  return [{ id: 'default', name: i18n.t('slice.persist.defaultWorkspace'), path: '', createdAt: Date.now() }]
}

export function saveWorkspaces(list: Workspace[]): void {
  try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

export function loadActiveWorkspace(): string {
  try {
    return localStorage.getItem(ACTIVE_WS_KEY) || 'default'
  } catch { return 'default' }
}

export function saveActiveWorkspace(id: string): void {
  try { localStorage.setItem(ACTIVE_WS_KEY, id) } catch { /* ignore */ }
}

/* ============================================================
 * v0.9.0 — ui-state 持久化（按工作区隔离，对齐 ui-state.json 语义）
 * ============================================================ */
const uiKey = (k: string) => `arkwork:ui:${k}:${loadActiveWorkspace() || 'default'}`

export function loadUiState<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(uiKey(key))
    if (raw != null) return JSON.parse(raw) as T
  } catch { /* ignore */ }
  return fallback
}

export function saveUiState<T>(key: string, val: T): void {
  try { localStorage.setItem(uiKey(key), JSON.stringify(val)) } catch { /* ignore */ }
}

