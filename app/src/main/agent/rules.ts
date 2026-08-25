/* ArkWork — 权限规则解析、匹配与合并（v0.15.0） */

import { PermissionMode, isPersistableMode } from './permission-mode.js'

export interface Rule {
  raw: string
  tool: string
  pattern?: string
}

export interface ResolvedRules {
  defaultMode?: PermissionMode
  allow: Rule[]
  ask: Rule[]
  deny: Rule[]
}

export function parseRule(raw: string): Rule | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const m = trimmed.match(/^([A-Za-z0-9_][A-Za-z0-9_*]*?)\((.*)\)$/)
  if (m) {
    return { raw: trimmed, tool: m[1], pattern: m[2] }
  }
  return { raw: trimmed, tool: trimmed, pattern: '*' }
}

export function matchGlob(pattern: string, input: string): boolean {
  if (pattern === '*') return true
  // Claude Code 语义：`:` 后跟 `*` 视为「(冒号|空格) + 任意子命令」可选
  // 在转义前把 `:*` 替换为占位符，glob 处理后还原为可选组
  const COLON_STAR = '\u0001COLON_STAR\u0001'
  let working = pattern
  let needsColonStar = false
  if (working.includes(':*')) {
    working = working.replace(/:\*/g, COLON_STAR)
    needsColonStar = true
  }
  let re = working.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  re = re.replace(/\*\*/g, '__GLOBSTAR__')
  re = re.replace(/\*/g, '[^/]*')
  re = re.replace(/\?/g, '[^/]')
  re = re.replace(/__GLOBSTAR__/g, '.*')
  if (needsColonStar) {
    re = re.split(COLON_STAR).join('(?:[\\s:][^/]*)?')
  }
  return new RegExp(`^${re}$`).test(input)
}

export function matchRule(rule: Rule, toolName: string, commandOrPath: string): boolean {
  const normalizedTool = toolName === 'shell' ? 'Bash' : toolName
  if (!matchGlob(rule.tool, normalizedTool)) return false
  const target = commandOrPath ?? ''
  if (rule.pattern === undefined || rule.pattern === '*') return true
  return matchGlob(rule.pattern, target)
}

export function loadRulesFromConfig(_scope: string, config: unknown): ResolvedRules {
  const c = (config ?? {}) as Record<string, unknown>
  const permissions = (c.permissions ?? {}) as Record<string, unknown>
  const parseList = (key: string): Rule[] => {
    const arr = permissions[key]
    if (!Array.isArray(arr)) return []
    return arr
      .map((r) => parseRule(String(r)))
      .filter((r): r is Rule => r !== null)
  }
  return {
    // v0.28.0：持久化白名单校验——配置文件里的 bypassPermissions 视为脏数据（不落盘铁律）
    defaultMode: isPersistableMode(permissions.defaultMode) ? permissions.defaultMode : undefined,
    allow: parseList('allow'),
    ask: parseList('ask'),
    deny: parseList('deny'),
  }
}

export function mergeRules(
  managed: ResolvedRules,
  local: ResolvedRules,
  project: ResolvedRules,
  user: ResolvedRules,
): ResolvedRules {
  return {
    defaultMode: managed.defaultMode ?? local.defaultMode ?? project.defaultMode ?? user.defaultMode,
    deny: [...managed.deny, ...local.deny, ...project.deny, ...user.deny],
    ask: [...managed.ask, ...local.ask, ...project.ask, ...user.ask],
    allow: [...managed.allow, ...local.allow, ...project.allow, ...user.allow],
  }
}
