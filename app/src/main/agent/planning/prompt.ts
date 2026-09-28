/* ============================================================
 * ArkWork — 规划通道提示词（v0.39.0 · F1）
 *
 * 三条设计约束（都来自 v0.38.x 的实测教训）：
 *   ① **不使用 ReAct 模板**（`Thought:` / `Observation:`）。Qwen 官方明确警示
 *      「推理模型应避免 ReAct 风格模板，因 stopword 冲突」，而这恰好与我们观测到
 *      的「qwen3.5 思考后不吐工具调用」现象吻合（假设 H1）。
 *   ② **不提任何工具名**：这是一次没有工具的调用，提工具等于诱导模型写伪调用。
 *   ③ **禁止自证完成**：显式要求「没做过的不要标 done」，与解析器的 S1 双保险。
 * ============================================================ */
import type { PlannerRequest } from './types.js'
import { PLANNER_MAX_ITEMS } from './types.js'
import { renderFailureDigest } from './digest.js'

/**
 * 输出契约，三个变体共用。
 * v0.39.0：导出供契约用例断言（TC-PLANCH-011 必须能证明"契约真的进了 system"）。
 */
export const OUTPUT_CONTRACT = `【输出格式】
只返回一个 JSON 数组，每项含两个字段：
  · "text"：动宾短语，说清「要做什么」，不超过 ${PLANNER_MAX_ITEMS * 6} 字
  · "status"：只能是 todo（还没做）/ doing（正在做）/ blocked（受阻，用 note 说明）之一
可选字段："note"（一句话补充）、"parent"（父项，见下方括号说明）

示例：
[{"text":"调研现有实现并写一份对比表","status":"todo"},{"text":"确认目标可运行","status":"doing"}]

【硬性要求】
· 只输出 JSON 本身；代码围栏可以有，**但 JSON 前后的解释文字一律不要**
· 不要标 done —— 你还没有产生任何可核对的产物，声称完成会被引擎视为错误
· 不要写工具调用、不要写代码、不要回答用户
· 一次只应有至多一项 doing`

const ROLE = `你是任务规划器。你的唯一职责是把一件事拆成「按顺序执行、每一步都能被验收」的清单。
你不执行任何动作，也不与用户对话 —— 你只产出计划。`

/** W1：开局订计划 */
const START = `${ROLE}

${OUTPUT_CONTRACT}`

/** W3/W4：在既有清单基础上修订 */
function revise(req: PlannerRequest): string {
  return `${ROLE}

这里是当前的任务清单（账本当前状态，必须以此为准）：
${renderCurrentItems(req)}

${OUTPUT_CONTRACT}

【修订要求】
· 输出**完整清单**（含已完成的项），不是增量 —— 引擎会自己算出差异
· 如果现状已经合理，原样返回即可（引擎会记录你已做过检视）
· 不要把新的大目标塞进旧项的措辞里；确属新的工作就单独列一项`
}

/** W2：失败后重排 —— 顶部放失败摘要 */
function failure(req: PlannerRequest): string {
  const digest = renderFailureDigest(req.failures)
  return `${ROLE}

这里是当前的任务清单：
${renderCurrentItems(req)}

${digest ? `以下是已经失败过的尝试：\n${digest}\n\n` : ''}${OUTPUT_CONTRACT}

【重排要求】
· **不得**原样重试已经失败的动作 —— 要么换路径，要么把这一步拆得更小
· 如果某项目标不变量已经不可能达成，把它标记为 blocked 并在 note 里说明原因，以及用户该做什么
· 你不需要解释失败原因，用户会看到；你只需要给出「接下来怎么办」`
}

function renderCurrentItems(req: PlannerRequest): string {
  if (req.items.length === 0) return '（当前没有任何任务）'
  return req.items
    .map((it, i) => `  ${i + 1}. [${it.status}] ${it.text.slice(0, 60)}${it.parentId ? '（子任务）' : ''}`)
    .join('\n')
}

/** 按触发源选择 prompt 变体（纯函数） */
export function buildPlannerSystem(req: PlannerRequest): string {
  switch (req.trigger) {
    case 'run-start':
      return START
    case 'failure':
      return failure(req)
    case 'stale':
    case 'new-instruction':
    case 'model-revision':
      return revise(req)
  }
}

/** 规划通道的用户消息 —— 目标 + 约束，刻意不含对话历史 */
export function renderPlannerUserMessage(req: PlannerRequest): string {
  const parts: string[] = []
  parts.push(`目标：${req.goal.slice(0, 120)}`)
  if (req.constraints && req.constraints.length > 0) {
    parts.push(`已知约束：\n${req.constraints.map((c) => `  · ${c.slice(0, 80)}`).join('\n')}`)
  }
  const max = req.maxItems ?? PLANNER_MAX_ITEMS
  parts.push(`请产出不超过 ${max} 项的清单。`)
  return parts.join('\n\n')
}

/**
 * 解析失败后的第二次 tightening 提醒（不是新任务，只是要求它只给 JSON）。
 * 只重试一次 —— 两连败就回落既有路径，不在弱模型上死磕（D168 教训）。
 */
export const PLANNER_TIGHTEN_HINT =
  '你上一次的回复无法被解析成任务清单。这一次请**只**输出 JSON 数组本身，不要围栏、不要解释、不要 Markdown 标题。'
