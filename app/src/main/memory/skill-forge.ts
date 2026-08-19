/* ============================================================
 * ArkWork — 技能创建严格管线（v0.25.0 F3 / 设计文档 §5.3）
 *
 * 五阶段：候选发现 → AI 价值评估 → 起草 → 完整性校验 → 注册
 *   ├ 评估未通过（不够常用 / 未验证有效）→ 终止
 *   ├ 起草为空 / 校验任一不过 → 隔离区（quarantine）
 *   └ 校验通过 → 注册到 {arkworkDir}/skills/{id}/
 *
 * 隔离区：{arkworkDir}/skills-quarantine/{id}/（SKILL.md + report.json）；
 * 不注册、不可被发现；保留最新 20 条。
 *
 * 设计原则：
 *  - L1 不再是蒸馏源；L2 步骤文件作为唯一合法候选证据（且必须 ≥1 条）
 *  - 候选仅在 task-done 时机评估（不再按规模门槛自动触发）
 *  - 评估与起草共用一次 LLM 调用（双条件 + 草案合并 prompt）
 * ============================================================ */
import { readFile, writeFile, readdir, mkdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { getArkworkDir, getTaskDir } from '../store/db.js'
import { listRawL2 } from './l2-file.js'
import { getAdapter } from '../llm/registry.js'
import { logger } from '../system/logger.js'
import { discoverSkills } from '../agent/skill-discovery.js'
import { convertToSkill } from './convert.js'
import type { Skill } from '@shared/types/agent'

/** SKILL.md frontmatter 解析（独立函数：仅 name/description，避开 gates.ts 的 F1 字段） */
function parseNameDesc(md: string): { name?: string; description?: string } {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return {}
  return {
    name: fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim(),
  }
}

/* ============================================================
 * 类型契约
 * ============================================================ */

export interface SkillCandidate {
  taskId: string
  /** 候选证据：L2 步骤文件路径集合（完整读取，不截断） */
  evidencePaths: string[]
  /** 触发来源：当前仅 'task-done'（按设计文档 §5.3） */
  trigger: 'task-done'
}

export interface ValueJudgement {
  pass: boolean
  /**
   * 双条件：
   *  - reusable：跨任务可复用（多处相似任务能复用同一套步骤）
   *  - effective：已验证解决问题（如排错成功闭环 / 用户确认有效）
   */
  reusable: { pass: boolean; reason: string }
  effective: { pass: boolean; reason: string }
  /** 起草的 SKILL.md 全文（评估通过时一并返回，避免二次 LLM 调用） */
  skillMd: string
}

export interface SkillIntegrityReport {
  pass: boolean
  checks: Array<{ id: string; pass: boolean; detail: string }>
}

export interface ForgePipelineResult {
  /** 评估 / 起草 / 校验 / 注册 任一阶段失败的原因 */
  reason: string
  /** 注册成功时返回的技能 */
  skill?: Skill
  /** 进入隔离区的路径（评估未通过时不入隔离） */
  quarantinePath?: string
  /** 阶段标识：candidate → value-judge → draft → integrity → register | quarantine | terminated */
  stage: string
}

/* ============================================================
 * 阶段 1：候选发现
 * ============================================================ */

/**
 * 收集任务 L2 步骤产物作为候选证据。无 L2 → 返回 null（不进入评估）。
 * 设计文档 §5.3：L2 步骤目录为空 → 不评估（避免"凭空起草"）。
 */
export async function discoverSkillCandidates(taskId: string): Promise<SkillCandidate | null> {
  const artifacts = await listRawL2(taskId)
  if (artifacts.length === 0) return null
  return {
    taskId,
    evidencePaths: artifacts.map((a) => a.path),
    trigger: 'task-done',
  }
}

/* ============================================================
 * 阶段 2：AI 价值评估（合并起草以减少 LLM 调用）
 * ============================================================ */

const JUDGE_SYSTEM_PROMPT = `你是 ArkWork 技能创建评估助手。基于任务证据评估是否值得提炼为可复用技能。

评估双条件（必须都满足才算 pass）：
  1. reusable（跨任务可复用）：证据显示该步骤能复用于其他相似任务，而非一次性特例。
  2. effective（已验证解决问题）：证据含闭环信号（排错成功 / 用户确认 / 测试通过 / 部署上线等）。

仅返回 JSON（无其他文字）：
{
  "reusable": { "pass": true|false, "reason": "<一句话理由>" },
  "effective": { "pass": true|false, "reason": "<一句话理由>" },
  "skillMd": "---完整 SKILL.md---"
}

SKILL.md 格式（draft 必须遵循）：
---
name: <skill-id-name>
description: <一句话描述>
---
# <技能标题>
## 适用场景
<一段话说明何时使用，含触发关键词>
## 步骤 / 检查清单
1. <具体步骤>
2. <具体步骤>
## 注意事项
- <关键约束/踩坑要点>

skillMd 字段：若双条件任一不过则返回空字符串；通过则填写完整 SKILL.md（含 frontmatter）。`

/**
 * 一次 LLM 调用完成双条件评估 + 起草。
 * LLM 调用失败 → pass:false（宁缺毋滥）。
 */
export async function judgeSkillValue(
  candidate: SkillCandidate,
  modelId: string,
): Promise<ValueJudgement> {
  try {
    const evidenceTexts = await Promise.all(
      candidate.evidencePaths.map(async (p) => {
        try {
          const raw = await readFile(p, 'utf-8')
          return `[${basename(p)}]\n${raw.slice(0, 8000)}`
        } catch {
          return `[${basename(p)}]: <unreadable>`
        }
      }),
    )
    const userPrompt = `任务 ${candidate.taskId} 的 L2 证据：\n\n${evidenceTexts.join('\n\n---\n\n')}`

    const adapter = await getAdapter(modelId)
    const resp = await adapter.complete({
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.2,
      maxTokens: 2000,
    })
    return parseJudgeResponse(resp.content)
  } catch (err) {
    logger.warn('Memory', `judgeSkillValue failed: ${(err as Error).message}`, candidate.taskId)
    return {
      pass: false,
      reusable: { pass: false, reason: 'LLM 调用失败' },
      effective: { pass: false, reason: 'LLM 调用失败' },
      skillMd: '',
    }
  }
}

function parseJudgeResponse(raw: string): ValueJudgement {
  // 优先尝试匹配 ```json ... ``` 围栏；其次退化为 { ... } 子串
  const fenced = raw.match(/```json\s*([\s\S]*?)```/) ?? raw.match(/```\s*([\s\S]*?)```/)
  const jsonStr = fenced ? fenced[1] : extractJsonObject(raw)
  if (!jsonStr) {
    return emptyJudge('LLM 输出无法解析')
  }
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>
    const reusable = (obj.reusable ?? {}) as { pass?: boolean; reason?: string }
    const effective = (obj.effective ?? {}) as { pass?: boolean; reason?: string }
    const skillMd = typeof obj.skillMd === 'string' ? obj.skillMd.trim() : ''
    const pass = !!reusable.pass && !!effective.pass && skillMd.length > 0
    return {
      pass,
      reusable: { pass: !!reusable.pass, reason: reusable.reason ?? '' },
      effective: { pass: !!effective.pass, reason: effective.reason ?? '' },
      skillMd,
    }
  } catch {
    return emptyJudge('JSON 解析失败')
  }
}

function emptyJudge(reason: string): ValueJudgement {
  return {
    pass: false,
    reusable: { pass: false, reason },
    effective: { pass: false, reason },
    skillMd: '',
  }
}

function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  return s.slice(start, end + 1)
}

/* ============================================================
 * 阶段 3：完整性校验（纯函数，不调 LLM）
 * ============================================================ */

/**
 * 五项完整性校验：
 *  1 frontmatter-valid   name/description 合法
 *  2 body-nonempty       指令体非空且 ≥200 字（最小信息量）
 *  3 structure-complete  含「适用场景 + 步骤/检查清单」两要素（结构性校验）
 *  4 discoverable        经 skill-discovery 扫描可被发现
 *  5 no-conflict         id/name 与现有技能不冲突
 */
export async function verifySkillIntegrity(skillMd: string, workspaceDir?: string): Promise<SkillIntegrityReport> {
  const checks: SkillIntegrityReport['checks'] = []

  // 1. frontmatter 合法
  const fm = parseNameDesc(skillMd)
  const fmValid = !!fm.name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fm.name)
  checks.push({
    id: 'frontmatter-valid',
    pass: fmValid,
    detail: fmValid ? `name=${fm.name}` : `frontmatter 缺失或 name 不合法`,
  })

  // 2. 指令体非空且 ≥200 字
  const body = skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
  const bodyLen = body.replace(/\s+/g, '').length
  checks.push({
    id: 'body-nonempty',
    pass: bodyLen >= 200,
    detail: `指令体 ${bodyLen} 字（≥200）`,
  })

  // 3. 结构完整（适用场景 + 步骤/检查清单）
  const hasScenario = /适用场景|适用情况|使用场景|when to use/i.test(body)
  const hasSteps = /步骤|检查清单|step|checklist/i.test(body)
  checks.push({
    id: 'structure-complete',
    pass: hasScenario && hasSteps,
    detail: `scenario=${hasScenario}, steps=${hasSteps}`,
  })

  // 4. 可被发现（id 由 frontmatter.name 派生）
  const discoverable = !!fm.name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(fm.name)
  checks.push({
    id: 'discoverable',
    pass: discoverable,
    detail: discoverable ? 'id 合法可扫描' : 'id 不合法，skill-discovery 无法发现',
  })

  // 5. 不冲突（与现有技能 name/id 比较）
  let noConflict = true
  let conflictDetail = '无冲突'
  if (fm.name) {
    try {
      const existing = await discoverSkills(workspaceDir ?? process.cwd())
      const dup = existing.find((s) => s.id === fm.name || s.name === fm.name)
      if (dup) {
        noConflict = false
        conflictDetail = `与现有技能冲突：${dup.id} / ${dup.name}`
      }
    } catch (err) {
      // discovery 失败不阻塞校验（保留其他四项）
      logger.warn('Memory', `discoverSkills failed during integrity check: ${(err as Error).message}`)
      conflictDetail = `discover 失败：${(err as Error).message}`
    }
  }
  checks.push({
    id: 'no-conflict',
    pass: noConflict,
    detail: conflictDetail,
  })

  return { pass: checks.every((c) => c.pass), checks }
}

/* ============================================================
 * 阶段 4：注册（落盘到 {arkworkDir}/skills/{id}/）
 * ============================================================ */

/**
 * 校验通过后落盘并注册（委托 convertToSkill；该函数已实现 SKILL.md 落盘 + skill 注册）。
 */
export async function registerForgedSkill(skillMd: string, taskId: string): Promise<Skill> {
  const result = await convertToSkill({ kind: 'l1', taskId, content: skillMd }, skillMd)
  return result.skill
}

/* ============================================================
 * 阶段 5：隔离区（评估未通过 / 起草失败 / 校验失败）
 * ============================================================ */

const QUARANTINE_DIR = 'skills-quarantine'
const QUARANTINE_MAX = 20

export async function quarantineSkill(
  skillMd: string,
  report: { reason: string; checks?: SkillIntegrityReport['checks']; judgement?: ValueJudgement },
  taskId: string,
): Promise<string> {
  const dir = join(getArkworkDir(), QUARANTINE_DIR)
  await mkdir(dir, { recursive: true })
  const id = `qf_${Date.now()}_${taskId.slice(-6)}`
  const subdir = join(dir, id)
  await mkdir(subdir, { recursive: true })
  await writeFile(join(subdir, 'SKILL.md'), skillMd, 'utf-8')
  await writeFile(
    join(subdir, 'report.json'),
    JSON.stringify(
      {
        taskId,
        reason: report.reason,
        checks: report.checks ?? [],
        judgement: report.judgement ?? null,
        createdAt: Date.now(),
      },
      null,
      2,
    ),
    'utf-8',
  )
  // 超出上限保留最新 20 条
  await pruneQuarantine(dir)
  logger.info('Memory', `skill-forge quarantined: ${subdir} (${report.reason})`, taskId)
  return subdir
}

async function pruneQuarantine(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir)
    const dirs = await Promise.all(
      entries.map(async (name) => {
        const full = join(dir, name)
        try {
          const st = await stat(full)
          return st.isDirectory() ? { name, mtime: st.mtimeMs, full } : null
        } catch {
          return null
        }
      }),
    )
    const filtered = dirs.filter((d): d is { name: string; mtime: number; full: string } => !!d)
    filtered.sort((a, b) => b.mtime - a.mtime)
    for (const old of filtered.slice(QUARANTINE_MAX)) {
      await rm(old.full, { recursive: true, force: true })
    }
  } catch {
    // prune 失败静默
  }
}

/* ============================================================
 * 管线编排：runForSkillForge(taskId, modelId)
 * ============================================================ */

/**
 * 完整五阶段管线入口。仅在任务完成时由 runDoneMemoryHooks 触发。
 * 返回每阶段结果（成功 / 终止原因 / 隔离路径）。
 */
export async function runForSkillForge(taskId: string, modelId: string): Promise<ForgePipelineResult> {
  // 阶段 1：候选发现
  const candidate = await discoverSkillCandidates(taskId)
  if (!candidate) {
    return { reason: '无 L2 产物，跳过评估', stage: 'candidate' }
  }

  // 阶段 2：价值评估 + 起草（一次 LLM 调用）
  const judgement = await judgeSkillValue(candidate, modelId)
  if (!judgement.pass || !judgement.skillMd) {
    return {
      reason: `蒸馏评估未通过：reusable=${judgement.reusable.reason || 'N/A'}；effective=${judgement.effective.reason || 'N/A'}`,
      stage: 'value-judge',
    }
  }

  // 阶段 3：完整性校验
  const integrity = await verifySkillIntegrity(judgement.skillMd)
  if (!integrity.pass) {
    const failed = integrity.checks.filter((c) => !c.pass).map((c) => `${c.id}(${c.detail})`).join('; ')
    const qf = await quarantineSkill(
      judgement.skillMd,
      { reason: `完整性校验失败：${failed}`, checks: integrity.checks, judgement },
      taskId,
    )
    return {
      reason: `完整性校验失败：${failed}`,
      stage: 'integrity',
      quarantinePath: qf,
    }
  }

  // 阶段 4：注册
  try {
    const skill = await registerForgedSkill(judgement.skillMd, taskId)
    logger.info('Memory', `skill-forge registered: ${skill.id} (from ${taskId})`, taskId)
    return { reason: `已自动蒸馏为技能「${skill.name}」`, skill, stage: 'register' }
  } catch (err) {
    const qf = await quarantineSkill(
      judgement.skillMd,
      { reason: `注册失败：${(err as Error).message}`, checks: integrity.checks, judgement },
      taskId,
    )
    return {
      reason: `注册失败：${(err as Error).message}`,
      stage: 'register',
      quarantinePath: qf,
    }
  }
}

/* ============================================================
 * 隔离区查询（供 UI 查看 / 重试 / 删除）
 * ============================================================ */

export interface QuarantineEntry {
  id: string
  path: string
  reason: string
  createdAt: number
}

export async function listQuarantine(): Promise<QuarantineEntry[]> {
  const dir = join(getArkworkDir(), QUARANTINE_DIR)
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  const out: QuarantineEntry[] = []
  for (const name of names) {
    const full = join(dir, name)
    try {
      const reportPath = join(full, 'report.json')
      const raw = await readFile(reportPath, 'utf-8')
      const report = JSON.parse(raw) as { reason: string; createdAt: number }
      out.push({ id: name, path: full, reason: report.reason, createdAt: report.createdAt })
    } catch {
      // 跳过无 report.json 的目录
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteQuarantineEntry(id: string): Promise<void> {
  const dir = join(getArkworkDir(), QUARANTINE_DIR, id)
  if (!existsSync(dir)) return
  await rm(dir, { recursive: true, force: true })
}
