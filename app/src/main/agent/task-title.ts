/* ============================================================
 * ArkWork — Task Title Generator
 * v0.31.0 C2：任务标题由大模型生成（用户需求：任务清单中的标题
 * 不能都是「未命名任务」，标题需要模型根据任务内容生成）。
 *
 * 设计要点（docs/versions/v0.31.0/04-system-design.md §6.7）：
 *  - 挂点：runner.runTask 写入 running 并广播之后，fire-and-forget 调用，
 *    绝不阻塞主循环，失败静默（机械截断标题仍是兜底）。
 *  - 竞态协调：Task.titleSource 是唯一事实源 ——
 *      undefined = 占位/机械产物（可被 LLM 升级）
 *      'user'    = 用户手动命名，锁定不再覆盖
 *      'llm'     = 模型已生成，不再重生成
 *    写回前重读任务，titleSource 已被置位则放弃本次结果。
 *  - 素材来源：task.input.text。空壳任务（「新建任务」占位创建）由
 *    appendUserMessage 首条消息回填（见 store/tasks.ts）。
 *  - 清洗/占位判定纯函数在 task-title-clean.ts（零依赖，可直连单测）。
 * ============================================================ */
import { getAdapter } from '../llm/registry.js'
import { getTask, updateTask } from '../store/tasks.js'
import { broadcastTaskStatus } from './events.js'
import { logger } from '../system/logger.js'
import { MESSAGES } from '../i18n/messages.js'
import { cleanTitle, isPlaceholderTitleIn } from './task-title-clean.js'

export { cleanTitle, isPlaceholderTitleIn }

/** 生成超时（毫秒）：标题生成是低优先级旁路，超时即放弃。
 * v0.34.x 实测：45s。20s 会被小模型冷启动（首次加载 1GB 进显存）直接吃掉，
 * 真机 qwen3.5:0.8b 首任务标题必然 'Request was aborted'。 */
const TITLE_TIMEOUT_MS = 45_000
/**
 * 送给模型的素材上限（字符）
 * v0.34.x 修正：32 → 512。思考模型（qwen3.5 等）会先输出 `<think>` 思考再给
 * 标题，32 token 全被思考吃光 → finish=length、content 空 → 标题永远生成失败
 * （用户实测日志：'model returned empty/unusable output'）。
 */
const MATERIAL_MAX_CHARS = 500
const TITLE_MAX_TOKENS = 512

const TITLE_SYSTEM_PROMPT = [
  '你是任务命名助手。根据用户给出的任务描述，生成一个简短、具体的任务标题。',
  '规则：',
  '1. 只输出标题本身，禁止任何解释、引号、序号或句末标点',
  '2. 使用任务描述的主要语言（中文描述输出中文标题，英文输出英文，以此类推）',
  '3. 不超过 16 个字',
  '4. 反映任务的核心目标，而非复述原文',
].join('\n')

/**
 * 占位标题判定基准集合：遍历四语言 messages 取 'tasks.untitled' 的值
 * （未命名任务 / Untitled task / 無題タスク / 제목 없는 작업），
 * 避免硬编码某一国文字。惰性构建一次。
 */
let placeholderBases: string[] | null = null
function getPlaceholderBases(): string[] {
  if (!placeholderBases) {
    const bases = new Set<string>()
    for (const table of Object.values(MESSAGES)) {
      const v = table['tasks.untitled']
      if (v) bases.add(v)
    }
    placeholderBases = [...bases]
  }
  return placeholderBases
}

/** 判断 title 是否是「未命名任务」类占位标题（四语言 + 数字后缀） */
export function isPlaceholderTitle(title: string): boolean {
  return isPlaceholderTitleIn(title, getPlaceholderBases())
}

/**
 * 尝试为任务生成 LLM 标题（fire-and-forget，调用方用 void 调用）。
 *
 * 跳过条件：titleSource 已置位（user 锁定 / llm 已生成）或素材为空。
 * 成功路径：清洗 → 写回前重读任务（竞态保护）→ updateTask({title, titleSource:'llm'})
 *          → broadcastTaskStatus 刷新侧栏。
 * 失败路径：静默 logger.debug，保留原标题（机械截断兜底仍在）。
 */
export async function maybeGenerateTaskTitle(taskId: string): Promise<void> {
  try {
    const task = await getTask(taskId)
    if (!task) return
    // titleSource 已置位：用户手动命名或已生成过，不再覆盖
    if (task.titleSource) return
    const material = (task.input?.text ?? '').trim()
    if (!material) return

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
    try {
      const adapter = await getAdapter(task.modelId)
      // v0.34.x：空输出补试一次（思考模型偶发把预算吃满/端点毛刺 → content 空）
      let resp = await adapter.complete({
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: material.slice(0, MATERIAL_MAX_CHARS) }],
        temperature: 0.2,
        maxTokens: TITLE_MAX_TOKENS,
        signal: controller.signal,
      })
      // content 优先（思考模型的 thought 是推理过程，content 才是标题）
      let raw = resp.content?.trim() || resp.thought || ''
      let title = cleanTitle(raw)
      if (!title) {
        resp = await adapter.complete({
          system: TITLE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: material.slice(0, MATERIAL_MAX_CHARS) }],
          temperature: 0.2,
          maxTokens: TITLE_MAX_TOKENS,
          signal: controller.signal,
        })
        raw = resp.content?.trim() || resp.thought || ''
        title = cleanTitle(raw)
      }
      if (!title) {
        logger.debug('Agent', 'task title: model returned empty/unusable output', taskId)
        return
      }
      // 竞态保护：LLM 往返期间用户可能已手动改名（titleSource='user'），重读后放弃
      const latest = await getTask(taskId)
      if (!latest || latest.titleSource) return
      const updated = await updateTask(taskId, { title, titleSource: 'llm' })
      if (updated) {
        broadcastTaskStatus(updated)
        logger.info('Agent', `task title generated: "${title}"`, taskId)
      }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    // 静默：标题生成是旁路增强，任何失败（无模型/网络/超时/中止）都不影响主流程
    logger.debug('Agent', `task title generate skipped: ${(err as Error).message}`, taskId)
  }
}
