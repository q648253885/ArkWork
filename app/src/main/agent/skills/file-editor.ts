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
import { resolveEffectiveMode } from '../session-mode.js'
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

  // v0.28.0：写守卫模式感知（与 file-writer 同规则：plan 禁写、仅 bypass 穿透受保护路径）
  const mode = await resolveEffectiveMode(workspaceDir)

  if (!isInsideWorkspace(rel)) {
    return { status: 'failed', error: `file-editor: 路径越界（${rawPath} 不在工作区内）` }
  }
  if (mode === 'plan') {
    return {
      status: 'failed',
      error: 'file-editor: 当前为 Plan 模式，禁止编辑文件。请切换权限模式（如 default / autoApprove）后再执行编辑。',
    }
  }
  if (isProtectedPath(abs) && mode !== 'bypassPermissions') {
    return { status: 'failed', error: `file-editor: 禁止编辑受保护路径 ${rawPath}` }
  }

  try {
    const content = await readFile(abs, 'utf-8')
    // v0.28.0（F5）：对齐 Claude Code Edit 的引导性报错——
    // 未命中 → 引导先 grep 核对原文；多命中且未传 all → 拒绝模糊替换并给出两条出路
    const occurrences = content.split(oldStr).length - 1
    if (occurrences === 0) {
      return {
        status: 'failed',
        error:
          `file-editor: 在 ${rawPath} 中未找到 oldStr（匹配 0 处）。` +
          '请先用 grep-search 查看目标文件原文（注意空格/缩进/换行差异），按原文逐字复制后重试。',
      }
    }
    if (!args.all && occurrences > 1) {
      return {
        status: 'failed',
        error:
          `file-editor: oldStr 匹配到 ${occurrences} 处，为避免误伤已拒绝本次编辑。请二选一：` +
          `① 扩大 oldStr 的上下文使其在文件中唯一；② 传 all=true 替换全部 ${occurrences} 处。`,
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
