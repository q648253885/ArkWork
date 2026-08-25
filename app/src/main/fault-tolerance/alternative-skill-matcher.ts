/* ============================================================
 * v0.14.0 Task 5.3 — 替代方案匹配（findAlternative）
 *
 * 匹配策略（按 spec）：
 *  1. 同 category（用 tags[0] 启发式）— 标准差大权重
 *  2. inputSchema 完全或部分兼容（重叠字段数 / 0~1）
 *  3. description 关键词 overlap（jaccard 启发式）
 *
 * 返回 top-3 候选（按 score 倒序；0 分被剔除）。
 *
 * 兼容：SkillRegistry 解耦（engine 注入 listSkills() 即可），单测可注入桩。
 * ============================================================ */

import type { PlanItem } from '@shared/types/task'
import type { Skill } from '@shared/types/agent'
import type { SkillMatch, SkillRegistry } from './types.js'

/**
 * 取「首发 category」启发式：tags[0] > namespace > ''
 * Skill 类型没有原生 category 字段，使用 tags[0] 兜底。
 */
function categoryOf(skill: Skill): string {
  if (skill.tags && skill.tags.length > 0) return skill.tags[0].toLowerCase()
  return (skill.namespace ?? '').toLowerCase()
}

/** 简单的「停用词」集合，避免 description 关键词被无意义词主导 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'this', 'that',
  'it', 'be', 'as', 'at', 'by', 'from', 'you', 'your', 'we', 'our', 'our', 'i', '我', '你', '他', '她',
  '它', '的', '了', '在', '是', '和', '与', '或', '并', '及', '以', '为', '为', '由', '从', '到',
  '把', '将', '给', '向', '让', '使', '用', '在', '上', '下', '里', '外', '中', '内', '本', '该',
  '一个', '一些', '一下', '一种', '一定', '可以', '可能', '应该', '需要', '我们', '你们', '他们',
])

/** 移除停用词 + 转为小写集 */
function tokenize(text: string): Set<string> {
  if (!text) return new Set()
  // 拆中英文：中文按字符（2~4 字短语跳过不去），英文按非字母数字
  const out = new Set<string>()
  // 英文 / 数字
  const en = text.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  for (const w of en) {
    if (w.length < 2) continue
    if (STOPWORDS.has(w)) continue
    out.add(w)
  }
  // 中文：在 spec 中我们主要用 description 关键词触发，跳过单字（仅取 2~6 字短语）
  const zh = text.match(/[\u4e00-\u9fa5]{2,6}/g) ?? []
  for (const w of zh) {
    if (STOPWORDS.has(w.toLowerCase())) continue
    out.add(w)
  }
  return out
}

/** 集合 jaccard 相似度 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * inputSchema 字段重叠度。
 *  - 两者都无 / 无 schema → 0.5（不加分也不扣分）
 *  - 完全相同 required/properties 集合 → 1
 *  - 部分重叠 → 0~1
 */
function schemaOverlap(a: Skill, b: Skill): number {
  const sa = a.inputSchema
  const sb = b.inputSchema
  if (!sa && !sb) return 0.5
  if (!sa || !sb) return 0
  const saProps = (sa['properties'] && typeof sa['properties'] === 'object') ? Object.keys(sa['properties'] as Record<string, unknown>) : []
  const sbProps = (sb['properties'] && typeof sb['properties'] === 'object') ? Object.keys(sb['properties'] as Record<string, unknown>) : []
  const saRequired = (sa['required'] && Array.isArray(sa['required'])) ? (sa['required'] as string[]) : []
  const sbRequired = (sb['required'] && Array.isArray(sb['required'])) ? (sb['required'] as string[]) : []
  if (saProps.length === 0 && sbProps.length === 0) return 0.5
  const setA = new Set(saProps)
  const setB = new Set(sbProps)
  let inter = 0
  for (const x of setA) if (setB.has(x)) inter++
  const union = setA.size + setB.size - inter
  const propScore = union === 0 ? 0.5 : inter / union
  // required 严格匹配作为放大器
  const reqSetA = new Set(saRequired)
  const reqSetB = new Set(sbRequired)
  let reqInter = 0
  for (const x of reqSetA) if (reqSetB.has(x)) reqInter++
  const reqUnion = reqSetA.size + reqSetB.size - reqInter
  const reqScore = reqUnion === 0 ? 1 : reqInter / reqUnion
  return propScore * 0.7 + reqScore * 0.3
}

/**
 * 找到 toolName 的替代方案（top-3）。
 *  - 排除自己
 *  - 排除 disabled
 *  - 评分 ≥ 0.2 才返回
 *  - 按 score 倒序
 */
export async function findAlternative(
  toolName: string,
  registry: SkillRegistry,
): Promise<SkillMatch[]> {
  const target = await lookupSkill(registry, toolName)
  const all = await registry.list()
  const matches: SkillMatch[] = []
  for (const candidate of all) {
    if (candidate.id === toolName || candidate.toolName === toolName) continue
    if (candidate.enabled === false) continue
    const m = scoreSkill(target, candidate)
    if (m.score >= 0.2) matches.push(m)
  }
  // 排序 + 截前 3
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, 3)
}

async function lookupSkill(registry: SkillRegistry, toolName: string): Promise<Skill | null> {
  if (registry.get) {
    const r = await registry.get(toolName)
    if (r) return r
  }
  const list = await registry.list()
  return list.find((s) => s.id === toolName || s.toolName === toolName) ?? null
}

/** 单元可测：单 skill 评分 */
export function scoreSkill(target: Skill | null, candidate: Skill): SkillMatch {
  let category = 0
  let schema = 0
  let description = 0
  if (target) {
    const c1 = categoryOf(target)
    const c2 = categoryOf(candidate)
    if (c1 && c2 && c1 === c2) category = 1
    else if (c1 && c2 && (c1.includes(c2) || c2.includes(c1))) category = 0.6
    schema = schemaOverlap(target, candidate)
    const tDesc = `${target.name} ${target.description}`
    const cDesc = `${candidate.name} ${candidate.description}`
    description = jaccard(tokenize(tDesc), tokenize(cDesc))
  }
  // 权重：category 0.4 + schema 0.4 + description 0.2
  const score = category * 0.4 + schema * 0.4 + description * 0.2
  return {
    skillId: candidate.id,
    name: candidate.name,
    score,
    reasons: { category, schema, description },
  }
}

/**
 * v0.14.0 Task 5.4 — 规则版影响判断（fallback）。
 * 当 LLM 因果分析超时 / 不可用时，使用本启发式：
 *  - 任一 following PlanItem 的 description / 包含「依赖前置」标记
 *    （例如「依赖 <上一步结果>」「基于前一步」「depends on」「requires」）
 *    → blocksFollowers = true
 *  - 否则 → false
 *
 * 接受任意形状 PlanItem（兼容不同字段命名），只读 description / text / id。
 */
export function staticDependencyBlocks(following: PlanItem[], _current: PlanItem): { blocksFollowers: boolean; reason: string } {
  if (!following || following.length === 0) return { blocksFollowers: false, reason: 'no following items' }
  const depsRe = /(依赖|前置|基于|以.+为基础|以.+为前提|depends on|depends on|requires|prerequisite|after .+ is done|继.+之后|等.+完成)/i
  const matched: string[] = []
  for (const item of following) {
    // PlanItem 本身只有 text 字段；依赖标记直接写在 text 中
    const text = item.text ?? ''
    if (depsRe.test(text)) matched.push(item.id)
  }
  if (matched.length > 0) {
    return {
      blocksFollowers: true,
      reason: `后续 PlanItem 依赖前置结果：${matched.join(', ')}`,
    }
  }
  return { blocksFollowers: false, reason: 'no explicit dependency marker in following items' }
}
