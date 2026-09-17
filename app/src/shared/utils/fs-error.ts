/* ============================================================
 * ArkWork — Shared Utils: FsError 跨 IPC 保真编解码（纯函数）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §5.2
 *
 * 问题：`ipcMain.handle` 抛出的 Error 经 Electron 序列化后**只剩 message**，
 *      `code` 与 `payload`（如 ConflictInfo）会丢。而 §5.2 的契约要求
 *      渲染层能按 `E_CONFLICT` / `E_PATH_OUTSIDE_WORKSPACE` 分支处理。
 *
 * 方案：把 {code, message, payload} 压进 message 的固定前缀段，
 *      main 侧 `encodeFsError()`，preload 侧 `decodeFsError()` 还原成
 *      带 code / payload 的 Error。前缀用不可见字符包裹，避免与自然文案冲突。
 *
 * 纪律：纯函数、无 IO、无 electron 依赖 —— main / preload 两侧共用同一份实现。
 * ============================================================ */
import type { ConflictInfo, FsErrorCode } from '../types/fs'

/** 前缀哨兵：`\u0000ARKFS\u0000` —— 自然文案不可能以此开头 */
export const FS_ERROR_PREFIX = '\u0000ARKFS\u0000'

export interface FsErrorPayload {
  code: FsErrorCode
  message: string
  /** 目前仅 E_CONFLICT 携带（ConflictInfo）；其余为 undefined */
  payload?: unknown
}

/** 带错误码的文件系统异常（main 侧抛出） */
export class FsError extends Error {
  readonly code: FsErrorCode
  readonly payload?: unknown

  constructor(code: FsErrorCode, message: string, payload?: unknown) {
    super(message)
    this.name = 'FsError'
    this.code = code
    this.payload = payload
  }
}

/** main → preload：把 FsError 编码进 message（其余 Error 原样透传 message） */
export function encodeFsError(err: unknown): string {
  if (err instanceof FsError) {
    const body: FsErrorPayload = { code: err.code, message: err.message, payload: err.payload }
    return FS_ERROR_PREFIX + JSON.stringify(body)
  }
  return err instanceof Error ? err.message : String(err)
}

function isFsErrorCode(v: unknown): v is FsErrorCode {
  return (
    v === 'E_PATH_OUTSIDE_WORKSPACE' ||
    v === 'E_NOT_FOUND' ||
    v === 'E_CONFLICT' ||
    v === 'E_ENCODING' ||
    v === 'E_WRITE_FAILED' ||
    v === 'E_ARKWORK_RESERVED' ||
    v === 'E_WATCH_INIT'
  )
}

/**
 * 从 message 中抽出 `\u0000ARKFS\u0000{...}` 段。
 * 命中返回结构化载荷；未命中返回 null（普通异常）。
 */
export function decodeFsError(message: string): FsErrorPayload | null {
  const idx = message.indexOf(FS_ERROR_PREFIX)
  if (idx === -1) return null
  const raw = message.slice(idx + FS_ERROR_PREFIX.length)
  // Electron 会把 message 包成 `Error invoking remote method 'fs:write-text': Error: <msg>`；
  // 前缀段总在末尾，但保险起见从第一个 `{` 截到最后一个 `}`
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<FsErrorPayload>
    if (!isFsErrorCode(parsed.code) || typeof parsed.message !== 'string') return null
    return { code: parsed.code, message: parsed.message, payload: parsed.payload }
  } catch {
    return null
  }
}

/** 把任意 error 归一为 `{code, message, payload}`；无码异常 code = null */
export function toFsErrorInfo(err: unknown): {
  code: FsErrorCode | null
  message: string
  payload: unknown
} {
  if (err instanceof FsError) {
    return { code: err.code, message: err.message, payload: err.payload }
  }
  const msg = err instanceof Error ? err.message : String(err)
  const decoded = decodeFsError(msg)
  if (decoded) return { code: decoded.code, message: decoded.message, payload: decoded.payload }
  return { code: null, message: msg, payload: undefined }
}

/** 便捷断言：从 unknown 载荷里安全取 ConflictInfo */
export function asConflictInfo(payload: unknown): ConflictInfo | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Partial<ConflictInfo>
  if (typeof p.path === 'string' && typeof p.diskHash === 'string') return p as ConflictInfo
  return null
}

/** IPC 频道抛错包装：让 code / payload 穿过 Electron 序列化边界 */
export function throwEncodedFsError(err: unknown): never {
  throw new Error(encodeFsError(err))
}
