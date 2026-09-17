/* ============================================================
 * ArkWork — Editor: 语言包注册表（B2 / v0.31.1 修订）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §1.2 分包要求
 *
 * v0.31.1 变更（用户实测缺陷）：**动态 `import()` → 静态 `import`**。
 * 缺陷：Windows 产物（asar + file://）下 `__vitePreload` 动态拉取语言
 * chunk 静默失败（loadLanguage 的 catch 兜底为 null）→ 全语言退化为
 * 纯文本、无任何语法色；macOS 不受影响。
 * 修订：语言包改为静态 import，随 EditorPanel chunk（React.lazy）
 * 一次性加载 —— 主 chunk 仍零 @codemirror（§1.2 验收口径不变），
 * 语言包总量 ~400KB 本地读取，无网络成本，跨平台行为一致。
 *
 * 未登记的语言按 `null` 处理 → 编辑器退化为纯文本模式（不报错、不阻断打开）。
 * ============================================================ */
import type { LanguageSupport } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'

const LOADERS: Record<string, () => LanguageSupport> = {
  markdown: () => markdown(),
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  python: () => python(),
  html: () => html(),
  // css 语言包顺带支撑 scss/less 的近似高亮
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  yaml: () => yaml(),
  yml: () => yaml(),
}

/** 已登记（可高亮）的语言名 */
export function supportsLanguage(language: string): boolean {
  return language in LOADERS
}

const cache = new Map<string, LanguageSupport | null>()

/**
 * 按语言名取 `LanguageSupport`（返回 Promise 以保持既有调用方契约）。
 * 未登记语言 → `null`，调用方应退化为纯文本。
 */
export function loadLanguage(language: string): Promise<LanguageSupport | null> {
  const key = language.toLowerCase()
  const loader = LOADERS[key]
  if (!loader) return Promise.resolve(null)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const support = loader()
  cache.set(key, support)
  return Promise.resolve(support)
}
