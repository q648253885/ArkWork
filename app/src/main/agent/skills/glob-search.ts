/* ============================================================
 * ArkWork — Builtin Skill: glob-search
 * v0.16.0
 *
 * 按 glob 模式查找工作区文件，替代 shell 的 find/ls。
 * 使用 Node.js 22+ fs.promises.glob（若不可用则降级为递归扫描）。
 * ============================================================ */
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  getWorkspaceDirFromCtx,
  resolveWorkspacePath,
  isInsideWorkspace,
  logInfo,
  logError,
  type FileToolContext,
} from './file-tool-safety.js'

export interface GlobSearchArgs {
  pattern: string
  /** 起始目录（相对工作区，默认工作区根） */
  path?: string
}

export interface GlobSearchResult {
  pattern: string
  matches: string[]
  total: number
  truncated: boolean
}

const MAX_RESULTS = 500

export async function globSearch(
  args: GlobSearchArgs,
  ctx: FileToolContext,
): Promise<GlobSearchResult | { status: 'failed'; error: string }> {
  const pattern = (args.pattern ?? '').trim()
  if (!pattern) {
    return { status: 'failed', error: 'glob-search: pattern 不能为空' }
  }

  const workspaceDir = await getWorkspaceDirFromCtx(ctx)
  const baseRaw = (args.path ?? '').trim() || '.'
  const { abs: baseAbs, rel: baseRel } = resolveWorkspacePath(baseRaw, workspaceDir)
  if (!isInsideWorkspace(baseRel)) {
    return { status: 'failed', error: `glob-search: 起始路径越界（${baseRaw} 不在工作区内）` }
  }

  try {
    let matches: string[] = []

    // Node.js 22+ 原生 glob 支持
    const fs = await import('node:fs/promises')
    if (typeof (fs as { glob?: unknown }).glob === 'function') {
      const iter = (fs as { glob: (pattern: string, options: { cwd: string }) => AsyncIterable<string> }).glob(pattern, {
        cwd: baseAbs,
      })
      for await (const m of iter) {
        matches.push(relative(workspaceDir, join(baseAbs, m)).replaceAll(sep, '/'))
        if (matches.length >= MAX_RESULTS) break
      }
    } else {
      matches = await legacyGlob(baseAbs, workspaceDir, pattern)
    }

    matches.sort()
    await logInfo('Tool', `glob-search: ${pattern} → ${matches.length} matches`, ctx.taskId)
    return {
      pattern,
      matches: matches.slice(0, MAX_RESULTS),
      total: matches.length,
      truncated: matches.length > MAX_RESULTS,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logError('Tool', `glob-search failed: ${error}`, ctx.taskId)
    return { status: 'failed', error: `glob-search: ${error}` }
  }
}

/** 降级实现：仅支持递归扩展名匹配和简单通配符 */
async function legacyGlob(baseAbs: string, workspaceDir: string, pattern: string): Promise<string[]> {
  const results: string[] = []
  const parts = pattern.split('/')
  const last = parts[parts.length - 1]
  const isRecursive = parts.includes('**')
  const extMatch = last.startsWith('*.') ? last.slice(2) : null

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(dir, e.name)
      const rel = relative(workspaceDir, full).replaceAll(sep, '/')
      if (e.isDirectory()) {
        if (isRecursive && !['node_modules', '.git', '.arkwork'].includes(e.name)) {
          await walk(full)
        }
      } else if (e.isFile()) {
        let ok = true
        if (extMatch) ok = e.name.endsWith(`.${extMatch}`)
        else if (last !== '*' && last !== '**') ok = matchSimple(e.name, last)
        if (ok) results.push(rel)
      }
    }
  }

  await walk(baseAbs)
  return results
}

function matchSimple(name: string, pat: string): boolean {
  const re = pat.replace(/\./g, '\\.').replace(/\*/g, '.*')
  return new RegExp(`^${re}$`).test(name)
}
