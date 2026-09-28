/* ============================================================
 * ArkWork — 规划通道执行器（v0.39.0 · F1）
 * 设计文档：docs/versions/v0.39.0/04-system-design.md §3.4
 *
 * 这是规划通道**唯一**的 IO 出口。行为契约：
 *   C1 调用 `adapter.complete({ tools: undefined })` —— 不带任何工具定义
 *   C2 温度 0.2，maxTokens 2048
 *   C3 超时默认 20s，超时返回 ok:false, skipped:'aborted'，**不抛**
 *   C4 planner 的 thought 只用于解析兜底，**绝不写回 L1 / 对话历史**
 *   C5 解析失败返回 ok:false, skipped:'unparsable'（D195：不再借用 'aborted'），由调用方回落既有链
 *   C6 用户中止原样抛出
 *   C7 最多两次尝试（一次正常 + 一次 tighten）
 * ============================================================ */
import type { PlanDraftItem } from '../ledger/plan-diff.js'
import type { PlannerRequest, PlannerResult, PlannerSkipReason } from './types.js'
import { PLANNER_BUDGET_MS, PLANNER_MAX_ITEMS } from './types.js'
import { buildPlannerSystem, renderPlannerUserMessage, PLANNER_TIGHTEN_HINT } from './prompt.js'
import { parsePlannerOutput } from './parse.js'
import { clipRawForLog } from './digest.js'
import { getAdapter } from '../../llm/registry.js'
import { withLlmTimeout } from '../llm-call.js'
import { logger } from '../../system/logger.js'

export interface PlannerLlmInput {
  system: string
  user: string
  temperature: number
  maxTokens: number
  signal: AbortSignal
}

export interface PlannerLlmOutput {
  content?: string | null
  thought?: string | null
}

export interface RunPlannerPassArgs {
  req: PlannerRequest
  modelId: string
  signal: AbortSignal
  /** 超时上限，默认 PLANNER_BUDGET_MS；开局场合由调用方放宽 */
  timeoutMs?: number
  /**
   * 测试注入点：不传则走真实 adapter。
   * 有它才能在不联网的前提下把「一次完整的规划调用」跑成单测（纪律⑫）。
   */
  completeFn?: (input: PlannerLlmInput) => Promise<PlannerLlmOutput>
}

const TEMPERATURE = 0.2
const MAX_TOKENS = 2048
const MAX_ATTEMPTS = 2

function skip(reason: PlannerSkipReason, summary: string): PlannerResult {
  return { ok: false, draft: [], via: 'none', summary, attempts: 0, skipped: reason }
}

/**
 * 发起一次独立的规划调用。
 *
 * 注意：**不写账本**。落库统一由调用方经 `plan-commit-pipeline` 完成 ——
 * 规划通道只负责「想清楚」，不负责「写进去」（依赖方向铁律的另一半）。
 */
export async function runPlannerPass(args: RunPlannerPassArgs): Promise<PlannerResult> {
  const { req, modelId, signal, timeoutMs = PLANNER_BUDGET_MS, completeFn } = args
  const systemBase = buildPlannerSystem(req)
  const user = renderPlannerUserMessage(req)

  const call = completeFn ?? defaultComplete(modelId)

  let lastWarn = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    const system = attempt === 1 ? systemBase : `${systemBase}\n\n${PLANNER_TIGHTEN_HINT}`
    let out: PlannerLlmOutput
    try {
      out = await call({ system, user, temperature: TEMPERATURE, maxTokens: MAX_TOKENS, signal })
    } catch (err) {
      // C6：用户中止原样抛出（与既有 plan.ts 同口径），其余失败 return 不抛
      const name = (err as Error)?.name
      if (name === 'AbortError' || signal.aborted) throw err
      logger.warn('Agent', `planner pass failed (attempt ${attempt}): ${(err as Error).message}`, req.taskId)
      return skip('aborted', `规划调用失败：${(err as Error).message}`)
    }
    // C4：思考模型常把答案放进 thought，两者都要看；但内容只进解析器，绝不进 L1
    const raw = [out.content, out.thought].filter(Boolean).join('\n')
    const parsed = parsePlannerOutput(raw)
    if (!parsed) {
      lastWarn = parsedWarnReason(raw)
      // D195：解析失败必须把**原文**（有界）落诊断通道。
      // 既有计划链一直这么做（`engine/plan.ts` 的 `plan LLM raw (maxTokens=…): …`，
      // 截断 200 字符），而本通道当初只留了一个分类词 → 实机（qwen3.5:9b）出现
      // 「两次都未给出可解析的清单（回复不是可识别的清单形态）」时，
      // **无法判断模型到底回了散文、错形状列表还是空串**，下一轮调 prompt 无从下手。
      // 纪律⑨：「容错路径必须在诊断通道留人话」—— 分类词是人话，但原文才是诊断依据。
      // 只进日志（logs.jsonl），不进 UI 提示、不进 L1（保持 C4）。
      logger.warn(
        'Agent',
        `planner pass unparsable (attempt ${attempt}/${MAX_ATTEMPTS}): ${clipRawForLog(raw)}`,
        req.taskId,
      )
      continue
    }
    const items = capItems(parsed.draft, req.maxItems ?? PLANNER_MAX_ITEMS)
    return {
      ok: true,
      draft: items,
      via: parsed.via,
      summary:
        parsed.warnings.length > 0
          ? `${items.length} 项｜${parsed.warnings.slice(0, 2).join('；')}`
          : `${items.length} 项清单（${viaLabel(parsed.via)}）`,
      attempts: attempt,
    }
  }
  return skip('unparsable', `规划模型两次都未给出可解析的清单${lastWarn ? `（${lastWarn}）` : ''}`)
}

/** 缺省实现：真实 adapter，超时保护，无工具 */
function defaultComplete(modelId: string): (input: PlannerLlmInput) => Promise<PlannerLlmOutput> {
  return async (input: PlannerLlmInput): Promise<PlannerLlmOutput> => {
    const adapter = await getAdapter(modelId)
    const res = await withLlmTimeout(
      (sig) =>
        adapter.complete({
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          signal: sig,
          // C1：**不带任何工具** —— 规划回合不需要外部能力，带了只会诱导伪调用
          tools: undefined,
        }),
      PLANNER_BUDGET_MS,
      input.signal,
    )
    return { content: res.content ?? null, thought: res.thought ?? null }
  }
}

function capItems(items: readonly PlanDraftItem[], max: number): PlanDraftItem[] {
  return items.length <= max ? items.slice() : items.slice(0, max)
}

function parsedWarnReason(raw: string): string {
  if (!raw || !raw.trim()) return '模型回复为空'
  return '回复不是可识别的清单形态'
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
 * 规划模型选择：默认同模型；配了 `plannerModelId` 用它（Cline Plan/Act 范式的口子）。
 * 任何异常都回落任务模型 —— 配置项不该能让任务开不了局。
 */
export async function getPlannerModelId(taskModelId: string): Promise<string> {
  try {
    const { getSettings } = await import('../../ipc/settings.js')
    const id = (await getSettings()).plannerModelId?.trim()
    return id || taskModelId
  } catch {
    return taskModelId
  }
}
