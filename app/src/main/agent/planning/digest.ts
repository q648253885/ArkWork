/* ============================================================
 * ArkWork — 失败摘要（v0.39.0 · F7）
 *
 * 业界范式 B 的核心洞察：
 *   「LLM 不懂『真的失败』，它只懂你放进上下文的那句话。」
 *   所以失败回灌不是把异常堆栈贴给模型，而是三件事都说清：
 *     ① 哪一步失败（itemId）
 *     ② 失败了多少次（attempts —— 让模型知道「重试过了，别再来」）
 *     ③ **下一步建议**（否则它会一字不差地重试同一个调用）
 * ============================================================ */
import type { PlannerFailureDigest } from './types.js'

const DEFAULT_LIMIT = 6

/** 追加一条失败摘要；同一 itemId + tool 视为同一次失败，累加 attempts */
export function pushFailureDigest(
  buf: PlannerFailureDigest[],
  next: PlannerFailureDigest,
  limit: number = DEFAULT_LIMIT,
): PlannerFailureDigest[] {
  const idx = buf.findIndex((f) => f.itemId === next.itemId && f.tool === next.tool)
  if (idx >= 0) {
    const merged: PlannerFailureDigest[] = buf.slice()
    merged[idx] = { ...buf[idx]!, attempts: buf[idx]!.attempts + 1, message: next.message, code: next.code }
    return merged.slice(-limit)
  }
  return [...buf, next].slice(-limit)
}

const SUGGESTIONS: Array<{ match: RegExp; text: string }> = [
  { match: /timeout|超时/i, text: '考虑把这一步拆小或换一种更轻的做法，超时通常意味着粒度过粗' },
  { match: /not.?found|不存在|没有找到/i, text: '先确认路径/名称是否真实存在，再决定这一步要不要保留' },
  { match: /permission|权限|denied|禁止/i, text: '权限受限时换个可达的产物位置，或把它标为受阻交给用户决定' },
  { match: /exit\s*(code)?\s*\d+|命令.*失败|non-zero/i, text: '先读完整报错定位第一行根因，不要盲目重跑同一条命令' },
  { match: /parse|json|解析/i, text: '输出格式不稳定时，改用更简单的结构（短句列表）再试' },
  { match: /context|上下文|overflow|过长/i, text: '上下文过长时把这一步拆成更小的检索块' },
]

function suggest(d: PlannerFailureDigest): string {
  for (const s of SUGGESTIONS) {
    if (s.match.test(`${d.code ?? ''} ${d.message}`)) return s.text
  }
  return '先确认失败的最小复现条件，再决定「修它」还是「绕开它」'
}

/** 渲染成喂给规划模型的人话段落（空数组返回空串） */
export function renderFailureDigest(failures: readonly PlannerFailureDigest[]): string {
  if (failures.length === 0) return ''
  const lines = failures.map((f, i) => {
    const head = `${i + 1}. ${f.itemId ? `${f.itemId} ` : ''}${f.tool ? `${f.tool} ` : ''}失败 ${f.attempts} 次：${f.message.slice(0, 120)}`
    return `${head}\n   建议：${suggest(f)}`
  })
  return lines.join('\n')
}

/* ============================================================
 * 诊断摘要（v0.39.0 · D195）
 *
 * 与上面的「喂给模型」相反，这个函数只服务**人看的日志通道**：
 * 解析失败时把模型原文压成一行有界摘要，供事后调 prompt。
 * 口径与既有计划链（`engine/plan.ts` 的 `safeSlice(raw, 200)`）对齐 —— 200 字符。
 * ============================================================ */

/** 原文摘要上限（码点）。与既有计划链 200 字同口径，改动须同步。 */
export const RAW_LOG_LIMIT = 200

/**
 * 把模型原文压成一行、有界、可 grep 的诊断摘要。
 *   ① 空 / 全空白 → `(空回复)`（与「非空但不成形」区分，这是两类不同的锅）
 *   ② 首尾空白裁掉、换行折叠成 `⏎`（一行一条日志，避免 logs.jsonl 被多行撑爆）
 *   ③ 超长按**码点**截断（不劈代理对）并标出原文长度 —— 让"模型话太多"可量化
 */
export function clipRawForLog(raw: string | null | undefined, limit: number = RAW_LOG_LIMIT): string {
  const s = String(raw ?? '')
  if (!s.trim()) return '(空回复)'
  // 首尾空白无信息量 → 裁掉（与内部折叠一致：目标是"一行可读"）
  const oneLine = s.trim().replace(/\s*\r?\n+\s*/g, '⏎')
  const chars = Array.from(oneLine)
  if (chars.length <= limit) return oneLine
  return `${chars.slice(0, limit).join('')}…(原文共 ${chars.length} 字符)`
}
