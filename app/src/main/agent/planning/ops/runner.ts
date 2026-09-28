/* ============================================================
 * ArkWork — 清单操作通道执行器（v0.40.0）
 * 设计文档：docs/versions/v0.40.0/04-system-design.md §六
 *
 * 本文件是 PlanOps **唯一**的 IO 出口。行为契约（与 v0.39.0 `planning/runner.ts`
 * 逐条对齐，不另起一套口径）：
 *   C1 调用 `adapter.complete({ tools: undefined })` —— 不带任何工具定义
 *   C2 温度 0.2，maxTokens 2048
 *   C3 超时默认 20s（create 45s），超时返回 ok:false, skipped:'aborted'，**不抛**
 *   C4 模型的 thought 只用于解析兜底，**绝不写回 L1 / 对话历史**
 *   C5 解析失败返回 ok:false, skipped:'unparsable'（不借用 'aborted'，D195 教训），
 *      且**原文有界落诊断**（D203：只留分类词会无法归因）
 *   C6 用户中止原样抛出
 *   C7 最多两次尝试（一次正常 + 一次 tighten）
 *
 * **不写账本** —— 落库统一由调用方经 `commitPlanDraft` 完成（依赖方向铁律）。
 * ============================================================ */
import type { PlanDraftItem } from '../../ledger/plan-diff.js'
import type { PlanOpsKind, PlanOpsRequest, PlanOpsResult } from './types.js'
import { PLAN_OPS_BUDGET_MS, PLAN_OPS_CREATE_BUDGET_MS, PLAN_OPS_MAX_ITEMS } from './types.js'
import { buildPlanOpsSystem, renderPlanOpsUserMessage, PLANOPS_TIGHTEN_HINT } from './prompt.js'
import { parsePlannerOutput } from '../parse.js'
import { clipRawForLog } from '../digest.js'
import { getAdapter } from '../../../llm/registry.js'
import { withLlmTimeout } from '../../llm-call.js'
import { logger } from '../../../system/logger.js'

export interface PlanOpsLlmInput {
  system: string
  user: string
  temperature: number
  maxTokens: number
  signal: AbortSignal
}

export interface PlanOpsLlmOutput {
  content?: string | null
  thought?: string | null
}

export interface RunPlanOpsArgs {
  req: PlanOpsRequest
  modelId: string
  signal: AbortSignal
  /** 超时上限；缺省按 kind 决定（create 放宽） */
  timeoutMs?: number
  /**
   * 测试注入点：不传则走真实 adapter。
   * 有它才能在不联网的前提下把「一次完整的清单操作调用」跑成单测（纪律⑫）。
   */
  completeFn?: (input: PlanOpsLlmInput) => Promise<PlanOpsLlmOutput>
}

const TEMPERATURE = 0.2
const MAX_TOKENS = 2048
const MAX_ATTEMPTS = 2

/**
 * 哪些操作允许模型输出 `done`。
 *
 * `update` / `complete` **必须**放行：它们要求模型输出**完整**清单并保留已完成项，
 * 而解析器的 S1 会把解析出的 `done` 降级 `todo` —— 不放行的话「原样返回当前清单」
 * 会把已完成项回退成待做（清单倒退），与本版目标相反。
 *
 * `create` / `cancel` / `replan` **不放行**：
 *   · create 是「工作还没开始」，不该有已完成项；
 *   · cancel 的 done 项来自**当前清单**，模型只需原样保留 —— 但若它乱标新 done，
 *     放行等于给它开口子；保守起见走降级（降级后仍会保留 note 说明）；
 *   · replan 同理，新的 done 必须由执行事实产生，不是由重排产生。
 */
function allowDoneFor(kind: PlanOpsKind): boolean {
  return kind === 'update' || kind === 'complete'
}

/**
 * 构造一条失败结果。
 *
 * `attempts` 记**真实**尝试次数（v0.40.0 与 v0.39.0 规划通道的一个刻意差异）：
 * 「失败前到底问了几次」是归因的关键 —— 1 次失败（端点直接报错）与 2 次失败
 * （问了两遍都没问出清单）指向完全不同的修复动作，统一写 0 会让诊断退化。
 */
function skip(
  kind: PlanOpsKind,
  reason: PlanOpsResult['skipped'],
  summary: string,
  attempts: number,
): PlanOpsResult {
  return { ok: false, kind, draft: [], via: 'none', summary, attempts, skipped: reason }
}

/**
 * 发起一次独立的清单操作调用。
 *
 * 只负责「问清楚清单应该长什么样」，**不落库**（落库由调用方经 `commitPlanDraft`）。
 */
export async function runPlanOps(args: RunPlanOpsArgs): Promise<PlanOpsResult> {
  const { req, modelId, signal, completeFn } = args
  const timeoutMs =
    args.timeoutMs ?? (req.kind === 'create' ? PLAN_OPS_CREATE_BUDGET_MS : PLAN_OPS_BUDGET_MS)
  const systemBase = buildPlanOpsSystem(req)
  const user = renderPlanOpsUserMessage(req)
  const allowDone = allowDoneFor(req.kind)
  const call = completeFn ?? defaultComplete(modelId, timeoutMs)

  let lastWarn = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    const system = attempt === 1 ? systemBase : `${systemBase}\n\n${PLANOPS_TIGHTEN_HINT}`
    let out: PlanOpsLlmOutput
    try {
      out = await call({ system, user, temperature: TEMPERATURE, maxTokens: MAX_TOKENS, signal })
    } catch (err) {
      // C6：用户中止原样抛出（与既有 plan.ts / planner 同口径），其余失败 return 不抛
      const name = (err as Error)?.name
      if (name === 'AbortError' || signal.aborted) throw err
      logger.warn('Agent', `plan-ops ${req.kind} failed (attempt ${attempt}): ${(err as Error).message}`, req.taskId)
      return skip(req.kind, 'aborted', `清单维护调用失败：${(err as Error).message}`, attempt)
    }
    // C4：思考模型常把答案放进 thought，两者都要看；但内容只进解析器，绝不进 L1
    const raw = [out.content, out.thought].filter(Boolean).join('\n')
    const parsed = parsePlannerOutput(raw, { allowDone })
    if (!parsed) {
      lastWarn = raw && raw.trim() ? '回复不是可识别的清单形态' : '模型回复为空'
      // C5 / D203：解析失败必须把**原文**（有界）落诊断通道 —— 只留分类词，
      // 事后无法判断模型回了散文 / 错形状列表 / 空串，下一轮调 prompt 无从下手。
      // 只进日志，不进 summary、不进 L1（保持 C4）。
      logger.warn(
        'Agent',
        `plan-ops ${req.kind} unparsable (attempt ${attempt}/${MAX_ATTEMPTS}): ${clipRawForLog(raw)}`,
        req.taskId,
      )
      continue
    }
    const items = capItems(parsed.draft, req.maxItems ?? PLAN_OPS_MAX_ITEMS)
    return {
      ok: true,
      kind: req.kind,
      draft: items,
      via: parsed.via,
      summary:
        parsed.warnings.length > 0
          ? `${items.length} 项｜${parsed.warnings.slice(0, 2).join('；')}`
          : `${items.length} 项清单（${viaLabel(parsed.via)}）`,
      attempts: attempt,
    }
  }
  return skip(
    req.kind,
    'unparsable',
    `清单维护模型 ${MAX_ATTEMPTS} 次都未给出可解析的清单${lastWarn ? `（${lastWarn}）` : ''}`,
    MAX_ATTEMPTS,
  )
}

/** 缺省实现：真实 adapter，超时保护，无工具 */
function defaultComplete(
  modelId: string,
  timeoutMs: number,
): (input: PlanOpsLlmInput) => Promise<PlanOpsLlmOutput> {
  return async (input: PlanOpsLlmInput): Promise<PlanOpsLlmOutput> => {
    const adapter = await getAdapter(modelId)
    const res = await withLlmTimeout(
      (sig) =>
        adapter.complete({
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          signal: sig,
          // C1：**不带任何工具** —— 清单回合不需要外部能力，带了只会诱导伪调用
          tools: undefined,
        }),
      timeoutMs,
      input.signal,
    )
    return { content: res.content ?? null, thought: res.thought ?? null }
  }
}

function capItems(items: readonly PlanDraftItem[], max: number): PlanDraftItem[] {
  return items.length <= max ? items.slice() : items.slice(0, max)
}

function viaLabel(via: string): string {
  switch (via) {
    case 'json-strict':
      return '标准 JSON'
    case 'json-fence':
      return '代码块 JSON'
    case 'json-repair':
      return '修补后 JSON'
    case 'checklist':
      return '勾选清单'
    case 'outline':
      return '提纲列表'
    default:
      return via
  }
}

/**
 * 清单操作模型选择：默认同模型；配了 `plannerModelId` 用它（Cline Plan/Act 范式的口子）。
 * 任何异常都回落任务模型 —— 配置项不该能让任务开不了局。
 */
export async function getPlanOpsModelId(taskModelId: string): Promise<string> {
  try {
    const { getSettings } = await import('../../../ipc/settings.js')
    const id = (await getSettings()).plannerModelId?.trim()
    return id || taskModelId
  } catch {
    return taskModelId
  }
}
