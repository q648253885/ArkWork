/* ArkWork — 权限模式与策略映射（v0.15.0，v0.28.0 扩五态） */

export type PermissionMode =
  | 'default'
  | 'autoApprove'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'

/**
 * PermissionMode 对 5 级风险分级的策略映射。
 * 每个策略位的消费者（改策略位前必读）：
 *  - workspaceReadonly / externalReadonly：registry.confirmBuiltinSkill 只读直通分支
 *  - workspaceLightWrite：registry 轻写分支 + permissions.evaluatePermission 第 4 步（riskToPolicy）
 *  - highRisk：registry 高风险分支（决定是否弹窗）+ evaluatePermission 第 4 步
 *  - reject：黑名单命中处置——evaluatePermission 第 0 步与 registry reject 分支；
 *    仅 bypassPermissions 允许 'allow'（穿透黑名单），其余状态必须 'deny'
 *  - protectedPaths：受保护路径写入处置——evaluatePermission 第 5 步 confirm 覆盖、
 *    file-writer/file-editor 的 isProtectedPath 拦截；仅 bypassPermissions 允许 'allow'
 */
export interface ModePolicy {
  workspaceReadonly: 'allow'
  externalReadonly: 'allow'
  workspaceLightWrite: 'allow' | 'light-confirm' | 'deny'
  highRisk: 'confirm' | 'deny' | 'allow'
  reject: 'deny' | 'allow'
  protectedPaths: 'confirm' | 'allow'
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
    reject: 'deny',
    protectedPaths: 'confirm',
  },
  // autoApprove（v0.28.0）：常规操作全部自动放行（含高风险命令），但保留两堵硬墙：
  // 黑名单仍拒绝（reject:'deny'）、受保护路径写入仍确认（protectedPaths:'confirm'）。
  // doom_loop 防失控检测照常生效。借鉴 mini-harness 的 auto + hard-wall 分层。
  autoApprove: {
    workspaceReadonly: 'allow',
    externalReadonly: 'allow',
    workspaceLightWrite: 'allow',
    highRisk: 'allow',
    reject: 'deny',
    protectedPaths: 'confirm',
  },
  acceptEdits: {
    workspaceReadonly: 'allow',
    externalReadonly: 'allow',
    workspaceLightWrite: 'allow',
    highRisk: 'confirm',
    reject: 'deny',
    protectedPaths: 'confirm',
  },
  plan: {
    workspaceReadonly: 'allow',
    externalReadonly: 'allow',
    workspaceLightWrite: 'deny',
    highRisk: 'deny',
    reject: 'deny',
    protectedPaths: 'confirm',
  },
  // bypassPermissions（v0.28.0）：唯一全放行形态，可穿透黑名单与受保护路径。
  // 仅会话内存态（不落盘）、进入前必须二次确认；doom_loop 升级跳过。
  bypassPermissions: {
    workspaceReadonly: 'allow',
    externalReadonly: 'allow',
    workspaceLightWrite: 'allow',
    highRisk: 'allow',
    reject: 'allow',
    protectedPaths: 'allow',
  },
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    value === 'default' ||
    value === 'autoApprove' ||
    value === 'acceptEdits' ||
    value === 'plan' ||
    value === 'bypassPermissions'
  )
}

/**
 * 持久化白名单：settings*.json 的 defaultMode 只允许这四种。
 * bypassPermissions 是纯会话态，出现在配置文件里视为脏数据（加载时告警并回退 default）。
 */
export const PERSISTABLE_MODES: readonly PermissionMode[] = [
  'default',
  'autoApprove',
  'acceptEdits',
  'plan',
]

/** 配置文件 defaultMode 专用守卫（排除纯会话态 bypassPermissions） */
export function isPersistableMode(value: unknown): value is PermissionMode {
  return PERSISTABLE_MODES.includes(value as PermissionMode)
}
