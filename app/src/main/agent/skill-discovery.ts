/* ============================================================
 * ArkWork — 技能分层发现（v0.19.0 M5）
 * 借鉴 Claude Code / dsh 的技能分层：
 * 按 [workspace/.arkwork/skills, {arkworkDir}/skills, bundled] 顺序扫描，
 * 同名 id 最近层获胜（project > user > bundled）。
 *
 * 职责：
 *  - 扫描三层技能来源，打 layer 标签
 *  - 按 id 去重 + 遮蔽（高优先级层覆盖低优先级层）
 *  - 可选按 agentId 作用域过滤（scopes 空 = 全局）
 * 副作用：读文件系统。
 * ============================================================ */
import { join } from 'node:path'
import { readdir, stat, readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { builtinSkills } from '../store/seed.js'
import { getArkworkDir } from '../store/db.js'
import type { Skill } from '@shared/types/agent'

export type SkillLayer = 'project' | 'user' | 'bundled' | 'runtime'

/** 层优先级（索引越大越优先）；遮蔽时高优先级覆盖低优先级同名 id */
const LAYER_PRECEDENCE: SkillLayer[] = ['bundled', 'user', 'project', 'runtime']

export interface SkillLayerGroup {
  layer: SkillLayer
  skills: Skill[]
}

/**
 * 纯函数：按层合并技能，同名 id 由高优先级层遮蔽低优先级层。
 * 副作用：无。
 */
export function mergeSkillsByLayer(groups: SkillLayerGroup[]): Skill[] {
  const precedence = new Map(LAYER_PRECEDENCE.map((l, i) => [l, i]))
  const byId = new Map<string, Skill>()
  for (const group of groups) {
    const p = precedence.get(group.layer) ?? -1
    for (const skill of group.skills) {
      const existing = byId.get(skill.id)
      const existingP = existing ? (precedence.get(existing.layer ?? 'user') ?? -1) : -1
      if (!existing || p > existingP) {
        byId.set(skill.id, { ...skill, layer: group.layer })
      }
    }
  }
  return [...byId.values()]
}

/** 相对路径转绝对路径（保持与 registry 旧逻辑一致：/ 或盘符开头的视为绝对） */
function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:/.test(p)
}

/**
 * 纯函数：按作用域过滤。scopes 为空/缺省 = 全局可见；
 * 否则仅当 scopes 包含 agentId 时可见。
 * 副作用：无。
 */
export function filterSkillsByScope(skills: Skill[], agentId?: string): Skill[] {
  if (!agentId) return skills
  return skills.filter((s) => {
    const scopes = s.scopes ?? []
    return scopes.length === 0 || scopes.includes(agentId)
  })
}

/** 扫描单个目录下的技能（skill.json 格式 A + SKILL.md-only 格式 B） */
async function scanFolder(dir: string): Promise<Skill[]> {
  const result: Skill[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return result
  }
  for (const name of entries) {
    const sub = join(dir, name)
    try {
      if (!(await stat(sub)).isDirectory()) continue
    } catch {
      continue
    }
    const skillJsonPath = join(sub, 'skill.json')
    if (existsSync(skillJsonPath)) {
      try {
        const raw = await readFile(skillJsonPath, 'utf-8')
        const skill = JSON.parse(raw) as Skill
        if (skill.enabled === undefined) skill.enabled = true
        if (skill.instructionMd && !isAbsolute(skill.instructionMd)) {
          skill.instructionMd = join(sub, skill.instructionMd)
        }
        result.push(skill)
      } catch {
        /* 跳过解析失败的 skill.json */
      }
      continue
    }
    if (existsSync(join(sub, 'SKILL.md'))) {
      const skill = parseSkillMdOnly(sub, name)
      if (skill) result.push(skill)
    }
  }
  return result
}

/** 解析 SKILL.md-only 目录（Anthropic/SkillHub 标准格式，与 registry 旧逻辑一致） */
function parseSkillMdOnly(dir: string, folderName: string): Skill | null {
  const mdPath = join(dir, 'SKILL.md')
  let raw: string
  try {
    raw = readFileSync(mdPath, 'utf-8')
  } catch {
    return null
  }
  let name = folderName
  let description = ''
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const nameMatch = fm[1].match(/^name:\s*(.+)$/m)
    const descMatch = fm[1].match(/^description:\s*(.+)$/m)
    if (nameMatch) name = nameMatch[1].trim()
    if (descMatch) description = descMatch[1].trim()
  }
  return {
    id: folderName,
    name,
    description: description || `${folderName}（SkillHub 技能）`,
    namespace: 'market',
    source: 'market',
    enabled: true,
    toolName: folderName,
    instructionMd: 'SKILL.md',
    inputSchema: { type: 'object', properties: {} },
    tags: ['skillhub'],
    installedFrom: `skillhub.${folderName}`,
  }
}

/** 内置技能（bundled 层）：解析相对 instructionMd 为绝对路径 */
function resolveBuiltinSkills(): Skill[] {
  return builtinSkills.map((s) => {
    if (s.instructionMd && !isAbsolute(s.instructionMd)) {
      // 仓库内置 SKILL.md：相对 app/src/main/skills/builtin/{id}/ 解析
      const builtinPath = join(getArkworkDir(), '..', '..', '..', s.instructionMd)
      return { ...s, instructionMd: builtinPath }
    }
    return s
  })
}

/** 项目层技能目录：{workspaceDir}/.arkwork/skills */
function projectSkillsDir(workspaceDir: string): string {
  return join(workspaceDir, '.arkwork', 'skills')
}

/**
 * 分层发现技能：扫描 project / user / bundled 三层并合并（project 遮蔽同名 user/bundled）。
 * @param workspaceDir 工作区根目录（用于定位 project 层）
 * @param agentId 可选：按技能 scopes 过滤（含 agentId 或空 scopes = 可见）
 */
export async function discoverSkills(workspaceDir: string, agentId?: string): Promise<Skill[]> {
  const project = await scanFolder(projectSkillsDir(workspaceDir))
  const user = await scanFolder(join(getArkworkDir(), 'skills'))
  const bundled = resolveBuiltinSkills()
  const merged = mergeSkillsByLayer([
    { layer: 'project', skills: project },
    { layer: 'user', skills: user },
    { layer: 'bundled', skills: bundled },
  ])
  if (!agentId) return merged
  return merged.filter((s) => {
    const scopes = s.scopes ?? []
    return scopes.length === 0 || scopes.includes(agentId)
  })
}
