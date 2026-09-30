/* ============================================================
 * ArkWork — Renderer Utils: path-links（v0.42.0 新增，纯函数）
 * 把自由文本（清单项产物摘要等）中的「类路径 token」切成分段序列，
 * 供消费方把 path 段渲染为可点击 FileLink（文本段原样保留）。
 *
 * 为什么下沉为纯函数：判定「这句话里哪个词是文件路径」是高风险判据 ——
 * 误判会把普通句子切碎成假链接，漏判会让用户必须自己去工作区找文件。
 * 真值表用例（TC-PLINK）钉死正/负例，消费方只做渲染。
 *
 * 判据（looksLikePathToken，作用在**清洗后**的 token 上）：
 *  - 含 `/` 或 `\`（分隔符是路径的必要条件；裸文件名 `a.ts:12` 不算，
 *    与时间 `12:30` 无法区分，宁缺毋滥）；
 *  - 不含 `://`（URL 不是工作区路径）；
 *  - 清洗（剥首尾标点 + 尾分隔符 + 行号后缀）后长度 ≥ 4 且不全是
 *    分隔符/点（`src/` 这类口语化目录引用不算，`a/b` 过短不算）。
 * ============================================================ */

export interface PathSegment {
  kind: 'text' | 'path'
  value: string
  /** 仅 path 段：`a.ts:12` 形态解析出的行号 */
  line?: number | null
}

/** 首尾会被清洗的标点（中英文常见句读 + 引号括号 + 孤立冒号；数字/字母不在其列） */
const PUNCT = '.,;:!?)\'"`([{}「『（《、，。；：！？…》）』」'

/** 尾部分隔符（`src/` 这类口语化目录引用：剥掉后无分隔符 → 不再判为路径） */
const SEPARATORS = '/\\'

function isPunct(ch: string | undefined): boolean {
  return !!ch && PUNCT.includes(ch)
}

function isSep(ch: string | undefined): boolean {
  return !!ch && SEPARATORS.includes(ch)
}

export interface CleanedToken {
  /** 清洗后的可打开路径（行号后缀已剥离） */
  path: string
  /** `src/a.ts:12` → 12；无行号后缀为 null */
  line: number | null
  /** token 起始处跳过的前导标点数（供调用方切 text 段） */
  lead: number
}

/** 剥首尾标点与尾分隔符 + 解析行号后缀（唯一清洗实现，looksLike 与 linkify 共用） */
export function trimToken(token: string): CleanedToken {
  let start = 0
  let end = token.length
  while (start < end && isPunct(token[start])) start++
  while (end > start && (isPunct(token[end - 1]) || isSep(token[end - 1]))) end--
  const s = token.slice(start, end)
  // 行号后缀：仅当冒号后是纯数字结尾（`a.ts:12` → path `a.ts` line 12）。
  // 注意此步无前置过滤 —— 「12:30」会被切成 path '12'，由 looksLikePathToken
  // 的长度/分隔符判据兜住（调用序：looksLike 先行，不过关不会走到这）。
  const m = s.match(/^(.+):(\d+)$/)
  if (m) return { path: m[1], line: Number(m[2]), lead: start }
  return { path: s, line: null, lead: start }
}

/** token 是否「像工作区路径」（不含空白的前提由调用方保证） */
export function looksLikePathToken(raw: string): boolean {
  if (!raw) return false
  if (raw.includes('://')) return false
  const { path } = trimToken(raw)
  // 4 = 「x/y.ts」级别的下限：'a/b' 这类三字符 token 与口语片段无法区分，宁缺毋滥
  if (path.length < 4) return false
  if (!path.includes('/') && !path.includes('\\')) return false
  if (/^[\\/.\s]+$/.test(path)) return false
  return true
}

/**
 * 主入口：文本 → 分段序列。全部 text 段与 path 段按序拼接后与输入逐字一致
 * （含空白与标点），path 段是清洗后的可打开路径。
 * 分词：空白与常见中文标点都算分隔 —— 「修改了 src/a.ts、src/b.ts」顿号两侧
 * 必须各自成 token（中文摘要天然无空格）；被跳过的标点留在 text 段（无损）。
 */
const TOKEN_RE = /[^\s\u3001\u3002\uFF0C\uFF1B\uFF1A\uFF01\uFF1F\uFF08\uFF09\u300C\u300D\u300A\u300B\u2014\u2026]+/g

export function linkifyWorkspacePaths(text: string): PathSegment[] {
  if (!text) return []
  const out: PathSegment[] = []
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const token = m[0]
    if (!looksLikePathToken(token)) continue
    const { path, line, lead } = trimToken(token)
    const start = m.index + lead
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) })
    out.push({ kind: 'path', value: path, line })
    // 尾标点（token 里 path 之后的部分）留给后续 text 段
    last = start + path.length
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}
