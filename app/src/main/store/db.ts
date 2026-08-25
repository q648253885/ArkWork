/* ============================================================
 * ArkWork — JSON File Store
 * 用 JSON 文件持久化 Task / Agent / Skill / Model 等，避免 better-sqlite3 原生编译开销（v1 简化方案）
 * 设计文档 §8.6 列出的 SQLite 在 v2 切换
 * ============================================================ */
import { app } from 'electron'
import { mkdir, readFile, writeFile, rm, copyFile, unlink, rename } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

let arkworkDir = ''
let workspaceDir = ''

/** ArkWork 应用数据根目录：~/Library/Application Support/ArkWork (macOS) */
export function getArkworkDir(): string {
  if (!arkworkDir) {
    arkworkDir = join(app.getPath('userData'), 'arkwork-data')
  }
  return arkworkDir
}

/** 当前工作区目录（用户可切换） */
export function getWorkspaceDir(): string {
  if (!workspaceDir) {
    workspaceDir = join(getArkworkDir(), 'workspace', 'default')
  }
  return workspaceDir
}

export function setWorkspaceDir(path: string): void {
  workspaceDir = path
}

/**
 * 任务工作目录：{workspaceDir}/.arkwork/tasks/{taskId}/
 * v0.27.1：迁入隐藏区——任务数据不再以明面 tasks/ 目录暴露在工作区根下，
 * 统一收纳进 .arkwork/（与 memory/kb/checkpoints 同域），文件树 IPC 对
 * .arkwork 整体忽略，对用户不可见。
 */
export function getTaskDir(taskId: string): string {
  return join(getWorkspaceDir(), '.arkwork', 'tasks', taskId)
}

/** 任务索引文件：{workspaceDir}/.arkwork/tasks.json（v0.27.1 起隐藏化） */
export function getTasksJsonPath(): string {
  return join(getWorkspaceDir(), '.arkwork', 'tasks.json')
}

/** 任务 L1 记忆目录：{workspaceDir}/.arkwork/memory/{taskId}/ */
export function getTaskMemoryDir(taskId: string): string {
  return join(getWorkspaceDir(), '.arkwork', 'memory', taskId)
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true })
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    if (!existsSync(path)) return fallback
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    console.error(`[store] failed to read ${path}:`, err)
    return fallback
  }
}

async function writeJson<T>(path: string, data: T): Promise<void> {
  await ensureDir(dirname(path))
  // v0.6.5 修复：原子写入——先写临时文件再 rename，防止并发读写时读到空文件
  // 导致 readJson 返回 fallback []，进而丢失全部已有数据
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** 通用集合存储 — 单文件 JSON 数组 */
export class JsonCollection<T extends { id: string }> {
  constructor(private readonly filePath: string, private readonly seed: T[] = []) {}

  // v0.6.5 修复：互斥锁——串行化 read-modify-write 操作，防止并发 upsert/delete
  // 导致后写入者覆盖前者的结果（Lost Update），进而丢失 task 记录
  private writeChain: Promise<unknown> = Promise.resolve()

  /** 串行化读-改-写操作 */
  private async runExclusive<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.writeChain.then(fn, fn)
    this.writeChain = next.catch(() => {})
    return next
  }

  async list(): Promise<T[]> {
    const data = await readJson<unknown>(this.filePath, this.seed)
    // v0.17.x 防御：tasks.json 可能被 Agent 误写为对象（如自建的清单 JSON），
    // 此时 readJson 会成功 parse 出非数组对象，导致调用方 items.findIndex 抛
    // "items.findIndex is not a function"。这里把非数组统一回退到 seed，避免崩溃。
    if (!Array.isArray(data)) {
      console.error(`[store] ${this.filePath} 不是 JSON 数组（可能被误写为对象），已回退到 seed`)
      return this.seed
    }
    return data as T[]
  }

  async get(id: string): Promise<T | null> {
    const items = await this.list()
    return items.find((x) => x.id === id) ?? null
  }

  async upsert(item: T): Promise<void> {
    await this.runExclusive(async () => {
      const items = await this.list()
      const idx = items.findIndex((x) => x.id === item.id)
      if (idx >= 0) items[idx] = item
      else items.push(item)
      await writeJson(this.filePath, items)
    })
  }

  async upsertMany(newItems: T[]): Promise<void> {
    await this.runExclusive(async () => {
      const items = await this.list()
      for (const item of newItems) {
        const idx = items.findIndex((x) => x.id === item.id)
        if (idx >= 0) items[idx] = item
        else items.push(item)
      }
      await writeJson(this.filePath, items)
    })
  }

  async delete(id: string): Promise<void> {
    await this.runExclusive(async () => {
      const items = await this.list()
      const next = items.filter((x) => x.id !== id)
      await writeJson(this.filePath, next)
    })
  }

  async clear(): Promise<void> {
    await this.runExclusive(async () => {
      await writeJson(this.filePath, this.seed)
    })
  }
}

/** 单文件 JSON 对象存储 */
export class JsonDoc<T> {
  constructor(private readonly filePath: string, private readonly fallback: T) {}

  async read(): Promise<T> {
    return readJson<T>(this.filePath, this.fallback)
  }

  async write(data: T): Promise<void> {
    await writeJson(this.filePath, data)
  }

  async patch(patch: Partial<T>): Promise<T> {
    const current = await this.read()
    const next = { ...current, ...patch }
    await this.write(next)
    return next
  }
}

/** JSONL 行存储 — L1 Memory 等需要追加写入的场景 */
export class JsonlCollection<T extends { id: string }> {
  constructor(private readonly filePath: string) {}

  async list(): Promise<T[]> {
    if (!existsSync(this.filePath)) return []
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T)
    } catch (err) {
      console.error(`[store] failed to read jsonl ${this.filePath}:`, err)
      return []
    }
  }

  async append(item: T): Promise<void> {
    await ensureDir(dirname(this.filePath))
    await writeFile(this.filePath, JSON.stringify(item) + '\n', { flag: 'a' })
  }

  async appendMany(items: T[]): Promise<void> {
    if (items.length === 0) return
    await ensureDir(dirname(this.filePath))
    const block = items.map((i) => JSON.stringify(i)).join('\n') + '\n'
    await writeFile(this.filePath, block, { flag: 'a' })
  }

  async rewrite(items: T[]): Promise<void> {
    await ensureDir(dirname(this.filePath))
    const block = items.map((i) => JSON.stringify(i)).join('\n') + '\n'
    await writeFile(this.filePath, block, 'utf-8')
  }

  async delete(id: string): Promise<void> {
    const items = await this.list()
    const next = items.filter((x) => x.id !== id)
    await this.rewrite(next)
  }
}

/** 初始化存储目录 */
export async function initStore(): Promise<void> {
  await ensureDir(getArkworkDir())
  await ensureDir(join(getArkworkDir(), 'config'))
  await ensureDir(getWorkspaceDir())
  await ensureDir(join(getWorkspaceDir(), '.arkwork', 'tasks'))
  await ensureDir(join(getWorkspaceDir(), '.arkwork', 'memory'))
  await ensureDir(join(getWorkspaceDir(), 'shared'))
  // v0.4.0-rev2 迁移：把旧全局 tasks.json 搬到 default 工作区目录
  await migrateLegacyTasksJson()
  // v0.27.1 迁移：把明面的 tasks.json / tasks/ 收进隐藏区 .arkwork/
  await migrateTaskDataIntoHidden()
}

/**
 * v0.4.0-rev2 迁移：旧版 tasks.json 在 arkworkDir/tasks.json（全局共享），
 * 新版每工作区独立 tasks.json。首次启动时把旧文件搬到 default 工作区目录，
 * 避免用户丢失已有任务。仅当 default 工作区下没有 tasks.json 且旧文件存在时执行。
 */
async function migrateLegacyTasksJson(): Promise<void> {
  const legacy = join(getArkworkDir(), 'tasks.json')
  // 只在 default 工作区（workspaceDir 未被 activateWorkspace 改过）执行迁移
  const isDefault = getWorkspaceDir().endsWith(join('workspace', 'default'))
  if (!isDefault) return
  const target = join(getWorkspaceDir(), 'tasks.json')
  if (!existsSync(legacy) || existsSync(target)) return
  try {
    await copyFile(legacy, target)
    await unlink(legacy)
    console.log('[store] migrated legacy tasks.json to default workspace')
  } catch (err) {
    console.error('[store] migrate tasks.json failed:', err)
  }
}

/**
 * v0.27.1 迁移：任务数据隐藏化——把工作区根下明面的 tasks.json 与 tasks/
 * 目录搬进 .arkwork/ 隐藏区。幂等：目标已存在时以隐藏区版本为准并丢弃旧文件；
 * 单项失败仅记录告警，不阻断启动（下次启动重试剩余项）。
 */
async function migrateTaskDataIntoHidden(): Promise<void> {
  const legacyJson = join(getWorkspaceDir(), 'tasks.json')
  const targetJson = getTasksJsonPath()
  // 1) tasks.json：优先搬移；两份并存时隐藏区为准，删除旧文件
  if (existsSync(legacyJson)) {
    try {
      if (!existsSync(targetJson)) {
        await mkdir(dirname(targetJson), { recursive: true })
        await rename(legacyJson, targetJson)
        console.log('[store] moved tasks.json into .arkwork/')
      } else {
        await unlink(legacyJson)
        console.log('[store] legacy visible tasks.json dropped (hidden copy exists)')
      }
    } catch (err) {
      console.warn('[store] migrate visible tasks.json failed:', err)
    }
  }
  // 2) tasks/{id}/ 子目录逐个搬入 .arkwork/tasks/
  const legacyDir = join(getWorkspaceDir(), 'tasks')
  if (!existsSync(legacyDir)) return
  let children: string[] = []
  try {
    children = readdirSync(legacyDir)
  } catch (err) {
    console.warn('[store] read legacy tasks dir failed:', err)
    return
  }
  for (const child of children) {
    const from = join(legacyDir, child)
    const to = getTaskDir(child)
    try {
      if (!existsSync(to)) {
        await mkdir(dirname(to), { recursive: true })
        await rename(from, to)
      } else {
        // 同名冲突：隐藏区已有该任务目录（更新版本语义），丢弃旧目录
        await rm(from, { recursive: true, force: true })
      }
    } catch (err) {
      console.warn(`[store] migrate task dir ${child} failed:`, err)
    }
  }
  // 3) 清空后移除遗留的明面 tasks/ 目录
  try {
    if (existsSync(legacyDir) && readdirSync(legacyDir).length === 0) {
      await rm(legacyDir, { recursive: true, force: true })
      console.log('[store] removed empty visible tasks/ dir (moved into .arkwork/)')
    }
  } catch (err) {
    console.warn('[store] cleanup visible tasks dir failed:', err)
  }
}

export async function ensureWorkspace(): Promise<void> {
  await initStore()
}

/** 删除任务工作目录 */
export async function removeTaskDir(taskId: string): Promise<void> {
  const taskDir = getTaskDir(taskId)
  const memDir = getTaskMemoryDir(taskId)
  if (existsSync(taskDir)) await rm(taskDir, { recursive: true, force: true })
  if (existsSync(memDir)) await rm(memDir, { recursive: true, force: true })
}

/** 解析为相对于工作区的路径（用于显示） */
export function relativeToWorkspace(absolute: string): string {
  const ws = resolve(getWorkspaceDir())
  if (absolute.startsWith(ws)) {
    return absolute.slice(ws.length + 1)
  }
  return absolute
}
