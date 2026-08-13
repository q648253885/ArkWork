import { join } from 'node:path'
import { delegateAgent } from '../../../agent/skills/delegate.js'
import { getWorkspaceDir } from '../../../store/db.js'
import { logger } from '../../../system/logger.js'
import type { SkillContext } from '../../../agent/registry.js'

export interface SpecArgs {
  taskName: string
  scope?: string
}

export interface SpecResult {
  specPath: string
  tasksPath: string
  checklistPath: string
  goal: string
}

export const PROMPT_SPEC = `你是编码规格设计子 Agent。请根据任务名称和范围分析当前工作区，生成三件套文件：spec.md（目标、范围、约束、验收标准）、tasks.md（可执行任务拆分）和 checklist.md（验证清单）。使用 file-reader 阅读必要文件，并使用 shell 创建目录并写入文件。文件必须落盘到指定的 .arkwork/specs/<taskName>/ 目录；不要修改范围外的代码。完成后用 task_complete 摘要返回文件路径和任务目标。`

export async function spec(args: SpecArgs, ctx: SkillContext): Promise<SpecResult | { status: 'failed'; error: string }> {
  try {
    const taskName = args.taskName?.trim()
    if (!taskName) return { status: 'failed', error: 'spec: taskName 不能为空' }
    const workspace = ctx.workspaceDir ?? getWorkspaceDir()
    const directory = join(workspace, '.arkwork', 'specs', taskName)
    const result = await delegateAgent({
      agentId: '@coding',
      task: `${PROMPT_SPEC}\n\n任务名称：${taskName}\n范围：${args.scope?.trim() || '未指定'}\n目标目录：${directory}`,
    }, ctx)
    if (result.status !== 'done') return { status: 'failed', error: result.summary }
    const output: SpecResult = {
      specPath: join(directory, 'spec.md'),
      tasksPath: join(directory, 'tasks.md'),
      checklistPath: join(directory, 'checklist.md'),
      goal: result.summary,
    }
    logger.info('Tool', `spec: generated ${directory}`, ctx.taskId)
    return output
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('Tool', `spec failed: ${error}`, ctx.taskId)
    return { status: 'failed', error }
  }
}
