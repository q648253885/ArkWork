/* ============================================================
 * v0.14.0 Task 5.6 / 5.7 / 5.8 — 5 档防御链路编排器
 *
 * 入口：runFaultTolerant(toolCall, ctx) → FaultDecisionOutcome
 *
 * 链路（严格按 spec）：
 *  ① retry ≤3 次（1s/2s/4s 指数退避）→ 成功 done
 *  ② 替代方案自动执行（来自 findAlternative）→ 成功 done（备注）
 *  ③ LLM 因果分析（analyzeImpact，10s 超时 fallback 规则版）
 *  ④ 影响后续则 pushFaultCard 等用户决策
 *  ⑤ 不影响后续则 markFailed(planItem) + continue
 *  - LLM 致命异常（llm-fatal）：task:interrupt + 任务置 failed
 *
 * 不主动暂停：除上面 llm-fatal 分支外，链路不会 throw 给外层「主动暂停」。
 * 编排器对外暴露抛出的两类异常：
 *  - 'llm-fatal' : 任务级致命错误（不应继续）
 *  - 'exhausted' : 全部 5 档走完仍失败（已标记 planItem，调用方继续）
 * ============================================================ */

import type { SkillContext } from '../agent/registry.js'
import { broadcast } from '../window.js'
import type { LlmAdapter } from '../llm/adapter.js'
import { getUiLocale, tFor } from '../i18n/messages.js'

// 把 invokeSkill 间接化（便于单测替换；默认通过 dynamic import 加载，避免模块加载期触发整条静态依赖链）
type InvokeSkillFn = (skillId: string, args: Record<string, unknown>, ctx: SkillContext) => Promise<{ result: unknown; summary: string }>
let _invokeSkillOverride: InvokeSkillFn | null = null
/** 仅测试暴露：替换 invokeSkill 桩 */
export function __setInvokeSkillForTest(fn: InvokeSkillFn | null): void {
  _invokeSkillOverride = fn
}

async function defaultInvokeSkill(skillId: string, args: Record<string, unknown>, ctx: SkillContext): Promise<{ result: unknown; summary: string }> {
  const { invokeSkill } = await import('../agent/registry.js')
  return invokeSkill(skillId, args, ctx)
}
import type {
  FaultDecisionOutcome,
  FaultError,
  FaultTolerantCtx,
  RetryResult,
  SkillMatch,
  SkillRegistry,
} from './types.js'
import { classifyError, isFaultError } from './classify.js'
import { retryWithBackoff, DEFAULT_BACKOFF_MS, DEFAULT_MAX_ATTEMPTS } from './retry-with-backoff.js'
import { findAlternative } from './alternative-skill-matcher.js'
import { analyzeImpact } from './impact-analyzer.js'
import { pushFaultCard, logFaultDecision } from './notify.js'

export interface RunFaultTolerantOptions {
  /** Skill 注册表（默认使用 agent/registry.listSkills） */
  registry?: SkillRegistry
  /** LLM 适配层（注入便于单测） */
  adapter?: LlmAdapter
  /** 模型 id（用于影响分析） */
  modelId?: string
  /** markFailed 写入同步器（默认通过事件总线广播 planItem:status） */
  onPlanItemFailed?: (planItemId: string, taskId: string, note?: string) => Promise<void> | void
  /** 重试配置覆盖 */
  retry?: { maxAttempts?: number; backoffMs?: number[] }
}

/**
 * 5 档链路主入口。
 *
 * @param toolCall 实际工具调用（toolName + args + SkillContext）。返回 T。
 * @param ctx 任务上下文（taskId / planItem / followingPlanItems / signal）
 * @param opts 注入依赖（registry / adapter / onPlanItemFailed）。便于单测。
 */
export async function runFaultTolerant<T = unknown>(
  toolCall: (args: FaultTolerantCtx['toolCall']) => Promise<T>,
  ctx: FaultTolerantCtx,
  opts: RunFaultTolerantOptions = {},
): Promise<FaultDecisionOutcome> {
  const { toolName, args } = ctx.toolCall
  const onPlanItemFailed = opts.onPlanItemFailed ?? defaultMarkPlanItemFailed
  const registry = opts.registry ?? defaultRegistry

  /* ---------------- 0. 早期守卫：signal 中断 ---------------- */
  if (ctx.signal?.aborted) {
    return { outcome: 'cancelled', fault: { code: 'aborted', message: tFor(getUiLocale(), 'fault.preAborted'), originalKind: 'unknown', toolName } }
  }

  /* ---------------- ① 重试（≤3 次指数退避） ---------------- */
  let retryResult: RetryResult<T> | null = null
  let finalError: FaultError | null = null
  try {
    retryResult = await retryWithBackoff<T>(
      () => toolCall({ toolName, args }),
      {
        maxAttempts: opts.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        backoffMs: opts.retry?.backoffMs ?? Array.from(DEFAULT_BACKOFF_MS),
        signal: ctx.signal,
        onAttempt: (n, err) => {
          // 推 task:progress 让 UI 显示「重试中」
          broadcast('task:progress', {
            taskId: ctx.taskId,
            tool: toolName,
            phase: 'retry',
            attempt: n,
            error: err.message,
            ts: Date.now(),
          })
        },
      },
    )
    return { outcome: 'retry-succeeded', value: retryResult.value }
  } catch (raw) {
    finalError = isFaultError(raw) ? raw : classifyError(raw)

    // 5.7：LLM 致命异常 → 广播 task:interrupt + 任务置 failed，不走 5 档
    if (finalError.originalKind === 'llm-fatal') {
      broadcast('task:interrupt', {
        taskId: ctx.taskId,
        reason: finalError.message,
        code: finalError.code,
        ts: Date.now(),
      })
      return { outcome: 'llm-fatal', fault: finalError }
    }

    // 不可重试 → 跳过替代之前的重试（仍走 ②③）
    // 跳过外层 if
  }

  /* ---------------- ② 替代方案检索 + 自动执行 ---------------- */
  let alternativeUsed: { match: SkillMatch; value: T } | null = null
  try {
    const matches = await findAlternative(toolName, registry)
    if (matches.length > 0) {
      const top = matches[0]!
      // 走替代 skill（用相同的 args 试一次；不再重试；失败归因到 alternative）
      try {
        const altValue = await invokeAlternativeSkill<T>(top.skillId, args, ctx, registry)
        alternativeUsed = { match: top, value: altValue }
        await logFaultDecision({
          decision: 'auto',
          fault: finalError ?? undefined,
          note: `alternative matched: ${top.skillId} (score=${top.score.toFixed(2)})`,
        })
        const note = tFor(getUiLocale(), 'runft.completedVia', { name: top.name, skillId: top.skillId })
        // 替代成功 → 标记当前 planItem done（备注）
        if (ctx.planItem && ctx.taskId) {
          await markPlanItemDoneWithNote(ctx.taskId, ctx.planItem.id, note)
        }
        return {
          outcome: 'alternative-succeeded',
          value: altValue,
          note,
          alternativeSkillId: top.skillId,
        }
      } catch (altErr) {
        const altFault: FaultError = isFaultError(altErr) ? altErr : classifyError(altErr)
        await logFaultDecision({
          decision: 'auto',
          fault: altFault,
          note: `alternative failed: ${top.skillId}`,
        })
        // 替代失败 → 进 ③ 影响分析
        finalError = altFault
      }
    }
  } catch {
    // 检索替代方案本身失败 → 静默继续走 ③
  }

  /* ---------------- ③ LLM 因果分析（10s 超时 fallback） ---------------- */
  const impact = ctx.planItem
    ? await analyzeImpact(
        ctx.planItem,
        ctx.followingPlanItems ?? [],
        { adapter: opts.adapter, modelId: opts.modelId },
      )
    : { blocksFollowers: false, reason: 'planItem not provided', latencyMs: 0 }

  /* ---------------- ④ / ⑤ 影响判断 + 决策 ---------------- */
  if (impact.blocksFollowers) {
    // 弹卡等用户决策
    pushFaultCard(
      finalError ?? {
        code: 'retries-exhausted',
        message: tFor(getUiLocale(), 'fault.retryExhausted'),
        originalKind: 'unknown',
        toolName,
      },
      impact,
      {
        onRetry: () => {
          ctx.onDecision?.({ outcome: 'retry-succeeded' })
        },
        onIgnore: () => {
          // 忽略 → 标记当前计划项 failed，继续后续
          if (ctx.planItem && ctx.taskId) {
            void onPlanItemFailed(ctx.planItem.id, ctx.taskId, 'user-ignored')
          }
          ctx.onDecision?.({ outcome: 'no-impact' })
        },
        onCancelFollowing: () => {
          // 取消后续 → 不标记 failed（标记 cancelled），结束当前任务流
          if (ctx.planItem && ctx.taskId) {
            void markPlanItemCancelled(ctx.planItem.id, ctx.taskId)
            // 广播 task:cancel-following（让后续 PlanItem 跳过）
            broadcast('task:cancel-following', {
              taskId: ctx.taskId,
              fromPlanItemId: ctx.planItem.id,
              ts: Date.now(),
            })
          }
          ctx.onDecision?.({ outcome: 'cancelled' })
        },
      },
      { taskId: ctx.taskId, planItemId: ctx.planItem?.id },
    )
    return {
      outcome: 'impacts-followers',
      fault: finalError ?? undefined,
      // 保留替代成功的结果（如果走到了这里但替代成功信息）
      value: alternativeUsed?.value,
      alternativeSkillId: alternativeUsed?.match.skillId,
    }
  }

  // ⑤ 不影响后续 → markFailed(planItem) + continue
  if (ctx.planItem && ctx.taskId) {
    await onPlanItemFailed(ctx.planItem.id, ctx.taskId, finalError?.message)
  }
  return {
    outcome: 'no-impact',
    fault: finalError ?? undefined,
    value: alternativeUsed?.value,
    alternativeSkillId: alternativeUsed?.match.skillId,
  }
}

/* ============================================================
 * 内部辅助
 * ============================================================ */

/** 默认 Skill 注册表：通过 agent/registry.listSkills 取 */
const defaultRegistry: SkillRegistry = {
  async list() {
    const { listSkills } = await import('../agent/registry.js')
    return listSkills()
  },
  async get(id: string) {
    const { getSkill } = await import('../agent/registry.js')
    return getSkill(id)
  },
}

async function invokeAlternativeSkill<T>(
  skillId: string,
  args: Record<string, unknown> | undefined,
  ctx: FaultTolerantCtx,
  registry: SkillRegistry,
): Promise<T> {
  // 同步构造 SkillContext（来自 ctx 的 signal）
  const skillCtx: SkillContext = {
    taskId: ctx.taskId ?? '',
    signal: ctx.signal ?? new AbortController().signal,
  }
  if (ctx.planItem) {
    // 关联当前 PlanItem / 任务给后续 engine / audit
    skillCtx.task = ctx.planItem as unknown as SkillContext['task']
  }
  // 优先走测试桩（若注入）；否则走生产 invokeSkill
  const fn = _invokeSkillOverride ?? defaultInvokeSkill
  const r = await fn(skillId, args ?? {}, skillCtx)
  // 失败时 invokeSkill 可能返回 { result: { error: '...' } }，不抛
  const result = r.result as { error?: string } | undefined
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    // 把 invokeSkill 的错误结果归类为 FaultError 再抛
    throw new Error(result.error)
  }
  return r.result as T
}

async function defaultMarkPlanItemFailed(planItemId: string, taskId: string, note?: string): Promise<void> {
  broadcast('planItem:status', {
    taskId,
    planItemId,
    status: 'failed',
    note,
    ts: Date.now(),
  })
  await logFaultDecision({ decision: 'auto', note: `markFailed: ${planItemId} (${note ?? ''})` })
}

async function markPlanItemDoneWithNote(taskId: string, planItemId: string, note: string): Promise<void> {
  broadcast('planItem:status', {
    taskId,
    planItemId,
    status: 'done',
    note,
    ts: Date.now(),
  })
}

async function markPlanItemCancelled(planItemId: string, taskId: string): Promise<void> {
  broadcast('planItem:status', {
    taskId,
    planItemId,
    status: 'cancelled',
    ts: Date.now(),
  })
}
