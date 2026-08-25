/* ArkWork — 会话级 PermissionMode 状态（v0.15.0，v0.28.0 扩五态）
 *
 * 与 settings 文件中的 defaultMode 区分：defaultMode 是持久化基线，
 * 本模块是用户在当前会话内通过 Shift+Tab / UI 切换的覆盖层。
 * 同一 workspace 内多任务共享一个会话模式；未显式切换时回退到 defaultMode。
 * bypassPermissions 只存在于本覆盖层，永不落盘。
 */
import { PermissionMode, PERSISTABLE_MODES } from './permission-mode.js'

// v0.28.0：re-export 便于消费方（shell.ts 等）从单一模块取类型
export type { PermissionMode } from './permission-mode.js'

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

/** 校验并返回有效模式；非法输入返回 undefined（五态白名单） */
export function normalizeMode(value: unknown): PermissionMode | undefined {
  return value === 'default' ||
    value === 'autoApprove' ||
    value === 'acceptEdits' ||
    value === 'plan' ||
    value === 'bypassPermissions'
    ? value
    : undefined
}

/** 持久化校验：配置文件 defaultMode 不接受 bypassPermissions（纯会话态） */
export function normalizePersistedMode(value: unknown): PermissionMode | undefined {
  const mode = normalizeMode(value)
  return mode && PERSISTABLE_MODES.includes(mode) ? mode : undefined
}

/**
 * 共享的有效模式解析器：session override > settings.defaultMode > 'default'。
 * 供 registry / shell / file-writer / file-editor 等多条路径统一使用，
 * 动态 import settings-loader 避免测试环境加载 electron 模块图。
 */
export async function resolveEffectiveMode(workspaceDir?: string): Promise<PermissionMode> {
  try {
    if (!workspaceDir) return getSessionMode('') ?? 'default'
    const { loadPermissionSettings } = await import('./settings-loader.js')
    const settings = await loadPermissionSettings(workspaceDir)
    return getSessionMode(workspaceDir) ?? settings.defaultMode ?? 'default'
  } catch {
    return getSessionMode(workspaceDir ?? '') ?? 'default'
  }
}
