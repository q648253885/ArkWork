/* ============================================================
 * ArkWork — Renderer Service: EditorDoc（文档元数据与保存状态机）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §4.3.2 / §5.4.3 / §6.3
 *
 * 本模块**不含 CM6 / React**：它只是「一组纯函数 + 一次性 IPC 编排」，
 * 因此可以在 node:test 里密闭断言状态机（TC-DOC-001..008）。
 * 与 `services/savePipeline.ts` 的分工：
 *   - 本模块 = 单文档的状态迁移与一次保存的编排（含冲突/失败的语义）
 *   - savePipeline = 多文档注册表（handle 查找、per-doc 互斥、关闭保护查询）
 *
 * 硬约束（§3.3 依赖方向）：本模块不得 import `@codemirror/*`。
 * ============================================================ */
import type {
  ConflictInfo,
  DocStatus,
  EditorDocMeta,
  ReadonlyReason,
  TextProbe,
  WriteTextRequest,
  WriteTextResult,
} from '@shared/types/fs'

/* ------------------------------------------------------------
 * EditorHandle —— CM6 宿主的对外抽象（§5.4.3）
 * 文本真源是 EditorState，本服务只透过这个接口读写，不持有文本。
 * ---------------------------------------------------------- */

export interface EditorHandle {
  getText(): string
  setText(text: string, opts?: { markClean?: boolean }): void
  getCursor(): { line: number; col: number }
  setCursor(pos: { line: number; col: number }): void
  /** 静默重载后按行比例恢复光标（chokidar changed 分支） */
  restoreCursorRatio(ratio: number): void
  getScrollLineRatio(): number
  focus(): void
  toJSON(): unknown
  fromJSON(s: unknown): void
  destroy(): void
}

export type SaveOutcome =
  | { kind: 'saved'; revision: string }
  | { kind: 'conflict'; info: ConflictInfo }
  | { kind: 'failed'; message: string }
  /** 已在保存中（排队）或非 dirty */
  | { kind: 'skipped'; reason: 'busy' | 'clean' | 'not-editable' }

/* ------------------------------------------------------------
 * 构造（§4.3.2 字段映射表 —— 不得再造第二套）
 * ---------------------------------------------------------- */

export function createEditorDoc(
  probe: TextProbe,
  language: string,
  now: number = Date.now(),
): EditorDocMeta {
  const editable = probe.readonlyReason === null
  return {
    path: probe.path,
    language,
    editable,
    readonlyReason: probe.readonlyReason,
    ...(probe.readonlyDetail ? { readonlyDetail: probe.readonlyDetail } : {}),
    dirty: false,
    conflict: null,
    saveState: 'idle',
    diskSnapshotHash: probe.fastHash,
    openedAt: now,
    lastActiveAt: now,
    // 编码三件套原样带入；保存时原样回传（编码保真的渲染层唯一职责）
    encoding: probe.encoding,
    eol: probe.eol,
    finalNewline: probe.finalNewline,
    // 只读文档没有编辑态（A2），直接停在只读渲染视图
    viewMode: editable ? 'edit' : 'render',
  }
}

/* ------------------------------------------------------------
 * 派生（派生不新增状态：否则必然漂移）
 * ---------------------------------------------------------- */

export function docStatus(doc: EditorDocMeta): DocStatus {
  if (doc.conflict) return 'conflicted'
  if (doc.saveState === 'saving') return 'saving'
  if (doc.dirty) return 'dirty'
  return 'clean'
}

export function isDirty(doc: EditorDocMeta | undefined | null): boolean {
  return doc?.dirty === true
}

/**
 * `dirtyPaths` **派生自 `docs`，不单独存**（§5.4.4 派生约束 / TC-DOC-008）。
 * 任何新增「dirty 集合」字段都是同一类漂移缺陷。
 */
export function deriveDirtyPaths(docs: Record<string, EditorDocMeta>): string[] {
  return Object.keys(docs).filter((p) => docs[p]?.dirty === true)
}

/** 需关闭保护的路径（dirty 或保存中） */
export function deriveCloseProtectedPaths(docs: Record<string, EditorDocMeta>): string[] {
  return Object.keys(docs).filter((p) => {
    const d = docs[p]
    return !!d && (d.dirty || d.saveState === 'saving')
  })
}

/* ------------------------------------------------------------
 * 状态迁移（纯函数，返回新对象）
 * ---------------------------------------------------------- */

export function markDirty(doc: EditorDocMeta, dirty: boolean, now = Date.now()): EditorDocMeta {
  if (doc.dirty === dirty) return { ...doc, lastActiveAt: now }
  return { ...doc, dirty, lastActiveAt: now }
}

export function touchDoc(doc: EditorDocMeta, now = Date.now()): EditorDocMeta {
  return { ...doc, lastActiveAt: now }
}

export function setViewMode(doc: EditorDocMeta, viewMode: EditorDocMeta['viewMode']): EditorDocMeta {
  return { ...doc, viewMode: doc.editable ? viewMode : 'render' }
}

export function beginSave(doc: EditorDocMeta): EditorDocMeta {
  return { ...doc, saveState: 'saving' }
}

/** 保存成功：hash 基线前移、dirty 清除、冲突清除 */
export function applySaved(
  doc: EditorDocMeta,
  revision: string,
  now = Date.now(),
): EditorDocMeta {
  return {
    ...doc,
    saveState: 'idle',
    dirty: false,
    conflict: null,
    diskSnapshotHash: revision,
    lastActiveAt: now,
  }
}

/** 保存失败：**dirty 必须保持 true**（绝不静默清除 dirty / §5.2 E_WRITE_FAILED） */
export function applyFailed(doc: EditorDocMeta, now = Date.now()): EditorDocMeta {
  return { ...doc, saveState: 'idle', dirty: true, lastActiveAt: now }
}

/** 冲突：记录冲突摘要，**缓冲不动**（用户内容不被清掉） */
export function applyConflict(
  doc: EditorDocMeta,
  info: ConflictInfo,
  now = Date.now(),
): EditorDocMeta {
  return {
    ...doc,
    saveState: 'idle',
    dirty: true,
    conflict: { diskHash: info.diskHash, diskMtimeMs: info.diskMtimeMs, source: info.source },
    lastActiveAt: now,
  }
}

/** 还原磁盘（丢弃我的改动）：缓冲区即将被替换为磁盘内容，视为已保存 */
export function applyRevertedToDisk(doc: EditorDocMeta, probe: TextProbe, now = Date.now()): EditorDocMeta {
  return {
    ...doc,
    dirty: false,
    conflict: null,
    saveState: 'idle',
    diskSnapshotHash: probe.fastHash,
    encoding: probe.encoding,
    eol: probe.eol,
    finalNewline: probe.finalNewline,
    lastActiveAt: now,
  }
}

/* ------------------------------------------------------------
 * Tab 软上限与 LRU 淘汰（J9 / TC-DOC-007）
 * ---------------------------------------------------------- */

/** Tab 软上限：超出后按 lastActiveAt 淘汰最久未用的**非 dirty** Tab */
export const MAX_DOC_TABS = 20

export function selectLruEvictions(
  docs: Record<string, EditorDocMeta>,
  limit: number = MAX_DOC_TABS,
): string[] {
  const paths = Object.keys(docs)
  if (paths.length <= limit) return []
  // dirty / saving / conflicted 的 Tab 一律不淘汰（有未落盘的用户内容）
  const closable = paths
    .filter((p) => {
      const d = docs[p]
      return !!d && !d.dirty && d.saveState === 'idle' && !d.conflict
    })
    .sort((a, b) => docs[a].lastActiveAt - docs[b].lastActiveAt)
  const need = paths.length - limit
  return closable.slice(0, Math.max(0, need))
}

/* ------------------------------------------------------------
 * 保存编排（§5.4.3 saveEditorDoc / §6.3 时序）
 * ---------------------------------------------------------- */

export interface SaveIo {
  writeText(req: WriteTextRequest): Promise<WriteTextResult>
  now(): number
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

function errorPayload(err: unknown): unknown {
  return (err as { payload?: unknown } | null)?.payload
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 一次保存的完整编排。**不做 React / 不做 store 写入**——
 * 调用方（savePipeline）拿到 `SaveOutcome` 后据 kind 更新 fsSlice。
 *
 * 三条不可回退的语义：
 *  - `doc.saveState !== 'idle'` → `skipped('busy')`（per-doc 互斥挡掉连按，TC-DOC-004）
 *  - 失败 → `failed`，**调用方必须保持 dirty**（TC-DOC-005）
 *  - 冲突 → `conflict` 带 ConflictInfo，**绝不自动覆盖 / 绝不自动合并**（J3 / TC-DOC-006）
 */
export async function saveEditorDoc(
  doc: EditorDocMeta,
  handle: Pick<EditorHandle, 'getText'>,
  io: SaveIo,
  opts: { force?: boolean } = {},
): Promise<SaveOutcome> {
  if (!doc.editable && !opts.force) return { kind: 'skipped', reason: 'not-editable' }
  if (doc.saveState !== 'idle') return { kind: 'skipped', reason: 'busy' }
  if (!doc.dirty && !opts.force) return { kind: 'skipped', reason: 'clean' }

  const content = handle.getText()
  try {
    const result = await io.writeText({
      path: doc.path,
      content,
      // force = 走「覆盖磁盘」分支：跳过 CAS，主进程会先落本地历史
      ...(opts.force ? {} : { expectedDiskHash: doc.diskSnapshotHash }),
      // 编码三件套**原样回传**（从 probe 带入，渲染层绝不重新推断）
      encoding: doc.encoding === 'utf-8-bom' ? 'utf-8-bom' : 'utf-8',
      eol: doc.eol,
      finalNewline: doc.finalNewline,
      origin: 'user-save',
    })
    return { kind: 'saved', revision: result.revision }
  } catch (err) {
    if (errorCode(err) === 'E_CONFLICT') {
      const info = errorPayload(err) as ConflictInfo | undefined
      if (info && typeof info.diskHash === 'string') return { kind: 'conflict', info }
    }
    return { kind: 'failed', message: errorMessage(err) }
  }
}

/** 只读原因 → i18n 键（03-interaction §4.8 的只读卡片标题） */
export const READONLY_REASON_KEY: Record<ReadonlyReason, string> = {
  deleted: 'editor.readonly.reason.deleted',
  'outside-workspace': 'editor.readonly.reason.outsideWorkspace',
  binary: 'editor.readonly.reason.binary',
  'too-large': 'editor.readonly.reason.tooLarge',
  permission: 'editor.readonly.reason.permission',
  'agent-writing': 'editor.readonly.reason.agentWriting',
  'non-utf8': 'editor.readonly.reason.nonUtf8',
}

/* ------------------------------------------------------------
 * 编码三件套 → 人类可读状态条文案（原型 07：UTF-8 · CRLF）
 * ---------------------------------------------------------- */

export function encodingLabel(doc: EditorDocMeta): string {
  const enc =
    doc.encoding === 'utf-8-bom'
      ? 'UTF-8 BOM'
      : doc.encoding === 'utf-8'
        ? 'UTF-8'
        : String(doc.encoding).toUpperCase()
  const eol = doc.eol === 'crlf' ? 'CRLF' : 'LF'
  return `${enc} · ${eol}${doc.finalNewline ? '' : ' · 无末尾换行'}`
}
