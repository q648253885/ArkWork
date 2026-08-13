/* ============================================================
 * ArkWork — Builtin Skill: file-reader
 * 设计文档 §5.3 / §10.5
 * 读取本地文件内容（文本、代码、JSON 等），支持读取目录列表
 * ============================================================ */
import { getWorkspaceDir } from '../../store/db.js'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'
import { checkRepeatRead } from './read-repeat-guard.js'

export interface FileReaderArgs {
  path: string
  /** 最多读取的行数（0 表示全部） */
  maxLines?: number
  /** 起始行（从 0 开始；与 maxLines 配合实现分页读） */
  startLine?: number
}

export interface FileReaderResult {
  path: string
  content: string
  lines: number
  size: number
  truncated: boolean
}

/** 给可能长时间挂起的 I/O 加超时保护，超时抛出 Error 走调用方既有失败处理 */
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])

export async function fileReader(
  args: FileReaderArgs,
  ctx: SkillContext,
): Promise<FileReaderResult> {
  // v0.6.2：相对路径基于当前工作区根目录（与用户打开的项目文件夹一致），
  // 不再基于任务工作目录，否则 README.md/package.json 等常见文件恒找不到。
  const baseDir = ctx.workspaceDir ?? getWorkspaceDir()
  const abs = isAbsolute(args.path)
    ? args.path
    : resolve(baseDir, args.path)

  if (!existsSync(abs)) {
    throw new Error(`file not found: ${args.path}`)
  }

  // v0.16.6+：重复读同一文件/同一段 → 给 Agent 友好提示（不阻断）
  const repeatHint = checkRepeatRead(ctx, 'file-reader', {
    path: args.path,
    maxLines: args.maxLines ?? 0,
    startLine: args.startLine ?? 0,
  })

  const fs = await import('node:fs/promises')
  const s = await fs.stat(abs)

  // v0.6.2：支持目录读取，返回文件/文件夹列表
  if (s.isDirectory()) {
    const entries = await withTimeout(readdir(abs, { withFileTypes: true }), 15_000, 'file-reader.list')
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    const lines = entries.map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
    const content = lines.join('\n')
    logger.info('Tool', `file-reader.list(${args.path}) → ${entries.length} entries`, ctx.taskId)
    return {
      path: args.path,
      content,
      lines: entries.length,
      size: 0,
      truncated: false,
    }
  }

  const raw = await withTimeout(readFile(abs, 'utf-8'), 15_000, 'file-reader.read')
  const allLines = raw.split('\n')
  const maxLines = args.maxLines ?? 0
  const startLine = args.startLine ?? 0
  // v0.16.6+：支持 startLine 分页读，避免每次都拉全文
  const sliced = startLine > 0 ? allLines.slice(startLine) : allLines
  const truncated = maxLines > 0 && sliced.length > maxLines
  const content = truncated
    ? sliced.slice(0, maxLines).join('\n') + `\n\n… (truncated, ${sliced.length - maxLines} more lines, total=${allLines.length})`
    : sliced.join('\n')

  logger.info('Tool', `file-reader.read(${args.path}) → ${allLines.length} lines, ${s.size} bytes`, ctx.taskId)

  const result: FileReaderResult & { hint?: string } = {
    path: args.path,
    content,
    lines: allLines.length,
    size: s.size,
    truncated,
  }
  if (repeatHint) {
    result.hint = repeatHint
  }
  return result
}
