/* ============================================================
 * ArkWork — Builtin Skill: file-reader
 * 设计文档 §5.3 / §10.5
 * 读取本地文件内容（文本、代码、JSON 等），支持读取目录列表
 * ============================================================ */
import { getWorkspaceDir } from '../../store/db.js'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
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
  /**
   * v0.28.0：起始行（1-based，Claude Code Read 风格别名）。
   * 显式传入时优先于 startLine（内部换算 offset-1 → 0-based）。
   */
  offset?: number
  /** v0.28.0：本次返回的最大行数（limit 别名）；显式传入时优先于 maxLines */
  limit?: number
}

export interface FileReaderResult {
  path: string
  content: string
  lines: number
  size: number
  truncated: boolean
  /** v0.28.0：truncated=true 时给出下次续读应传的 offset（1-based），引导模型分页读完 */
  nextOffset?: number
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
  // v0.28.0（F2）：offset/limit 别名归一 —— offset 为 1-based（Claude Code Read 风格，
  // 对 LLM 更直觉），内部换算为 0-based；limit 显式传入时优先于 maxLines。
  // 归一化必须先于防重读签名计算，保证新旧参数写法命中同一页级签名。
  const startLine = args.offset !== undefined
    ? Math.max(0, Math.floor(args.offset) - 1)
    : (args.startLine ?? 0)
  const maxLines = args.limit ?? args.maxLines ?? 0
  const sig = {
    path: abs,
    page: Math.floor(startLine / 50),
  }
  // v0.24.2：文件级读取预算——同文件换 startLine 分页反复读同样拦截。
  // 实测（第三次重跑）：模型改用 startLine 分页变体把同一小文件读了 15+ 次，
  // 页级签名（path+page）随页变化永不命中。文件级预算按 path 累计，
  // 编辑后由 invalidateReadsOf 重置。
  // v0.28.0（F9）：文件级阈值 4/6→8/12 —— cat-n + 分页续读成为推荐读法后，
  // 大文件合法分页次数显著增多；页级签名（4/6 默认）继续拦截同页重复。
  const fileSig = { path: abs }
  const pageVerdict = checkRepeatRead(ctx, 'file-reader', sig)
  const fileVerdict = checkRepeatRead(ctx, 'file-reader', fileSig, {
    warnThreshold: 8,
    blockThreshold: 12,
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
    // v0.28.0（F1）：条目附 stat 元信息（大小/修改时间），模型无需再逐个 stat，
    // 一次列目录即可判断"哪些文件最近改过、哪些是大文件"。
    const withStat = await Promise.all(entries.map(async (e) => {
      try {
        const st = await stat(join(abs, e.name))
        return { e, size: st.size as number | null, mtime: st.mtime }
      } catch {
        return { e, size: null as number | null, mtime: null as Date | null }
      }
    }))
    const lines = withStat.map(({ e, size, mtime }) => {
      const tag = e.isDirectory() ? '📁' : '📄'
      const suffix = e.isDirectory()
        ? '/'
        : size !== null && mtime
          ? ` (${formatSize(size)}, ${formatMtime(mtime)})`
          : ''
      return `${tag} ${e.name}${suffix}`
    })
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
  // v0.16.6+：支持分页读，避免每次都拉全文
  const sliced = startLine > 0 ? allLines.slice(startLine) : allLines
  const truncated = maxLines > 0 && sliced.length > maxLines
  const page = truncated ? sliced.slice(0, maxLines) : sliced
  // v0.28.0（F2）：cat-n 行号输出（右对齐行号 + tab，对齐 Claude Code / 主流 Read 工具），
  // 让 Edit 的 oldStr 定位、跨页续读引用都有明确行锚点。
  const lastNo = startLine + page.length
  const width = String(Math.max(lastNo, 1)).length
  const content = page
    .map((l, i) => `${String(startLine + i + 1).padStart(width)}\t${l}`)
    .join('\n')
    + (truncated
      ? `\n\n… (truncated, ${sliced.length - maxLines} more lines, total=${allLines.length}) — 续读请传 offset=${startLine + maxLines + 1}${maxLines ? `、limit=${maxLines}` : ''}`
      : '')

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
  if (truncated) {
    result.nextOffset = startLine + maxLines + 1
  }
  if (repeatHint) {
    result.hint = repeatHint
  }
  return result
}

/** v0.28.0：目录条目的人类可读大小（B/KB/MB 一位小数） */
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** v0.28.0：目录条目的短修改时间（MM-DD HH:mm） */
function formatMtime(d: Date): string {
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
