/* ============================================================
 * ArkWork — Renderer Service: SavePipeline（per-doc 互斥与关闭保护）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §5.4.3 / §6.3
 *
 * 职责边界（刻意收窄，避免 store ↔ service 循环依赖）：
 *  - 本模块持有 **EditorHandle 注册表**（path → CM6 宿主的对外句柄）
 *  - 本模块**不 import store**：状态迁移由 fsSlice 的 action 发起，
 *    拿到 SaveOutcome 后自行写回。依赖方向单向：fsSlice → savePipeline → editorDoc。
 *
 * 关闭保护（A5 / A6：禁止静默丢弃）的查询也在本模块，供 PreviewWindow 调用。
 * ============================================================ */
import { MAX_DOC_TABS, deriveCloseProtectedPaths, saveEditorDoc } from './editorDoc'
import type { EditorHandle, SaveOutcome } from './editorDoc'
import type { EditorDocMeta, WriteTextRequest, WriteTextResult } from '@shared/types/fs'

/* ------------------------------------------------------------
 * EditorHandle 注册表
 * ---------------------------------------------------------- */

const handles = new Map<string, EditorHandle>()

export function registerEditorHandle(path: string, handle: EditorHandle): void {
  handles.set(path, handle)
}

export function unregisterEditorHandle(path: string, handle?: EditorHandle): void {
  // 只在登记的仍是同一个 handle 时移除（防止「旧实例卸载晚于新实例挂载」误删新句柄）
  if (handle && handles.get(path) !== handle) return
  handles.delete(path)
}

export function getEditorHandle(path: string): EditorHandle | undefined {
  return handles.get(path)
}

export function registeredHandlePaths(): string[] {
  return [...handles.keys()]
}

export function clearEditorHandles(): void {
  handles.clear()
}

/* ------------------------------------------------------------
 * 保存执行
 * ---------------------------------------------------------- */

export interface SavePipelineIo {
  writeText(req: WriteTextRequest): Promise<WriteTextResult>
  now(): number
}

/** 无 handle（Tab 已卸载 / 只读文档）时的结果语义：视为跳过，不报错 */
export async function runSave(
  doc: EditorDocMeta,
  io: SavePipelineIo,
  opts: { force?: boolean } = {},
): Promise<SaveOutcome> {
  const handle = getEditorHandle(doc.path)
  if (!handle) return { kind: 'skipped', reason: 'busy' }
  return saveEditorDoc(doc, handle, io, opts)
}

/* ------------------------------------------------------------
 * 关闭保护（A5 / A6）
 * ---------------------------------------------------------- */

export interface CloseGuard {
  /** 有未保存改动的路径（含保存中） */
  protectedPaths: string[]
  /** 是否允许直接关闭 */
  safeToClose: boolean
}

export function closeGuard(docs: Record<string, EditorDocMeta>): CloseGuard {
  const protectedPaths = deriveCloseProtectedPaths(docs)
  return { protectedPaths, safeToClose: protectedPaths.length === 0 }
}

/**
 * 关闭前的「保存并关闭」批量执行。
 * 逐个串行：单文件冲突不应阻断其余文件的保存（用户可稍后逐个处理）。
 */
export async function saveAllForClose(
  docs: Record<string, EditorDocMeta>,
  paths: string[],
  io: SavePipelineIo,
): Promise<{ saved: string[]; conflicted: string[]; failed: Array<{ path: string; message: string }> }> {
  const saved: string[] = []
  const conflicted: string[] = []
  const failed: Array<{ path: string; message: string }> = []
  for (const p of paths) {
    const doc = docs[p]
    if (!doc || !doc.dirty) continue
    const outcome = await runSave(doc, io)
    if (outcome.kind === 'saved') saved.push(p)
    else if (outcome.kind === 'conflict') conflicted.push(p)
    else if (outcome.kind === 'failed') failed.push({ path: p, message: outcome.message })
  }
  return { saved, conflicted, failed }
}

/* ------------------------------------------------------------
 * Tab 软上限（J9）
 * ---------------------------------------------------------- */

export const DOC_TAB_SOFT_LIMIT = MAX_DOC_TABS
