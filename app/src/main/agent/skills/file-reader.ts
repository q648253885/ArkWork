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
import { checkRepeatRead, recordRepeatResult } from './read-repeat-guard.js'

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
    throw new Error(`file not found: ${args.path}（已解析为 ${abs}）`)
  }

  // v0.24.1：签名规范化——用解析后的绝对路径（容忍 LLM 的绝对/相对混用），
  // startLine 按 50 行对齐成"页"，忽略 maxLines（分页参数漂移不再绕过防重读）。
  // 实测（MiniMax-M3 重跑 t2 修复 game）：模型以 maxLines 3→100→293 变化反复读
  // 同一文件，旧签名(含 maxLines)永远不匹配 → 防重读 0 拦截、40 轮打转。
  const sig = {
    path: abs,
    page: Math.floor((args.startLine ?? 0) / 50),
  }
  // v0.24.2：文件级读取预算——同文件换 startLine 分页反复读同样拦截。
  // 实测（第三次重跑）：模型改用 startLine 分页变体把同一小文件读了 15+ 次，
  // 页级签名（path+page）随页变化永不命中。文件级预算按 path 累计，
  // 第 4 次警告、第 6 次起拦截，编辑后由 invalidateReadsOf 重置。
  const fileSig = { path: abs }
  const pageVerdict = checkRepeatRead(ctx, 'file-reader', sig)
  const fileVerdict = checkRepeatRead(ctx, 'file-reader', fileSig, {
    warnThreshold: 4,
    blockThreshold: 6,
  })
  const verdict =
    pageVerdict.action === 'block' || fileVerdict.action === 'block'
      ? pageVerdict.action === 'block' ? pageVerdict : fileVerdict
      : pageVerdict.action === 'warn' ? pageVerdict
      : fileVerdict.action === 'warn' ? fileVerdict
      : pageVerdict
  if (verdict.action === 'block') {
    logger.warn('Tool', `file-reader: 重复读已拦截（${args.path}），返回行动指令`, ctx.taskId)
    return {
      path: args.path,
      content: verdict.observation,
      lines: 0,
      size: 0,
      truncated: false,
      blocked: true,
    } as FileReaderResult & { blocked?: boolean }
  }
  const repeatHint = verdict.action === 'warn' ? verdict.hint : null

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

  // v0.24.0：记录内容头，供防重读 block 时回带（页级 + 文件级都记录）
  if (!s.isDirectory()) {
    recordRepeatResult(ctx, 'file-reader', sig, content)
    recordRepeatResult(ctx, 'file-reader', fileSig, content)
  }

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
