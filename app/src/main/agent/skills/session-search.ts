/* ============================================================
 * ArkWork — Builtin Skill: session-search（v0.8.0 F803 §5.2）
 * 检索 L3b 档案记忆——Agent 显式调用，返回 top-N 命中片段。
 * 档案「只搜不注」：命中后由 Agent 决定是否复述引用，档案不自动注入。
 * 设计文档：versions/v0.8.0/01-memory.md §5.2
 * ============================================================ */
import { searchArchive } from '../../memory/l3-archive.js'
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'

export interface SessionSearchArgs {
  query: string
  limit?: number
}

export interface SessionSearchResult {
  query: string
  total: number
  hits: Array<{
    taskId: string
    taskTitle: string
    snippet: string
    createdAt: number
  }>
}

export async function sessionSearch(
  args: SessionSearchArgs,
  ctx: SkillContext,
): Promise<SessionSearchResult> {
  const query = (args.query ?? '').trim()
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 20)
  if (!query) {
    throw new Error('session-search: query 不能为空')
  }

  logger.info('Tool', `session-search: "${query}" (limit=${limit})`, ctx.taskId)
  const hits = await searchArchive(query, limit)
  return {
    query,
    total: hits.length,
    hits: hits.map((h) => ({
      taskId: h.taskId,
      taskTitle: h.taskTitle,
      snippet: h.snippet,
      createdAt: h.createdAt,
    })),
  }
}
