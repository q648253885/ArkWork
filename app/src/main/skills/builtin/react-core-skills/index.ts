/* ============================================================
 * ArkWork — react-core-skills Skill: index (v0.15.0)
 * 准则型技能：读取同目录 SKILL.md 并返回作为 instruction 注入系统提示词。
 * 行为：当被调用时读取 SKILL.md 内容并返回，由 registry 渐进式披露
 * 链路（additionalSystemHint）+ 本 handler 返回值共同保证准则生效。
 * ============================================================ */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { logger } from '../../../system/logger.js'
import type { SkillContext } from '../../../agent/registry.js'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_MD_PATH = join(MODULE_DIR, 'SKILL.md')

export interface ReactCoreSkillsArgs {
  /** 软件开发任务描述（用于场景路由） */
  task?: string
}

export interface ReactCoreSkillsResult {
  instruction: string
}

/**
 * 读取 SKILL.md 准则内容并返回作为 instruction 注入。
 * registry.invokeSkill 在调用本 handler 前已将 instructionMd 读入
 * ctx.additionalSystemHint（渐进式披露）；本 handler 显式返回准则文本，
 * 供 LLM 在工具结果中同步获得完整指令。
 */
export async function reactCoreSkills(
  _args: ReactCoreSkillsArgs,
  ctx: SkillContext,
): Promise<ReactCoreSkillsResult | { status: 'failed'; error: string }> {
  try {
    const instruction = await readFile(SKILL_MD_PATH, 'utf-8')
    logger.info(
      'Tool',
      `react-core-skills: loaded instruction (${instruction.length} chars)`,
      ctx.taskId,
    )
    return { instruction }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Tool', `react-core-skills failed: ${error}`, ctx.taskId)
    return { status: 'failed', error }
  }
}
