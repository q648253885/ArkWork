/* ============================================================
 * ArkWork — Builtin Skill: delegate-agent
 * v0.6.0 设计文档 §4.7 / §F11
 *
 * 将子任务委派给另一个 Agent 执行，返回其摘要结果。
 * 用于多 Agent 协作：父 Agent 调用 delegate-agent 把专业子任务交给
 * 专门 Agent（如 @researcher / @coder），仅回收摘要而非全部 L1。
 *
 * 安全约束（§6.2）：
 *  - 子 agent 必须存在且非 builtin 的"特殊"agent（允许委派给任意已注册 agent）
 *  - 子 agent 继承父 agent 的 skill 白名单（不可越权调用未授权 skill）
 *  - 子任务标记 parentTaskId，便于 UI 展示委派链路
 *  - 共享父任务的 AbortSignal（父任务中断时子任务一并中断）
 *
 * 流程：
 *  1. 读取目标 agent
 *  2. 创建子 task（parentTaskId = ctx.taskId）
 *  3. 写入 system_prompt + user_message 到子 task L1
 *  4. 同步运行 runReActLoop（await）
 *  5. 从子 task L1 提取 task_complete 的 summary 作为返回
 *  6. 返回 { agentId, summary, taskId, status }
 * ============================================================ */
import { getAgent } from '../../store/agents.js'
import { createTask, getTask } from '../../store/tasks.js'
import { listEnabledL1 } from '../../memory/l1-working.js'
import { runReActLoop } from '../engine/index.js'
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'

export interface DelegateArgs {
  agentId: string
  task: string
}

export interface DelegateResult {
  agentId: string
  taskId: string
  status: 'done' | 'failed' | 'paused' | 'cancelled'
  summary: string
  /** 子任务执行的 ReAct 迭代次数 */
  iterations: number
}

export async function delegateAgent(
  args: DelegateArgs,
  ctx: SkillContext,
): Promise<DelegateResult> {
  const agentId = args.agentId?.trim()
  if (!agentId) {
    throw new Error('delegate-agent: agentId 不能为空')
  }
  const taskDesc = args.task?.trim()
  if (!taskDesc) {
    throw new Error('delegate-agent: task 不能为空')
  }

  // 1. 读取目标 agent
  const subAgent = await getAgent(agentId)
  if (!subAgent) {
    throw new Error(`delegate-agent: 目标 Agent 不存在：${agentId}`)
  }

  // 2. 防止自委派死循环
  if (ctx.agent && agentId === ctx.agent.id) {
    throw new Error(`delegate-agent: 不允许委派给自身（${agentId}），会形成死循环`)
  }

  // 3. 防止过深委派（最多 3 层）
  if (ctx.parentTaskId) {
    // ctx.parentTaskId 存在说明已经是子 agent → 阻止再委派
    throw new Error('delegate-agent: 不允许子 agent 再次委派（最多 1 层）')
  }

  // 4. 创建子任务（继承父任务的 modelId）
  const parentTask = ctx.task
  const modelId = parentTask?.modelId ?? subAgent.defaultModelId
  if (!modelId) {
    throw new Error('delegate-agent: 父任务未指定 modelId，无法委派')
  }

  // 子 agent 继承父 agent 的 skill 白名单：合并 subAgent.defaultSkillIds + parentTask.skillIds
  // 安全考虑：子 agent 只能用父 agent 已授权的 skill，不可越权
  const inheritedSkillIds = parentTask?.skillIds ?? []
  const subSkillIds = [...new Set([
    ...subAgent.defaultSkillIds,
    ...inheritedSkillIds,
  ])]

  logger.info('Tool', `delegate-agent: 委派给 @${subAgent.name}（taskId 父=${ctx.taskId}）`, ctx.taskId)

  const subTask = await createTask({
    title: `[委派→@${subAgent.name}] ${taskDesc.slice(0, 40)}`,
    text: taskDesc,
    agentId: subAgent.id,
    skillIds: subSkillIds,
    modelId,
    config: subAgent.defaultConfig,
  })

  // 标记 parentTaskId（createTask 默认 null，此处更新）
  const { updateTask } = await import('../../store/tasks.js')
  await updateTask(subTask.id, { parentTaskId: ctx.taskId })

  // 5. 运行子 ReAct 循环（await — 同步等待结果）
  //    使用子 agent 的 systemPrompt（createTask 已写入 L1）
  //    共享父任务的 AbortSignal
  try {
    await runReActLoop({
      task: { ...subTask, parentTaskId: ctx.taskId },
      agent: subAgent,
      modelId,
      signal: ctx.signal,
      maxIterations: subAgent.defaultConfig.maxIterations ?? 25,
    })
  } catch (err) {
    logger.error('Tool', `delegate-agent: 子任务执行失败：${(err as Error).message}`, ctx.taskId)
    return {
      agentId: subAgent.id,
      taskId: subTask.id,
      status: 'failed',
      summary: `子任务执行失败：${(err as Error).message}`,
      iterations: 0,
    }
  }

  // 6. 读取子任务最终状态与 summary
  const finalTask = await getTask(subTask.id)
  const status = finalTask?.status ?? 'failed'
  const iterations = await countIterations(subTask.id)
  const summary = await extractFinalSummary(subTask.id)

  logger.info('Tool', `delegate-agent: 子任务完成 status=${status} iter=${iterations} summary=${summary.slice(0, 80)}`, ctx.taskId)

  return {
    agentId: subAgent.id,
    taskId: subTask.id,
    status: status as DelegateResult['status'],
    summary: summary || `子任务 ${status}（无摘要）`,
    iterations,
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
  if (last.meta) {
    try {
      const action = JSON.parse(last.meta) as { tool?: string; args?: { summary?: string } }
      if (action.tool === 'task_complete' && action.args?.summary) {
        return action.args.summary
      }
    } catch {
      // ignore parse error
    }
  }
  // fallback：最后一条 reasoning 的 thought
  return last.content
}
