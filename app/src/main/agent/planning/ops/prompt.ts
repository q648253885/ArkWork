/* ============================================================
 * ArkWork — 清单操作通道提示词（v0.40.0）
 * 设计文档：docs/versions/v0.40.0/04-system-design.md §四
 *
 * 三条设计约束（沿用 v0.39.0 规划通道的实测教训，一条不丢）：
 *   ① **不使用 ReAct 模板**（`Thought:` / `Observation:`）。Qwen 官方明确警示
 *      「推理模型应避免 ReAct 风格模板，因 stopword 冲突」，与实测「qwen3.5
 *      思考后不吐工具调用」现象吻合。
 *   ② **不提任何工具名**：这是一次没有工具的调用，提工具等于诱导伪调用。
 *   ③ **禁止自证完成**：只有「清单里已经标着 done」的项可保持 done；
 *      新标 done 必须真有可核对结果（与解析器的 S1 双保险）。
 *
 * 第四条（本版新增）：
 *   ④ **输出契约只有一份**（PLANOPS_OUTPUT_CONTRACT，不变量 I-O7）。
 *      五类操作若各自演化输出格式，`parse.ts` 的五层降级会被各自的文案细节
 *      拖垮 —— v0.38.1 的 `plan-regex` 只认两种形态就是这么来的。
 * ============================================================ */
import type { PlanOpsRequest } from './types.js'
import { PLAN_OPS_MAX_ITEMS } from './types.js'

/**
 * 五类操作**共用**的输出契约 —— 单一事实源（I-O7）。
 *
 * 与 v0.39.0 规划通道的 `OUTPUT_CONTRACT` 有两点不同：
 *   · 允许 `done`：本通道要求模型输出**完整**清单并保留已完成项，禁止 done
 *     会让「原样返回」把已完成项回退成待做（清单倒退）；
 *   · 明确列出四种可收形态：弱模型最常输出的是勾选清单与编号列表
 *     （实机 `evidence/04` §3.1 用例 B：0.8b 无工具时输出的就是 Markdown 清单），
 *     只认 JSON 等于把弱模型排除在外。
 */
export const PLANOPS_OUTPUT_CONTRACT = `【输出格式】
只输出清单本身，不要解释、不要前言、不要代码。以下四种写法都收（按可靠性排序）：

1) JSON 数组：
[{"text":"读取 CSV","status":"done"},{"text":"画折线图","status":"doing"}]

2) 代码块 JSON（\`\`\`json 包裹，同上形态）

3) 勾选清单：
- [x] 读取 CSV
- [ ] 画折线图

4) 编号列表：
1. 读取 CSV（已完成）
2. 画折线图（进行中）

status 只用这五个词之一：
  todo（还没做）/ doing（正在做）/ done（已完成）/ skipped（已跳过）/ blocked（受阻）

【硬性要求】
· 同时最多一项 doing
· **只有清单里已经标着 done 的项可以保持 done**
· 不要把「你打算做」或「你说过要做」的事标成 done —— 光说"做了"不算完成
· 不确定的一律写 todo`

const ROLE = `你是任务清单维护器。你的唯一职责是回答「这份清单现在应该长什么样」。
你不执行任何动作、不调用任何工具、不与用户对话 —— 你只产出清单。`

/** 当前清单快照渲染（空清单要有明确表态，避免模型凭空编造） */
function renderSnapshot(snapshot: string): string {
  const s = (snapshot ?? '').trim()
  return s ? s : '（当前没有任何任务）'
}

/** 五类操作的正文（在 ROLE + 输出契约之间） */
const KIND_BODY: Record<PlanOpsRequest['kind'], (req: PlanOpsRequest) => string> = {
  create: (req) =>
    `用户目标：${clip(req.goal, 200)}\n\n` +
    `请给出完成这个目标需要的清单（3–8 项），按执行顺序排列。\n` +
    `工作还没开始 —— **全部写 todo**，不要写 doing、不要写 done。`,

  update: (req) =>
    `用户目标：${clip(req.goal, 200)}\n\n` +
    `当前清单（账本当前状态，以此为准）：\n${renderSnapshot(req.snapshot)}\n\n` +
    `刚刚发生：${clip(req.event, 400)}\n\n` +
    `请给出**更新后的完整清单**（含已完成项，保持顺序；只改需要改的）。\n` +
    `如果现状已经合理，原样返回当前清单即可 —— 引擎会记录你已做过检视。\n` +
    `**不要删除任何已完成的项。**`,

  complete: (req) =>
    `用户目标：${clip(req.goal, 200)}\n\n` +
    `当前清单：\n${renderSnapshot(req.snapshot)}\n\n` +
    `刚刚发生：${clip(req.event, 400)}\n\n` +
    `请判断清单里**哪一项已经真正完成**——必须有可核对的结果（文件已生成 / 命令已跑通 /` +
    ` 事实已确认），光是"我做了"或"我打算做"都不算。\n` +
    `给出完整清单，把该项标 done；若确实没有项可确认完成，原样返回当前清单。\n` +
    `**不要标多项 done，也不要把没做完的标成 done。**`,

  cancel: (req) =>
    `用户目标：${clip(req.goal, 200)}\n\n` +
    `当前清单：\n${renderSnapshot(req.snapshot)}\n\n` +
    `取消原因：${clip(req.event, 300)}\n\n` +
    `请给出清单的**收尾形态**：不会再做的项标 skipped；已完成的保留 done；` +
    `受阻的标 blocked 并在 note 里说明。\n` +
    `**不要删除任何项** —— 取消也要留痕，用户需要知道当初打算做什么。`,

  replan: (req) =>
    `用户目标（不变）：${clip(req.goal, 200)}\n\n` +
    `当前清单：\n${renderSnapshot(req.snapshot)}\n\n` +
    `受阻情况：${clip(req.event, 400)}\n\n` +
    `请重新给出**接下来该做什么**的清单：可以删改未完成的项，但**已完成项必须保留并标 done**。\n` +
    `不要原样重试已经失败过的动作 —— 要么换路径，要么把这一步拆得更小。`,
}

/** 按操作类型构建 system（纯函数） */
export function buildPlanOpsSystem(req: PlanOpsRequest): string {
  return `${ROLE}\n\n${KIND_BODY[req.kind](req)}\n\n${PLANOPS_OUTPUT_CONTRACT}`
}

/** 用户消息 —— 只放目标与项数约束，刻意不含对话历史与工具结果全文 */
export function renderPlanOpsUserMessage(req: PlanOpsRequest): string {
  const max = req.maxItems ?? PLAN_OPS_MAX_ITEMS
  return `请输出不超过 ${max} 项的完整清单。`
}

/**
 * 解析失败后的第二次 tightening 提醒 —— 只重试一次。
 * 两连败就回落（不在弱模型上死磕，D168 教训）。
 */
export const PLANOPS_TIGHTEN_HINT =
  '你上一次的回复无法被解析成任务清单。这一次请**只**输出清单本身：' +
  '要么一个 JSON 数组，要么每行一条 `- [ ] 文本`。不要围栏、不要解释、不要 Markdown 标题。'

function clip(s: string, n: number): string {
  const t = (s ?? '').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || '（无）'
}
