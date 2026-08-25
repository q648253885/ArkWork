/* ============================================================
 * ArkWork — Builtin Skill: kb-search（v0.8.0 F812 §5.1）
 * 检索知识库切块——Agent 自主消费的主路径。
 * 检索范围 = 当前任务启用的知识库集合（task.kbIds，缺省继承面板 enabled）。
 * 无任何启用时返回引导提示而非报错。
 * 设计文档：versions/v0.8.0/02-knowledge-base.md §5.1
 *
 * Task 8：知识库启用可关闭
 *  - 全局关闭（settings.kbEnabled=false）→ 直接返回 hint，不再注入上下文
 *  - 会话级关闭（skill context.kbSessionEnabled=false）→ 同上
 * ============================================================ */
import { searchKb } from '../../kb/index.js'
import { listEnabledKb } from '../../kb/store.js'
import { getSettings } from '../../ipc/settings.js'
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'

export interface KbSearchArgs {
  query: string
  limit?: number
}

export interface KbSearchSkillResult {
  query: string
  total: number
  hits: Array<{
    kbName: string
    seq: number
    snippet: string
  }>
  /** 各种跳过场景的引导提示 */
  hint?: string
  /** Task 8：标记是否被禁用（关闭态） */
  disabled?: boolean
}

export async function kbSearch(
  args: KbSearchArgs,
  ctx: SkillContext,
): Promise<KbSearchSkillResult> {
  const query = (args.query ?? '').trim()
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 20)
  if (!query) {
    throw new Error('kb-search: query 不能为空')
  }

  // Task 8：全局开关（settings.json 持久化）—— 关闭后立即生效，无需重启
  const settings = await getSettings()
  if (settings.kbEnabled === false) {
    logger.info('Tool', `kb-search: global toggle off, hint returned`, ctx.taskId)
    return {
      query,
      total: 0,
      hits: [],
      disabled: true,
      hint: '知识库已在全局设置中关闭（设置 → 知识库）。如需检索请重新开启。',
    }
  }

  // Task 8：会话级开关（运行时由 ctx 字段传入）—— 切换任务/会话互不影响
  if (ctx.kbSessionEnabled === false) {
    logger.info('Tool', `kb-search: session toggle off, hint returned`, ctx.taskId)
    return {
      query,
      total: 0,
      hits: [],
      disabled: true,
      hint: '当前会话已关闭知识库注入。可在 Composer 上下文面板的知识库开关处重新开启。',
    }
  }

  // 确定检索范围：task.kbIds 优先，缺省用面板 enabled 集合
  let kbIds: string[] | null = ctx.task?.kbIds ?? null
  if (!kbIds || kbIds.length === 0) {
    const enabled = await listEnabledKb()
    kbIds = enabled.map((k) => k.id)
  }

  if (kbIds.length === 0) {
    logger.info('Tool', `kb-search: no KB enabled, hint returned`, ctx.taskId)
    return {
      query,
      total: 0,
      hits: [],
      hint: '当前未启用任何知识库。请用户在 Composer 的知识库 chip 中勾选，或用 kb-enable 工具启用。',
    }
  }

  logger.info('Tool', `kb-search: "${query}" (kbIds=${kbIds.length}, limit=${limit})`, ctx.taskId)
  const hits = await searchKb(query, kbIds, limit)
  return {
    query,
    total: hits.length,
    hits: hits.map((h) => ({
      kbName: h.kbName,
      seq: h.seq,
      snippet: h.text,
    })),
  }
}
