/* ============================================================
 * ArkWork — Builtin Skill: delegate-agent（v0.36.0 F4.1 并行化重写）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §3.6
 *
 * 将一个或多个子任务并行委派给其他 Agent 执行，返回各子任务摘要结果。
 * 用于多 Agent 协作：父 Agent 调用 delegate-agent 把专业子任务交给
 * 专门 Agent（如 @researcher / @coder），仅回收摘要而非全部 L1。
 *
 * v0.36.0 并行语义：
 *  - targets 数组：并发上限 4（Semaphore），失败隔离（单目标失败不拖垮整批）
 *  - 兼容旧单对象 {agentId, task} 形态（自动包裹为单元素 targets）
 *  - 每个子任务独立 AbortController：支持单卡取消（cancelDelegateChild），
 *    父任务中断时全部子任务级联中断
 *  - 生命周期进度事件 task:subagent-progress 广播到父任务
 *    （queued → running → 终态），渲染层据此维护并行组卡（P5 五态）
 *
 * 安全约束（§6.2，逐目标生效）：
 *  - 子 agent 必须存在；不允许自委派（死循环）
 *  - 防过深委派（最多 1 层：子 agent 不再委派）
 *  - 子 agent 继承父 agent 的 skill 白名单（不可越权调用未授权 skill）
 *  - 子任务标记 parentTaskId，便于 UI 展示委派链路
 * ============================================================ */
import { getAgent } from '../../store/agents.js'
import { createTask, getTask } from '../../store/tasks.js'
import { listEnabledL1 } from '../../memory/l1-working.js'
import { runReActLoop } from '../engine/index.js'
import { emitEvent } from '../engine/broadcast.js'
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'
import type { SubagentRunStatus } from '@shared/types/react.js'
// v0.44.1（D219）：工具名孪生拼写比较（读侧容错，见 shared/utils/tool-name.ts）
import { sameToolName } from '@shared/utils/tool-name'

/** 委派目标（新形态） */
export interface DelegateTarget {
  agentId: string
  objective: string
}

export interface DelegateArgs {
  /** 并行委派目标列表；兼容旧单对象 {agentId, task}（自动包裹） */
  targets?: DelegateTarget | DelegateTarget[]
  /**
   * @deprecated v0.36.0 前的单目标形态（`{agentId, task}`）。
   * 保留仅为兼容存量调用方与模型旧输出 —— 运行时会被自动包裹为单元素 targets。
   */
  agentId?: string
  /** @deprecated v0.36.0 前的单目标形态（见 agentId） */
  task?: string
}

/** 单个委派目标的结果（与入参 targets 同序） */
export interface DelegateItemResult {
  agentId: string
  agentName: string
  /** 校验失败未建子任务时为 null */
  taskId: string | null
  objective: string
  status: 'done' | 'failed' | 'paused' | 'cancelled'
  summary: string
  /** 子任务执行的 ReAct 迭代次数 */
  iterations: number
  durationMs: number
}

export interface DelegateResult {
  results: DelegateItemResult[]
}

/* ============================================================
 * 并发闸（内联实现：峰值并发 = limit，FIFO 唤醒）
 * ============================================================ */
class Semaphore {
  private active = 0
  private waiters: Array<() => void> = []
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

/** 并发上限（设计 §3.6：默认 4） */
const MAX_PARALLEL = 4

/* ============================================================
 * 活跃子任务注册表：childTaskId → 子 AbortController
 * 供「单卡取消」IPC（task:cancel-subagent）按 childTaskId 精确中断。
 * ============================================================ */
const activeChildren = new Map<string, AbortController>()

export function cancelDelegateChild(childTaskId: string): boolean {
  const ctrl = activeChildren.get(childTaskId)
  if (!ctrl) return false
  ctrl.abort()
  return true
}

/* ============================================================
 * 测试注入口：替换 runReActLoop 实现（引擎假体）。
 * 生产代码不调用；仅 delegate-parallel.test.ts 使用。
 * ============================================================ */
type RunLoopFn = typeof runReActLoop
let runLoopImpl: RunLoopFn = runReActLoop
export function __setDelegateEngineForTests(fn: RunLoopFn | null): void {
  runLoopImpl = fn ?? runReActLoop
}

/* ---------------- 进度事件（静默失败：不得打断委派主流程） ---------------- */
async function emitSubagentProgress(
  parentTaskId: string,
  payload: {
    childTaskId: string
    agentId: string
    agentName?: string
    objective?: string
    modelId?: string
    status: SubagentRunStatus
    stepSummary?: string
    durationMs?: number
  },
): Promise<void> {
  try {
    await emitEvent(parentTaskId, {
      type: 'task:subagent-progress',
      iteration: 0,
      parentTaskId,
      ...payload,
    })
  } catch (err) {
    logger.warn('Tool', `delegate-agent: 进度事件发射失败（静默）：${(err as Error).message}`, parentTaskId)
  }
}

/**
 * 委派入口：targets 数组并行（上限 4），失败隔离。
 * 校验失败（agent 不存在 / 自委派 / 过深）按 per-target failed 返回，不 throw 整批；
 * 整批级错误（空 targets / 全空白 objective）才 throw。
 */
export async function delegateAgent(
  args: DelegateArgs,
  ctx: SkillContext,
): Promise<DelegateResult> {
  /* ---------- 入参归一（兼容旧单对象 {agentId, task}） ---------- */
  const legacy = args as unknown as { targets?: unknown; agentId?: unknown; task?: unknown }
  let rawTargets: Array<{ agentId?: unknown; objective?: unknown; task?: unknown }>
  if (Array.isArray(legacy.targets)) {
    rawTargets = legacy.targets as Array<{ agentId?: unknown; objective?: unknown; task?: unknown }>
  } else if (legacy.targets && typeof legacy.targets === 'object') {
    rawTargets = [legacy.targets as { agentId?: unknown; objective?: unknown }]
  } else if (typeof legacy.agentId === 'string' && typeof legacy.task === 'string') {
    // 旧单对象兼容
    rawTargets = [{ agentId: legacy.agentId, objective: legacy.task }]
  } else {
    throw new Error('delegate-agent: targets 不能为空')
  }
  if (rawTargets.length === 0) {
    throw new Error('delegate-agent: targets 不能为空')
  }
  const targets = rawTargets.map((t) => ({
    agentId: typeof t.agentId === 'string' ? t.agentId.trim() : '',
    objective:
      typeof (t as { objective?: unknown }).objective === 'string'
        ? ((t as { objective: string }).objective ?? '').trim()
        : typeof (t as { task?: unknown }).task === 'string'
          ? (t as { task: string }).task.trim()
          : '',
  }))
  // 全空白 objective → 整批 throw；部分空白 → per-target failed
  if (targets.every((t) => !t.objective)) {
    throw new Error('delegate-agent: 所有委派目标均缺少任务描述（objective）')
  }

  /* ---------- 父级前置：modelId（无法解析则整批不可运行） ---------- */
  const parentTask = ctx.task
  const modelId = parentTask?.modelId
  if (!modelId) {
    throw new Error('delegate-agent: 父任务未指定 modelId，无法委派')
  }

  /* ---------- 并行执行（失败隔离：单目标校验/运行失败不拖垮整批） ---------- */
  const sem = new Semaphore(MAX_PARALLEL)
  const settled = await Promise.allSettled(
    targets.map((t) => sem.run(() => runOneTarget(t, ctx, modelId))),
  )
  const results: DelegateItemResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value
    // runOneTarget 内部已捕获预期错误；此处兜底非预期异常（编程错误不静默）
    logger.error('Tool', `delegate-agent: 目标 ${targets[i]!.agentId} 非预期异常：${String(s.reason)}`, ctx.taskId)
    return {
      agentId: targets[i]!.agentId,
      agentName: targets[i]!.agentId,
      taskId: null,
      objective: targets[i]!.objective,
      status: 'failed',
      summary: `委派失败：${String((s.reason as Error)?.message ?? s.reason)}`,
      iterations: 0,
      durationMs: 0,
    }
  })
  return { results }
}

/** 单目标执行（校验失败 → per-target failed；永不 throw） */
async function runOneTarget(
  t: { agentId: string; objective: string },
  ctx: SkillContext,
  modelId: string,
): Promise<DelegateItemResult> {
  const startedAt = Date.now()
  const parentTaskId = ctx.taskId
  const objective = t.objective
  const preflightId = `delegate-preflight-${parentTaskId}-${t.agentId}`
  const elapsed = () => Date.now() - startedAt
  const fail = (taskId: string | null, summary: string, agentName?: string): DelegateItemResult => ({
    agentId: t.agentId,
    agentName: agentName ?? t.agentId,
    taskId,
    objective,
    status: 'failed',
    summary,
    iterations: 0,
    durationMs: elapsed(),
  })

  /**
   * 本目标的进度发射器（预绑定目标级稳定字段）。
   * 为什么预绑定：agentId / objective / modelId 在整个目标生命周期内不变，
   * 七处调用各自重复一遍就是漂移源 —— 漏一处即"某个状态缺模型徽标"。
   */
  const emit = (p: {
    childTaskId: string
    status: SubagentRunStatus
    agentName?: string
    stepSummary?: string
    durationMs?: number
  }): Promise<void> =>
    emitSubagentProgress(parentTaskId, { ...p, agentId: t.agentId, objective, modelId })

  // 空白 objective → per-target failed
  if (!objective) {
    return fail(null, 'delegate-agent: 委派目标缺少任务描述（objective）')
  }

  // 1. 目标 agent 存在性
  const subAgent = await getAgent(t.agentId)
  if (!subAgent) {
    const summary = `delegate-agent: 目标 Agent 不存在：${t.agentId}`
    await emit({ childTaskId: preflightId, status: 'failed', stepSummary: summary, durationMs: elapsed() })
    return fail(null, summary)
  }

  // 2. 防自委派死循环
  if (ctx.agent && subAgent.id === ctx.agent.id) {
    const summary = `delegate-agent: 不允许委派给自身（${subAgent.id}），会形成死循环`
    await emit({
      childTaskId: preflightId,
      agentName: subAgent.name,
      status: 'failed',
      stepSummary: summary,
      durationMs: elapsed(),
    })
    return fail(null, summary, subAgent.name)
  }

  // 3. 防过深委派（最多 1 层）
  if (ctx.parentTaskId) {
    const summary = 'delegate-agent: 不允许子 agent 再次委派（最多 1 层）'
    await emit({
      childTaskId: preflightId,
      agentName: subAgent.name,
      status: 'failed',
      stepSummary: summary,
      durationMs: elapsed(),
    })
    return fail(null, summary, subAgent.name)
  }

  // 4. 父任务已中止 → 不建子任务，直接 cancelled
  if (ctx.signal.aborted) {
    const summary = '父任务已中断，子任务未创建'
    await emit({
      childTaskId: preflightId,
      agentName: subAgent.name,
      status: 'cancelled',
      stepSummary: summary,
      durationMs: elapsed(),
    })
    return {
      agentId: subAgent.id,
      agentName: subAgent.name,
      taskId: null,
      objective,
      status: 'cancelled',
      summary,
      iterations: 0,
      durationMs: elapsed(),
    }
  }

  // 5. 子 agent 继承父 agent 的 skill 白名单（去重）：不可越权
  //    取 ctx.task（父任务）的 skillIds —— 父任务声明的白名单即子 agent 的上限。
  const inheritedSkillIds = ctx.task?.skillIds ?? []
  const subSkillIds = [...new Set([...subAgent.defaultSkillIds, ...inheritedSkillIds])]

  // 6. 创建子任务（标题沿用「模型产物」语义：objective 来自父任务 LLM）
  const subTask = await createTask({
    title: `[委派→@${subAgent.name}] ${objective.slice(0, 40)}`,
    text: objective,
    agentId: subAgent.id,
    skillIds: subSkillIds,
    modelId,
    config: subAgent.defaultConfig,
    titleSource: 'llm',
  })
  const { updateTask } = await import('../../store/tasks.js')
  await updateTask(subTask.id, { parentTaskId })

  // 7. 独立 AbortController：父中断级联 → 子中断；单卡取消走注册表
  const childCtrl = new AbortController()
  const onParentAbort = () => childCtrl.abort()
  ctx.signal.addEventListener('abort', onParentAbort, { once: true })
  // 挂监听后二次确认（check 与 attach 之间的窗口竞态）
  if (ctx.signal.aborted) childCtrl.abort()

  // queued 生命周期事件（子任务已创建、排队等待信号量）
  await emit({ childTaskId: subTask.id, agentName: subAgent.name, status: 'queued' })

  logger.info('Tool', `delegate-agent: 委派给 @${subAgent.name}（子任务=${subTask.id}，父=${parentTaskId}）`, parentTaskId)

  try {
    activeChildren.set(subTask.id, childCtrl)
    // running 生命周期事件（进入执行段）
    await emit({ childTaskId: subTask.id, agentName: subAgent.name, status: 'running' })

    try {
      await runLoopImpl({
        task: { ...subTask, parentTaskId },
        agent: subAgent,
        modelId,
        signal: childCtrl.signal,
        maxIterations: subAgent.defaultConfig.maxIterations ?? 25,
      })
    } catch (err) {
      // 级联取消与运行失败语义分离
      if (childCtrl.signal.aborted) {
        logger.info('Tool', `delegate-agent: 子任务已取消（${subTask.id}）`, parentTaskId)
      } else {
        logger.error('Tool', `delegate-agent: 子任务执行失败：${(err as Error).message}`, parentTaskId)
      }
    }
  } finally {
    ctx.signal.removeEventListener('abort', onParentAbort)
    activeChildren.delete(subTask.id)
  }

  // 8. 读取子任务终态与 summary（运行中残留 → 按中止态归一）
  const finalTask = await getTask(subTask.id)
  const rawStatus = finalTask?.status ?? 'failed'
  const status: DelegateItemResult['status'] =
    rawStatus === 'done' || rawStatus === 'failed' || rawStatus === 'paused' || rawStatus === 'cancelled'
      ? rawStatus
      : childCtrl.signal.aborted
        ? 'cancelled'
        : 'failed'
  const iterations = await countIterations(subTask.id)
  const summary = await extractFinalSummary(subTask.id)
  const durationMs = elapsed()

  const displaySummary =
    status === 'cancelled' && !summary
      ? `子任务已取消（${subTask.id}）`
      : summary || `子任务 ${status}（无摘要）`

  // 终态生命周期事件（携带摘要 + 时长）
  const progressStatus: SubagentRunStatus =
    status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'failed'
  await emit({
    childTaskId: subTask.id,
    agentName: subAgent.name,
    status: progressStatus,
    stepSummary: displaySummary.slice(0, 200),
    durationMs,
  })

  logger.info(
    'Tool',
    `delegate-agent: 子任务完成 status=${status} iter=${iterations} summary=${displaySummary.slice(0, 80)}`,
    parentTaskId,
  )

  return {
    agentId: subAgent.id,
    agentName: subAgent.name,
    taskId: subTask.id,
    objective,
    status,
    summary: displaySummary,
    iterations,
    durationMs,
  }
}

/** 统计子任务的 ReAct 迭代次数（L1 中最大 iteration） */
async function countIterations(taskId: string): Promise<number> {
  const items = await listEnabledL1(taskId)
  return items.reduce((max, m) => Math.max(max, m.iteration), 0)
}

/**
 * 从子任务 L1 提取最终摘要：
 *  - 优先找 task_complete 的 summary（在 reasoning 的 action.meta 中）
 *  - 其次找最后一条 reasoning 的 thought
 *  - 都没有则返回空串
 */
async function extractFinalSummary(taskId: string): Promise<string> {
  const items = await listEnabledL1(taskId)
  // 按 iteration 降序找最后一条 reasoning
  const reasonings = items
    .filter((m) => m.role === 'assistant' && m.kind === 'reasoning')
    .sort((a, b) => b.iteration - a.iteration)
  if (reasonings.length === 0) return ''
  const last = reasonings[0]
  // 若 meta 中是 task_complete action，提取 summary
  // v0.44.1（D219）：孪生拼写容错 —— 旧 L1 meta 可能存有模型原始拼写（`task-complete`），
  // 正名精确匹配会漏掉子任务已写好的 summary
  if (last.meta) {
    try {
      const action = JSON.parse(last.meta) as { tool?: string; args?: { summary?: string } }
      if (sameToolName(action.tool, 'task_complete') && action.args?.summary) {
        return action.args.summary
      }
    } catch {
      // ignore parse error
    }
  }
  // fallback：最后一条 reasoning 的 thought
  return last.content
}
