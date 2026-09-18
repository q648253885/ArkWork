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
import { sealGraphForTaskOutcome } from './engine/gates.js'
import { broadcastTaskStatus } from './events.js'
import { maybeGenerateTaskTitle } from './task-title.js'
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

  // v0.31.0 C2：fire-and-forget 生成任务标题（不阻塞主循环；内部自带
  // titleSource 竞态保护与 20s 超时，失败静默保留原标题）。
  void maybeGenerateTaskTitle(taskId)

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
      // v0.32.1（缺陷 D36）：**兜底收口**。
      // runReActLoop 自身的 try/catch 已覆盖绝大多数失败路径（并已封图），
      // 但异常若从它的 catch 块内部再次抛出（如 handleAbort / 收口本身出错），
      // 就只能落到这里。收口是幂等的（无变更即不落盘），因此这层重复调用
      // 只为「绝不留下 task=failed 而 graph=in_progress 的残留」，无额外代价。
      try {
        await sealGraphForTaskOutcome(task, 'failed', `run 异常终止：${message.slice(0, 120)}`)
      } catch {
        /* 收口失败不阻断终态写入 */
      }
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

export async function cancelTask(
  taskId: string,
  opts: { transient?: boolean } = {},
): Promise<void> {
  const controller = controllers.get(taskId)
  if (controller) {
    controllers.delete(taskId)
    controller.abort()
  }
  // v0.30.1 问题②：transient = 仅中止在跑的循环（续聊/放行前的复位）。
  // 此时**不得**写终态：否则会命中 store/tasks 的终态清理，
  // 误删刚登记的待决补丁 / 计划闸门
  // （appendUserMessage → cancelTask('cancelled') → dropGraphPending）。
  // 复位后的状态由调用方（appendUserMessage）以 pending 落库。
  if (opts.transient) return
  const updated = await updateTask(taskId, { status: 'cancelled', completedAt: Date.now() })
  if (updated) broadcastTaskStatus(updated)
  // v0.32.1（缺陷 D36）：取消同样是**任务终态**，图级 status 必须跟着收口。
  //
  // 循环在跑时由 abort.ts 的 cancelled 分支封口；但**没在跑的**任务（如 paused 状态
  // 被取消）没有任何人封口 → 任务 cancelled、图仍 `in_progress`，面板显示「进行中」。
  // 收口幂等：已在跑的场景下这里先封一次，循环随后的收口成为无操作。
  // （「取消后又被继续」不会因此失真 —— 新一轮启动会 reopen 图，见 loop.ts。）
  if (updated) await sealGraphForTaskOutcome(updated, 'cancelled', '任务已取消')
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
      // v0.32.1（缺陷 D36）：崩溃重启修正孤儿任务时同样要封图 —— 否则重启后
      // 任务列表显示「失败」，任务面板里那张图却还挂着「进行中」。
      if (updated) await sealGraphForTaskOutcome(updated, 'failed', '进程异常退出，孤儿任务已修正')
      logger.warn('Agent', `reconcile: orphan running ${task.id} → failed`, task.id)
    } catch (err) {
      logger.warn('Agent', `reconcile fix failed for ${task.id}: ${(err as Error).message}`)
    }
  }
}

export type { Task }
