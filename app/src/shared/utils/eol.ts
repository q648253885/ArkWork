/* ============================================================
 * ArkWork — Shared Utils: EOL / 末尾换行（纯函数）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §6.3 硬要求 2
 *
 * 纪律：
 *  - 本模块**必须保持纯函数**（无 node:fs / electron / window），
 *    以便主进程 fs/text 与渲染层共用同一套口径，且可密闭单测。
 *  - 编码 / 换行 / 末尾换行三项的「真源」永远是磁盘探测结果（probe），
 *    这里只提供**无歧义的换算原语**；谁都不许在此之外重新推断。
 * ============================================================ */
import type { EolStyle } from '../types/fs'

/** CRLF 检出：只要出现一个 `\r\n` 即判为 crlf（不按占比投票，避免半归一文件被误判） */
export function detectEol(text: string): EolStyle {
  return text.includes('\r\n') ? 'crlf' : 'lf'
}

/** 文件末尾是否有换行符（`\n` 收尾，crlf 的 `\r\n` 同样命中） */
export function hasFinalNewline(text: string): boolean {
  return text.endsWith('\n')
}

/** 归一为 LF：先 `\r\n` → `\n`，再消化独占的 `\r`（旧 Mac 行尾） */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** LF → 目标行尾。输入**必须已归一为 LF**（本函数不做逆向归一，避免二次转换） */
export function applyEol(text: string, eol: EolStyle): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

/** 去掉全部末尾换行（含连续空行） */
export function stripFinalNewlines(text: string): string {
  return text.replace(/\n+$/, '')
}

/**
 * 末尾换行规范化为 probe 的既有约定。
 *
 * - `finalNewline === true`  → 压平为「恰好一个 `\n` 结尾」
 * - `finalNewline === false` → 去掉全部末尾换行
 *
 * **刻意选择**：用户在编辑器里手动删掉末尾换行，保存时也会被还原成该文件的既有约定。
 * 理由见 §6.3 硬要求 2 —— git 全文件 diff 噪音的代价远大于「保留一个不可见字符」的收益。
 * 输入必须已归一为 LF。
 */
export function applyFinalNewline(text: string, finalNewline: boolean): string {
  const body = stripFinalNewlines(text)
  return finalNewline ? `${body}\n` : body
}

/**
 * 行数口径：空文件 = 0；其余按行尾切分计数。
 * （与既有 `workspace.ts:readTextFile` 的 `split('\n').length` 略有差异——那里空文件报 1 行。
 *  编辑器状态条显示「N 行」时，0 行比 1 行诚实；旧函数保留不为编辑器服务。）
 */
export function countLines(text: string): number {
  if (text === '') return 0
  return normalizeToLf(text).split('\n').length
}

/** 把文本按行拆开（去行尾，便于 diff / 选区换算） */
export function splitLines(text: string): string[] {
  if (text === '') return []
  return normalizeToLf(text).split('\n')
}
