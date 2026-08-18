/* ============================================================
 * ArkWork — Builtin Skill: grep-search
 * v0.16.0
 *
 * 在工作区文件中搜索文本/正则，替代 shell 的 grep/rg。
 * 忽略二进制、node_modules、.git、.arkwork；返回文件+行号+上下文。
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

export interface GrepSearchArgs {
  pattern: string
  /** 搜索目录或文件（相对工作区，默认工作区根） */
  path?: string
  /** 可选的 glob 过滤，例如所有 ts 文件 */
  glob?: string
  /** 是否区分大小写（默认 false） */
  caseSensitive?: boolean
  /** 最大返回条数（默认 100） */
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
  /** v0.24.0：防重读警告/拦截指令/零命中提示（engine 观察组装时前置送达模型） */
  hint?: string
}

const DEFAULT_MAX_RESULTS = 100
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

  // v0.24.1：签名规范化——path 用解析后绝对路径（容忍绝对/相对混用），
  // 去掉 maxResults（参数漂移不再绕过防重读）。同关键词换参数反复搜 → 命中拦截。
  // v0.24.2：关键词归一化——把 `选择关卡|levelSelect|selectLevel|关卡` 与
  // `levelSelect|selectLevel|关卡|选择关卡` 视为同一 signature，阻止换序/换转义反复探测。
  // 同时加全局预算：grep-search 单任务内累计第 6 次起 warn、第 8 次起 block。
  const sig = {
    path: baseAbs,
    pattern: normalizeGrepPattern(pattern),
    caseSensitive: !!args.caseSensitive,
  }
  // v0.24.2 全局预算：把 baseAbs 也带进 _global 签名，便于编辑/写入后按 path 重置
  //（invalidateReadsOf 按子串匹配，可同时清掉单签名 + 全局签名）。
  // 关键词已归一化，alternation 类通常意图一致 → 阈值收紧到 warn@2/block@3。
  const verdict = checkRepeatRead(ctx as SkillContext, 'grep-search', sig, {
    warnThreshold: 2,
    blockThreshold: 3,
  })
  const globalVerdict = checkRepeatRead(ctx as SkillContext, 'grep-search', { _global: baseAbs }, {
    warnThreshold: 6,
    blockThreshold: 8,
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
      hint: finalVerdict.observation,
    }
  }
  const repeatHint = finalVerdict.action === 'warn' ? finalVerdict.hint : null

  const s = await stat(baseAbs).catch(() => null)
  if (!s) {
    return { status: 'failed', error: `grep-search: 路径不存在 ${baseRaw}` }
  }

  const maxResults = Math.min(args.maxResults ?? DEFAULT_MAX_RESULTS, 500)
  const regex = buildRegex(pattern, !!args.caseSensitive)
  if (!regex) {
    return { status: 'failed', error: 'grep-search: pattern 不是合法正则表达式' }
  }

  const matches: GrepSearchResult['matches'] = []
  let scannedFiles = 0
  const seenFiles: string[] = []

  try {
    if (s.isFile()) {
      scannedFiles = 1
      await searchFile(baseAbs, relative(workspaceDir, baseAbs).replaceAll(sep, '/'), regex, matches, maxResults)
    } else {
      await walk(baseAbs, workspaceDir, regex, matches, maxResults, args.glob ?? '*', () => {
        scannedFiles += 1
      }, seenFiles)
    }

    await logInfo('Tool', `grep-search: ${pattern} → ${matches.length} matches in ${scannedFiles} files`, ctx.taskId)
    const result: GrepSearchResult & { hint?: string } = {
      pattern,
      total: matches.length,
      matches: matches.slice(0, maxResults),
      truncated: matches.length > maxResults,
      scannedFiles,
    }
    if (repeatHint) result.hint = repeatHint
    // v0.24.0（P1）：零命中 + 小工作区（≤ 20 个可搜文件）→ 列出全部文件，
    // 引导模型直接读目标文件，终结"换关键词反复 grep"打转（实测 81 次/任务）。
    if (matches.length === 0 && seenFiles.length > 0 && seenFiles.length <= 20) {
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
      matches.length > 0
        ? `${matches.length} 处命中，如 ${matches[0]?.file}:${matches[0]?.line} ${matches[0]?.text}`
        : `零命中（已扫描 ${scannedFiles} 个文件）`,
    )
    // 全局预算也要记录，否则后续全局判定没有内容头可回带
    recordRepeatResult(
      ctx as SkillContext,
      'grep-search',
      { _global: baseAbs },
      `本次搜索命中 ${matches.length} 处 / 扫描 ${scannedFiles} 个文件 / 关键词「${pattern}」`,
    )
    return result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logError('Tool', `grep-search failed: ${error}`, ctx.taskId)
    return { status: 'failed', error: `grep-search: ${error}` }
  }
}

function buildRegex(pattern: string, caseSensitive: boolean): RegExp | null {
  try {
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi')
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

async function walk(
  dir: string,
  workspaceDir: string,
  regex: RegExp,
  matches: Array<{ file: string; line: number; text: string }>,
  maxResults: number,
  glob: string,
  onFile: () => void,
  /** v0.24.0：收集可搜文本文件相对路径（上限 24 个），零命中小工作区时列给模型 */
  seenFiles?: string[],
): Promise<void> {
  if (matches.length >= maxResults) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      await walk(join(dir, e.name), workspaceDir, regex, matches, maxResults, glob, onFile, seenFiles)
      if (matches.length >= maxResults) return
    } else if (e.isFile()) {
      const rel = relative(workspaceDir, join(dir, e.name)).replaceAll(sep, '/')
      if (!matchGlob(rel, glob)) continue
      if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue
      onFile()
      if (seenFiles && seenFiles.length < 24) seenFiles.push(rel)
      await searchFile(join(dir, e.name), rel, regex, matches, maxResults)
      if (matches.length >= maxResults) return
    }
  }
}

async function searchFile(
  abs: string,
  rel: string,
  regex: RegExp,
  matches: Array<{ file: string; line: number; text: string }>,
  maxResults: number,
): Promise<void> {
  const content = await readFile(abs, 'utf-8').catch(() => null)
  if (!content) return
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    regex.lastIndex = 0
    if (regex.test(lines[i])) {
      matches.push({ file: rel, line: i + 1, text: lines[i].trim() })
      if (matches.length >= maxResults) return
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
