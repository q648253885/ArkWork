/* ============================================================
 * ArkWork — Builtin Skill: glob-search
 * v0.16.0 / v0.28.0（F4）
 *
 * 按 glob 模式查找工作区文件，替代 shell 的 find/ls。
 * 使用 Node.js 22+ fs.promises.glob（若不可用则降级为递归扫描）。
 * v0.28.0 对齐 Claude Code Glob：
 *  - 结果按修改时间降序（最近改动的文件排最前，定位"刚写的文件"不再靠猜）
 *  - 上限 500→1000
 *  - 截断时附「共 N 个显示前 M 个」尾注与收窄指引
 *  - 接入防重读守卫（同 pattern 反复 glob → warn/block）
 * ============================================================ */
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
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
  /** v0.28.0：防重读警告/拦截指令/截断收窄提示 */
  hint?: string
}

// v0.28.0（F9）：上限 500→1000 —— 大仓库全量文件清单场景（如"列出所有测试"）500 常不够。
const MAX_RESULTS = 1000

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

  // v0.28.0（F4）：防重读守卫——签名取归一化后的绝对路径 + pattern；
  // 阈值 2/3→3/5（换 path 变体探索目录结构是合法动作，但同参数反复扫应拦截）。
  const sig = { path: baseAbs, pattern: pattern.toLowerCase() }
  const verdict = checkRepeatRead(ctx as SkillContext, 'glob-search', sig, {
    warnThreshold: 3,
    blockThreshold: 5,
  })
  if (verdict.action === 'block') {
    await logInfo('Tool', `glob-search: 重复扫描已拦截（${pattern}），返回行动指令`, ctx.taskId)
    return {
      pattern,
      matches: [],
      total: 0,
      truncated: false,
      hint: verdict.observation,
    }
  }

  try {
    // 收集 { 相对路径, mtime }——v0.28.0：按修改时间降序排序
    const entries: Array<{ rel: string; mtime: number }> = []

    // Node.js 22+ 原生 glob 支持
    const fs = await import('node:fs/promises')
    if (typeof (fs as { glob?: unknown }).glob === 'function') {
      const iter = (fs as { glob: (pattern: string, options: { cwd: string }) => AsyncIterable<string> }).glob(pattern, {
        cwd: baseAbs,
      })
      for await (const m of iter) {
        const full = join(baseAbs, m)
        const st = await stat(full).catch(() => null)
        entries.push({
          rel: relative(workspaceDir, full).replaceAll(sep, '/'),
          mtime: st?.mtimeMs ?? 0,
        })
        if (entries.length >= MAX_RESULTS) break
      }
    } else {
      for (const full of await legacyGlob(baseAbs, workspaceDir, pattern)) {
        const st = await stat(full).catch(() => null)
        entries.push({
          rel: relative(workspaceDir, full).replaceAll(sep, '/'),
          mtime: st?.mtimeMs ?? 0,
        })
      }
    }

    // v0.28.0：mtime 降序优先；同时间回退路径字典序（保证确定性输出）
    entries.sort((a, b) => (b.mtime - a.mtime) || a.rel.localeCompare(b.rel))
    const total = entries.length
    const matches = entries.slice(0, MAX_RESULTS).map((e) => e.rel)

    await logInfo('Tool', `glob-search: ${pattern} → ${total} matches`, ctx.taskId)

    let hint: string | undefined
    // v0.24.0：防重读警告前置送达
    if (verdict.action === 'warn') {
      hint = verdict.hint
    }
    // v0.28.0（F4）：截断尾注——明确告知总量与收窄方法，避免模型误以为列表即全部
    if (total > MAX_RESULTS) {
      const truncateNote = `共 ${total} 个匹配，仅显示前 ${MAX_RESULTS} 个（按修改时间降序）。如未找到目标，请用更具体的 pattern（如 "src/**/*.ts"）或传入 path 收窄搜索范围。`
      hint = hint ? `${hint}\n\n${truncateNote}` : truncateNote
    }

    recordRepeatResult(
      ctx as SkillContext,
      'glob-search',
      sig,
      total > 0 ? `${total} 个匹配${matches.length ? `，如 ${matches[0]}` : ''}` : '零匹配',
    )

    return {
      pattern,
      matches,
      total,
      truncated: total > MAX_RESULTS,
      hint,
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
      if (e.isDirectory()) {
        if (isRecursive && !['node_modules', '.git', '.arkwork'].includes(e.name)) {
          await walk(full)
        }
      } else if (e.isFile()) {
        let ok = true
        if (extMatch) ok = e.name.endsWith(`.${extMatch}`)
        else if (last !== '*' && last !== '**') ok = matchSimple(e.name, last)
        if (ok && results.length < MAX_RESULTS) results.push(full)
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
