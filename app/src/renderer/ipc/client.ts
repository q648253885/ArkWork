/* ============================================================
 * ArkWork — Renderer IPC Client
 * 类型化的 window.ark 包装 + 加载状态管理
 * ============================================================ */
import type { ArkApi } from '@shared/types/ipc'

export const ark: ArkApi = (window as unknown as { ark: ArkApi }).ark

/** 验证 window.ark 已暴露（preload 加载后） */
export function isArkReady(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { ark?: ArkApi }).ark
}

export type Unsubscribe = () => void
