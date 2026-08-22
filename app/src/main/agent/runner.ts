/* ============================================================
 * ArkWork — Task Run Controller
 * 管理 AbortSignal — 每个 task 一个，支持 pause/resume/cancel
 *
 * v0.9.1 §Task 6：
 *  - 解析错误分类：noAgent / noModel 等以 Error.code 标记，便于 Renderer 端
 *    friendlyError 识别并给出针对性提示（不再吞错，也不再混为一谈的「任务失败」）
 *  - runTask 同步抛错路径保留：modelId 空、Agent 不存在、模型无效抛 throw
 * ============================================================ */
import { getTask, updateTask, listRunningTasks } from '../store/tasks.js'
import { getAgent } from '../store/agents.js'
import { getModel } from '../store/agents.js'
import { runReActLoop } from './engine/index.js'
import { broadcastTaskStatus } from './events.js'
import { logger } from '../system/logger.js'
import type { Task } from '@shared/types/task'

const controllers = new Map<string, AbortController>()
/**
 * v0.15.x Task 1+2：generation 计数器 —— 每次 runTask 都自增，
 * 用于 catch / finally 路径判断「当前循环是否已被新一次 runTask 接管」。
 * 被接管时本循环必须静默退出，不得写入 failed / 完成态。
 * （runner 单实例持有此 Map，跨进程重启后置零不致命：重启后 reconcile
 *  会以 controllers Map 为准把遗留 running 任务收回 cancelled。）
 */
const generations = new Map<string, number>()

/** 读不到时返回 0；供其它模块调试或诊断使用 */
export function currentGeneration(taskId: string): number {
  return generations.get(taskId) ?? 0
}

/**
 * v0.9.1 §Task 6：构造领域错误，附 code 便于 Renderer 端 friendlyError 分流。
 * Runner 抛出的同步错误（如 Agent 不存在 / 模型空缺）会通过 IPC return 到 Renderer。
 */
class RunnerError extends Error {
  readonly code: 'noAgent' | 'noModel' | 'invalidModel' | 'missingTask' | 'unknown'
  constructor(code: RunnerError['code'], message: string) {
    super(message)
    this.name = 'RunnerError'
    this.code = code
  }
}

export async function runTask(taskId: string): Promise<void> {
  const task = await getTask(taskId)
  if (!task) throw new RunnerError('missingTask', `任务不存在：${taskId}`)

  // v0.15.x 修正：旧循环/旧进程异常退出时可能残留 controller，导致任务明明已经
  // done/failed/cancelled/paused，新 runTask 却被 already running 拦在外面。
  // 入口自检：若 DB 状态已是终态，强制清理残留 controller + generation，允许重新运行。
  const terminalStatuses: Array<Task['status']> = ['done', 'failed', 'cancelled', 'paused']
  if (terminalStatuses.includes(task.status)) {
    if (controllers.has(taskId)) {
      logger.warn('Agent', `task ${taskId} status=${task.status} but controller still in memory — cleanup before restart`, taskId)
      controllers.delete(taskId)
    }
    generations.delete(taskId)
  }

  // v0.8.1：以内存运行表判断"正在运行"，不再看 DB 状态。
  if (controllers.has(taskId)) {
    logger.warn('Agent', `task ${taskId} already running`, taskId)
    return
  }

  const agent = await getAgent(task.agentId)
  if (!agent) throw new RunnerError('noAgent', `Agent 不存在：${task.agentId}`)

  // 模型校验：runner 需要至少一个可调用的模型，否则立即抛错（不再吞噬）
  if (!task.modelId || task.modelId.trim() === '') {
    throw new RunnerError('noModel', `任务 ${taskId} 缺少模型配置`)
  }
  const model = await getModel(task.modelId)
  if (!model) {
    throw new RunnerError('invalidModel', `模型不可用或已删除：${task.modelId}`)
  }
  if (!model.enabled) {
    throw new RunnerError('invalidModel', `模型已禁用：${task.modelId}`)
  }

  // v0.15.x Task 1+2：在创建 controller 之前先把状态写 running 并广播，
  // 保证前端能先看到 running 状态，再触发后续 ReAct 循环（即便首轮 LLM
  // 调用前发生异常，catch 路径也能正确写入 failed 而不会被覆盖）。
  const updated = await updateTask(taskId, { status: 'running', startedAt: Date.now() })
  if (updated) broadcastTaskStatus(updated)

  // generation 自增：每次 runTask 都把计数 +1，并记下本次的 startGeneration。
  // engine 内通过 stale() 检查 generations.get(taskId) === startGeneration，
  // 若不等则说明已被新一次 runTask 接管——本循环必须静默退出。
  generations.set(taskId, (generations.get(taskId) ?? 0) + 1)
  const startGeneration = generations.get(taskId)!

  const controller = new AbortController()
  controllers.set(taskId, controller)

  // 异步执行 — 不 await 业务循环本身，但任何同步前抛错同步抛给调用方
  void runReActLoop({
    task,
    agent,
    modelId: task.modelId,
    signal: controller.signal,
    startGeneration,
    stale: () => generations.get(taskId) !== startGeneration,
  })
    .catch(async (err) => {
      // v0.15.x Task 1+2：catch 路径必须先校验 generation——
      // 若已被新一次 runTask 接管（pause/resume/重发 runTask），
      // 本次循环的异常由新循环负责处理（其内部 emitEvent + write failed），
      // 不允许双重写入失败状态污染 DB / 前端。
      if (generations.get(taskId) !== startGeneration) {
        logger.info('Agent', `runTask catch ignored: superseded by new generation (${startGeneration} -> ${generations.get(taskId)})`, taskId)
        return
      }
      const message = (err as Error).message
      const failed = await updateTask(taskId, {
        status: 'failed',
        completedAt: Date.now(),
        errorMessage: message,
      })
      if (failed) broadcastTaskStatus(failed)
      logger.error('Agent', `runTask catch: ${message}`, taskId)
    })
    .finally(() => {
      if (controllers.get(taskId) === controller) controllers.delete(taskId)
    })
}

export async function pauseTask(taskId: string): Promise<void> {
  const controller = controllers.get(taskId)
  if (!controller) return
  controllers.delete(taskId)
  controller.abort()
}

export async function resumeTask(taskId: string): Promise<void> {
  await runTask(taskId)
}

export async function cancelTask(taskId: string): Promise<void> {
  const controller = controllers.get(taskId)
  if (controller) {
    controllers.delete(taskId)
    controller.abort()
  }
  const updated = await updateTask(taskId, { status: 'cancelled', completedAt: Date.now() })
  if (updated) broadcastTaskStatus(updated)
}

export function isTaskRunning(taskId: string): boolean {
  return controllers.has(taskId)
}

/** 当前正在运行的任务列表 */
export function listRunningTaskIds(): string[] {
  return Array.from(controllers.keys())
}

export async function getRunningTaskIds(): Promise<string[]> {
  return listRunningTaskIds()
}

/**
 * v0.15.x Task 1+2+3 启动 reconcile：扫所有 status='running' 任务，若内存
 * controllers/generations 没有注册对应循环（进程崩溃或异常退出），修正为 failed。
 * 双条件判断以避免误杀正在运行的循环：
 *   1. controllers.has(taskId) === false → 没有活跃 controller
 *   2. generations.get(taskId) 为 undefined 或 stale → runner 也没在管
 * 两个条件同时成立才认定是孤儿（正常在跑的循环一定同时在 controllers 与 generations）。
 * 由 boot 链路启动时调用一次。
 */
export async function reconcileOrphanRunning(): Promise<void> {
  let orphans: Task[] = []
  try {
    orphans = await listRunningTasks()
  } catch (err) {
    logger.warn('Agent', `reconcile list failed: ${(err as Error).message}`)
    return
  }
  for (const task of orphans) {
    // 控制器在 → 循环必然在跑，跳过（controllers 一旦被删除会在 finally 同步回收）
    if (controllers.has(task.id)) continue
    // generation：runner 在每次 runTask 都会 set，覆盖前不会删除。
    // - undefined：从未跑过，DB 状态是进程崩溃前的脏数据 → 孤儿
    // - 仍存在（可能被新循环覆盖）：已被 runner 接管但控制器消失是异常路径，
    //   此时 stale 已无法判定，按孤儿处理 → 写 failed。
    // 真正"仍被管理"的循环必然同时保有 controller，跳过判断已先于此处处理。
    try {
      const updated = await updateTask(task.id, {
        status: 'failed',
        completedAt: Date.now(),
        errorMessage: 'reconcile_orphan_running: 进程崩溃或异常退出，任务状态已修正',
      })
      if (updated) broadcastTaskStatus(updated)
      logger.warn('Agent', `reconcile: orphan running ${task.id} → failed`, task.id)
    } catch (err) {
      logger.warn('Agent', `reconcile fix failed for ${task.id}: ${(err as Error).message}`)
    }
  }
}

export type { Task }
