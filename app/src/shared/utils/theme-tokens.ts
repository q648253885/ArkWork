/* ============================================================
 * ArkWork — 主题 token 覆盖净化（纯函数 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §9.3
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §6
 *
 * 两条硬纪律：
 *  ① **只覆盖不新增** —— 行台/插件只能改已有 token 的值，不能发明新 token。
 *     理由：ArkWork 的 token 纪律是「定义 `--x` + tailwind.config 注册同名键」
 *     两步缺一即静默失效（TC-TOKEN-001..003）。允许新增等于允许制造失效 token。
 *  ② **值必须是静态颜色/长度** —— 拒绝 `url(...)` / `expression(...)` / `var(...)`
 *     与任何含 `;` 的复合值。插件的 manifest 是外部输入，不能成为注入面。
 * ============================================================ */

export type ThemeGroup = 'light' | 'dark'

export interface ThemeTokens {
  light: Record<string, string>
  dark: Record<string, string>
}

export interface ThemeRejection {
  group: ThemeGroup
  key: string
  reason: string
  value?: unknown
}

export interface SanitizeThemeResult {
  tokens: ThemeTokens
  rejected: ThemeRejection[]
}

/** token 键：CSS 自定义属性名（小写 + 数字 + 连字符） */
const TOKEN_KEY_RE = /^--[a-z0-9-]+$/
/** 十六进制颜色：#rgb / #rgba / #rrggbb / #rrggbbaa */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
/** 函数式颜色：只允许 rgb/rgba/hsl/hsla，参数集是数字/逗号/百分号/空格/点/斜杠/deg */
const FN_COLOR_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/degDE-]+\)$/
/** 长度：数字 + px/rem/em/% */
const LENGTH_RE = /^\d+(?:\.\d+)?(?:px|rem|em|%)$/

/**
 * 值白名单。**默认拒绝**：不在白名单一律 false
 * （宁可让作者改成十六进制，也不放行一个可能的注入面）。
 */
export function isSafeTokenValue(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length === 0 || s.length > 120) return false
  return HEX_RE.test(s) || FN_COLOR_RE.test(s) || LENGTH_RE.test(s)
}

/**
 * 净化一份 `{ light, dark }` token 覆盖集。
 *
 * 纪律：
 *  - **不抛错**（输入来自磁盘 JSON）；
 *  - 逐条记录 rejected（UI 与激活报告要逐条可见 —— 「冲突是信息不是故障」）；
 *  - 非对象 / 数组 / 缺组 → 该组为空集，**不视为错误**（缺省就是「不覆盖」）。
 */
export function sanitizeThemeTokens(input: unknown): SanitizeThemeResult {
  const tokens: ThemeTokens = { light: {}, dark: {} }
  const rejected: ThemeRejection[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { tokens, rejected }
  }
  const src = input as Record<string, unknown>
  for (const group of ['light', 'dark'] as ThemeGroup[]) {
    const raw = src[group]
    if (raw === undefined) continue
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      rejected.push({ group, key: group, reason: '该组必须是对象（键为 --token，值为颜色/长度）', value: raw })
      continue
    }
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!TOKEN_KEY_RE.test(k)) {
        rejected.push({ group, key: k, reason: 'token 名必须形如 --x-y（小写字母/数字/连字符，且以 -- 开头）', value: v })
        continue
      }
      if (typeof v !== 'string') {
        rejected.push({ group, key: k, reason: 'token 值必须是字符串', value: v })
        continue
      }
      if (!isSafeTokenValue(v)) {
        rejected.push({ group, key: k, reason: 'token 值只允许十六进制/rgb()/hsl() 颜色或 px/rem/em/% 长度', value: v })
        continue
      }
      tokens[group][k] = v.trim()
    }
  }
  return { tokens, rejected }
}

/** 合并多份 token 覆盖集（后者覆盖前者；用于 profile 与插件的叠加） */
export function mergeThemeTokens(...sets: Array<Partial<ThemeTokens> | null | undefined>): ThemeTokens {
  const out: ThemeTokens = { light: {}, dark: {} }
  for (const s of sets) {
    if (!s) continue
    if (s.light) Object.assign(out.light, s.light)
    if (s.dark) Object.assign(out.dark, s.dark)
  }
  return out
}

/** 该覆盖集是否为空（空集就不必写 documentElement，避免无谓的样式重算） */
export function isEmptyTheme(t: ThemeTokens | null | undefined): boolean {
  if (!t) return true
  return Object.keys(t.light).length === 0 && Object.keys(t.dark).length === 0
}
