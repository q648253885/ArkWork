/* ============================================================
 * ArkWork — Shared Types: Permission Model (v0.15.0)
 * 设计文档 §01-shell-permission-redesign
 * ============================================================ */

/**
 * 会话级权限模式（v0.28.0 五种）。
 * 与 main/agent/permission-mode.ts 双文件同步定义，改一处必须同步另一处。
 * bypassPermissions 仅会话内存态，不落盘（见 PERSISTABLE_MODES）。
 */
export type PermissionMode =
  | 'default'
  | 'autoApprove'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'

/** PermissionMode 对 5 级风险分级的策略映射（消费者说明见 main/agent/permission-mode.ts） */
export interface ModePolicy {
  /** workspace-readonly 的策略 */
  workspaceReadonly: 'allow'
  /** external-readonly 的策略 */
  externalReadonly: 'allow'
  /** workspace-light-write 的策略 */
  workspaceLightWrite: 'allow' | 'light-confirm' | 'deny'
  /** high-risk 的策略；'allow' 仅 autoApprove/bypassPermissions 使用 */
  highRisk: 'confirm' | 'deny' | 'allow'
  /** 黑名单命中处置；仅 bypassPermissions 允许 'allow' */
  reject: 'deny' | 'allow'
  /** 受保护路径写入处置；仅 bypassPermissions 允许 'allow' */
  protectedPaths: 'confirm' | 'allow'
}

/** 四级配置合并后的最终规则集合 */
export interface ResolvedRules {
  /** 永远优先的拒绝规则 */
  deny: string[]
  /** 触发确认的规则 */
  ask: string[]
  /** 静默放行的规则 */
  allow: string[]
  /** 合并后的默认模式（高优先级覆盖低优先级） */
  defaultMode: PermissionMode
  /** 追加到默认 PROTECTED_PATHS 的额外受保护路径 */
  protectedPaths: string[]
  /** 额外允许访问的目录（用于路径越界校验） */
  additionalDirectories: string[]
}

/** 权限评估三态决策 */
export interface PermissionDecision {
  decision: 'allow' | 'ask' | 'deny'
  reason: string
  /** 对应 v0.14.0 的 5 级风险分级，供日志/审计使用 */
  riskLevel: 'workspace-readonly' | 'external-readonly' | 'workspace-light-write' | 'high-risk' | 'reject'
  /** 用于 UI 展示的影响说明 */
  impacts: string[]
  /** 是否因 doom_loop 触发而升级为 ask */
  doomLoop?: boolean
}

/** 命令指纹，用于 doom_loop 防卡死检测 */
export interface CommandFingerprint {
  /** 规范化后的命令（去前后空格、合并连续空格） */
  command: string
  /** 执行目录 */
  cwd: string
}

/** 权限评估上下文 */
export interface PermissionContext {
  command: string
  cwd: string
  workspaceDir: string
  mode: PermissionMode
  /** 四级配置合并后的 allow/deny/ask 规则 */
  rules: ResolvedRules
}
