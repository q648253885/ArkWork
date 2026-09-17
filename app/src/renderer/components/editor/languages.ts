/* ============================================================
 * ArkWork — Editor: 语言包懒加载（B2）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §1.2 分包要求
 *
 * **每个语言包必须是独立 chunk，且只能通过动态 `import()` 触达**：
 *  - 顶层静态 import 会把全部语言包拖进主 chunk → 分包验收失败（主 chunk 不得含 @codemirror）
 *  - 语言包按需加载后缓存（同一语言只下载一次）
 *
 * 未登记的语言按 `null` 处理 → 编辑器退化为纯文本模式（不报错、不阻断打开）。
 * ============================================================ */
import type { LanguageSupport } from '@codemirror/language'

type LanguageLoader = () => Promise<LanguageSupport>

const LOADERS: Record<string, LanguageLoader> = {
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  jsx: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  tsx: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  json: async () => (await import('@codemirror/lang-json')).json(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  // css 语言包顺带支撑 scss/less 的近似高亮
  css: async () => (await import('@codemirror/lang-css')).css(),
  scss: async () => (await import('@codemirror/lang-css')).css(),
  less: async () => (await import('@codemirror/lang-css')).css(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  yml: async () => (await import('@codemirror/lang-yaml')).yaml(),
}

/** 已登记（可高亮）的语言名 */
export function supportsLanguage(language: string): boolean {
  return language in LOADERS
}

const cache = new Map<string, Promise<LanguageSupport | null>>()

/**
 * 按语言名取 `LanguageSupport`（懒加载 + 缓存）。
 * 未登记语言 → `null`，调用方应退化为纯文本。
 */
export function loadLanguage(language: string): Promise<LanguageSupport | null> {
  const key = language.toLowerCase()
  const loader = LOADERS[key]
  if (!loader) return Promise.resolve(null)
  const hit = cache.get(key)
  if (hit) return hit
  const p = loader().catch(() => null)
  cache.set(key, p)
  return p
}
