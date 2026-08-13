/* ============================================================
 * ArkWork — Knowledge Base Parser (v0.8.0 F810)
 * 三路解析：pdf-parse / mammoth / 直读
 * 设计文档：versions/v0.8.0/02-knowledge-base.md §3.1
 * ============================================================ */
import { readFile } from 'node:fs/promises'
import { logger } from '../system/logger.js'

export type ParseFormat = 'pdf' | 'docx' | 'txt' | 'md' | 'unknown'

export interface ParseResult {
  text: string
  /** 解析失败原因（成功时为空） */
  error?: string
}

/** 从文件名推断解析格式 */
export function detectFormat(filename: string): ParseFormat {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (ext === 'txt') return 'txt'
  if (ext === 'md' || ext === 'markdown') return 'md'
  return 'unknown'
}

/** 文件扩展名（小写，无点） */
export function fileExt(filename: string): string {
  return (filename.toLowerCase().split('.').pop() ?? '').replace(/^markdown$/, 'md')
}

/**
 * 解析文件为纯文本。
 * @param absPath 文件绝对路径
 * @param format 解析格式
 * @returns 解析结果（text 为空串且 error 非空表示失败）
 */
export async function parseFile(
  absPath: string,
  format: ParseFormat,
): Promise<ParseResult> {
  switch (format) {
    case 'pdf':
      return parsePdf(absPath)
    case 'docx':
      return parseDocx(absPath)
    case 'txt':
    case 'md':
      return parseText(absPath)
    default:
      return { text: '', error: `不支持的格式：${format}（仅支持 pdf/docx/txt/md）` }
  }
}

/** PDF 解析——pdf-parse（纯 JS，按页提取文本） */
async function parsePdf(absPath: string): Promise<ParseResult> {
  // 动态导入避免影响未使用 KB 的启动性能；parser 类型延迟到运行时
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parser: any = null
  try {
    // v0.8.0：适配 pdf-parse 新版 API（class-based，无 default 导出）
    const { PDFParse } = await import('pdf-parse')
    const buffer = await readFile(absPath)
    parser = new PDFParse({ data: new Uint8Array(buffer) })
    const data = await parser.getText()
    const text = (data.text ?? '').trim()
    if (!text) {
      return { text: '', error: '该 PDF 无可提取文本（可能是扫描件，需 OCR 后重新导入）' }
    }
    return { text }
  } catch (err) {
    logger.warn('System', `pdf parse failed: ${(err as Error).message}`)
    return { text: '', error: `PDF 解析失败：${(err as Error).message}` }
  } finally {
    // 释放 pdfjs 底层 worker / 文档句柄
    await parser?.destroy?.().catch(() => {})
  }
}

/** DOCX 解析——mammoth.extractRawText */
async function parseDocx(absPath: string): Promise<ParseResult> {
  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ path: absPath })
    const text = (result.value ?? '').trim()
    if (!text) {
      return { text: '', error: '该 DOCX 内容为空' }
    }
    return { text }
  } catch (err) {
    const msg = (err as Error).message
    // .doc 旧格式 mammoth 不支持
    if (msg.includes('zip') || msg.includes('ZIP')) {
      return { text: '', error: '不支持 .doc 旧格式，请另存为 .docx 后导入' }
    }
    logger.warn('System', `docx parse failed: ${msg}`)
    return { text: '', error: `DOCX 解析失败：${msg}` }
  }
}

/** TXT/MD 直接读取 */
async function parseText(absPath: string): Promise<ParseResult> {
  try {
    const text = await readFile(absPath, 'utf-8')
    return { text: text.trim() }
  } catch (err) {
    return { text: '', error: `文件读取失败：${(err as Error).message}` }
  }
}

/** 单文件上限 20MB */
export const MAX_FILE_SIZE = 20 * 1024 * 1024
