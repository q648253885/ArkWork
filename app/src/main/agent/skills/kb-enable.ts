/* ============================================================
 * ArkWork — Builtin Skill: kb-enable（v0.8.0 F813 §6.2）
 * Agent 自主调用——当用户要求"使用知识库"但任务未启用任何条目时，
 * Agent 通过 ask_user 确认后调用本工具为当前任务启用知识库。
 * 设计文档：versions/v0.8.0/02-knowledge-base.md §6.2
 * ============================================================ */
import { listKb } from '../../kb/store.js'
import { updateTask } from '../../store/tasks.js'
import { getSettings } from '../../ipc/settings.js'
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'

export interface KbEnableArgs {
  /** 要启用的知识库 id 集合；缺省或空表示启用全部已解析成功的条目 */
  kbIds?: string[]
}

export interface KbEnableResult {
  taskId: string
  enabledKbIds: string[]
  enabledNames: string[]
  /** Task 8：标记是否被禁用（全局/会话级关闭态） */
  disabled?: boolean
  /** 关闭态下的引导提示 */
  hint?: string
}

export async function kbEnable(
  args: KbEnableArgs,
  ctx: SkillContext,
): Promise<KbEnableResult> {
  if (!ctx.task) {
    throw new Error('kb-enable: 缺少任务上下文')
  }

  // Task 8：遵守全局开关与会话级开关——任一关闭时不允许 Agent 自行重新打开，
  // 返回引导提示让用户去设置/上下文面板开启（保证"启用后可关闭"链路不可被反向绕过）。
  const settings = await getSettings()
  if (settings.kbEnabled === false) {
    logger.info('Tool', 'kb-enable: global toggle off, skipped', ctx.taskId)
    return {
      taskId: ctx.task.id,
      enabledKbIds: [],
      enabledNames: [],
      disabled: true,
      hint: '知识库已在全局设置中关闭（设置 → 知识库）。如需使用请先在设置中重新开启。',
    }
  }
  if (ctx.kbSessionEnabled === false) {
    logger.info('Tool', 'kb-enable: session toggle off, skipped', ctx.taskId)
    return {
      taskId: ctx.task.id,
      enabledKbIds: [],
      enabledNames: [],
      disabled: true,
      hint: '当前会话已关闭知识库注入。如需使用请在上下文面板的知识库开关处重新开启。',
    }
  }

  const allKb = await listKb()
  const available = allKb.filter((k) => !k.parseError)

  let toEnable: string[]
  if (args.kbIds && args.kbIds.length > 0) {
    // 验证 id 有效
    const validIds = new Set(available.map((k) => k.id))
    toEnable = args.kbIds.filter((id) => validIds.has(id))
    if (toEnable.length === 0) {
      throw new Error('kb-enable: 指定的知识库 id 均无效或未解析成功')
    }
  } else {
    // 缺省启用全部可用
    toEnable = available.map((k) => k.id)
  }

  // 合并已有 kbIds（避免覆盖用户已勾选的）
  const existing = ctx.task.kbIds ?? []
  const merged = [...new Set([...existing, ...toEnable])]

  await updateTask(ctx.task.id, { kbIds: merged })

  const enabledNames = available
    .filter((k) => merged.includes(k.id))
    .map((k) => k.name)

  logger.info('Tool', `kb-enable: task ${ctx.task.id} now has ${merged.length} KBs`, ctx.taskId)
  return {
    taskId: ctx.task.id,
    enabledKbIds: merged,
    enabledNames,
  }
}
