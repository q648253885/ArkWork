/* ============================================================
 * ArkWork — Shared Types: Filesystem / Editor（v0.31.0 新增）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §4.3.1 ~ §4.3.5 / §4.3.2
 *
 * 本文件是编辑器文件能力的**类型唯一真源**：
 *  - main（fs/guard · fs/text · fs/write · ipc/fs）
 *  - preload（ark.fs 转发）
 *  - renderer（fsSlice · services/editorDoc · components/editor）
 * 三处一律从 `@shared/types/fs` 引用，**不得在任何一侧重新声明**（§5.3 契约纪律）。
 * ============================================================ */

/* ------------------------------------------------------------
 * 4.3.1 文本探测与只读原因
 * ---------------------------------------------------------- */

/**
 * 只读七原因（03-interaction §4.8）。null = 可编辑。
 * 判定顺序有意义：deleted → outside-workspace → binary → too-large
 * → permission → agent-writing → non-utf8（先硬后软，先永久后临时）。
 */
export type ReadonlyReason =
  | 'deleted'
  | 'outside-workspace'
  | 'binary'
  | 'too-large'
  | 'permission'
  | 'agent-writing'
  | 'non-utf8'

export type TextEncoding =
  | 'utf-8'
  | 'utf-8-bom'
  | 'utf-16le'
  | 'utf-16be'
  | 'gbk'
  | 'gb18030'
  | 'big5'
  | 'shift_jis'
  | 'latin1'
  | 'binary'

export type EolStyle = 'lf' | 'crlf'

/** 可写出的编码（= 可编辑文件的编码；其余一律只读 non-utf8） */
export type WritableEncoding = 'utf-8' | 'utf-8-bom'

export interface TextProbe {
  path: string
  exists: boolean
  byteLength: number
  /** 空文件 = 0；否则按行尾切分计数（口径见 shared/utils/eol.countLines） */
  lineCount: number
  encoding: TextEncoding
  eol: EolStyle
  /** 文件末尾是否有换行符。原样保留是硬要求（git diff 噪音防护） */
  finalNewline: boolean
  mtimeMs: number
  /** 权限位（stat.mode 低 12 位），只读卡片展示用 */
  mode: number
  readonlyReason: ReadonlyReason | null
  /** 人类可读细节（缺失的权限位 / 探测到的编码名 / 实际字节数），用于只读卡片第二行 */
  readonlyDetail?: string
  /** 快速哈希（长度 + 首中尾各 4KB 采样 + CRC32），冲突检测基线。正本 J13 */
  fastHash: string
}

export interface ReadTextResult {
  probe: TextProbe
  /**
   * 解码后的文本。
   * 可解码（utf-8 / gbk / big5 / latin1 / utf-16*）时**恒非 null**——
   * 非 UTF-8 也是可读的，只是不可写（只读原因 non-utf8）。
   * 仅 binary / too-large / deleted 时为 null。
   */
  content: string | null
  /** 复用现有 detectLanguage（main/fs/workspace.ts:132） */
  language: string
}

/* ------------------------------------------------------------
 * 4.3.2 TextProbe ↔ EditorDocMeta 字段对齐
 * ---------------------------------------------------------- */

/** 保存状态机：idle = 可发起保存；saving = per-doc 互斥中（再次保存返回 skipped） */
export type DocSaveState = 'idle' | 'saving'

/** 编辑器两视图（v0.31.0 C1：split 已删 —— 分屏是 markdown 等渲染器的能力，编辑器只留 编辑/只读渲染） */
export type EditorViewMode = 'edit' | 'render'

/**
 * 文档级状态（派生值，不单独存 —— 与 dirtyPaths 同一纪律）。
 * CLEAN / DIRTY / CONFLICT / RELOAD 四态对应 正本 file-cap 03 §2 的状态机。
 */
export type DocStatus = 'clean' | 'dirty' | 'saving' | 'conflicted'

/** 文档元数据里冗余的冲突摘要（完整 ConflictInfo 存在 fsSlice.conflicts） */
export interface DocConflictState {
  diskHash: string
  diskMtimeMs: number
  source: 'external' | 'agent' | 'unknown'
}

/**
 * 打开中的文档元数据。**文本不在此**（正本 J12：文本真源是 CM6 EditorState）。
 * 字段来源严格按 §4.3.2 映射表填充，**不得再造第二套**。
 */
export interface EditorDocMeta {
  path: string
  language: string
  /** `probe.readonlyReason === null` */
  editable: boolean
  readonlyReason: ReadonlyReason | null
  readonlyDetail?: string
  /** 渲染层状态机（CM6 updateListener 的 docChanged），不从主进程取 */
  dirty: boolean
  conflict: DocConflictState | null
  saveState: DocSaveState
  /** 打开时 = probe.fastHash；保存成功后 = WriteTextResult.revision */
  diskSnapshotHash: string
  /** LRU 依据（正本 J9） */
  openedAt: number
  lastActiveAt: number
  /** 编码三件套：保存时**原样回传**，否则编码保真失守 */
  encoding: WritableEncoding | TextEncoding
  eol: EolStyle
  finalNewline: boolean
  /** Tab 视图态；只读文档恒为 'render' */
  viewMode: EditorViewMode
}

/* ------------------------------------------------------------
 * 4.3.3 保存契约
 * ---------------------------------------------------------- */

export interface WriteTextRequest {
  path: string
  content: string
  /**
   * 期望的磁盘指纹。undefined = 强制覆盖（走「覆盖磁盘」分支，跳过 CAS）。
   * 命中不等 → 抛 E_CONFLICT，**不写盘**。
   */
  expectedDiskHash?: string
  /** 编码 / 换行 / 末尾换行——从 probe 原样回传，不得由渲染层重新推断 */
  encoding: WritableEncoding
  eol: EolStyle
  finalNewline: boolean
  /** 写入来源：用于「覆盖磁盘前先存本地历史」与 chokidar 自写回环抑制 */
  origin: 'user-save' | 'selection-action'
}

export interface WriteTextResult {
  path: string
  bytes: number
  /** 写入后的新快速哈希 = 新的 diskSnapshotHash */
  revision: string
  mtimeMs: number
  /** 覆盖 conflicted 内容时，被覆盖版本的本地历史条目 id（正本 04 §B31 的"先入历史"） */
  historyId?: string
}

export interface ConflictInfo {
  path: string
  /** 磁盘当前指纹与 mtime */
  diskHash: string
  diskMtimeMs: number
  /** 磁盘版来源归因（来自 watch 的来源归因表） */
  source: 'external' | 'agent' | 'unknown'
  /** 磁盘版可读文本（供双栏对比视图），文本不可解码时为 null */
  diskText: string | null
  diskProbe: TextProbe
}

/* ------------------------------------------------------------
 * 4.3.4 文件监听批次
 * ---------------------------------------------------------- */

export type FsBatchEntry = {
  path: string
  /**
   * 来源归因（见 §6.4）：
   *  - 'agent'      命中 agent 写盘登记表（该工具调用成功返回的路径）
   *  - 'external'   其余一切（外部脚本 / git / 云盘同步 / 人手改）
   *  - 自写回环命中的条目不进入广播（直接丢弃）
   */
  origin: 'agent' | 'external'
}

export interface FsBatchEvent {
  batchId: number
  ts: number
  root: string
  added: FsBatchEntry[]
  changed: FsBatchEntry[]
  removed: FsBatchEntry[]
}

export type WatchState = 'idle' | 'starting' | 'active' | 'failed'

/* ------------------------------------------------------------
 * 4.3.5 QuickOpen 候选集（扁平，替代递归树）
 * ---------------------------------------------------------- */

export interface WorkspaceFileEntry {
  path: string
  /** 工作区相对路径，QuickOpen 匹配与展示用 */
  rel: string
  size: number
  language: string
  mtimeMs: number
  /** git 状态（沿用 FsNode.status 口径） */
  status?: 'M' | 'A' | 'D' | ' '
}

export interface ListPathsResult {
  root: string
  files: WorkspaceFileEntry[]
  /** 超过 20000 条时截断（QuickOpen 不需要全量） */
  truncated: boolean
}

/* ------------------------------------------------------------
 * 错误码（§5.2 逐条契约）
 * ---------------------------------------------------------- */

export type FsErrorCode =
  | 'E_PATH_OUTSIDE_WORKSPACE'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_ENCODING'
  | 'E_WRITE_FAILED'
  | 'E_ARKWORK_RESERVED'
  | 'E_WATCH_INIT'

/** 哈希算法口径：`crc32:<8hex>:<len>` —— 见 main/fs/text.fastHash */
export type FastHash = string
