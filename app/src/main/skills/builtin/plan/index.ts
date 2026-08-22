import { join } from 'node:path'
import { delegateAgent } from '../../../agent/skills/delegate.js'
import { getWorkspaceDir } from '../../../store/db.js'
import { logger } from '../../../system/logger.js'
import type { SkillContext } from '../../../agent/registry.js'
import type { PlanItem } from '@shared/types/task'

export interface PlanArgs {
  taskName: string
  scope?: string
}

export interface PlanResult {
  planPath: string
  planItems: PlanItem[]
}

export const PROMPT_PLAN = `你是编码计划设计子 Agent。请根据任务名称和范围分析当前工作区，生成 plan.md，必须包含背景、实施步骤和每一步的验收点。使用 file-reader 阅读必要文件，并使用 shell 创建目录并写入文件。文件必须落盘到指定的 .arkwork/documents/<taskName>/plan.md；不要修改范围外的代码。完成后用 task_complete 摘要返回步骤列表。`

export async function plan(args: PlanArgs, ctx: SkillContext): Promise<PlanResult | { status: 'failed'; error: string }> {
  try {
    const taskName = args.taskName?.trim()
    if (!taskName) return { status: 'failed', error: 'plan: taskName 不能为空' }
    const workspace = ctx.workspaceDir ?? getWorkspaceDir()
    const directory = join(workspace, '.arkwork', 'documents', taskName)
    const result = await delegateAgent({
      agentId: '@coder',
      task: `${PROMPT_PLAN}\n\n任务名称：${taskName}\n范围：${args.scope?.trim() || '未指定'}\n目标目录：${directory}`,
    }, ctx)
    if (result.status !== 'done') return { status: 'failed', error: result.summary }
    const planItems = parseSummaryToPlanItems(result.summary, taskName)
    logger.info('Tool', `plan: generated ${join(directory, 'plan.md')}`, ctx.taskId)
    return { planPath: join(directory, 'plan.md'), planItems }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Tool', `plan failed: ${error}`, ctx.taskId)
    return { status: 'failed', error }
  }
}

function parseSummaryToPlanItems(summary: string, taskName: string): PlanItem[] {
  const lines = summary.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+[.)])\s+/.test(line))
  const now = Date.now()
  return lines.map((line, index) => ({
    id: `${taskName}#pi${index + 1}`,
    text: line.replace(/^(?:[-*]|\d+[.)])\s+/, '').trim(),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }))
}
