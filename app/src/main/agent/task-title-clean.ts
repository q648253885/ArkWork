/* ============================================================
 * ArkWork — Task Title Pure Helpers
 * v0.31.0 C2：标题清洗与占位判定的**纯函数层**（零依赖，可被 node:test
 * 直连导入）。依赖 MESSAGES / LLM / store 的编排逻辑在 task-title.ts。
 * ============================================================ */

/** 标题最大长度（码点数） */
export const TITLE_MAX_CHARS = 16

/** 引号包裹对：首尾成对时剥掉外层 */
const QUOTE_PAIRS: ReadonlyArray<[string, string]> = [
  ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'],
  ['"', '"'], ['\'', '\''], ['`', '`'], ['《', '》'],
]

/** 常见「任务：」「Task:」类前缀（模型偶发无视规则加上） */
const PREFIX_RE = /^(?:任务|标题|title|task)\s*[:：]\s*/i
/** 句末标点（模型偶发带句号收尾） */
const TRAILING_PUNCT_RE = /[。．.！!？?…~～\s]+$/u

/**
 * 判断 title 是否命中占位标题（含 dedupeTitle 追加的数字后缀，
 * 如「未命名任务 2」/「Untitled task 3」）。
 * bases 由调用方提供（task-title.ts 从四语言 MESSAGES 取 'tasks.untitled' 值），
 * 本函数保持零依赖。
 */
export function isPlaceholderTitleIn(title: string, bases: readonly string[]): boolean {
  const t = title.trim()
  if (t === '') return true
  for (const base of bases) {
    if (base === '') continue
    if (t === base) return true
    if (t.startsWith(`${base} `) && /^\d+$/.test(t.slice(base.length + 1))) return true
  }
  return false
}

/**
 * 清洗模型输出的标题（纯函数）：
 * 取首个非空行 → 剥引号包裹 → 去前缀 → 去句末标点 → 压缩空白 → 限长 16 码点。
 * 清洗后为空返回 ''（调用方放弃本次结果，保留原标题）。
 */
export function cleanTitle(raw: string): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  // 取首个非空行
  const firstLine = s.split('\n').map((l) => l.trim()).find((l) => l !== '')
  if (!firstLine) return ''
  s = firstLine
  // 剥成对引号（只剥一层；嵌套引号本身就该保留）
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(1, -1).trim()
      break
    }
  }
  // 去「任务：」类前缀（可能多层，循环剥）
  for (;;) {
    const next = s.replace(PREFIX_RE, '')
    if (next === s) break
    s = next
  }
  // 去句末标点
  s = s.replace(TRAILING_PUNCT_RE, '')
  // 压缩内部连续空白
  s = s.replace(/\s+/g, ' ').trim()
  // 限长（按码点，避免 emoji/生僻字截出代理对残片）
  const chars = [...s]
  if (chars.length > TITLE_MAX_CHARS) s = chars.slice(0, TITLE_MAX_CHARS).join('')
  return s.trim()
}
