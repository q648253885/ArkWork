/* ============================================================
 * ArkWork — 记忆转化：手动转化落盘（v0.8.0 F805 §7.1）
 * L3/L4 条目 → 技能 / 知识库（用户可控的保底路径）。
 *  - 转技能：LLM 起草 SKILL.md → 用户确认 → 落盘到 {arkworkDir}/skills/{id}/，
 *    注册 source:'custom'、tags:['distilled']；源 L1 条目标记 distilled.target='skill'
 *  - 转知识库：条目导出为 md 文件存入 {workspace}/.arkwork/kb/files/，
 *    Module 2 的 KB store 将扫描并索引；源 L1 条目标记 distilled.target='kb'
 * 设计文档：versions/v0.8.0/01-memory.md §7.1
 * ============================================================ */
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getArkworkDir, getWorkspaceDir } from '../store/db.js'
import { genId } from '@shared/utils/id'
import { writeSkillToFolder } from '../agent/registry.js'
import { markL1Distilled } from './l1-working.js'
import { logger } from '../system/logger.js'
import { broadcast } from '../window.js'
import type { Skill } from '@shared/types/agent'

/** 转化源——记录来源类型与内容，用于落盘与流向标记 */
export interface ConvertSource {
  /** 来源记忆条目类型 */
  kind: 'l1' | 'l3a' | 'l3b' | 'l4'
  /** 来源 L1 条目 id（仅 kind='l1' 时用于标记 distilled 流向） */
  l1ItemId?: string
  /** 来源条目所属任务（仅 kind='l1' 时用于定位 L1） */
  taskId?: string
  /** 待转化的内容文本 */
  content: string
}

export interface ConvertToSkillResult {
  skill: Skill
  skillMd: string
}

/**
 * 转化为技能——落盘 SKILL.md 到 skills 目录并注册。
 * 落盘位置：{arkworkDir}/skills/{id}/（registry 实际扫描位置，与既有自定义技能一致）。
 * 设计文档写 {workspace}/.arkwork/skills/，但 registry 扫描 {arkworkDir}/skills/，
 * 且改动清单未列 registry.ts——为一致性，蒸馏技能落 {arkworkDir}/skills/。
 * @param source - 转化源
 * @param skillMd - 用户在向导中确认的 SKILL.md 全文
 */
export async function convertToSkill(
  source: ConvertSource,
  skillMd: string,
): Promise<ConvertToSkillResult> {
  const parsed = parseSkillFrontmatter(skillMd)
  const skillId = `S-distill.${genId('s').slice(-8)}`
  const skill: Skill = {
    id: skillId,
    name: parsed.name || `蒸馏技能-${skillId.slice(-4)}`,
    description: parsed.description || '从任务经验蒸馏的可复用技能',
    namespace: 'custom',
    source: 'custom',
    builtinHandler: undefined,
    inputSchema: { type: 'object', properties: {} },
    enabled: true,
    instructionMd: 'SKILL.md',
    tags: ['distilled'],
    installedFrom: `distilled.${source.taskId ?? 'unknown'}`,
  }

  await writeSkillToFolder(skill, skillMd)
  logger.info('Memory', `convert → skill ${skillId} (from ${source.kind})`, source.taskId)

  // 标记源 L1 条目的流向（仅 L1 来源）
  if (source.kind === 'l1' && source.l1ItemId && source.taskId) {
    await markL1Distilled(source.taskId, source.l1ItemId, 'skill', skillId)
  }

  broadcast('memory:changed', source.taskId ?? '')
  return { skill, skillMd }
}

export interface ConvertToKbResult {
  kbFileId: string
  filePath: string
  /** 写入的 markdown 内容 */
  content: string
}

/**
 * 转化为知识库条目——把内容导出为 md 文件存入 KB 文件目录。
 * {workspace}/.arkwork/kb/files/{id}.md（Module 2 的 KB store 会扫描并索引）。
 * @param source - 转化源
 */
export async function convertToKb(source: ConvertSource): Promise<ConvertToKbResult> {
  const kbFileId = `kb_${genId('f').slice(-8)}`
  const filePath = join(getWorkspaceDir(), '.arkwork', 'kb', 'files', `${kbFileId}.md`)
  const content = `# 蒸馏记忆条目\n\n> 来源：${source.kind}${source.taskId ? ` · 任务 ${source.taskId}` : ''}\n\n${source.content}\n`

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
  logger.info('Memory', `convert → kb ${kbFileId} (from ${source.kind})`, source.taskId)

  // 标记源 L1 条目的流向
  if (source.kind === 'l1' && source.l1ItemId && source.taskId) {
    await markL1Distilled(source.taskId, source.l1ItemId, 'kb', kbFileId)
  }

  broadcast('memory:changed', source.taskId ?? '')
  return { kbFileId, filePath, content }
}

/** 解析 SKILL.md frontmatter 的 name / description */
function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return {}
  const nameMatch = fm[1].match(/^name:\s*(.+)$/m)
  const descMatch = fm[1].match(/^description:\s*(.+)$/m)
  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
  }
}
