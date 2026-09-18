/* ============================================================
 * ArkWork — 内置扩展名 → 渲染器映射（纯函数 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §1.2（覆盖流）
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §2
 *                「preview/registry.ts 的 7 种渲染器 → ui.renderer 插槽」
 *
 * 为什么把这张表从 `renderer/store/meta.ts` 搬到 shared：
 *  ① `ui.renderer` 插槽（插件接管扩展名）需要知道**哪些扩展名已被内置占用**
 *     —— 这是「未显式 override 不得接管」规则的判定依据；
 *  ② 判定发生在**纯函数层**（可用 node:test 密闭覆盖），
 *     而 `renderer/store/meta.ts` 顶层读 `import.meta.env`，node:test 无法导入；
 *  ③ 单一真源：内置表只有一份，`detectRenderer` 与插件校验共用，永不漂移。
 *
 * ⚠️ 行为对齐纪律：本表与 v0.32.1 `meta.ts:241-252` 的实现**逐行等价**
 * （含 `'Makefile'.split('.').pop() === 'makefile'` 这一细节 —— 因此
 * `Makefile` 命中 `code` 而不是 `fallback`）。迁移期不改语义。
 * ============================================================ */
import { isRendererKind, type RendererKindName } from '@shared/types/vlib'

const MARKDOWN = ['md', 'markdown']
const BROWSER = ['html', 'htm']
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp']
const SVG = ['svg']
const TABLE = ['csv', 'tsv']
const CODE = [
  'ts', 'tsx', 'js', 'jsx', 'py', 'json', 'css', 'scss', 'less', 'go', 'rs', 'java', 'kt', 'swift',
  'rb', 'php', 'c', 'cpp', 'h', 'hpp', 'cs', 'vue', 'svelte', 'yaml', 'yml', 'toml', 'ini', 'sh',
  'bash', 'zsh', 'sql', 'dockerfile', 'makefile', 'lua', 'r', 'dart', 'txt', 'log', 'xml', 'text',
  'cfg', 'conf', 'env', 'properties', 'gitignore', 'editorconfig',
]

export const FALLBACK_RENDERER: RendererKindName = 'fallback'

/** 内置扩展名 → 渲染器（唯一真源） */
export const BUILTIN_EXT_RENDERER: Record<string, RendererKindName> = (() => {
  const out: Record<string, RendererKindName> = {}
  for (const e of MARKDOWN) out[e] = 'markdown'
  for (const e of BROWSER) out[e] = 'browser'
  for (const e of IMAGE) out[e] = 'image'
  for (const e of SVG) out[e] = 'svg'
  for (const e of TABLE) out[e] = 'table'
  for (const e of CODE) out[e] = 'code'
  return out
})()

/** 内置已占用的扩展名集合（插件「未 override 不得接管」的判定依据） */
export const BUILTIN_EXTENSIONS: string[] = Object.keys(BUILTIN_EXT_RENDERER)

/** 取扩展名（与既有实现同口径：无点文件名整串当扩展名） */
export function extOf(path: string): string {
  const parts = String(path ?? '').split('.')
  return (parts.length > 1 ? parts.pop()! : parts[0] ?? '').toLowerCase()
}

/**
 * 按扩展名判定渲染器。
 * @param overrides 插件/工作台声明的覆盖表 `{ '<ext>': '<RendererKind>' }`（键大小写不敏感）
 *
 * 两条纪律：
 *  ① **无 overrides 时与 v0.32.1 逐位一致**（回归用例把守）；
 *  ② overrides 的值若不是合法 RendererKind → **回落内置映射**（绝不返回非法值）。
 */
export function detectRendererKind(
  path: string,
  overrides?: Record<string, string> | null,
): RendererKindName {
  const ext = extOf(path)
  if (overrides && ext) {
    // 覆盖表键统一小写比较（作者可能写 KCHART）
    for (const [k, v] of Object.entries(overrides)) {
      if (k.toLowerCase() !== ext) continue
      if (isRendererKind(v)) return v
      break
    }
  }
  return BUILTIN_EXT_RENDERER[ext] ?? FALLBACK_RENDERER
}

/** 覆盖表净化：去掉扩展名不被支持的项（键必须小写字母数字） */
export function sanitizeRendererOverrides(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    const key = k.toLowerCase()
    if (!/^[a-z0-9]+$/.test(key)) continue
    out[key] = v
  }
  return out
}
