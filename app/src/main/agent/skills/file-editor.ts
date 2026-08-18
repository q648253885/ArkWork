/* ============================================================
 * ArkWork — Builtin Skill: file-editor
 * v0.16.0
 *
 * 对文件执行搜索替换编辑，替代 shell 的 sed -i / tee 等操作。
 * 安全策略：路径必须在工作区内；禁止编辑受保护路径；匹配失败返回信息性结果。
 * ============================================================ */
import { readFile, writeFile } from 'node:fs/promises'
import {
  getWorkspaceDirFromCtx,
  resolveWorkspacePath,
  isInsideWorkspace,
  isProtectedPath,
  logInfo,
  logError,
  type FileToolContext,
} from './file-tool-safety.js'
import { invalidateReadsOf } from './read-repeat-guard.js'
import type { SkillContext } from '../registry.js'

export interface FileEditorArgs {
  path: string
  oldStr: string
  newStr: string
  /** true = 替换所有匹配；false（默认）= 替换第一次出现 */
  all?: boolean
}

export interface FileEditorResult {
  path: string
  replacements: number
}

export async function fileEditor(
  args: FileEditorArgs,
  ctx: FileToolContext,
): Promise<FileEditorResult | { status: 'failed'; error: string }> {
  const rawPath = (args.path ?? '').trim()
  const oldStr = args.oldStr ?? ''
  if (!rawPath) {
    return { status: 'failed', error: 'file-editor: path 不能为空' }
  }
  if (oldStr === '') {
    return { status: 'failed', error: 'file-editor: oldStr 不能为空（避免无意义替换）' }
  }

  const workspaceDir = await getWorkspaceDirFromCtx(ctx)
  const { abs, rel } = resolveWorkspacePath(rawPath, workspaceDir)

  if (!isInsideWorkspace(rel)) {
    return { status: 'failed', error: `file-editor: 路径越界（${rawPath} 不在工作区内）` }
  }
  if (isProtectedPath(abs)) {
    return { status: 'failed', error: `file-editor: 禁止编辑受保护路径 ${rawPath}` }
  }

  try {
    const content = await readFile(abs, 'utf-8')
    if (!content.includes(oldStr)) {
      return {
        status: 'failed',
        error: `file-editor: 在 ${rawPath} 中未找到 oldStr 内容，请检查 oldStr 是否完整且与文件原文一致`,
      }
    }

    let replacements = 0
    let newContent: string
    if (args.all) {
      const parts = content.split(oldStr)
      replacements = parts.length - 1
      newContent = parts.join(args.newStr ?? '')
    } else {
      newContent = content.replace(oldStr, args.newStr ?? '')
      replacements = 1
    }

    await writeFile(abs, newContent, 'utf-8')
    await logInfo('Tool', `file-editor: ${rawPath} replacements=${replacements}`, ctx.taskId)
    // v0.24.0：文件已变更，清除该路径的重复读记录（改后重读验证是合法行为）
    invalidateReadsOf(ctx as SkillContext, rawPath)
    return { path: rawPath, replacements }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await logError('Tool', `file-editor failed: ${error}`, ctx.taskId)
    return { status: 'failed', error: `file-editor: ${error}` }
  }
}
