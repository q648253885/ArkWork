/* ============================================================
 * ArkWork — Workspace Filesystem
 * 设计文档 §8.6 / 附录 B
 * ============================================================ */
import { app, dialog } from 'electron'
import { join } from 'node:path'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir, getWorkspaceDir, setWorkspaceDir } from '../store/db.js'
import { seedDefaults } from '../store/seed.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

/** 应用启动时确认工作区存在；若为空则写入示例文件 */
export async function ensureWorkspace(): Promise<void> {
  const ws = getWorkspaceDir()
  if (!existsSync(ws)) await mkdir(ws, { recursive: true })

  await Promise.all([
    // v0.27.1：任务工作目录收纳进 .arkwork/ 隐藏区（与 memory 同域，文件树不展示）
    mkdir(join(ws, '.arkwork', 'tasks'), { recursive: true }),
    mkdir(join(ws, '.arkwork', 'memory'), { recursive: true }),
    mkdir(join(ws, 'shared', 'templates'), { recursive: true }),
  ])

  // 写入默认配置与种子数据（仅首次）
  await seedDefaults()
}

/**
 * 探测目录是否真实可写：实际写入一个探针文件再删除。
 * 权限位（access W_OK）在沙盒/受限环境会误报可写，只有真实 open() 才能暴露 EPERM/EACCES。
 * 用于切换工作区前预检，避免用户切过去后 tasks.json 写入静默失败。
 */
export async function assertWorkspaceWritable(dir: string): Promise<void> {
  if (!dir) return
  const probe = join(dir, '.arkwork-write-probe')
  try {
    await writeFile(probe, 'ok', 'utf-8')
    await unlink(probe)
  } catch (err) {
    const code = (err as { code?: string }).code
    const locale = getUiLocale()
    if (code === 'EPERM' || code === 'EACCES') {
      throw new Error(tFor(locale, 'workspace.notWritableEperm'))
    }
    if (code === 'ENOENT') {
      throw new Error(tFor(locale, 'workspace.notFound'))
    }
    throw new Error(tFor(locale, 'workspace.notWritable', { message: (err as Error).message }))
  }
}

/** 让用户选择工作区目录 */
export async function pickWorkspace(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: tFor(getUiLocale(), 'dialog.pickWorkspaceTitle'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return undefined
  const dir = result.filePaths[0]
  // 预检可写性：目录不可写时直接报错，避免切换后任务无法落盘
  await assertWorkspaceWritable(dir)
  setWorkspaceDir(dir)
  await ensureWorkspace()
  return dir
}

/** 列出指定目录下的文件树（深度受限） */
export async function listTree(
  root: string,
  opts: { maxDepth?: number; ignore?: string[] } = {},
): Promise<FsNode[]> {
  const maxDepth = opts.maxDepth ?? 6
  const ignore = new Set(opts.ignore ?? ['.git', 'node_modules', '.DS_Store'])
  return walk(root, 0, maxDepth, ignore)
}

import type { FsNode } from '@shared/types/ipc'

async function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  ignore: Set<string>,
): Promise<FsNode[]> {
  if (depth >= maxDepth) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // 权限不足或目录不存在：返回空，不中断整个文件树
    return []
  }
  const nodes: FsNode[] = []

  for (const entry of entries) {
    if (ignore.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const children = await walk(fullPath, depth + 1, maxDepth, ignore)
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'folder',
        children,
      })
    } else if (entry.isFile()) {
      try {
        const s = await stat(fullPath)
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
          size: s.size,
          language: detectLanguage(ext),
        })
      } catch {
        // stat 失败（符号链接等）：跳过
      }
    }
  }

  // 文件夹优先，再按名字排序
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

function detectLanguage(ext: string): string {
  const map: Record<string, string> = {
    md: 'markdown',
    markdown: 'markdown',
    json: 'json',
    js: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
    jsx: 'jsx',
    py: 'python',
    go: 'go',
    rs: 'rust',
    txt: 'text',
    yml: 'yaml',
    yaml: 'yaml',
    html: 'html',
    css: 'css',
    sh: 'bash',
  }
  return map[ext] ?? 'text'
}

/** 图片扩展名：读取时以 base64 dataURL 返回，供右侧预览渲染（参考 GitHub / VS Code 图片查看） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])

export async function readTextFile(path: string): Promise<{ content: string; language: string; size: number; lines: number }> {
  const s = await stat(path)
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTS.has(ext)) {
    const buf = await readFile(path)
    const mime = ext === 'jpg' ? 'jpeg' : ext
    const dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`
    return { content: dataUrl, language: 'image', size: s.size, lines: 1 }
  }
  const content = await readFile(path, 'utf-8')
  return {
    content,
    size: s.size,
    lines: content.split('\n').length,
    language: detectLanguage(ext),
  }
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf-8')
}

export { getWorkspaceDir, getArkworkDir }
