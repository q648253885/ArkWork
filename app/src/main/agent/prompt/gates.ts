/* ============================================================
 * ArkWork — 门禁契约（v0.25.0 F1 / 设计文档 §3.4）
 *
 * 门禁从「SKILL.md 正文里的一行自然语言」升级为
 * 「frontmatter 声明 + 引擎持久化状态机」：
 *   1. run 启动时从 always-on / 已激活技能的 frontmatter 收集 gates，
 *      初始化 task.gateStates（持久化到 tasks.json）；
 *   2. todo_update 把某阶段标 done 时校验关联 gate 是否 passed；
 *      未通过 → 软失败并返回行动指令（拦截不 throw）；
 *   3. ask_user 确认结果写回 gateStates（引擎在下一 run 启动时消费
 *      task.pendingGateBlock），中断续聊可恢复。
 *
 * 全部为纯函数（Task 对象原地更新，持久化由调用方负责）——可单测。
 * ============================================================ */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Agent, GateSpec, GateState, Skill } from '@shared/types/agent'
import type { Task } from '@shared/types/task'
import { logger } from '../../system/logger.js'

/** SKILL.md frontmatter 中与 F1 相关的声明。 */
export interface SkillFrontmatter {
  instructionMode?: 'always-on' | 'on-demand' | 'hint-only'
  gates?: GateSpec[]
}

const GATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 解析 SKILL.md frontmatter（轻量行式解析，不引入 yaml 依赖）。
 * 支持形态：
 *   ---
 *   name: xxx
 *   description: xxx
 *   instructionMode: always-on
 *   gates:
 *     - id: prd-confirmed
 *       after: 产出 01-prd.md
 *       ask: PRD 要点总结 + 待确认项
 *   ---
 * 错误场景：gates 非法（缺字段 / id 不合法）→ 忽略该 gate + warn，不阻塞任务。
 */
export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const out: SkillFrontmatter = {}
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return out
  const body = fm[1]

  const modeMatch = body.match(/^instructionMode:\s*(\S+)\s*$/m)
  if (modeMatch) {
    const mode = modeMatch[1]
    if (mode === 'always-on' || mode === 'on-demand' || mode === 'hint-only') {
      out.instructionMode = mode
    } else {
      logger.warn('Agent', `[gates] invalid instructionMode '${mode}' in frontmatter — ignored`)
    }
  }

  // gates 块：从 "gates:" 行到下一个顶层 key（非缩进行）或结尾
  const gatesStart = body.match(/^gates:\s*$/m)
  if (gatesStart && typeof gatesStart.index === 'number') {
    const rest = body.slice(gatesStart.index + gatesStart[0].length).replace(/^\r?\n/, '')
    const nextTop = rest.match(/^[A-Za-z][\w-]*:/m)
    const block = nextTop && typeof nextTop.index === 'number' ? rest.slice(0, nextTop.index) : rest
    const gates: GateSpec[] = []
    // 按 "- id: xxx" 切条目（容忍前导缩进；按 "- id:" 行首切）
    const entries = block.split(/^[ \t]*-\s+id:\s*/m).slice(1)
    for (const raw of entries) {
      // 每条以下一条目开头或块结尾结束；提取首个换行前的 id，余下取 after/ask
      const newlineIdx = raw.search(/\r?\n/)
      const idLine = newlineIdx >= 0 ? raw.slice(0, newlineIdx) : raw
      const restEntry = newlineIdx >= 0 ? raw.slice(newlineIdx + 1) : ''
      const id = idLine.trim()
      // 允许 after/ask 行带前导缩进（YAML 列表条目常见格式）
      const after = restEntry.match(/^[ \t]*after:\s*(.+)$/m)?.[1]?.trim()
      const ask = restEntry.match(/^[ \t]*ask:\s*(.+)$/m)?.[1]?.trim()
      if (!id || !after || !ask) {
        if (id || after || ask) {
          logger.warn('Agent', `[gates] invalid gate entry (need id/after/ask) — ignored: ${id ?? '(no id)'}`)
        }
        continue
      }
      if (!GATE_ID_RE.test(id)) {
        logger.warn('Agent', `[gates] invalid gate id '${id}' — ignored`)
        continue
      }
      gates.push({ id, after, ask })
    }
    if (gates.length > 0) out.gates = gates
  }
  return out
}

/** 读取技能并解析 frontmatter（技能不存在 / 指令体缺失 → 跳过 + warn）。 */
export async function loadSkillFrontmatter(skill: Skill): Promise<SkillFrontmatter> {
  if (!skill.instructionMd) return {}
  try {
    const md = await readFile(skill.instructionMd, 'utf-8')
    return parseSkillFrontmatter(md)
  } catch (err) {
    logger.warn('Agent', `[gates] failed to read SKILL.md for ${skill.id}: ${(err as Error).message}`)
    return {}
  }
}

/**
 * 收集技能集合的门禁声明（skill.gates 优先，缺省回退 frontmatter 解析）。
 * 职责：供 run 启动时初始化状态机。
 */
export async function collectGateSpecs(skills: Skill[]): Promise<GateSpec[]> {
  const specs: GateSpec[] = []
  const seen = new Set<string>()
  for (const skill of skills) {
    let gates = skill.gates
    if (!gates && skill.instructionMd) {
      gates = (await loadSkillFrontmatter(skill)).gates
    }
    if (!gates) continue
    for (const g of gates) {
      if (seen.has(g.id)) continue
      seen.add(g.id)
      specs.push(g)
    }
  }
  return specs
}

/**
 * 初始化 / 合并门禁状态机（原地更新 task.gateStates，返回最新数组）。
 * 已存在的 gateId 保留原状态（含 after/ask 快照），仅补充新 gate。
 */
export function initGateStates(task: Task, specs: GateSpec[]): GateState[] {
  const existing = task.gateStates ?? []
  const byId = new Map(existing.map((g) => [g.gateId, g]))
  for (const spec of specs) {
    if (byId.has(spec.id)) {
      // 刷新声明快照（状态保持）
      const cur = byId.get(spec.id)!
      byId.set(spec.id, { ...cur, after: spec.after, ask: spec.ask })
      continue
    }
    byId.set(spec.id, {
      gateId: spec.id,
      status: 'pending',
      after: spec.after,
      ask: spec.ask,
    })
  }
  task.gateStates = [...byId.values()]
  return task.gateStates
}

/** 从 GateSpec.after / GateState.after 提取匹配 token（文件名 / 目录片段）。 */
function extractAfterTokens(after: string): string[] {
  const tokens: string[] = []
  // 文件名（含扩展名），如 01-prd.md / 00-opensource-research.md
  const fileNames = after.match(/[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,5}/g) ?? []
  tokens.push(...fileNames)
  // 目录片段，如 prototype/
  const dirFrags = after.match(/[\w.-]+\/(?=\S)/g) ?? []
  tokens.push(...dirFrags)
  return tokens.filter((t) => t.length >= 4)
}

/** gate.after 与 todo 条目文本是否关联（token 包含匹配，保守判定）。 */
export function gateMatchesText(after: string, itemText: string): boolean {
  if (!after || !itemText) return false
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const a = norm(after)
  const t = norm(itemText)
  const tokens = extractAfterTokens(a)
  if (tokens.length > 0) return tokens.some((tok) => t.includes(tok))
  // 无结构化 token 时退化为整句包含（after ≥6 字才可信）
  if (a.length >= 6) return t.includes(a)
  return false
}

export interface GateBlockResult {
  gateId: string
  ask: string
  instruction: string
}

/**
 * todo_update 标 done 前校验：pending 且与该条目关联的 gate 是否已确认。
 * 输出：null = 放行；GateBlockResult = 拦截（softFail 行动指令）。
 */
export function checkGateBeforeAdvance(task: Task, itemText: string): GateBlockResult | null {
  const states = task.gateStates ?? []
  for (const g of states) {
    if (g.status !== 'pending') continue
    const after = g.after ?? ''
    if (!gateMatchesText(after, itemText)) continue
    return {
      gateId: g.gateId,
      ask: g.ask ?? after,
      instruction:
        `门禁未确认：清单项「${itemText}」关联门禁 ${g.gateId} 尚未通过（触发点：${after}）。` +
        `请先调用 ask_user 向用户确认（问题：${g.ask ?? after}，附 2~4 个 suggestions），` +
        `用户确认后再重试 todo_update 把该项标 done。禁止未经用户确认跳过门禁。`,
    }
  }
  return null
}

/**
 * 写回门禁确认结果（原地更新 task.gateStates）。
 * 错误场景：gateId 不存在 → throw。
 */
export function confirmGate(
  task: Task,
  gateId: string,
  note?: string,
  status: 'passed' | 'skipped' = 'passed',
): GateState {
  const states = task.gateStates ?? []
  const target = states.find((g) => g.gateId === gateId)
  if (!target) {
    throw new Error(`[gates] confirmGate: unknown gateId '${gateId}' on task ${task.id}`)
  }
  target.status = status
  target.confirmedAt = Date.now()
  target.note = note
  task.gateStates = states
  return target
}

/**
 * 按阶段产物文档路径找关联门禁（stage-gates 自动 ask_user 触发点）。
 * 输出：匹配 after token 出现在该路径中的 pending gate；无匹配返回 null。
 */
export function findGateForStageDoc(task: Task, filePath: string): GateState | null {
  const states = task.gateStates ?? []
  const norm = filePath.replace(/\\/g, '/')
  const base = basename(norm)
  for (const g of states) {
    if (g.status !== 'pending') continue
    const after = g.after ?? ''
    const tokens = extractAfterTokens(after)
    if (tokens.length === 0) continue
    if (tokens.some((tok) => norm.includes(tok) || (base && tok === base))) return g
  }
  return null
}

/**
 * 判定 agent 是否声明了 doc-driven 计划 prompt（通用机制，替代旧正则特判）。
 * 优先 alwaysOnSkillIds 技能的 planPrompt 声明；兜底技能名/ID 关键词。
 */
export function isDocDrivenAgent(agent: Agent, alwaysOnSkills: Skill[]): boolean {
  if (alwaysOnSkills.some((s) => s.planPrompt === 'doc-driven')) return true
  const ids = [...(agent.alwaysOnSkillIds ?? []), ...(agent.defaultSkillIds ?? [])]
  return ids.some((id) => /react\.core\.skills|文档驱动|doc.?driven|structured.?dev/i.test(id)) ||
    alwaysOnSkills.some((s) => /react\.core\.skills|文档驱动|doc.?driven|structured.?dev/i.test(`${s.id} ${s.name}`))
}
