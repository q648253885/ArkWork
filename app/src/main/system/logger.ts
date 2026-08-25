/* ============================================================
 * ArkWork — Main Process Logger
 * 设计文档 §5.5 / §8.4
 * ============================================================ */
import { join } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getArkworkDir, relativeToWorkspace } from '../store/db.js'
import type { LogEntry } from '@shared/types/ipc'
import { broadcast } from '../window.js'

const LOG_FILE = () => join(getArkworkDir(), 'logs.jsonl')

const inMemory: LogEntry[] = []
const MAX_INMEMORY = 500

type Level = LogEntry['level']
type Source = LogEntry['source']

function log(level: Level, source: Source, message: string, taskId?: string): void {
  const entry: LogEntry = {
    ts: Date.now(),
    level,
    source,
    message,
    taskId,
  }

  // 推入内存环形
  inMemory.push(entry)
  if (inMemory.length > MAX_INMEMORY) inMemory.splice(0, inMemory.length - MAX_INMEMORY)

  // 控制台输出
  const ts = new Date(entry.ts).toISOString().slice(11, 23)
  const tag = `[${source.padEnd(7)}]`
  // eslint-disable-next-line no-console
  console.log(`${ts} ${tag} ${message}`)

  // 持久化（异步不阻塞）
  void persist(entry)

  // 广播给所有窗口
  broadcast('log:append', entry)
}

async function persist(entry: LogEntry): Promise<void> {
  try {
    if (!existsSync(LOG_FILE())) {
      await mkdir(join(LOG_FILE(), '..'), { recursive: true })
    }
    await appendFile(LOG_FILE(), JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // 静默失败：日志不能拖垮主流程
  }
}

export const logger = {
  debug: (source: Source, message: string, taskId?: string) => log('DEBUG', source, message, taskId),
  info: (source: Source, message: string, taskId?: string) => log('INFO', source, message, taskId),
  warn: (source: Source, message: string, taskId?: string) => log('WARN', source, message, taskId),
  error: (source: Source, message: string, taskId?: string) => log('ERROR', source, message, taskId),
}

export function listLogs(taskId?: string): Promise<LogEntry[]> {
  if (taskId) {
    return Promise.resolve(inMemory.filter((e) => e.taskId === taskId))
  }
  return Promise.resolve([...inMemory])
}

export { relativeToWorkspace }
