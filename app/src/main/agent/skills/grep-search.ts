/* ============================================================
 * ArkWork — Builtin Skill: grep-search
 * v0.16.0 / v0.28.0（F3）
 *
 * 在工作区文件中搜索文本/正则，替代 shell 的 grep/rg。
 * 忽略二进制、node_modules、.git、.arkwork；返回文件+行号+上下文。
 * v0.28.0 对齐 Claude Code Grep：
 *  - output_mode 三态：content（默认）/ files_with_matches / count
 *  - context 行（rg 惯例：命中行 `file:line:`，上下文行 `file-line-`）
 *  - multiline 跨行匹配
 *  - head_limit 默认 250、上限 2000（兼容旧 maxResults 别名）
 * ============================================================ */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep, extname } from 'node:path'
import {
  getWorkspaceDirFromCtx,
  resolveWorkspacePath,
  isInsideWorkspace,
  logInfo,
  logError,
  type FileToolContext,
} from './file-tool-safety.js'
import type { SkillContext } from '../registry.js'
import { checkRepeatRead, recordRepeatResult } from './read-repeat-guard.js'

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count'

export interface GrepSearchArgs {
  pattern: string
  /** 搜索目录或文件（相对工作区，默认工作区根） */
  path?: string
  /** 可选的 glob 过滤，例如所有 ts 文件 */
  glob?: string
  /** 是否区分大小写（默认 false） */
  caseSensitive?: boolean
  /**
   * v0.28.0：输出模式（Claude Code Grep 对齐）。
   * - content：逐行命中（默认），可搭配 context* 附上下文
   * - files_with_matches：仅列出含命中的文件路径（找文件用，最省 token）
   * - count：每个文件的命中次数统计
   */
  outputMode?: GrepOutputMode
  /** v0.28.0：命中行前后各附 N 行上下文（等价于同时设 contextBefore/contextAfter；仅 content 模式） */
  context?: number
  /** v0.28.0：命中行前 N 行上下文（仅 content 模式） */
  contextBefore?: number
  /** v0.28.0：命中行后 N 行上下文（仅 content 模式） */
  contextAfter?: number
  /** v0.28.0：跨行匹配模式（pattern 可含 \n，对整文件内容执行正则） */
  multiline?: boolean
  /** v0.28.0：最大返回条数（默认 250、上限 2000）；maxResults 保留为兼容别名 */
  headLimit?: number
  /** 最大返回条数（旧参数，v0.28.0 起推荐 headLimit；两者等价，headLimit 优先） */
  maxResults?: number
}

export interface GrepSearchResult {
  pattern: string
  total: number
  matches: Array<{
    file: string
    line: number
    text: string
  }>
  truncated: boolean
  /** 搜索总文件数 */
  scannedFiles: number
  /** v0.28.0：本次调用的输出模式回显 */
  outputMode: GrepOutputMode
  /** v0.28.0：files_with_matches 模式下的文件列表 */
  files?: string[]
  /** v0.28.0：count 模式下的每文件计数 */
  counts?: Array<{ file: string; count: number }>
  /**
   * v0.28.0：content 模式且附带上下文时的 rg 风格文本块
   * （命中行 `path:line:text`、上下文行 `path-line-text`、块间 `--` 分隔），
   * 模型优先读本字段，比逐条 matches 更省 token 且贴近 rg 直觉。
   */
  formatted?: string
  /** v0.24.0：防重读警告/拦截指令/零命中提示（engine 观察组装时前置送达模型） */
  hint?: string
}

// v0.28.0（F9）：默认 100→250、上限 500→2000（Claude Code head_limit 尺度；
// 大型仓库定位引用时 100 条常常不够，被迫二次搜索浪费轮次）。
const DEFAULT_MAX_RESULTS = 250
const MAX_RESULTS_CAP = 2000
const IGNORE_DIRS = new Set(['node_modules', '.git', '.arkwork', 'dist', 'out', 'release'])
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf',
  '.zip', '.tar', '.gz', '.dmg', '.exe', '.dll', '.so', '.dylib',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.mp3', '.mp4', '.mov',
  '.wasm', '.node',
])

export async function grepSearch(
  args: GrepSearchArgs,
  ctx: FileToolContext,
): Promise<GrepSearchResult | { status: 'failed'; error: string }> {
  const pattern = (args.pattern ?? '').trim()
  if (!pattern) {
    return { status: 'failed', error: 'grep-search: pattern 不能为空' }
  }

  const workspaceDir = await getWorkspaceDirFromCtx(ctx)
  const baseRaw = (args.path ?? '').trim() || '.'
  const { abs: baseAbs, rel: baseRel } = resolveWorkspacePath(baseRaw, workspaceDir)
  if (!isInsideWorkspace(baseRel)) {
    return { status: 'failed', error: `grep-search: 搜索路径越界（${baseRaw} 不在工作区内）` }
  }

  const outputMode: GrepOutputMode =
    args.outputMode === 'files_with_matches' || args.outputMode === 'count'
      ? args.outputMode
      : 'content'
  const multiline = !!args.multiline
  // v0.28.0：context 归一 —— context 是 before/after 的简写；上限 10 防止刷屏
  const ctxBefore = clampContext(args.contextBefore ?? args.context)
  const ctxAfter = clampContext(args.contextAfter ?? args.context)

  // v0.24.1：签名规范化——path 用解析后绝对路径（容忍绝对/相对混用），
  // 去掉 maxResults（参数漂移不再绕过防重读）。同关键词换参数反复搜 → 命中拦截。
  // v0.24.2：关键词归一化——alternation 拆开排序去转义，换序探测命中同一 signature。
  // v0.28.0：outputMode/multiline 进入签名（不同输出形态是不同的信息需求）；
  // context 不进入签名（同一关键词只换上下文行数视为漂移，继续拦截）。
  // 同时加全局预算：累计超限 → warn/block。
  const sig = {
    path: baseAbs,
    pattern: normalizeGrepPattern(pattern),
    caseSensitive: !!args.caseSensitive,
    outputMode,
    multiline,
  }
  // 全局预算把 baseAbs 也带进 _global 签名，便于编辑/写入后按 path 重置
  //（invalidateReadsOf 按子串匹配，可同时清掉单签名 + 全局签名）。
  // v0.28.0（F9）：单签 2/3→3/5、全局 6/8→12/16 —— 多关键词交叉定位是合法高频动作，
  // 配合放宽后的类别预算避免"搜索被拦但预算还剩很多"的倒挂。
  const verdict = checkRepeatRead(ctx as SkillContext, 'grep-search', sig, {
    warnThreshold: 3,
    blockThreshold: 5,
  })
  const globalVerdict = checkRepeatRead(ctx as SkillContext, 'grep-search', { _global: baseAbs }, {
    warnThreshold: 12,
    blockThreshold: 16,
  })
  const finalVerdict = pickStronger(verdict, globalVerdict)
  if (finalVerdict.action === 'block') {
    await logInfo('Tool', `grep-search: 重复搜索已拦截（${pattern}），返回行动指令`, ctx.taskId)
    return {
      pattern,
      total: 0,
      matches: [],
      truncated: false,
      scannedFiles: 0,
      outputMode,
      hint: finalVerdict.observation,
    }
  }
  const repeatHint = finalVerdict.action === 'warn' ? finalVerdict.hint : null

  const s = await stat(baseAbs).catch(() => null)
  if (!s) {
    return { status: 'failed', error: `grep-search: 路径不存在 ${baseRaw}` }
  }

  // v0.28.0：headLimit 为推荐名（Claude Code head_limit 对齐），maxResults 保留为兼容别名
  const maxResults = Math.min(
    args.headLimit ?? args.maxResults ?? DEFAULT_MAX_RESULTS,
    MAX_RESULTS_CAP,
  )
  const regex = buildRegex(pattern, !!args.caseSensitive, multiline)
  if (!regex) {
    return { status: 'failed', error: 'grep-search: pattern 不是合法正则表达式' }
  }

  const matches: GrepSearchResult['matches'] = []
  const files: string[] = []
  const counts: Array<{ file: string; count: number }> = []
  const formattedParts: string[] = []
  let scannedFiles = 0
  let collected = 0
  const seenFiles: string[] = []

  try {
    if (s.isFile()) {
      scannedFiles = 1
      const relPath = relative(workspaceDir, baseAbs).replaceAll(sep, '/')
      collectFile(baseAbs, relPath, regex, {
        outputMode,
        multiline,
        ctxBefore,
        ctxAfter,
        budget: maxResults,
        onCollected: (n) => { collected += n },
        matches,
        files,
        counts,
        formattedParts,
      })
    } else {
      await walk(baseAbs, workspaceDir, regex, {
        outputMode,
        multiline,
        ctxBefore,
        ctxAfter,
        glob: args.glob ?? '*',
        budget: maxResults,
        getRemaining: () => maxResults - collected,
        onCollected: (n) => { collected += n },
        onScanned: () => { scannedFiles += 1 },
        matches,
        files,
        counts,
        formattedParts,
        seenFiles,
      })
    }

    await logInfo('Tool', `grep-search: ${pattern} [${outputMode}] → ${collected} results in ${scannedFiles} files`, ctx.taskId)

    const result: GrepSearchResult & { hint?: string } = {
      pattern,
      total: collected,
      // content 模式才携带结构化命中列表（files/count 模式分别走自己的字段）
      matches: outputMode === 'content' ? matches.slice(0, maxResults) : [],
      truncated: collected > maxResults,
      scannedFiles,
      outputMode,
    }
    if (files.length) result.files = files
    if (counts.length) result.counts = counts
    if (formattedParts.length) result.formatted = formattedParts.join('\n')
    if (repeatHint) result.hint = repeatHint
    // v0.24.0（P1）：零命中 + 小工作区（≤ 20 个可搜文件）→ 列出全部文件，
    // 引导模型直接读目标文件，终结"换关键词反复 grep"打转（实测 81 次/任务）。
    if (collected === 0 && seenFiles.length > 0 && seenFiles.length <= 20) {
      result.hint = [
        result.hint ? result.hint + '\n\n' : '',
        `零命中提示：本次搜索范围内只有 ${seenFiles.length} 个可搜文本文件，已全部扫描：`,
        seenFiles.map((f) => `  - ${f}`).join('\n'),
        '',
        '工作区很小，不要继续换关键词 grep。请直接 file-reader 读取上述最相关的文件（或其中未读过的），定位后立即行动。',
      ].join('')
    }
    // v0.24.0：记录结果头，供防重读 block 时回带
    recordRepeatResult(
      ctx as SkillContext,
      'grep-search',
      sig,
      collected > 0
        ? `[${outputMode}] ${collected} 处结果${matches.length > 0 ? `，如 ${matches[0]?.file}:${matches[0]?.line}` : ''}`
        : `零结果（已扫描 ${scannedFiles} 个文件）`,
    )
    // 全局预算也要记录，否则后续全局判定没有内容头可回带
    recordRepeatResult(
      ctx as SkillContext,
      'grep-search',
      { _global: baseAbs },
      `[${outputMode}] 本次共 ${collected} 处结果 / 扫描 ${scannedFiles} 个文件 / 关键词「${pattern}」`,
    )
    return result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logError('Tool', `grep-search failed: ${error}`, ctx.taskId)
    return { status: 'failed', error: `grep-search: ${error}` }
  }
}

function clampContext(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 0
  return Math.min(Math.max(0, Math.floor(n)), 10)
}

function buildRegex(pattern: string, caseSensitive: boolean, multiline: boolean): RegExp | null {
  try {
    // g 必须开（exec 游标推进）；multiline 时 s 让 . 跨行（配合 pattern 内显式 \n）
    return new RegExp(pattern, `${caseSensitive ? '' : 'i'}g${multiline ? 's' : ''}`)
  } catch {
    return null
  }
}

/**
 * v0.24.2 关键词归一化：把 `A|B|C` 类 alternation 拆开、排序、去转义、忽略大小写，
 * 拼接成确定顺序的串，让 `选择关卡|levelSelect|selectLevel|关卡` 与
 * `levelSelect|selectLevel|关卡|选择关卡` 命中同一 signature。
 * 对纯量关键词（如 `mkButton`）只做去多余空格 / 去转义。
 */
function normalizeGrepPattern(p: string): string {
  const trimmed = p.trim()
  if (!trimmed) return trimmed
  // 去多余转义空格
  const cleaned = trimmed.replace(/\\\(|\\\)|\\\.|\(\?:|\\\^|\\\$/g, (m) =>
    m === '\\(' ? '(' : m === '\\)' ? ')' : m === '\\.' ? '.' : m === '\\^' ? '^' : m === '\\$' ? '$' : m,
  )
  // 仅当包含未转义 `|` 时按 alternation 拆
  if (/[^|]\|[^|]/.test(cleaned) || /^\|/.test(cleaned) || /\|$/.test(cleaned)) {
    const parts = cleaned
      .split(/(?<!\\)\|/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .sort()
    return parts.join('|')
  }
  return cleaned.trim().toLowerCase()
}

/** 选最强的判决（block > warn > pass） */
function pickStronger(
  a: import('./read-repeat-guard.js').RepeatVerdict,
  b: import('./read-repeat-guard.js').RepeatVerdict,
): import('./read-repeat-guard.js').RepeatVerdict {
  const rank = (v: import('./read-repeat-guard.js').RepeatVerdict) =>
    v.action === 'block' ? 2 : v.action === 'warn' ? 1 : 0
  return rank(a) >= rank(b) ? a : b
}

/** 单文件收集参数（v0.28.0：三态输出 + context + multiline 统一走这里） */
interface CollectOpts {
  outputMode: GrepOutputMode
  multiline: boolean
  ctxBefore: number
  ctxAfter: number
  budget: number
  onCollected: (n: number) => void
  matches: GrepSearchResult['matches']
  files: string[]
  counts: Array<{ file: string; count: number }>
  formattedParts: string[]
}

/**
 * v0.28.0：读取单文件并按输出模式收集结果。
 * - 先求出全部命中行号（multiline 时改为整文 exec）；
 * - content：push 结构化命中 + （可选）rg 风格 context 文本块；
 * - files_with_matches：有命中即记文件名（最省 token 的找文件方式）；
 * - count：记录每文件命中数。
 */
async function collectFile(
  abs: string,
  rel: string,
  regex: RegExp,
  opts: CollectOpts,
): Promise<void> {
  const remaining = opts.budget - (opts.matches.length + opts.files.length + opts.counts.reduce((a, c) => a + c.count, 0))
  if (remaining <= 0) return
  const content = await readFile(abs, 'utf-8').catch(() => null)
  if (!content) return
  const lines = content.split('\n')

  let hitLines: number[]
  if (opts.multiline) {
    hitLines = []
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(content)) !== null) {
      if (m[0].length === 0) { regex.lastIndex++; continue }
      const lineNo = content.slice(0, m.index).split('\n').length
      hitLines.push(lineNo - 1)
      if (hitLines.length >= remaining) break
    }
  } else {
    hitLines = []
    for (let i = 0; i < lines.length && hitLines.length < remaining; i++) {
      regex.lastIndex = 0
      if (regex.test(lines[i])) hitLines.push(i)
    }
  }
  if (hitLines.length === 0) return
  opts.onCollected(hitLines.length)

  if (opts.outputMode === 'files_with_matches') {
    opts.files.push(rel)
    return
  }
  if (opts.outputMode === 'count') {
    opts.counts.push({ file: rel, count: hitLines.length })
    return
  }

  // content 模式
  const hasContext = opts.ctxBefore > 0 || opts.ctxAfter > 0
  for (const i of hitLines) {
    opts.matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 400) })
  }
  if (!hasContext) return
  // rg 风格文本块：合并相邻命中的上下文区间，块间以 `--` 分隔
  const hitSet = new Set(hitLines)
  const sorted = [...hitSet].sort((a, b) => a - b)
  const ranges: Array<[number, number]> = []
  let start = -1
  let end = -1
  for (const i of sorted) {
    const s2 = Math.max(0, i - opts.ctxBefore)
    const e2 = Math.min(lines.length - 1, i + opts.ctxAfter)
    if (start === -1 || s2 > end + 1) {
      if (start !== -1) ranges.push([start, end])
      start = s2
      end = e2
    } else if (e2 > end) {
      end = e2
    }
  }
  if (start !== -1) ranges.push([start, end])
  for (const [rs, re] of ranges) {
    if (rs > 0) opts.formattedParts.push('--')
    for (let j = rs; j <= re; j++) {
      const sepCh = hitSet.has(j) ? ':' : '-'
      opts.formattedParts.push(`${rel}${sepCh}${j + 1}${sepCh}${lines[j].slice(0, 400)}`)
    }
  }
}

async function walk(
  dir: string,
  workspaceDir: string,
  regex: RegExp,
  opts: CollectOpts & {
    glob: string
    getRemaining: () => number
    onScanned: () => void
    seenFiles?: string[]
  },
): Promise<void> {
  if (opts.getRemaining() <= 0) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (opts.getRemaining() <= 0) return
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      await walk(join(dir, e.name), workspaceDir, regex, opts)
    } else if (e.isFile()) {
      const rel = relative(workspaceDir, join(dir, e.name)).replaceAll(sep, '/')
      if (!matchGlob(rel, opts.glob)) continue
      if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue
      opts.onScanned()
      if (opts.seenFiles && opts.seenFiles.length < 24) opts.seenFiles.push(rel)
      await collectFile(join(dir, e.name), rel, regex, opts)
    }
  }
}

/** 极简 glob：仅支持任意匹配和按扩展名过滤 */
function matchGlob(rel: string, glob: string): boolean {
  if (glob === '*' || glob === '**') return true
  if (glob.startsWith('*.')) {
    const ext = glob.slice(2)
    return rel.endsWith(`.${ext}`)
  }
  return true
}
