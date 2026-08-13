/* ============================================================
 * ArkWork — Builtin Skill: file-writer
 * v0.16.0
 *
 * 将文本内容写入工作区文件，替代 shell 的 echo/tee/重定向操作。
 * 安全策略：路径必须在工作区内；禁止覆盖受保护路径；默认不覆盖已存在文件。
 * ============================================================ */
import { writeFile, stat } from 'node:fs/promises'
import {
  getWorkspaceDirFromCtx,
  resolveWorkspacePath,
  isInsideWorkspace,
  isProtectedPath,
  ensureParentDir,
  logInfo,
  logError,
  type FileToolContext,
} from './file-tool-safety.js'

export interface FileWriterArgs {
  path: string
  content: string
  /** 是否覆盖已存在文件（默认 false） */
  overwrite?: boolean
}

export interface FileWriterResult {
  path: string
  bytes: number
  lines: number
  created: boolean
}

export async function fileWriter(
  args: FileWriterArgs,
  ctx: FileToolContext,
): Promise<FileWriterResult | { status: 'failed'; error: string }> {
  const rawPath = (args.path ?? '').trim()
  if (!rawPath) {
    return { status: 'failed', error: 'file-writer: path 不能为空' }
  }
  const workspaceDir = await getWorkspaceDirFromCtx(ctx)
  const { abs, rel } = resolveWorkspacePath(rawPath, workspaceDir)

  if (!isInsideWorkspace(rel)) {
    return { status: 'failed', error: `file-writer: 路径越界（${rawPath} 不在工作区内）` }
  }
  if (isProtectedPath(abs)) {
    return { status: 'failed', error: `file-writer: 禁止写入受保护路径 ${rawPath}` }
  }

  const existed = await stat(abs).then((s) => s.isFile(), () => false)
  if (existed && !args.overwrite) {
    return {
      status: 'failed',
      error: `file-writer: ${rawPath} 已存在，设置 overwrite=true 覆盖或改用 file-editor 编辑`,
    }
  }

  try {
    await ensureParentDir(abs)
    const content = args.content ?? ''
    await writeFile(abs, content, 'utf-8')
    const lines = content.split('\n').length
    await logInfo('Tool', `file-writer: ${rawPath} (${content.length} bytes, ${existed ? '覆盖' : '新建'})`, ctx.taskId)
    return {
      path: rawPath,
      bytes: Buffer.byteLength(content, 'utf-8'),
      lines,
      created: !existed,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logError('Tool', `file-writer failed: ${error}`, ctx.taskId)
    return { status: 'failed', error: `file-writer: ${error}` }
  }
}
