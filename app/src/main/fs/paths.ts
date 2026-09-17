/* ============================================================
 * ArkWork — Main: FS Paths（WATCH_IGNORE 单一配置 + 扁平路径清单）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §4.3.5 / §6.4
 *
 * TC-WATCH-010：`WATCH_IGNORE` 与 `fs:list-paths` **共用同一份配置**
 * （node_modules / .git / .arkwork / dist / build / 隐藏文件）——
 * 一处配置两处消费，防两套 ignore 漂移。
 *
 * 正本 06 §2.4：QuickOpen 候选集与 chokidar 的 ignore 同源。
 * ============================================================ */
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { getWorkspaceDir } from '../store/db.js'
import type { ListPathsResult, WorkspaceFileEntry } from '@shared/types/fs'

/** 快捷上限（§7.1 性能预算：QuickOpen 候选首开 < 100ms） */
export const LIST_PATHS_LIMIT = 20000

/**
 * 监听 / 扁平清单共用的忽略规则（**目录名级** + 隐藏文件级）。
 *  - 目录名命中 → 整棵子树跳过（chokidar ignored 与 walk 同语义）；
 *  - 隐藏文件（`.` 开头）默认跳过，`.arkwork` 是 agent 自身内容区（§7.2）一并拦。
 */
export const WATCH_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.arkwork',
  '.next',
  'dist',
  'build',
])

export const WATCH_IGNORE_FILES: ReadonlySet<string> = new Set(['.DS_Store'])

/** 纯函数：工作区相对路径是否被忽略（目录段任一命中即忽略） */
export function isIgnoredRelPath(rel: string): boolean {
  if (!rel) return true
  const segs = rel.split(sep)
  for (const seg of segs) {
    if (WATCH_IGNORE_DIRS.has(seg)) return true
    if (WATCH_IGNORE_FILES.has(seg)) return true
    if (seg.startsWith('.') && seg !== '.') return true
  }
  return false
}

/** chokidar 的 ignored 谓词（入参是绝对路径）。
 * 注意：**根自身不得忽略**（rel === ''）—— chokidar 3 会用本谓词过滤
 * 包括被 watch 的根路径在内的一切路径，误判为 true 会让整棵监听静默失效。 */
export function ignoredByWatch(absPath: string, root: string): boolean {
  if (resolve(absPath) === resolve(root)) return false
  const rel = relative(root, absPath)
  if (!rel || rel.startsWith('..')) return true
  return isIgnoredRelPath(rel)
}

/**
 * 扁平路径清单（§4.3.5）：QuickOpen 候选集（替代递归树）。
 * 超过 LIST_PATHS_LIMIT 条截断并置 truncated（TC-GOTO-006）。
 */
export async function listWorkspacePaths(
  root: string = getWorkspaceDir(),
  opts: { limit?: number } = {},
): Promise<ListPathsResult> {
  const limit = opts.limit ?? LIST_PATHS_LIMIT
  const files: WorkspaceFileEntry[] = []
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > 24) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const full = join(dir, entry.name)
      const rel = relative(root, full)
      if (isIgnoredRelPath(rel)) continue
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        try {
          const s = await stat(full)
          if (files.length >= limit) {
            truncated = true
            return
          }
          files.push({
            path: full,
            rel,
            size: s.size,
            language: detectLanguageByExt(entry.name),
            mtimeMs: s.mtimeMs,
          })
        } catch {
          /* stat 失败（symlink 等）：跳过 */
        }
      }
    }
  }

  await walk(root, 0)
  return { root, files, truncated }
}

/** 扩展名 → 语言（与 workspace.detectLanguage 同表；独立小实现避免跨模块依赖链） */
function detectLanguageByExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    md: 'markdown', markdown: 'markdown', json: 'json', js: 'javascript', ts: 'typescript',
    tsx: 'tsx', jsx: 'jsx', py: 'python', go: 'go', rs: 'rust', txt: 'text',
    yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', sh: 'bash',
  }
  return map[ext] ?? 'text'
}
