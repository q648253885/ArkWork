/* ============================================================
 * ArkWork — L3a 收尾巩固（v0.36.3 · R3 / stage: l3a-consolidate）
 * 设计文档：docs/versions/v0.36.0/15-v0363-memory-motion-path-design.md §4.2
 *
 * 一句话：任务收尾时把本任务的 L1/L2 **提炼成两类长期记忆** ——
 *   项目偏好 / 项目规则 / 项目事实 → {workspace}/.arkwork/memory.md（随工作区）
 *   用户偏好                       → {agentSpace}/user.md（跨工作区）
 *
 * 为什么单开一个 stage（而不是并进 L3b 归档）：
 *  ① 归档是**全量搬运**（ADD-only 原文入库，供日后检索）；巩固是**有损提炼**
 *     （要下判断：这条跨任务还成立吗？）—— 两者的失败语义与观测口径完全不同；
 *  ② 提炼要调 LLM，是「可能失败」的一步；与纯本地归档混在一起就说不清
 *     「这次收尾到底是搬运失败了还是提炼失败了」；
 *  ③ 输入同为「本任务 L1」，产物却分属两个文件与两套生命周期，混写会让用户
 *     事后无法回答「memory.md 里这条是哪来的」。
 *
 * 三条纪律（缺一不可）：
 *  ① **失败不写半成品**：LLM 抛错 / 输出解析不出 → 抛错（管线记 ok:false），
 *     一个字都不落暂存区，连幂等标记都不写（下次收尾还能重试）。
 *     宁可这次没巩固，也不能把半截垃圾写进长期记忆 —— 长期记忆一旦写脏，
 *     会被后续每一次 run 注入，代价远大于「这次没记住」；
 *  ② **幂等**：同一 taskId 只巩固一次（{taskDir}/.arkwork/.consolidated 标记）。
 *     任务被重复收尾（重跑 / 失败重试 / 手动补跑）不会把同一批偏好灌两遍；
 *  ③ **不直写快照**：一律走 addPendingLine 暂存区，保持既有「冻结快照 +
 *     下次 run 生效」口径 —— 否则正在跑的这一次会看到中途变化的记忆。
 *
 * 明确不做：不删 L1/L2（沿用 v0.25.0 F3 纪律：蒸馏与否都不删证据）。
 * ============================================================ */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getTaskDir } from '../store/db.js'
import { listL1 } from './l1-working.js'
import { listL2Memories } from './l2-memory.js'
import { addPendingLine, getCuratedSnapshot } from './l3-curated.js'
import { getAdapter } from '../llm/registry.js'
import { logger } from '../system/logger.js'
import type { L2Memory, MemoryItem } from '@shared/types/memory'

/** 单次巩固条数上限：**巩固不是搬家** —— 只留「值得跨任务记住」的那几条 */
export const CONSOLIDATE_LIMITS = { memory: 8, user: 5 } as const

/** 单条记忆字符上限（超长的「记忆」没人读，也撑爆快照预算） */
const LINE_MAX_CHARS = 200

/** 送入 LLM 的 L1 / L2 体量上限（字符） */
const L1_BRIEF_MAX = 6000
const L2_BRIEF_MAX = 4000

/** 幂等标记文件名（落在任务目录，随任务生命周期） */
export const CONSOLIDATE_MARKER = '.consolidated'

export interface ConsolidateOptions {
  modelId?: string
  /** 已取到的 L1（管线复用同一次读取，避免重复扫盘）；缺省现取 */
  l1Items?: MemoryItem[]
  /** LLM 完成函数覆盖（测试注入；缺省走 registry adapter） */
  complete?: (req: { system: string; user: string }) => Promise<string>
}

export interface ConsolidateResult {
  /** 条件未命中而正常跳过（无模型 / 已巩固 / 无有效内容） */
  skipped?: boolean
  detail: string
  /** 真正写入暂存区的行（供调用方上报 / 用例断言） */
  memoryLines: string[]
  userLines: string[]
}

const SYSTEM_PROMPT = `你是 ArkWork 的记忆巩固助手。任务刚结束，请从本任务的观测与产物中，
提炼出**值得长期记住**的两类内容（其余一律丢弃）。

判据（宁缺毋滥 —— 只提炼「跨任务仍然成立」的）：
  1. 项目偏好 / 项目规则 / 项目事实（memory）：本项目约定（包管理器、目录约定、
     收尾门槛、测试要求、架构约束、踩坑结论等）。**不要**写这一次具体做了什么。
  2. 用户偏好（user）：这个人怎么干活（UI 审美、沟通方式、流程要求、明确纠正过的做法）。

不要输出：任务流水账、一次性结论、代码片段、文件路径清单、与长期无关的细节。

仅返回严格 JSON（无 Markdown 围栏、无解释）：
{"memory": ["<一条一句话结论>"], "user": ["<一条一句话结论>"]}
没有可提炼的就返回空数组。每条不超过 60 字。`

/**
 * 收尾巩固：本任务 L1/L2 → L3a（memory.md 项目记忆 / user.md 用户偏好）。
 *
 * @returns 三态：`skipped:true`（无模型 / 已巩固 / 无有效内容）· 成功（detail 记 +N 条）
 * @throws LLM 调用失败或输出不可解析时抛错（**不写任何东西**，由管线记为 ok:false）
 */
export async function consolidateL3a(
  taskId: string,
  opts: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const empty = { memoryLines: [] as string[], userLines: [] as string[] }

  // ① 幂等：同一任务只巩固一次
  const marker = markerPath(taskId)
  if (existsSync(marker)) {
    return { skipped: true, detail: '本任务已巩固过（幂等标记在），跳过', ...empty }
  }

  // ② 输入：本任务 L1 + L2 + 既有快照（给 LLM 做去重参照）
  const l1 = opts.l1Items ?? (await listL1(taskId))
  const l2 = await listL2Memories(taskId)
  const snapshot = await getCuratedSnapshot()
  const brief = buildBrief(l1, l2, snapshot.memoryMd, snapshot.userMd)
  if (!brief) {
    return { skipped: true, detail: '无有效内容（L1/L2 均为空），跳过', ...empty }
  }

  // ③ 提炼：一次 LLM（temperature 0.2）
  const complete = opts.complete ?? (await makeLlmComplete(opts.modelId))
  if (!complete) {
    return { skipped: true, detail: '无模型 id（巩固需 LLM），跳过', ...empty }
  }
  let raw: string
  try {
    raw = await complete({ system: SYSTEM_PROMPT, user: brief })
  } catch (err) {
    throw new Error(`LLM 提炼失败：${(err as Error).message}`)
  }
  const parsed = parseConsolidation(raw)
  if (!parsed) {
    throw new Error(`LLM 输出无法解析为严格 JSON（期望 {"memory":[],"user":[]}，实际 ${raw.slice(0, 80)}…）`)
  }

  const memoryLines = normalizeLines(parsed.memory).slice(0, CONSOLIDATE_LIMITS.memory)
  const userLines = normalizeLines(parsed.user).slice(0, CONSOLIDATE_LIMITS.user)

  // ④ 写入：走 pending 暂存区（不直写快照），下次 run 合并生效
  for (const line of memoryLines) await addPendingLine('memory.md', line, taskId)
  for (const line of userLines) await addPendingLine('user.md', line, taskId)

  // ⑤ 标记：**跑完就记**（哪怕 0 条）—— 否则空任务每次收尾都白调一次 LLM
  await writeMarker(taskId, memoryLines.length, userLines.length)

  if (memoryLines.length === 0 && userLines.length === 0) {
    return { skipped: true, detail: '无有效内容（提炼结果为空），跳过', ...empty }
  }
  return {
    detail:
      `已巩固：项目记忆 +${memoryLines.length} 条 / 用户偏好 +${userLines.length} 条` +
      '（进暂存区，下次 run 生效）',
    memoryLines,
    userLines,
  }
}

/** 幂等标记路径（导出供用例构造「已巩固」状态） */
export function markerPath(taskId: string): string {
  return join(getTaskDir(taskId), '.arkwork', CONSOLIDATE_MARKER)
}

async function writeMarker(taskId: string, memory: number, user: number): Promise<void> {
  const p = markerPath(taskId)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify({ at: new Date().toISOString(), memory, user }, null, 2), 'utf-8')
  logger.info('Memory', `L3a consolidated (+${memory} memory / +${user} user)`, taskId)
}

async function makeLlmComplete(
  modelId?: string,
): Promise<((req: { system: string; user: string }) => Promise<string>) | null> {
  if (!modelId) return null
  return async ({ system, user }) => {
    const adapter = await getAdapter(modelId)
    const resp = await adapter.complete({
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.2,
      maxTokens: 900,
    })
    return resp.content
  }
}

/** 拼提炼输入：本任务 L1 + L2 + 既有长期记忆（供去重，避免重复巩固同一条） */
function buildBrief(
  l1: MemoryItem[],
  l2: L2Memory[],
  memoryMd: string,
  userMd: string,
): string {
  const parts: string[] = []

  const l1Text = l1
    .filter((m) => m.kind !== 'system_prompt')
    .slice(-40)
    .map((m) => `[${m.role}/${m.kind}] ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n')
    .slice(0, L1_BRIEF_MAX)
  if (l1Text.trim()) parts.push(`## 本任务 L1（逐步观测，按时间序）\n${l1Text}`)

  const l2Text = l2
    .slice(0, 20)
    .map((m) => `- [${m.intent}] ${m.compressedContent.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n')
    .slice(0, L2_BRIEF_MAX)
  if (l2Text.trim()) parts.push(`## 本任务 L2（压缩记忆 / 产物）\n${l2Text}`)

  if (parts.length === 0) return ''

  const existing = [memoryMd.trim(), userMd.trim()].filter(Boolean).join('\n')
  if (existing) {
    parts.push(
      `## 既有长期记忆（**已存在的不必重复提炼**）\n${existing.slice(0, 3600)}`,
    )
  }
  return parts.join('\n\n')
}

/** 解析严格 JSON（容忍 Markdown 围栏与前后缀噪声，但结构必须对） */
function parseConsolidation(raw: string): { memory: string[]; user: string[] } | null {
  for (const text of [raw.trim(), extractJson(raw)]) {
    if (!text) continue
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      if (!obj || typeof obj !== 'object') continue
      return { memory: asStringArray(obj.memory), user: asStringArray(obj.user) }
    } catch {
      /* 试下一种切法 */
    }
  }
  return null
}

function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return body.slice(start, end + 1)
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/** 清洗单行：去空白 / 去列表前缀 / 去重（同一批内不许重复） */
function normalizeLines(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.replace(/^[\s\-*•]+/, '').replace(/\s+/g, ' ').trim().slice(0, LINE_MAX_CHARS)
    if (!line) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

