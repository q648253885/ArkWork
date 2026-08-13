/* ArkWork — 权限模式与策略映射（v0.15.0） */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan'

export interface ModePolicy {
  workspaceReadonly: 'allow'
  externalReadonly: 'allow'
  workspaceLightWrite: 'allow' | 'light-confirm' | 'deny'
  highRisk: 'confirm' | 'deny'
}

export const MODE_POLICIES: Record<PermissionMode, ModePolicy> = {
  // default 模式：工作区内轻写（mkdir / cat > file / sed -i 等）静默通过，
  // 与 acceptEdits 行为一致；只有 high-risk（rm -rf / sudo / 越界写等）才弹窗。
  // 之前用 light-confirm（首次会话确认一次）会被用户在「工作区已确认」场景下反复打扰。
  default: {
    workspaceReadonly: 'allow',
    externalReadonly: 'allow',
    workspaceLightWrite: 'allow',
    highRisk: 'confirm',
  },
  acceptEdits: {
    workspaceReadonly: 'allow',
    externalReadonly: 'allow',
    workspaceLightWrite: 'allow',
    highRisk: 'confirm',
  },
  plan: {
    workspaceReadonly: 'allow',
    externalReadonly: 'allow',
    workspaceLightWrite: 'deny',
    highRisk: 'deny',
  },
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'default' || value === 'acceptEdits' || value === 'plan'
}
