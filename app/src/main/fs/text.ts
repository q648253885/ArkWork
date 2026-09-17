/* ============================================================
 * ArkWork — Main: FS Text Codec（编码 / BOM / EOL / 末尾换行 保真）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §4.3.1 / §5.2 / §6.3
 *
 * 唯一职责：把磁盘字节 ↔ 文本之间的四项约定（encoding / BOM / EOL / finalNewline）
 * 探测出来、并**按探测结果原样写回**。这是 C-6 的正面实现。
 *
 * 纪律：
 *  - 纯计算部分（fastHash / detectEncoding / decodeBuffer / encodeText / probeBuffer）
 *    不碰 IO，可密闭单测；IO 部分（probeText / readText）薄封装。
 *  - **不引入 iconv-lite**：编码能力全部来自 Node 内建 TextDecoder。
 *    Electron 33 与 Node 22 官方发行版均带 full-ICU，已实测支持
 *    gbk / gb18030 / big5 / shift_jis / utf-16le / utf-16be（L6 收口）。
 * ============================================================ */
import { open, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  applyEol,
  applyFinalNewline,
  countLines,
  detectEol,
  hasFinalNewline,
  normalizeToLf,
} from '@shared/utils/eol'
import { detectLanguageByPath } from './workspace.js'
import type {
  EolStyle,
  ReadTextResult,
  ReadonlyReason,
  TextEncoding,
  TextProbe,
  WritableEncoding,
} from '@shared/types/fs'

/* ------------------------------------------------------------
 * 常量
 * ---------------------------------------------------------- */

/** 超过此字节数一律只读（不建 CM6 实例，避免大文件卡死渲染进程） */
export const READONLY_MAX_BYTES = 20 * 1024 * 1024

/** 快速哈希采样窗口：首 / 中 / 尾各 4KB（正本 J13） */
export const HASH_SAMPLE_BYTES = 4096

export const BOM_UTF8: readonly number[] = [0xef, 0xbb, 0xbf]
export const BOM_UTF16LE: readonly number[] = [0xff, 0xfe]
export const BOM_UTF16BE: readonly number[] = [0xfe, 0xff]

/** 探测用候选编码（**顺序即优先级，同分取先者**）；gbk 优先符合本产品目标用户分布 */
const DETECT_CANDIDATES: readonly TextEncoding[] = ['gbk', 'gb18030', 'big5', 'shift_jis', 'latin1']

/**
 * 只读原因顺序（与 main/fs/guard.ts 的 `READONLY_PRECEDENCE` 同源）。
 * 内联于此而非 import：guard 依赖 i18n + store/db，text 只需这一个纯数组，
 * 反向依赖会让 text 的单测被迫拉起整个主进程依赖链。
 * **两处必须保持一致**（有 TC-GUARD-005 的源码契约用例守住）。
 */
export const READONLY_ORDER: readonly ReadonlyReason[] = [
  'deleted',
  'outside-workspace',
  'binary',
  'too-large',
  'permission',
  'agent-writing',
  'non-utf8',
] as const

/* ------------------------------------------------------------
 * CRC32（自实现，不用 node:zlib.crc32）
 * 理由：Node 20.15 才加入 zlib.crc32；自实现可保证「跨进程 / 跨运行时稳定」
 * 这一 CAS 基线的硬要求不受运行时版本影响（TC-TEXT-009）。
 * ---------------------------------------------------------- */

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 快速哈希：`crc32:<8hex>:<len>`
 *
 * 采样策略（正本 J13）：长度 ≤ 3×4KB 时对**全文**取 CRC；
 * 更大时取首 4KB + 中间 4KB + 末 4KB 三段拼接后取 CRC，串里带真实长度。
 * 设计上**不保证任意一字节改动都能检出**（中段未采样）——
 * 冲突检测的兜底是 `mtimeMs` 与显式覆盖分支，采样哈希只负责高频路径低开销。
 *
 * 关键约束：`fastHash(buf)` 与 `fastHashFile(path, size)` **必须对同一文件返回同值**，
 * 否则「打开时基线」与「保存后 revision」不可比，CAS 必然假冲突。
 */
export function fastHash(buf: Uint8Array): string {
  const len = buf.length
  if (len <= HASH_SAMPLE_BYTES * 3) return combineSamples(len, buf, null, null)
  const mid = (len - HASH_SAMPLE_BYTES) >> 1
  return combineSamples(
    len,
    buf.subarray(0, HASH_SAMPLE_BYTES),
    buf.subarray(mid, mid + HASH_SAMPLE_BYTES),
    buf.subarray(len - HASH_SAMPLE_BYTES, len),
  )
}

function combineSamples(
  len: number,
  head: Uint8Array,
  mid: Uint8Array | null,
  tail: Uint8Array | null,
): string {
  let payload: Uint8Array
  if (mid === null || tail === null) {
    payload = head
  } else {
    payload = new Uint8Array(head.length + mid.length + tail.length)
    payload.set(head, 0)
    payload.set(mid, head.length)
    payload.set(tail, head.length + mid.length)
  }
  return `crc32:${crc32(payload).toString(16).padStart(8, '0')}:${len.toString(16)}`
}

/** 流式快速哈希：大文件不必全量读入内存（与 `fastHash` 同口径） */
export async function fastHashFile(absPath: string, size: number): Promise<string> {
  const fh = await open(absPath, 'r')
  const readAt = async (offset: number, length: number): Promise<Uint8Array> => {
    const b = Buffer.alloc(Math.max(0, Math.min(length, size - offset)))
    if (b.length === 0) return b
    const r = await fh.read(b, 0, b.length, offset)
    return b.subarray(0, r.bytesRead)
  }
  try {
    if (size <= HASH_SAMPLE_BYTES * 3) {
      return combineSamples(size, await readAt(0, size), null, null)
    }
    const mid = (size - HASH_SAMPLE_BYTES) >> 1
    return combineSamples(
      size,
      await readAt(0, HASH_SAMPLE_BYTES),
      await readAt(mid, HASH_SAMPLE_BYTES),
      await readAt(size - HASH_SAMPLE_BYTES, HASH_SAMPLE_BYTES),
    )
  } finally {
    await fh.close()
  }
}

/* ------------------------------------------------------------
 * 编码探测与解码
 * ---------------------------------------------------------- */

function hasPrefix(buf: Uint8Array, prefix: readonly number[]): boolean {
  if (buf.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false
  return true
}

function hasNulByte(buf: Uint8Array): number {
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) return i
  return -1
}

function tryDecode(buf: Uint8Array, encoding: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(buf)
  } catch {
    return null
  }
}

/**
 * 解码质量惩罚分（越低越可信）。用于在「传统 CJK 编码」之间做启发式判别。
 *
 * 判别依据（实测 Node 22 / Electron 33 full-ICU，见测试报告）：
 *  - Big5 字节在 GBK 表外 → 落到 **PUA U+E000–U+F8FF**（实测 Big5「你一」→ U+E707 U+E5E6）
 *  - GBK 字节在 Big5 表内 → 多数仍是**合法汉字**（同分，靠候选顺序让 gbk 胜出）
 *  - shift_jis 错配 → 大量**半角片假名 U+FF61–U+FF9F** 混排 ASCII
 *
 * 说明：这是**启发式**，GBK 与 Big5 在字节层并非完全可区分。已知局限见 §11 遗留区 L17。
 */
export function decodePenalty(text: string): number {
  let penalty = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0xfffd) penalty += 100
    else if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) penalty += 100
    else if (cp >= 0xe000 && cp <= 0xf8ff) penalty += 25
    else if (cp >= 0xff61 && cp <= 0xff9f) penalty += 10
  }
  return penalty
}

/**
 * 字节 → 编码判定。
 * 顺序：BOM → NUL 字节（binary）→ 严格 UTF-8 → 传统 CJK 启发式。
 * **UTF-16 只在有 BOM 时被识别**（无 BOM 的 UTF-16 因含 NUL 会落到 binary）；
 * 这是刻意的：无 BOM 的 UTF-16 与二进制在统计上不可区分，误判为可编辑更危险。
 */
export function detectEncoding(buf: Uint8Array): TextEncoding {
  if (hasPrefix(buf, BOM_UTF8)) return 'utf-8-bom'
  if (hasPrefix(buf, BOM_UTF16LE)) return 'utf-16le'
  if (hasPrefix(buf, BOM_UTF16BE)) return 'utf-16be'
  if (hasNulByte(buf) !== -1) return 'binary'

  if (tryDecode(buf, 'utf-8', true) !== null) return 'utf-8'

  let best: TextEncoding = 'latin1'
  let bestPenalty = Number.POSITIVE_INFINITY
  for (const candidate of DETECT_CANDIDATES) {
    const decoded = tryDecode(buf, candidate, false)
    if (decoded === null) continue
    const penalty = decodePenalty(decoded)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = candidate
    }
  }
  return best
}

/** WHATWG 编码名映射（TextEncoding → TextDecoder label） */
export function decoderLabel(encoding: TextEncoding): string {
  if (encoding === 'utf-8' || encoding === 'utf-8-bom' || encoding === 'binary') return 'utf-8'
  return encoding
}

/** 该编码是否可编辑可写出（只有 utf-8 与 utf-8-bom 两类） */
export function isWritableEncoding(encoding: TextEncoding): encoding is WritableEncoding {
  return encoding === 'utf-8' || encoding === 'utf-8-bom'
}

/**
 * 按指定编码解码。
 * `utf-8-bom` / `utf-16le` / `utf-16be` 先显式剥 BOM，保证与 `encodeText` 往返对称
 * （TextDecoder 的 `ignoreBOM:false` 也会吞 BOM，但显式剥离更利于单测断言）。
 */
export function decodeBuffer(buf: Uint8Array, encoding: TextEncoding): string {
  if (encoding === 'binary') return ''
  let body: Uint8Array = buf
  if (encoding === 'utf-8-bom' && hasPrefix(buf, BOM_UTF8)) body = buf.subarray(3)
  else if (encoding === 'utf-16le' && hasPrefix(buf, BOM_UTF16LE)) body = buf.subarray(2)
  else if (encoding === 'utf-16be' && hasPrefix(buf, BOM_UTF16BE)) body = buf.subarray(2)
  return tryDecode(body, decoderLabel(encoding), false) ?? ''
}

/* ------------------------------------------------------------
 * 编码（写路径的字节组装）
 * ---------------------------------------------------------- */

export interface EncodeOptions {
  encoding: WritableEncoding
  eol: EolStyle
  finalNewline: boolean
}

/**
 * 文本 → 字节。三段处理顺序**不可交换**：
 *  ① 归一到 LF（清掉编辑器可能带入的混合行尾）
 *  ② 末尾换行规范化（在 LF 域判定，避免 `\r\n` 收尾时误判）
 *  ③ LF → 目标行尾（最后一步做，避免二次转换）
 * 最后按 encoding 决定是否前置 BOM。
 */
export function encodeText(text: string, opts: EncodeOptions): Buffer {
  let body = normalizeToLf(text)
  body = applyFinalNewline(body, opts.finalNewline)
  body = applyEol(body, opts.eol)
  const bytes = Buffer.from(body, 'utf-8')
  return opts.encoding === 'utf-8-bom'
    ? Buffer.concat([Buffer.from([...BOM_UTF8]), bytes])
    : bytes
}

/* ------------------------------------------------------------
 * Buffer 级探测（无 IO，供 probeText / 单测共用）
 * ---------------------------------------------------------- */

export interface BufferFacts {
  byteLength: number
  lineCount: number
  encoding: TextEncoding
  eol: EolStyle
  finalNewline: boolean
  fastHash: string
}

/** 从字节直接得出五项事实（不做任何只读判定） */
export function probeBuffer(buf: Uint8Array, encoding?: TextEncoding): BufferFacts {
  const enc = encoding ?? detectEncoding(buf)
  const text = decodeBuffer(buf, enc)
  return {
    byteLength: buf.length,
    lineCount: countLines(text),
    encoding: enc,
    eol: detectEol(text),
    finalNewline: hasFinalNewline(text),
    fastHash: fastHash(buf),
  }
}

/* ------------------------------------------------------------
 * IO 层：probeText / readText
 * ---------------------------------------------------------- */

export interface TextProbeDeps {
  /** 只读上界（测试可压低以验证 too-large 分支；生产恒为 READONLY_MAX_BYTES） */
  maxBytes?: number
  /** `agent-writing` 只读原因的判定钩子（B5 的 agent 写盘登记表注入；B2 恒为 undefined） */
  isAgentWriting?: (absPath: string) => boolean
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/** 缺权限位的可读描述（只读卡片第二行） */
export function describeModeBits(mode: number): string {
  const missing: string[] = []
  if (!(mode & 0o200)) missing.push('owner')
  if (!(mode & 0o020)) missing.push('group')
  if (!(mode & 0o002)) missing.push('other')
  const octal = (mode & 0o7777).toString(8).padStart(4, '0')
  if (missing.length === 3) return `mode ${octal}（owner/group/other 均无写位）`
  return `mode ${octal}（无写位: ${missing.join('/')}）`
}

/** 缺失文件的 probe（只读原因 deleted；不抛错，让渲染层拿到完整对象） */
function missingProbe(absPath: string): TextProbe {
  return {
    path: absPath,
    exists: false,
    byteLength: 0,
    lineCount: 0,
    encoding: 'utf-8',
    eol: 'lf',
    finalNewline: false,
    mtimeMs: 0,
    mode: 0,
    readonlyReason: 'deleted',
    fastHash: 'crc32:00000000:0',
  }
}

/**
 * 文本探测。
 *
 * **不抛「文件不存在」**（只读是正常态，不是异常态）：缺失文件返回
 * `exists:false + readonlyReason:'deleted'`，让渲染层拿到完整 probe 对象
 * 渲染「另存恢复」卡片。§5.2 的 `E_NOT_FOUND` 分支由此收敛——前端表现
 * （只读原因 deleted）完全不变，同时少了「异常即无数据」的表达缺失。
 */
export async function probeText(absPath: string, deps: TextProbeDeps = {}): Promise<TextProbe> {
  const target = resolve(absPath)
  const maxBytes = deps.maxBytes ?? READONLY_MAX_BYTES

  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(target)
  } catch {
    return missingProbe(absPath)
  }
  if (!st.isFile()) {
    return {
      ...missingProbe(absPath),
      byteLength: st.size,
      mtimeMs: st.mtimeMs,
      readonlyDetail: 'not-a-file',
    }
  }

  const mode = st.mode & 0o7777
  const tooLarge = st.size > maxBytes
  const noWriteBit = (mode & 0o222) === 0

  let buf: Buffer
  let facts: BufferFacts
  if (tooLarge) {
    // 超大文件：不全量读入。只取首 4KB 判 NUL/BOM，哈希走流式采样
    const fh = await open(target, 'r')
    try {
      const head = Buffer.alloc(Math.min(HASH_SAMPLE_BYTES, st.size))
      const r = await fh.read(head, 0, head.length, 0)
      buf = head.subarray(0, r.bytesRead)
    } finally {
      await fh.close()
    }
    const encoding = detectEncoding(buf)
    facts = {
      byteLength: st.size,
      lineCount: 0,
      encoding,
      eol: 'lf',
      finalNewline: false,
      fastHash: await fastHashFile(target, st.size),
    }
  } else {
    buf = await readFile(target)
    facts = probeBuffer(buf)
  }
  const encoding = facts.encoding

  const candidates: Array<ReadonlyReason | null | undefined> = []
  let readonlyDetail: string | undefined
  if (encoding === 'binary') {
    candidates.push('binary')
    readonlyDetail = `NUL @ 0x${hasNulByte(buf).toString(16)}`
  }
  if (tooLarge) {
    candidates.push('too-large')
    readonlyDetail = `${humanBytes(st.size)} > ${humanBytes(maxBytes)}`
  }
  if (noWriteBit) {
    candidates.push('permission')
    if (!readonlyDetail) readonlyDetail = describeModeBits(mode)
  }
  if (deps.isAgentWriting?.(target)) candidates.push('agent-writing')
  if (!isWritableEncoding(encoding)) {
    candidates.push('non-utf8')
    if (!readonlyDetail) readonlyDetail = encoding.toUpperCase()
  }

  return {
    path: absPath,
    exists: true,
    byteLength: facts.byteLength,
    lineCount: facts.lineCount,
    encoding: facts.encoding,
    eol: facts.eol,
    finalNewline: facts.finalNewline,
    mtimeMs: st.mtimeMs,
    mode,
    readonlyReason: pickReadonlyReasonLocal(candidates),
    readonlyDetail,
    fastHash: facts.fastHash,
  }
}

function pickReadonlyReasonLocal(
  candidates: ReadonlyArray<ReadonlyReason | null | undefined>,
): ReadonlyReason | null {
  for (const r of READONLY_ORDER) if (candidates.includes(r)) return r
  return null
}

/**
 * 读取文本 + probe。**编辑器打开的唯一入口**。
 * `content` 语义见 §4.3.1：可解码时恒非 null（非 UTF-8 也可读，只是不可写）；
 * 仅 binary / too-large / deleted 为 null。
 */
export async function readText(
  absPath: string,
  deps: TextProbeDeps = {},
): Promise<ReadTextResult> {
  const probe = await probeText(absPath, deps)
  const language = detectLanguageByPath(absPath)

  if (!probe.exists || probe.readonlyReason === 'binary' || probe.readonlyReason === 'too-large') {
    return { probe, content: null, language }
  }

  const buf = await readFile(resolve(absPath))
  return { probe, content: decodeBuffer(buf, probe.encoding), language }
}
