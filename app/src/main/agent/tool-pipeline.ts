/* ============================================================
 * ArkWork — 工具三段流水线（v0.19.0 M4）
 *
 * 把「确认/审批 → 执行 → 结果后处理」拆为三段，去除 registry.invokeSkill
 * 里 if/else 交织的确认逻辑。pre-execute 返回 approve/deny；
 * deny 时可附带结构化 result（如 shell 命令过长、高危拦截）。
 *
 * 副作用：pre 可能触发 confirm（弹确认）；execute 真正执行工具；
 * post 纯处理（摘要/截断/脱敏）。
 * ============================================================ */
import type { Task } from '@shared/types/task'
import type { Skill } from '@shared/types/agent'

/** 工具执行三段流水线上下文 */
export interface ToolPipelineContext {
  task: Task
  skill: Skill
  args: Record<string, unknown>
  permissionMode: string
}

/** pre-execute 结果：approve 放行；deny 拒绝（可带结构化 result） */
export type PreExecuteOutcome =
  | { verdict: 'approve' }
  | { verdict: 'deny'; reason: string; result?: unknown }

/**
 * pre-execute：风险评估 + 审批。副作用：可能触发 confirm（弹确认）、写审计事件。
 */
export type PreExecute = (ctx: ToolPipelineContext) => Promise<PreExecuteOutcome>

/**
 * execute：真正调用 handler，返回原始结果。副作用：执行工具（读/写文件、跑 shell 等）。
 */
export type Execute = (ctx: ToolPipelineContext) => Promise<unknown>

/**
 * post-execute：结果后处理（截断/摘要/脱敏）。副作用：无（纯处理）。
 */
export type PostExecute = (
  ctx: ToolPipelineContext,
  raw: unknown,
) => Promise<{ result: unknown; summary?: string }>

/**
 * 依序执行三段流水线，返回 { result, summary }。
 * - pre 返回 deny → 不执行 execute，直接用 deny 的 result/summary。
 * - pre 返回 approve → execute → post。
 * 副作用：透传给 pre/execute/post。
 */
export async function runToolPipeline(
  ctx: ToolPipelineContext,
  stages: { pre: PreExecute; execute: Execute; post: PostExecute },
): Promise<{ result: unknown; summary: string }> {
  const outcome = await stages.pre(ctx)
  if (outcome.verdict === 'deny') {
    const reason = outcome.reason || '工具执行被拒绝'
    return { result: outcome.result ?? { error: reason }, summary: reason }
  }
  const raw = await stages.execute(ctx)
  const { result, summary } = await stages.post(ctx, raw)
  return { result, summary: summary ?? '' }
}
