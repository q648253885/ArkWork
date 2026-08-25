/* ============================================================
 * v0.14.0 Task 5.4 — LLM 因果分析（analyzeImpact）
 *
 * 思路：调用 LLM 适配层（轻量 prompt ~80 tokens），超时 10s。
 * 超时回退到规则版（staticDependencyBlocks）。
 *
 * LLM 适配层解析：
 *  - adapter 注入（便于单测用桩）
 *  - 默认从 llm/registry.ts 拉取 defaultModelId；若都拿不到，则全部走 fallback
 *
 * JSON 输出：{ blocksFollowers: boolean, reason: string }
 * 解析失败 / 超时 / 不可用 → 规则版 fallback
 * ============================================================ */

import type { PlanItem } from '@shared/types/task'
import type { LlmAdapter } from '../llm/adapter.js'
import type { ImpactAnalysis } from './types.js'
import { staticDependencyBlocks } from './alternative-skill-matcher.js'

const LLM_TIMEOUT_MS = 10_000

export interface AnalyzeImpactDeps {
  /** LLM 适配层（注入便于单测） */
  adapter?: LlmAdapter
  /** 模型 id（仅在 adapter 注入时使用） */
  modelId?: string
  /** 显式提供 fallback（避免对静态规则的循环依赖） */
  fallback?: (following: PlanItem[], current: PlanItem) => { blocksFollowers: boolean; reason: string }
}

const SYSTEM_PROMPT = `You are an impact analyzer. Given a failed plan item and its following items, decide whether the failure blocks the following items. Respond with strict JSON only: {"blocksFollowers": boolean, "reason": string}. Do not include any other text.`

function buildUserPrompt(current: PlanItem, following: PlanItem[]): string {
  const lines: string[] = []
  lines.push(`failed: ${current.id} — ${current.text}`)
  for (const f of following) {
    lines.push(`  - ${f.id} — ${f.text}`)
  }
  lines.push('Output:')
  return lines.join('\n')
}

/** 测试/外部覆盖：把 LLM 调用的输出当 JSON 解析；任何字段缺失 → fallback */
export function parseImpactJson(raw: string): { blocksFollowers: boolean; reason: string } | null {
  try {
    // 兼容模型偶发返回前后多余文本
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const j = JSON.parse(raw.slice(start, end + 1)) as { blocksFollowers?: unknown; reason?: unknown }
    if (typeof j.blocksFollowers !== 'boolean') return null
    if (typeof j.reason !== 'string') return null
    return { blocksFollowers: j.blocksFollowers, reason: j.reason }
  } catch {
    return null
  }
}

/**
 * 入口。LLM 不可用 / 超时 / 解析失败 → 规则版 fallback。
 * latencyMs 总是返回实际耗时（含 fallback）。
 */
export async function analyzeImpact(
  current: PlanItem,
  following: PlanItem[],
  deps: AnalyzeImpactDeps = {},
): Promise<ImpactAnalysis> {
  const t0 = Date.now()
  const fallback = deps.fallback ?? staticDependencyBlocks
  if (!deps.adapter) {
    const r = fallback(following, current)
    return { ...r, latencyMs: Date.now() - t0 }
  }
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), LLM_TIMEOUT_MS)
    // 清空依赖其他文件 / 平台限制；这里只关心解析
    const resp = await deps.adapter.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(current, following) }],
      maxTokens: 80,
      temperature: 0,
      signal: ac.signal,
    })
    clearTimeout(t)
    const parsed = parseImpactJson(resp.content)
    if (!parsed) {
      const r = fallback(following, current)
      return { ...r, latencyMs: Date.now() - t0 }
    }
    return { ...parsed, latencyMs: Date.now() - t0 }
  } catch {
    const r = fallback(following, current)
    return { ...r, latencyMs: Date.now() - t0 }
  }
}
