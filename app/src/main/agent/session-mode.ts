/* ArkWork — 会话级 PermissionMode 状态（v0.15.0）
 *
 * 与 settings 文件中的 defaultMode 区分：defaultMode 是持久化基线，
 * 本模块是用户在当前会话内通过 Shift+Tab / UI 切换的覆盖层。
 * 同一 workspace 内多任务共享一个会话模式；未显式切换时回退到 defaultMode。
 */
import { PermissionMode } from './permission-mode.js'

const sessionModes = new Map<string, PermissionMode>()

/** 读取当前 workspace 的会话模式；未设置返回 undefined（调用方回退 defaultMode） */
export function getSessionMode(workspaceDir: string): PermissionMode | undefined {
  return sessionModes.get(workspaceDir)
}

/** 设置当前 workspace 的会话模式 */
export function setSessionMode(workspaceDir: string, mode: PermissionMode): PermissionMode {
  sessionModes.set(workspaceDir, mode)
  return mode
}

/** 校验并返回有效模式；非法输入返回 undefined */
export function normalizeMode(value: unknown): PermissionMode | undefined {
  return value === 'default' || value === 'acceptEdits' || value === 'plan'
    ? value
    : undefined
}
