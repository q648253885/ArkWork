/* ============================================================
 * ArkWork — Main: FS Atomic Write（原子写 + CAS + 串行 + 编码保真）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §5.2 / §6.3
 *
 * 四条硬要求（§6.3）：
 *  ① 原子性：临时文件 `.{name}.arkwork-tmp` + **同目录 rename**。
 *     绝不用 `writeFile(target)` 直写（现状 workspace.ts 直写是 C-6 根因）。
 *  ② 编码保真：encoding / eol / finalNewline 全由 probe 带入，渲染层不得重新推断。
 *  ③ 并发写同一路径串行化：`Map<path, Promise>` 互斥链。
 *  ④ 冲突不静默：CAS 失配 → `E_CONFLICT` + ConflictInfo；绝不自动覆盖、绝不自动合并（J3）。
 * ============================================================ */
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { getWorkspaceDir } from '../store/db.js'
import { getUiLocale, tFor } from '../i18n/messages.js'
import { FsError } from '@shared/utils/fs-error'
import {
  decodeBuffer,
  encodeText,
  fastHash,
  fastHashFile,
  isWritableEncoding,
  probeText,
} from './text.js'
import { assertInWorkspace, assertWritableTarget } from './guard.js'
import type { ConflictInfo, WriteTextRequest, WriteTextResult } from '@shared/types/fs'

/* ------------------------------------------------------------
 * 自写回环抑制登记表（§6.3 ⑥）
 * B5 的 chokidar 消费者用它区分「自己刚写的」与「外部改的」。
 * ---------------------------------------------------------- */

/** TTL：chokidar 的 awaitWriteFinish 默认 100ms，500ms 留足余量 */
export const SELF_WRITE_TTL_MS = 500

const selfWrites = new Map<string, { hash: string; until: number }>()

export function markSelfWrite(absPath: string, hash: string, now: number = Date.now()): void {
  selfWrites.set(resolve(absPath), { hash, until: now + SELF_WRITE_TTL_MS })
}

/** 命中即代表「该路径刚被本进程写过，且指纹相同」→ chokidar 事件应丢弃 */
export function isSelfWrite(
  absPath: string,
  hash: string,
  now: number = Date.now(),
): boolean {
  return peekSelfWrite(absPath, now) === hash
}

/**
 * 只查标记、不比对 hash（B5 watch 消费）：
 * 返回登记的指纹（未登记 / 已过期 → null）。
 * watch 的 flush 用它决定「要不要读盘算 hash」——绝大多数外部变更路径
 * 没有登记，先 peek 再读盘可避免每条 change 事件都做一次采样哈希。
 */
export function peekSelfWrite(absPath: string, now: number = Date.now()): string | null {
  const key = resolve(absPath)
  const hit = selfWrites.get(key)
  if (!hit) return null
  if (hit.until < now) {
    selfWrites.delete(key)
    return null
  }
  return hit.hash
}

export function clearSelfWrites(): void {
  selfWrites.clear()
}

/* ------------------------------------------------------------
 * 本地历史（B31 最小止损）
 * ---------------------------------------------------------- */

/** 历史条目 id：哈希里的 `:` 在 Windows 上是非法文件名字符，统一替换为 `-` */
export function historyIdFor(hash: string): string {
  return hash.replace(/:/g, '-')
}

export function historyDirFor(root: string): string {
  return join(root, '.arkwork', 'history')
}

/** 临时文件命名：同目录 + 隐藏 + 固定后缀，便于清理与识别 */
export function tmpPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.arkwork-tmp`)
}

/* ------------------------------------------------------------
 * per-path 串行队列
 * ---------------------------------------------------------- */

const writeQueues = new Map<string, Promise<unknown>>()

/** 当前排队中的路径数（诊断 / 测试用） */
export function pendingWriteCount(): number {
  return writeQueues.size
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve()
  const run = prev.then(task)
  const guard = run.catch(() => {})
  writeQueues.set(key, guard)
  void guard.then(() => {
    if (writeQueues.get(key) === guard) writeQueues.delete(key)
  })
  return run
}

/* ------------------------------------------------------------
 * 写主流程
 * ---------------------------------------------------------- */

export interface WriteIoOverrides {
  /** 故障注入：替换 rename（TC-WRITE-002 的断电模拟） */
  rename?: (from: string, to: string) => Promise<void>
  /** 故障注入：替换临时文件写入 */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
}

export interface WriteDeps {
  /** 工作区根（测试注入临时目录） */
  root?: string
  io?: WriteIoOverrides
  now?: () => number
}

function wrapIoError(err: unknown, absPath: string): FsError {
  const message = (err as Error)?.message ?? String(err)
  return new FsError(
    'E_WRITE_FAILED',
    tFor(getUiLocale(), 'fs.writeFailed', { message }),
    { path: absPath, cause: message },
  )
}

/** 组装 ConflictInfo（磁盘版文本 + probe；不可解码时 diskText = null） */
async function buildConflict(
  absPath: string,
  curBuf: Buffer | null,
  diskHash: string,
  diskMtimeMs: number,
): Promise<ConflictInfo> {
  const diskProbe = await probeText(absPath)
  let diskText: string | null = null
  if (curBuf && isWritableEncoding(diskProbe.encoding)) {
    diskText = decodeBuffer(curBuf, diskProbe.encoding)
  }
  return {
    path: absPath,
    diskHash,
    diskMtimeMs,
    // 来源归因表由 B5 的 watch 提供；B2 阶段恒为 unknown（宁可保守：不谎报 agent 写入）
    source: 'unknown',
    diskText,
    diskProbe,
  }
}

/**
 * 原子写文本。
 *
 * 时序见 §6.3：per-path 串行 → stat + fastHash → CAS → （覆盖分支）历史 → 编码
 * → 写 tmp → rename → 登记自写抑制。
 */
export async function writeText(
  req: WriteTextRequest,
  deps: WriteDeps = {},
): Promise<WriteTextResult> {
  const root = deps.root ?? getWorkspaceDir()
  /**
   * 入队 key 用**同步 `resolve`**，且入队发生在任何 await 之前——
   * 否则 20 次并发调用的入队顺序会退化为「路径断言（含 realpath IO）的完成顺序」，
   * 「末态 = 最后一次调用者内容」这条语义就不再成立（TC-WRITE-007 实测踩到过）。
   *
   * 已知边界：key 是字面归一化路径，两个不同的 symlink 字面路径指向同一物理文件时
   * 不会共用一个队列。编辑器写入的真源是文档单一状态（fsSlice），不会同时用两个别名写同一文件。
   */
  return enqueue(resolve(req.path), async () => {
    const target = await assertWritableTarget(req.path, root)
    const ioRename = deps.io?.rename ?? rename
    const ioWriteFile = deps.io?.writeFile ?? writeFile

    // ---- ① 读现状 + 指纹 ----
    let curBuf: Buffer | null = null
    let curMtimeMs = 0
    try {
      const st = await stat(target)
      if (st.isFile()) {
        curBuf = await readFile(target)
        curMtimeMs = st.mtimeMs
      }
    } catch {
      curBuf = null
    }
    const curHash = curBuf ? fastHash(curBuf) : null

    // ---- ② CAS ----
    if (req.expectedDiskHash !== undefined && curHash !== req.expectedDiskHash) {
      const info = await buildConflict(target, curBuf, curHash ?? '', curMtimeMs)
      throw new FsError(
        'E_CONFLICT',
        tFor(getUiLocale(), 'fs.conflictDetected', { path: req.path }),
        info,
      )
    }

    // ---- ③ 覆盖分支：先落本地历史（不可逆操作前的最小止损） ----
    let historyId: string | undefined
    if (req.expectedDiskHash === undefined && curBuf) {
      historyId = await writeHistory(root, curHash ?? fastHash(curBuf), curBuf)
    }

    // ---- ④ 父目录存在性（E_NOT_FOUND：目标目录已不存在） ----
    try {
      const parent = await stat(dirname(target))
      if (!parent.isDirectory()) throw new Error('parent is not a directory')
    } catch {
      throw new FsError(
        'E_NOT_FOUND',
        tFor(getUiLocale(), 'fs.writeParentMissing', { path: req.path }),
        { path: req.path, parent: dirname(target) },
      )
    }

    // ---- ⑤ 编码组装 ----
    const bytes = encodeText(req.content, {
      encoding: req.encoding,
      eol: req.eol,
      finalNewline: req.finalNewline,
    })

    // ---- ⑥ 原子写：tmp + 同目录 rename ----
    const tmpPath = tmpPathFor(target)
    try {
      await ioWriteFile(tmpPath, bytes)
    } catch (err) {
      await safeUnlink(tmpPath)
      throw wrapIoError(err, req.path)
    }
    try {
      await ioRename(tmpPath, target)
    } catch (err) {
      await safeUnlink(tmpPath)
      throw wrapIoError(err, req.path)
    }

    // ---- ⑦ 登记自写抑制 + 回执 ----
    const revision = fastHash(bytes)
    markSelfWrite(target, revision, deps.now?.() ?? Date.now())

    let mtimeMs = curMtimeMs
    try {
      mtimeMs = (await stat(target)).mtimeMs
    } catch {
      /* stat 失败不致命：回执 mtime 用旧值 */
    }

    return {
      path: req.path,
      bytes: bytes.length,
      revision,
      mtimeMs,
      ...(historyId ? { historyId } : {}),
    }
  })
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch {
    /* 已不存在 */
  }
}

/**
 * 落一份覆盖前快照到 `{root}/.arkwork/history/<id>.snap`。
 * **失败不阻断保存**（TC-WRITE-010）：历史是止损加分项，不是写入的前置条件。
 */
async function writeHistory(root: string, oldHash: string, buf: Buffer): Promise<string | undefined> {
  const id = historyIdFor(oldHash)
  try {
    const dir = historyDirFor(root)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${id}.snap`), buf)
    return id
  } catch {
    return undefined
  }
}

/** 单文件快速哈希（"另存恢复"等场景的校验入口；与 writeText 的 revision 同口径） */
export async function hashFile(absPath: string, root?: string): Promise<string> {
  const target = await assertWritableTarget(absPath, root ?? getWorkspaceDir())
  const buf = await readFile(target)
  return fastHash(buf)
}
