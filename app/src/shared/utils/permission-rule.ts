/* ============================================================
 * ArkWork — 权限规则的**纯函数**工具（v0.36.0 · F6.1 / P9）
 *
 * 放这里的理由（§3.3 规则 4：`shared/` 只放类型 + 纯函数）：
 *   两处需要同一套推理，而它们分处主/渲染两侧（渲染层不能引 main）：
 *     ① 拦截浮层（ToolConfirmLayer）要把「刚被拦下的这一次调用」建议成一条规则；
 *     ② 规则面板（PermissionRulesPanel）要把「工具 + glob」拼成规则原文。
 *   若各写一份，两处必然漂移 —— 用户会遇到「浮层说会记住这条，面板里却是另一条」。
 *
 * 规则语法（与 `main/agent/rules.ts` 的 `parseRule` 严格对齐）：
 *   `Tool`             → 整个工具
 *   `Tool(pattern)`    → 工具 + glob；`:` 后跟 `*` 表示「(冒号|空格) + 任意子命令」可选
 * ============================================================ */
import type { PermissionRuleBehavior } from '@shared/types/permission'

/** 与 `main/agent/rules.ts#parseRule` 同一条正则（单一事实源在此，main 侧引用） */
const RULE_RE = /^([A-Za-z0-9_][A-Za-z0-9_*]*?)\((.*)\)$/

export interface ParsedRuleText {
  tool: string
  /** 无括号时为空串（表示「整个工具」） */
  pattern: string
}

/**
 * 拆解规则原文为 `{ tool, pattern }`。
 *
 * 与 main 侧 `parseRule` 的唯一区别：`parseRule` 把无括号规则写成 `pattern:'*'`，
 * 这里保留**原始空串**以便面板区分「整个工具」与「显式 `Tool(*)`」。
 * 两者语义相同（`matchGlob('*', x)` 恒 true），但展示上不该混为一谈。
 */
export function parseRuleText(raw: string): ParsedRuleText | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const m = RULE_RE.exec(trimmed)
  if (m) return { tool: m[1] as string, pattern: m[2] as string }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_*]*$/.test(trimmed)) return null
  return { tool: trimmed, pattern: '' }
}

/** 组装规则原文（`pattern` 为空/`*` 时退化为整个工具） */
export function formatRuleText(tool: string, pattern?: string): string {
  const t = tool.trim()
  const p = (pattern ?? '').trim()
  if (!t) return ''
  if (!p || p === '*') return t
  return `${t}(${p})`
}

/** 从规则原文取工具名（解析失败回落为原文首段，供 UI 展示兜底） */
export function toolOfRule(raw: string): string {
  return parseRuleText(raw)?.tool ?? raw.split('(')[0] ?? raw
}

/** 从规则原文取 glob（无则 `*`） */
export function patternOfRule(raw: string): string {
  const p = parseRuleText(raw)
  if (!p) return '*'
  return p.pattern === '' ? '*' : p.pattern
}

/**
 * 把「刚被拦下的那一次 shell 调用」建议成一条**人还算能读懂**的规则。
 *
 * 设计取舍（为什么不做「精确到完整命令」）：
 *   `Bash(git diff --stat)` 只覆盖那一次调用 —— 用户下次跑 `git diff HEAD` 又要点一次，
 *   很快就把「记住」当成没用。所以默认建议到**子命令**粒度：
 *     git diff --stat        → Bash(git diff:*)
 *     npm test -- --watch    → Bash(npm test:*)
 *     rm -rf build           → Bash(rm:*)        ← 单令牌命令退化为整命令
 *     ls                     → Bash(ls)
 *
 * ⚠️ 安全取向：**只建议、不代替用户决定**。返回值由浮层原样展示，用户可改可取消；
 *    高风险命令（deny 场景）同样只是建议 `Bash(rm:*)` 这类**工具级**拦截。
 */
export function suggestRuleFromCommand(command: string, tool = 'Bash'): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return tool
  // 去掉前导环境变量赋值与 `sudo`（`FOO=1 sudo npm test` → 主体是 npm test）
  let i = 0
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] as string) || tokens[i] === 'sudo')) i += 1
  const head = tokens[i]
  if (!head) return tool
  const sub = tokens[i + 1]
  // 子命令必须是「词」（排除 flag 与路径参数），否则退化为整命令
  const isWord = (s: string | undefined): s is string => !!s && /^[A-Za-z][A-Za-z0-9_-]*$/.test(s)
  if (isWord(sub)) return `${tool}(${head} ${sub}:*)`
  return `${tool}(${head})`
}

/** 行为 → 面板展示的稳定顺序（allow 在前，与 P9 列表顺序一致） */
export const RULE_BEHAVIORS: readonly PermissionRuleBehavior[] = ['allow', 'ask', 'deny'] as const

/**
 * 规则表单里「工具」下拉的选项。
 *
 * ⚠️ 这份清单必须与**真实接入权限评估链的工具**一致，否则会造出静默陷阱：
 *   用户在面板里给 `Write` 写了一条 deny，以为从此写文件都要拦，
 *   而评估链压根没拿 `Write` 去匹配过规则 —— 规则静静地不生效。
 *
 * 因此它由一条守卫用例把守（TC-PRULES-004）：从 `main/agent/permissions.ts`
 * 里抽出所有 `findFirstMatchingRule(rules.x, '<Tool>', ...)` 的工具名，与本清单比对。
 * 将来谁把文件类工具接进评估链，那条用例立刻报红，逼着这里同步。
 *
 * 现状：**只有 shell 走了规则匹配**（`Bash`）；文件写入边界由
 * `main/agent/skills/file-tool-safety.ts` 的受保护路径独立把守，不走规则表。
 */
export const PERMISSION_TOOL_OPTIONS: readonly string[] = ['Bash'] as const
