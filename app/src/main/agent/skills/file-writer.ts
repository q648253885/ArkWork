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
import { invalidateReadsOf } from './read-repeat-guard.js'
import { resolveEffectiveMode } from '../session-mode.js'
import type { SkillContext } from '../registry.js'

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

  // v0.28.0：写守卫模式感知（fail-closed——解析失败按 default 处理，宁可多拦）。
  // plan 整体禁写（补齐缺口：此前 plan 不拦文件写工具）；
  // 仅 bypassPermissions 可穿透受保护路径。
  const mode = await resolveEffectiveMode(workspaceDir)

  if (!isInsideWorkspace(rel)) {
    return { status: 'failed', error: `file-writer: 路径越界（${rawPath} 不在工作区内）` }
  }
  if (mode === 'plan') {
    return {
      status: 'failed',
      error: 'file-writer: 当前为 Plan 模式，禁止写入文件。请切换权限模式（如 default / autoApprove）后再执行写入。',
    }
  }
  if (isProtectedPath(abs) && mode !== 'bypassPermissions') {
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
    // v0.17.5：防御 LLM 把 content 传成对象（错误地把代码块塞进对象而非字符串），
    // writeFile 此时会抛 "data argument must be of type string"，错误信息对模型不友好。
    // 提前拦截并给出明确的字段名提示，让下一轮直接修复。
    if (typeof content !== 'string') {
      const detail = `file-writer: 参数 content 必须是字符串（当前类型=${typeof content}）。` +
        `请检查 JSON 参数序列化——多行代码/反引号字符串必须放在 "content" 字段的字符串值里，不要嵌套对象/数组。`
      await logError('Tool', detail, ctx.taskId)
      return { status: 'failed', error: detail }
    }
    await writeFile(abs, content, 'utf-8')
    const lines = content.split('\n').length
    await logInfo('Tool', `file-writer: ${rawPath} (${content.length} bytes, ${existed ? '覆盖' : '新建'})`, ctx.taskId)
    // v0.24.0：文件已变更，清除该路径的重复读记录
    invalidateReadsOf(ctx as SkillContext, rawPath)
    return {
      path: rawPath,
      bytes: Buffer.byteLength(content, 'utf-8'),
      lines,
      created: !existed,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // v0.28.0（F7）：失败信息附元信息（绝对路径 + errno 代码 + 对应建议），减少模型盲试
    const code = (err as NodeJS.ErrnoException)?.code ?? ''
    const hint =
      code === 'EACCES' || code === 'EPERM'
        ? '权限不足，请检查目标文件的读写权限。'
        : code === 'EISDIR'
          ? '目标路径是目录，请改用具体文件路径。'
          : code === 'ENOSPC'
            ? '磁盘空间不足，请清理后重试。'
            : code === 'ENOENT'
              ? '路径中某一级不存在，请确认路径拼写。'
              : '请确认路径与权限后重试。'
    const friendly =
      /data argument/i.test(error) || /must be of type string/i.test(error)
        ? `file-writer: 写入失败——参数 content 类型/格式不合法（${error}）。` +
          `请确认 content 是字符串而不是对象/数组，必要时把代码块用 \\n 拼接后放入 content 字符串。`
        : `file-writer: 写入失败：${error}${code ? ` [${code}]` : ''}（path=${abs}）。${hint}`
    await logError('Tool', `file-writer failed: ${friendly}`, ctx.taskId)
    return { status: 'failed', error: friendly }
  }
}
