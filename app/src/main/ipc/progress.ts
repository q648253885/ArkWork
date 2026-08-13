/* ============================================================
 * ArkWork — IPC: Task Progress Persistence (Task 9)
 *
 * 任务侧边栏进度摘要独立持久化到 .arkwork/cache/task-progress.json，
 * 避免页面切换或重启后进度丢失。
 *
 *  - progress:save    → 单条覆盖式写入（fire-and-forget）
 *  - progress:load    → 启动时一次性读取全部（返回 Record<taskId, TaskProgress>）
 *
 * 设计要点：
 *  - 工作区隔离：缓存文件写在 {workspaceDir}/.arkwork/cache/ 下，
 *    与其它 cache（e.g. router-eval.jsonl）共用同一目录；切换工作区时
 *    自然隔离（不跨工作区读取，避免污染进度视图）。
 *  - 原子写入：先写临时文件再 rename，避免读取到半写状态。
 *  - 写入失败静默：进度摘要是辅助 UI，不应阻塞任务执行；仅 log warn。
 * ============================================================ */
import { ipcMain } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { getWorkspaceDir } from '../store/db.js'
import { logger } from '../system/logger.js'
import type { TaskProgress } from '@shared/types/progress'

/** 进度缓存文件名（位于 {workspaceDir}/.arkwork/cache/） */
const CACHE_FILE_NAME = 'task-progress.json'

/** 获取当前工作区的进度缓存文件路径 */
function progressFile(): string {
  return join(getWorkspaceDir(), '.arkwork', 'cache', CACHE_FILE_NAME)
}

/** 确保 cache 目录存在（首次写入前调用） */
async function ensureCacheDir(): Promise<void> {
  const dir = dirname(progressFile())
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/** 读取全部进度（返回 Record<taskId, TaskProgress>；文件不存在返回空对象） */
async function readAll(): Promise<Record<string, TaskProgress>> {
  const path = progressFile()
  if (!existsSync(path)) return {}
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, TaskProgress>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    logger.warn('Agent', `progress cache read failed: ${(err as Error).message}`)
    return {}
  }
}

/** 原子写入（先 tmp 再 rename） */
async function writeAll(map: Record<string, TaskProgress>): Promise<void> {
  await ensureCacheDir()
  const path = progressFile()
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** 注册进度相关 IPC handler */
export function registerProgressHandlers(): void {
  // 单条覆盖式写入（Renderer 频繁调用；做 lock 串行化避免并发 Lost Update）
  let writeChain: Promise<unknown> = Promise.resolve()
  ipcMain.handle(
    'task:progress-save',
    async (_e, payload: { taskId: string; progress: TaskProgress }) => {
      const next = writeChain.then(async () => {
        try {
          const map = await readAll()
          map[payload.taskId] = payload.progress
          await writeAll(map)
        } catch (err) {
          logger.warn('Agent', `task:progress-save failed: ${(err as Error).message}`, payload.taskId)
        }
      })
      writeChain = next.catch(() => {})
      await next
    },
  )

  // 启动时一次性读取（Renderer 在 init() 调用）
  ipcMain.handle('task:progress-load', async () => {
    return readAll()
  })
}
