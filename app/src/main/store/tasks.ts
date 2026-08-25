/* ============================================================
 * ArkWork — Task Store
 * 设计文档 §10.1
 *
 * v0.4.0-rev2：tasks.json 跟随 workspaceDir，每个工作区独立任务列表。
 * 旧版 filePath 固定为 arkworkDir/tasks.json，导致不同工作区任务混在同一文件。
 *
 * v0.14.0 Task 1：在读取入口调用 migrateTasks 把 PlanItem 六态规范化（详见 tasks.migrate.ts）。
 *   - 首次 listTasks() 时执行迁移 + 落盘回写（一次性 ≤ 200ms，后续 listTasks 命中缓存）
 *   - 写操作（upsert/delete）后失效缓存
 *   - 迁移幂等，重复执行无副作用
 * ============================================================ */
import { getTasksJsonPath, getWorkspaceDir, JsonCollection, removeTaskDir } from './db.js'
import type { Task, TaskStatus } from '@shared/types/task'
import { generateTaskId } from '@shared/types/task'
import { broadcast } from '../window.js'
import { broadcastTaskStatus } from '../agent/events.js'
import { logger } from '../system/logger.js'
import { getUiLocale, tFor } from '../i18n/messages.js'
import { migrateTasks } from './tasks.migrate.js'

let collection: JsonCollection<Task> | null = null
/**
 * v0.14.0 Task 1：迁移后的内存缓存。null 表示尚未迁移。
 * 写操作（upsert/delete/clear）必须调用 invalidateMigratedCache() 让下次 listTasks 重新落盘。
 */
let migratedCache: Task[] | null = null
/** 缓存对应的工作区目录，用于 resetTaskCollection 后正确失效 */
let migratedCacheWorkspace: string | null = null

function getCollection(): JsonCollection<Task> {
  if (!collection) {
    // 跟随 workspaceDir —— 每个工作区独立 tasks.json，物理隔离避免错乱
    // v0.27.1：路径改走 getTasksJsonPath()（.arkwork/ 隐藏区）
    collection = new JsonCollection<Task>(getTasksJsonPath(), [])
  }
  return collection
}

/**
 * v0.14.0 Task 1：把 collection.upsert / delete / clear 包一层，
 * 写操作后强制失效迁移缓存——下次 listTasks 触发重新读取 + 迁移。
 * 保持外部接口（listTasks / getTask / createTask / ...）签名不变。
 */
async function writeCollection(fn: () => Promise<void>): Promise<void> {
  await fn()
  invalidateMigratedCache()
}

/**
 * 重置 collection 单例。切换工作区时调用，确保后续 getCollection() 重新基于新 workspaceDir 创建。
 * 设计文档 v0.4.0-rev2 §二。
 */
export function resetTaskCollection(): void {
  collection = null
  invalidateMigratedCache()
}

/** v0.14.0 Task 1：写操作后失效迁移缓存，下次 listTasks 重新执行迁移 */
function invalidateMigratedCache(): void {
  migratedCache = null
  migratedCacheWorkspace = null
}

/**
 * v0.14.0 Task 1：启动期一次性迁移（≤ 200ms）。
 * 命中缓存直接返回；未命中则读取 tasks.json → migrateTasks → 落盘回写 → 缓存。
 * 落盘回写策略：仅当检测到迁移变更时才写文件（migratedCount > 0），避免无变更时 IO 开销。
 */
async function loadMigratedTasks(): Promise<Task[]> {
  const ws = getWorkspaceDir()
  if (migratedCache && migratedCacheWorkspace === ws) return migratedCache
  const raw = await getCollection().list()
  const { tasks, migratedCount } = migrateTasks(raw)
  if (migratedCount > 0) {
    // 仅在发生迁移时回写 tasks.json，避免无变更时频繁落盘
    try {
      await getCollection().clear()
      await getCollection().upsertMany(tasks)
      logger.info('System', `tasks: migrated ${migratedCount} record(s) on load`)
    } catch (err) {
      // 回写失败不影响内存中的迁移结果；下次启动会再尝试
      logger.warn('System', `tasks: migrate persist failed: ${(err as Error).message}`)
    }
  }
  migratedCache = tasks
  migratedCacheWorkspace = ws
  return tasks
}

export async function listTasks(): Promise<Task[]> {
  const tasks = await loadMigratedTasks()
  return tasks.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * v0.15.1：列出所有 status='running' 的任务。
 * 启动时 reconcile 使用：扫描 DB 中残留 running 但内存无 controller 的"孤儿"任务，
 * 由 boot 链路修正为 failed，避免 UI 卡死。
 */
export async function listRunningTasks(): Promise<Task[]> {
  const all = await listTasks()
  return all.filter((t) => t.status === 'running')
}

export async function getTask(id: string): Promise<Task | null> {
  const tasks = await loadMigratedTasks()
  return tasks.find((t) => t.id === id) ?? null
}

export interface CreateTaskInput {
  title: string
  text: string
  agentId: string
  skillIds?: string[]
  mcpIds?: string[]
  modelId?: string
  config?: Task['config']
  /** 由自动化触发的任务来源标记（侧边栏据此显示来源图标） */
  automationId?: string
}

/**
 * 标题去重：若 title 已存在于 existingTitles，追加数字后缀（"新任务" → "新任务 2" → "新任务 3"…）。
 * 设计文档 v0.4.0-rev1 §三。放在后端权威层，保证所有调用方一致去重。
 */
function dedupeTitle(title: string, existingTitles: string[]): string {
  if (!existingTitles.includes(title)) return title
  let n = 2
  while (existingTitles.includes(`${title} ${n}`)) n++
  return `${title} ${n}`
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const existing = await listTasks()
  // v0.4.0-rev1：标题去重——同名任务自动累加数字后缀
  // polish-workspace-task-title-skills-context-help §Task 1.4：前端已传 simplifyFirstLine(text)；
  // 后端不再依赖 input.text 截断兜底；空 title 占位「未命名任务」。
  const existingTitles = existing.map((t) => t.title)
  const finalTitle = dedupeTitle(input.title || tFor(getUiLocale(), 'tasks.untitled'), existingTitles)
  // v0.4.0-rev2：ID 用日期+随机后缀，不再用 existing.length+1（删除任务后会重复导致覆盖）
  const id = generateTaskId()
  const now = Date.now()
  const task: Task = {
    id,
    // workspaceId 保留字段（兼容类型），但实际工作区隔离由 workspaceDir 文件路径决定
    workspaceId: 'default',
    title: finalTitle,
    status: 'pending',
    agentId: input.agentId,
    skillIds: input.skillIds ?? [],
    mcpIds: input.mcpIds ?? [],
    // v0.4.0：移除 'gpt-4o-mini' 硬编码 fallback——必须由调用方传入有效 modelId
    modelId: input.modelId || '',
    input: {
      text: input.text,
    },
    config: input.config ?? { maxIterations: 60 },
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    parentTaskId: null,
    tags: [],
    starred: false,
    automationId: input.automationId,
  }
  await writeCollection(() => getCollection().upsert(task))
  logger.info('System', `task created: ${task.id} "${task.title}"`)

  // v0.4.0-rev4：当 input.text 非空时（如 sendMessage 无任务路径），把用户消息
  // 和 system_prompt 写入 L1。engine 不再负责注入 user_message，此处保证首次运行有输入。
  // input.text 为空时（点"新建任务"创建空任务）不写入，等用户后续输入时由 appendUserMessage 写入。
  if (input.text.trim() !== '') {
    const { appendL1 } = await import('../memory/l1-working.js')
    const { getAgent } = await import('./agents.js')
    const agent = await getAgent(input.agentId)
    if (agent) {
      await appendL1({
        taskId: id,
        role: 'system',
        kind: 'system_prompt',
        content: agent.systemPrompt,
        enabled: true,
      })
    }
    await appendL1({
      taskId: id,
      role: 'user',
      kind: 'user_message',
      content: input.text,
      enabled: true,
    })
  }

  broadcast('task:list-changed', null)
  return task
}

export async function updateTask(
  id: string,
  patch: Partial<Task>,
): Promise<Task> {
  const existing = await getTask(id)
  if (!existing) throw new Error(`Task not found: ${id}`)
  const updated: Task = {
    ...existing,
    ...patch,
    id: existing.id,
    updatedAt: Date.now(),
  }
  await writeCollection(() => getCollection().upsert(updated))
  return updated
}

export async function updateTaskStatus(
  id: string,
  status: TaskStatus,
): Promise<Task | null> {
  const patch: Partial<Task> = { status }
  if (status === 'running' ) patch.startedAt = Date.now()
  if (status === 'done' || status === 'failed' || status === 'cancelled') patch.completedAt = Date.now()
  return updateTask(id, patch)
}

/**
 * 追加用户消息：把用户输入写入 L1，重置任务状态为 pending，准备再次运行。
 *
 * 写入顺序的设计意图（B3）：
 *   1. 先 appendL1（持久化用户输入——本地优先应用中用户消息是最重要数据，优先落盘）
 *   2. 再 updateTask 重置状态为 pending
 * 若第 2 步失败：L1 已写入新消息（不丢失），任务状态虽未重置但引擎续聊时会从
 * L1 最大 iteration 继续，仍可恢复；同时本函数抛错由前端 friendlyError 展示，
 * 用户可手动重试。此顺序比"先改状态再写 L1"更安全——后者在崩溃窗口会丢失用户输入。
 */
export async function appendUserMessage(taskId: string, text: string): Promise<Task | null> {
  const task = await getTask(taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  // 动态导入避免循环依赖（l1-working → window → tasks）
  const { appendL1 } = await import('../memory/l1-working.js')
  await appendL1({
    taskId,
    role: 'user',
    kind: 'user_message',
    content: text,
    enabled: true,
  })

  // v0.16.7+：续聊路径竞态修复——
  // 1. 先调 cancelTask 清掉内存 controllers（如果上一次 run 还在 await 返回中），
  //    避免后续 runTask 被 `already running` 吞掉导致 user_message 写进 L1 但引擎不重跑。
  // 2. 清零所有"上一次运行"的痕迹字段（startedAt / completedAt / errorMessage），
  //    让前端任务区不会显示"已完成"假象。
  // 3. 把任务状态置回 pending。
  // 4. 立即调 runTask 触发新一轮 ReAct 循环。
  try {
    const { cancelTask } = await import('../agent/runner.js')
    await cancelTask(taskId)
  } catch (err) {
    // cancel 失败不阻塞后续流程
    logger.warn('System', `appendUserMessage: cancelTask skipped: ${(err as Error).message}`, taskId)
  }

  const updated = await updateTask(taskId, {
    status: 'pending',
    startedAt: null,
    completedAt: null,
    errorMessage: undefined,
  })
  if (updated) broadcastTaskStatus(updated)

  // v0.16.7+：内部自动 run，避免 renderer 串行 appendMessage + run 因竞态漏触发。
  // runTask 内部会再次做 controllers.has(taskId) 检查并清理残 controller，幂等安全。
  try {
    const { runTask } = await import('../agent/runner.js')
    void runTask(taskId)
  } catch (err) {
    logger.warn('System', `appendUserMessage: runTask skipped: ${(err as Error).message}`, taskId)
  }

  return updated
}

export async function deleteTask(id: string): Promise<void> {
  await writeCollection(() => getCollection().delete(id))
  await removeTaskDir(id)
  broadcast('task:list-changed', null)
  logger.info('System', `task deleted: ${id}`)
}

/**
 * 启动时回收「意外中断」的任务：上次进程退出时仍在 running 的任务，
 * 引擎已不存在，状态是虚假的。统一标记为 cancelled（completedAt 落盘），
 * 前端据此显示「重新执行」按钮，而不是卡在暂停/中止上。
 * v0.14.0 Task 9：paused 任务**不**回收——paused 是用户主动暂停且已写入
 * checkpoint（pause/manager.ts），重启后保留为 paused、可随时恢复续跑。
 * 仅在应用冷启动时调用一次（macOS 关窗不触发，正在跑的任务不受影响）。
 */
export async function reconcileStaleTasks(): Promise<number> {
  const tasks = await listTasks()
  let fixed = 0
  for (const t of tasks) {
    if (t.status === 'running') {
      await updateTask(t.id, { status: 'cancelled', completedAt: Date.now() })
      fixed++
    }
  }
  if (fixed > 0) {
    broadcast('task:list-changed', null)
    logger.info('System', `reconciled ${fixed} interrupted task(s) to cancelled`)
  }
  return fixed
}

export async function setTaskStarred(id: string, starred: boolean): Promise<Task | null> {
  return updateTask(id, { starred })
}
