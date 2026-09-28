/* ArkWork — 权限规则解析、匹配与合并（v0.15.0） */

import { PermissionMode, isPersistableMode } from './permission-mode.js'
import type { PermissionRuleEntry } from '@shared/types/permission.js'

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
  /**
   * ★ v0.36.0（F6.1 / P9）：被用户**关掉生效**的规则原文。
   *
   * 为什么不直接把关掉的规则从三张表里删掉：
   *   面板要能「关掉 → 再打开」，删掉就找不回来了。所以关停是**登记**而非删除 ——
   *   规则仍在表里，只是 `mergeRules` 在合并时跳过它（评估语义完全等价于已删除）。
   *   只有 `local` 作用域会被写入（其余三级是只读配置）。
   */
  disabled?: string[]
}

/** 是否被 `disabled` 关停 */
export function isRuleDisabled(scope: ResolvedRules, raw: string): boolean {
  return (scope.disabled ?? []).includes(raw)
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
  const rawDisabled = permissions.disabled
  const disabled = Array.isArray(rawDisabled) ? rawDisabled.map((s) => String(s).trim()).filter(Boolean) : []
  return {
    // v0.28.0：持久化白名单校验——配置文件里的 bypassPermissions 视为脏数据（不落盘铁律）
    defaultMode: isPersistableMode(permissions.defaultMode) ? permissions.defaultMode : undefined,
    allow: parseList('allow'),
    ask: parseList('ask'),
    deny: parseList('deny'),
    disabled,
  }
}

export function mergeRules(
  managed: ResolvedRules,
  local: ResolvedRules,
  project: ResolvedRules,
  user: ResolvedRules,
): ResolvedRules {
  // ★ v0.36.0（F6.1）：关停规则在**合并这一步**统一跳过 —— 只有一处需要记得这件事，
  //   评估链（evaluatePermission）拿到的就是「已生效集合」，行为与「直接删掉」等价。
  const live = (scope: ResolvedRules, list: Rule[]): Rule[] => list.filter((r) => !isRuleDisabled(scope, r.raw))
  return {
    defaultMode: managed.defaultMode ?? local.defaultMode ?? project.defaultMode ?? user.defaultMode,
    deny: [...live(managed, managed.deny), ...live(local, local.deny), ...live(project, project.deny), ...live(user, user.deny)],
    ask: [...live(managed, managed.ask), ...live(local, local.ask), ...live(project, project.ask), ...live(user, user.ask)],
    allow: [...live(managed, managed.allow), ...live(local, local.allow), ...live(project, project.allow), ...live(user, user.allow)],
  }
}

/* ============================================================
 * ★ v0.36.0（F6.1 / P9）：四级作用域 → 可视化条目
 * ============================================================ */

/** 作用域展示顺序 = 优先级顺序（managed 最高） */
export const RULE_SCOPES = ['managed', 'local', 'project', 'user'] as const
export type RuleScope = (typeof RULE_SCOPES)[number]

/**
 * 四级作用域 → 规则条目列表（**纯函数**）。
 *
 * 关键约定：
 *   · 顺序 = `managed → local → project → user`（与 `mergeRules` 的优先级一致，
 *     面板上「谁覆盖谁」一眼可见）；
 *   · `enabled` 只受**本作用域**的 `disabled` 影响（关停是作用域内的登记）；
 *   · `editable` 只对 `local` 为 true —— 其余三级来自用户手写配置或管理员下发，
 *     从 UI 改它们只会被下次读取覆盖，属「改了也没用」的静默陷阱（纪律⑨）。
 */
export function listRuleEntries(scoped: Record<RuleScope, ResolvedRules>): PermissionRuleEntry[] {
  const out: PermissionRuleEntry[] = []
  for (const scope of RULE_SCOPES) {
    const rules = scoped[scope]
    for (const behavior of ['allow', 'ask', 'deny'] as const) {
      for (const r of rules[behavior]) {
        const pattern = r.pattern === undefined || r.pattern === '' ? '*' : r.pattern
        out.push({
          raw: r.raw,
          tool: r.tool,
          pattern,
          behavior,
          scope,
          enabled: !isRuleDisabled(rules, r.raw),
          editable: scope === 'local',
        })
      }
    }
  }
  return out
}
