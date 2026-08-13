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
import { checkRepeatRead } from './read-repeat-guard.js'

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

  // v0.16.6+：重复搜索相同 pattern + 相同 path → 友好提示（不阻断）
  const repeatHint = checkRepeatRead(ctx as SkillContext, 'grep-search', {
    path: args.path ?? '.',
    pattern,
    caseSensitive: !!args.caseSensitive,
    maxResults: args.maxResults ?? 0,
  })

  const workspaceDir = await getWorkspaceDirFromCtx(ctx)
  const baseRaw = (args.path ?? '').trim() || '.'
  const { abs: baseAbs, rel: baseRel } = resolveWorkspacePath(baseRaw, workspaceDir)
  if (!isInsideWorkspace(baseRel)) {
    return { status: 'failed', error: `grep-search: 搜索路径越界（${baseRaw} 不在工作区内）` }
  }

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

  try {
    if (s.isFile()) {
      scannedFiles = 1
      await searchFile(baseAbs, relative(workspaceDir, baseAbs).replaceAll(sep, '/'), regex, matches, maxResults)
    } else {
      await walk(baseAbs, workspaceDir, regex, matches, maxResults, args.glob ?? '*', () => {
        scannedFiles += 1
      })
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

async function walk(
  dir: string,
  workspaceDir: string,
  regex: RegExp,
  matches: Array<{ file: string; line: number; text: string }>,
  maxResults: number,
  glob: string,
  onFile: () => void,
): Promise<void> {
  if (matches.length >= maxResults) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue
      await walk(join(dir, e.name), workspaceDir, regex, matches, maxResults, glob, onFile)
      if (matches.length >= maxResults) return
    } else if (e.isFile()) {
      const rel = relative(workspaceDir, join(dir, e.name)).replaceAll(sep, '/')
      if (!matchGlob(rel, glob)) continue
      if (BINARY_EXTS.has(extname(e.name).toLowerCase())) continue
      onFile()
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
