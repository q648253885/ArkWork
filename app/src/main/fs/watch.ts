/* ============================================================
 * ArkWork — Main: FS Watch（chokidar 生命周期 + 批次聚合 + 来源归因）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §3.1 / §4.3.4 / §5.2 / §6.4 / §7.3
 *
 * 核心决策：**chokidar 是唯一感知通道**（03-interaction 已定）。
 *  - 「通道覆盖性」由 chokidar 保证：任何磁盘变更（外部脚本 / git / 云盘 / 人手）都会到；
 *  - 「归因精度」由两张登记表增强（write.ts 自写抑制 + agent-writes.ts agent 归因），
 *    登记缺失只降级（origin='external'），**不丢事件**（TC-WATCH-006）。
 *
 * 纯度纪律：本模块**不 import electron** —— 广播函数由 IPC 层注入
 * （`startWatching({ broadcast })`），node:test 可直连密闭断言（TC-WATCH 全组）。
 *
 * 与 §6.4 文档草图的实现偏差（语义不变，仅拆分）：
 *  草图把两张登记表都画在 watch.ts；实装里自写表随原子写落在 write.ts
 *  （`markSelfWrite` 在写入成功点登记，离写入最近），本模块经
 *  `peekSelfWrite` 消费 —— 两表仍只做归因/抑制，不做事件上报。
 * ============================================================ */
import chokidar, { type FSWatcher } from 'chokidar'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ignoredByWatch, listWorkspacePaths } from './paths.js'
import { fastHashFile } from './text.js'
import { peekSelfWrite } from './write.js'
import { isAgentWrite } from './agent-writes.js'
import { getUiLocale, tFor } from '../i18n/messages.js'
import { FsError } from '@shared/utils/fs-error'
import { logger } from '../system/logger.js'
import type { FsBatchEntry, FsBatchEvent, WatchState } from '@shared/types/fs'

/* ------------------------------------------------------------
 * 常量（TC-WATCH-001 / 007 / 011 / 012 契约固化；调整须同步用例）
 * ---------------------------------------------------------- */

/** 批次聚合窗口：窗口内所有事件合并为一批（正本 U3：P1 零新增依赖做性能） */
export const BATCH_WINDOW_MS = 200

/** awaitWriteFinish：大文件写入稳定阈值（不等待会读到半个文件并触发无意义重载） */
export const WATCH_AWAIT_CONFIG: Readonly<{
  stabilityThreshold: number
  pollInterval: number
}> = { stabilityThreshold: 250, pollInterval: 100 }

/** 批次历史保留上限（诊断用，不无界增长；TC-WATCH-012） */
export const RECENT_BATCHES_LIMIT = 20

/** ready 事件超时：超过即判定初始化失败（E_WATCH_INIT，禁止静默降级 —— 正本 A18） */
export const WATCH_READY_TIMEOUT_MS = 15_000

/* ------------------------------------------------------------
 * 状态（模块级单例：一个工作区根一份监听）
 * ---------------------------------------------------------- */

interface PendingBatch {
  added: Set<string>
  changed: Set<string>
  removed: Set<string>
}

let watcher: FSWatcher | null = null
let watchState: WatchState = 'idle'
let watchRoot = ''
let nextBatchId = 1
let broadcastFn: ((e: FsBatchEvent) => void) | null = null
let flushTimer: NodeJS.Timeout | null = null
let windowMs = BATCH_WINDOW_MS
const pending: PendingBatch = { added: new Set(), changed: new Set(), removed: new Set() }
const recentBatches: FsBatchEvent[] = []

/* ------------------------------------------------------------
 * 内部：事件记账（去重合并规则）
 * ---------------------------------------------------------- */

function noteAdded(path: string): void {
  // 同窗口内「删除后重建」净效果 = 变更（编辑器视角：文件回来了，内容大概率不同）
  if (pending.removed.has(path)) {
    pending.removed.delete(path)
    pending.changed.add(path)
  } else {
    pending.added.add(path)
    pending.changed.delete(path) // added 优先于 changed（新文件的多段写入不再报 change）
  }
  scheduleFlush()
}

function noteChanged(path: string): void {
  if (!pending.added.has(path)) pending.changed.add(path)
  scheduleFlush()
}

function noteUnlink(path: string): void {
  pending.added.delete(path) // 窗口内「新建即删」净效果 = 无（不进批次）
  pending.changed.delete(path)
  pending.removed.add(path)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, windowMs)
}

/* ------------------------------------------------------------
 * 内部：批次落定（自写抑制 + 归因 + 广播）
 * ---------------------------------------------------------- */

/** flush 串行化：哈希读盘是异步的，防止窗口重叠期间两个 flush 交错发批 */
let flushChain: Promise<void> = Promise.resolve()

function flush(): Promise<void> {
  flushChain = flushChain.then(() => doFlush())
  return flushChain
}

async function doFlush(): Promise<void> {
  if (pending.added.size === 0 && pending.changed.size === 0 && pending.removed.size === 0) return

  const added: FsBatchEntry[] = []
  const changed: FsBatchEntry[] = []
  const removed: FsBatchEntry[] = []
  let suppressed = 0
  const now = Date.now()

  // 自写回环抑制（TC-WATCH-004/005）：命中登记且磁盘 hash 与登记相等 → 丢弃。
  // 只对「文件还在磁盘上」的条目可判（removed 无从取 hash，恒不抑制）。
  const survivesSelfWrite = async (path: string): Promise<boolean> => {
    const marked = peekSelfWrite(path, now)
    if (marked === null) return true
    try {
      const st = await stat(path)
      const diskHash = await fastHashFile(path, st.size)
      if (diskHash === marked) return false
    } catch {
      /* 读盘失败（正被删除等）：按未抑制处理，宁广播勿丢 */
    }
    return true
  }

  for (const path of pending.added) {
    if (!(await survivesSelfWrite(path))) {
      suppressed++
      continue
    }
    added.push({ path, origin: isAgentWrite(path, now) ? 'agent' : 'external' })
  }
  for (const path of pending.changed) {
    if (!(await survivesSelfWrite(path))) {
      suppressed++
      continue
    }
    changed.push({ path, origin: isAgentWrite(path, now) ? 'agent' : 'external' })
  }
  for (const path of pending.removed) {
    removed.push({ path, origin: 'external' })
  }

  pending.added.clear()
  pending.changed.clear()
  pending.removed.clear()

  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    if (suppressed > 0) {
      logger.debug('Tool', `fs:batch window fully self-suppressed (${suppressed} entries)`)
    }
    return
  }

  const event: FsBatchEvent = {
    batchId: nextBatchId++,
    ts: now,
    root: watchRoot,
    added,
    changed,
    removed,
  }
  recentBatches.push(event)
  if (recentBatches.length > RECENT_BATCHES_LIMIT) {
    recentBatches.splice(0, recentBatches.length - RECENT_BATCHES_LIMIT)
  }
  logger.debug(
    'Tool',
    `fs:batch #${event.batchId} +${added.length} ~${changed.length} -${removed.length}` +
      (suppressed > 0 ? ` (self-suppressed ${suppressed})` : ''),
  )
  try {
    broadcastFn?.(event)
  } catch (err) {
    // 广播失败（窗口已关）静默：沿用 llm-stream.ts 既有纪律（§7.3，不重试不报错）
    logger.debug('Tool', `fs:batch broadcast failed: ${(err as Error).message}`)
  }
}

/* ------------------------------------------------------------
 * 生命周期
 * ---------------------------------------------------------- */

export interface WatchStartOptions {
  /** 工作区根（缺省 getWorkspaceDir 的值由 IPC 层填入；本模块不直接读 store） */
  root: string
  /** 批次广播函数（IPC 层注入 window.broadcast('fs:batch')；测试注入收集器） */
  broadcast: (e: FsBatchEvent) => void
  /** 测试钩子：缩短聚合窗口（生产恒为 BATCH_WINDOW_MS） */
  windowMs?: number
  /** 测试钩子：替换 awaitWriteFinish 配置（生产恒为 WATCH_AWAIT_CONFIG） */
  awaitWriteFinish?: false | { stabilityThreshold: number; pollInterval: number }
  /** 测试钩子：替换 watcher 工厂（注入抛错以覆盖 E_WATCH_INIT 分支） */
  spawnWatcher?: (root: string, opts: WatchSpawnConfig) => FSWatcher
}

/** chokidar.watch 的完整入参形状（spawnWatcher 注入的契约） */
export interface WatchSpawnConfig {
  ignored: (absPath: string) => boolean
  ignoreInitial: boolean
  awaitWriteFinish: false | { stabilityThreshold: number; pollInterval: number }
}

function defaultSpawnWatcher(root: string, opts: WatchSpawnConfig): FSWatcher {
  return chokidar.watch(root, opts)
}

/**
 * 启动监听。返回 `{ root, initial }`——`initial.added` 为全量首快照
 * （`ignoreInitial: true` 的语义由该字段显式承载，TC-WATCH-008）。
 *
 * 失败（watcher 工厂抛错 / ready 超时）→ `E_WATCH_INIT`（TC-WATCH-009：
 * 前端据此进「手动刷新模式」横幅，**禁止静默降级成现状**）。
 * 已有活跃监听时先停再启（换根重启，语义干净）。
 */
export async function startWatching(opts: WatchStartOptions): Promise<{
  root: string
  initial: FsBatchEvent
}> {
  const root = resolve(opts.root)
  if (watcher !== null) await stopWatching()

  watchState = 'starting'
  watchRoot = root
  broadcastFn = opts.broadcast
  windowMs = opts.windowMs ?? BATCH_WINDOW_MS
  pending.added.clear()
  pending.changed.clear()
  pending.removed.clear()
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const spawn = opts.spawnWatcher ?? defaultSpawnWatcher
  const spawnConfig: WatchSpawnConfig = {
    ignored: (absPath: string) => ignoredByWatch(absPath, root),
    ignoreInitial: true,
    awaitWriteFinish: opts.awaitWriteFinish ?? WATCH_AWAIT_CONFIG,
  }

  let w: FSWatcher
  try {
    w = spawn(root, spawnConfig)
  } catch (err) {
    watchState = 'failed'
    const message = (err as Error).message
    logger.error('Tool', `watch init failed: ${message}`)
    throw new FsError(
      'E_WATCH_INIT',
      tFor(getUiLocale(), 'fs.watchInitFailed', { message }),
      { root, cause: message },
    )
  }
  watcher = w
  wireWatcherEvents(w)

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        cleanup()
        rejectReady(
          new FsError(
            'E_WATCH_INIT',
            tFor(getUiLocale(), 'fs.watchInitFailed', { message: `ready timeout > ${WATCH_READY_TIMEOUT_MS}ms` }),
            { root, cause: 'ready-timeout' },
          ),
        )
      }, WATCH_READY_TIMEOUT_MS)
      const cleanup = (): void => {
        clearTimeout(timer)
        w.removeListener('ready', onReady)
        w.removeListener('error', onError)
      }
      const onReady = (): void => {
        cleanup()
        resolveReady()
      }
      const onError = (err: Error): void => {
        cleanup()
        rejectReady(
          new FsError(
            'E_WATCH_INIT',
            tFor(getUiLocale(), 'fs.watchInitFailed', { message: err.message }),
            { root, cause: err.message },
          ),
        )
      }
      w.once('ready', onReady)
      w.once('error', onError)
    })
  } catch (err) {
    watchState = 'failed'
    await safelyClose(w)
    watcher = null
    throw err
  }

  // 运行期错误：不崩溃、不静默——状态置 failed 供 fs:watch-status 拉取（横幅 + 重试）
  w.on('error', (err) => {
    if (watchState === 'active') {
      watchState = 'failed'
      logger.error('Tool', `watch runtime error: ${(err as Error).message}`)
    }
  })

  // 全量首快照（ignoreInitial:true → 初始文件不产生事件，由本字段显式承载）
  const list = await listWorkspacePaths(root)
  watchState = 'active'
  logger.info('Tool', `watch active: ${root} (${list.files.length} files, truncated=${list.truncated})`)
  return {
    root,
    initial: {
      batchId: nextBatchId++,
      ts: Date.now(),
      root,
      added: list.files.map((f) => ({ path: f.path, origin: 'external' as const })),
      changed: [],
      removed: [],
    },
  }
}

/** 停止监听并清空未落定的窗口（幂等） */
export async function stopWatching(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending.added.clear()
  pending.changed.clear()
  pending.removed.clear()
  const w = watcher
  watcher = null
  broadcastFn = null
  if (w !== null) await safelyClose(w)
  watchState = 'idle'
}

/** 查询监听态（失败横幅的「重试」用；§5.2） */
export function watchStatus(): WatchState {
  return watchState
}

/** 诊断用：最近批次（≤ RECENT_BATCHES_LIMIT 条，不无界增长；TC-WATCH-012） */
export function getRecentBatches(): readonly FsBatchEvent[] {
  return recentBatches
}

/** 测试隔离用 */
export function resetWatchStateForTest(): void {
  recentBatches.length = 0
  nextBatchId = 1
}

/** 事件接线（startWatching 内部调用；导出供测试对裸 watcher 直连） */
export function wireWatcherEvents(w: FSWatcher): void {
  w.on('add', (path: string) => noteAdded(path))
  w.on('change', (path: string) => noteChanged(path))
  w.on('unlink', (path: string) => noteUnlink(path))
}

async function safelyClose(w: FSWatcher): Promise<void> {
  try {
    await w.close()
  } catch {
    /* 已关闭 */
  }
}
