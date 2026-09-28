/* ============================================================
 * ArkWork — 门禁与阶段结论的投递出口（v0.38.0 / D153 / D156）
 * 设计文档：docs/versions/v0.38.0/04-system-design.md §6.4、03-interaction.md §三/§四
 *
 * 为什么要把投递从判定里拆出来：
 *   D153 的根因是「判定」与「投递」写在同一函数里，于是两条语义完全不同的输出
 *   共用了一条通道 —— 门禁指令写 `appendL1({role:'user'})`，模型把它当最后一条
 *   用户消息**复述进了答复正文**，用户看到的是引擎的指令而不是答案。
 *
 *   本模块固定三条出口，各自一条通道，互不污染：
 *     ① 给模型的指令 → L1 的 **system** 通道（kind: gate_hint / input_judgement）
 *     ② 给用户的通告 → `gate_blocked` 事件（人话，不含内部标记）
 *     ③ 给用户的结论 → `turn_note` 事件（**不写 L1**：输出不是输入）
 *
 * 投递失败一律只告警（沿用"投递失败不阻断"的降级纪律），但**必须留人话日志**（纪律⑨）。
 * ============================================================ */
import { appendL1 } from '../../memory/l1-working.js'
import { logger } from '../../system/logger.js'
import { emitEvent } from './broadcast.js'
import { getUiLocale } from '../../i18n/messages.js'
import { MAX_LEDGER_REFUSALS, type LedgerItem } from '../ledger/types.js'
import { toDraftSnapshot } from '../ledger/plan-diff.js'

export type GateCode = 'TREE_SYNC' | 'UNFINISHED' | 'ARTIFACT'
/**
 * v0.39.0（U2）：新增 `'plan-revision'` —— 规划通道改过清单时，用户必须能看出
 * 「这不是模型自己说的，是引擎重新规划的结果」（否则清单突然变了没人知道为什么）。
 */
export type TurnNoteVia = 'model' | 'plan-commit' | 'gate-refusal' | 'engine-stop' | 'plan-revision'

function zh(): boolean {
  return getUiLocale().toLowerCase().startsWith('zh')
}

/* ============================================================
 * ① 门禁拒绝：system 指令（→模型）+ 用户通告（→UI）
 * ============================================================ */

export interface RefuseViaGateArgs {
  taskId: string
  iteration: number
  code: GateCode
  /** 判定理由（人话，来自 guardFinish 的 message） */
  message: string
  /** 含本次的拒绝次数 */
  refusals: number
  max?: number
}

/**
 * 给模型的控制指令 —— 必须显式禁止复述（D153 的直接对策）。
 * 与用户通告严格分离：本函数返回的文本**只**进 L1，不出现在任何 UI 文案里。
 */
function buildGateInstruction(a: RefuseViaGateArgs): string {
  const max = a.max ?? MAX_LEDGER_REFUSALS
  if (a.code === 'ARTIFACT') {
    // v0.38.1（D176）：成果产物核对拒绝 —— 指令聚焦"补产物声明"这一条可执行出路
    if (!zh()) {
      return (
        `[INTERNAL INSTRUCTION · DO NOT REPEAT] Completion gate blocked (${a.refusals}/${max}).\n\n` +
        `Reason: ${a.message}\n\n` +
        `Resubmit the FULL plan via task_plan: for every item you marked done, include an ` +
        `artifact — {path: "<workspace-relative path>", kind: "file" | "dir"} for produced files/folders, ` +
        `or {kind: "command", check: "<how to verify>"} for command-verifiable results. ` +
        `Items not actually finished must go back to todo/doing.\n\n` +
        `This is a control instruction from the engine, not a message from the user. ` +
        `Do NOT repeat it in your reply, and do NOT mention the gate or any internal mechanism.`
      )
    }
    return (
      `[内部指令 · 请勿复述] 完成门禁拦截（第 ${a.refusals}/${max} 次）。\n\n` +
      `判定依据：${a.message}\n\n` +
      `请用 task_plan 重新提交**完整**清单：每个标为 done 的项都必须带 artifact —— ` +
      `产出了文件/目录的填 {path: "相对工作区路径", kind: "file" 或 "dir"}；` +
      `以命令结果为产物的填 {kind: "command", check: "如何校验"}。` +
      `尚未实际完成的项改回 todo/doing，不要硬标 done。\n\n` +
      `本条是引擎发给你的控制指令，不是用户的消息。不要在答复里复述本条内容，也不要向用户` +
      `提及"门禁""产物核对"等内部机制 —— 直接把答案写给用户。`
    )
  }
  if (!zh()) {
    return (
      `[INTERNAL INSTRUCTION · DO NOT REPEAT] Completion gate blocked (${a.refusals}/${max}).\n\n` +
      `Reason: ${a.message}\n\n` +
      `Do ONE of the following, then finish again:\n` +
      `  1. The work just done needs tracking → submit the updated full plan via task_plan.\n` +
      `  2. The list genuinely needs no change → submit the SAME list via task_plan ` +
      `(this records that you inspected it).\n\n` +
      `This is a control instruction from the engine, not a message from the user. ` +
      `Do NOT repeat it in your reply, and do NOT mention the gate, plan sync, or any ` +
      `internal mechanism — answer the user directly.`
    )
  }
  return (
    `[内部指令 · 请勿复述] 完成门禁拦截（第 ${a.refusals}/${max} 次）。\n\n` +
    `判定依据：${a.message}\n\n` +
    `请二选一，完成后重新收尾：\n` +
    `  ① 刚才的工作包含需要跟踪的步骤 → 用 task_plan 提交更新后的完整清单；\n` +
    `  ② 确属对话级续聊、清单无需变化 → 用 task_plan 提交与现在相同的清单` +
    `（以此留下"已检视"的痕迹）。\n\n` +
    `本条是引擎发给你的控制指令，不是用户的消息。不要在答复里复述本条内容，也不要向用户` +
    `提及"门禁""清单同步""tree-sync"等内部机制 —— 直接把答案写给用户。`
  )
}

/** 给用户的通告 —— 人话，**不得**含 `[tree-sync-required]` 等内部标记（FR7.3） */
function buildGateNotice(a: RefuseViaGateArgs): string {
  const max = a.max ?? MAX_LEDGER_REFUSALS
  if (a.code === 'ARTIFACT') {
    return zh()
      ? `成果核对：部分已完成项缺少可验证的成果产物，已要求模型补齐产物声明后再收尾（第 ${a.refusals}/${max} 次）。`
      : `Deliverable check: some completed items have no verifiable artifact. The model has been asked to declare them before finishing (${a.refusals}/${max}).`
  }
  if (!zh()) {
    return `Completion gate: this run changed files or ran commands but the task list was not updated. The model has been asked to sync it before finishing (${a.refusals}/${max}).`
  }
  return `完成门禁：本次执行有实质动作，但任务清单未更新。已要求模型先同步清单再收尾（第 ${a.refusals}/${max} 次）。`
}

/**
 * 门禁拒绝的**唯一出口**：一次调用同时完成两个投递，避免漏掉任一侧。
 * 两处失败都只告警 —— 门禁本身已经拦住了收尾，通告失败不该连带失败。
 */
export async function refuseViaGate(a: RefuseViaGateArgs): Promise<void> {
  const max = a.max ?? MAX_LEDGER_REFUSALS
  try {
    await appendL1({
      taskId: a.taskId,
      role: 'system',
      kind: 'gate_hint',
      iteration: a.iteration,
      content: buildGateInstruction(a),
    })
  } catch (err) {
    logger.warn('Agent', `门禁指令注入失败（不阻断）：${(err as Error).message}`, a.taskId)
  }
  try {
    await emitEvent(a.taskId, {
      type: 'gate_blocked',
      taskId: a.taskId,
      iteration: a.iteration,
      code: a.code,
      refusals: a.refusals,
      max,
      text: buildGateNotice(a),
    })
  } catch (err) {
    logger.warn('Agent', `门禁通告投递失败（不阻断）：${(err as Error).message}`, a.taskId)
  }
  logger.info('Agent', `完成门禁拦截（${a.code}，第 ${a.refusals}/${max} 次）`, a.taskId)
}

/* ============================================================
 * ② 阶段结论：→ UI（**不写 L1**）
 * ============================================================ */

export interface EmitTurnNoteArgs {
  taskId: string
  iteration: number
  /** 正文；trim 后为空则直接返回（不投空卡片，FR3.4） */
  text: string
  via: TurnNoteVia
}

export async function emitTurnNote(a: EmitTurnNoteArgs): Promise<void> {
  const text = a.text.trim()
  if (text === '') return // FR3.4：空文本不投递
  try {
    await emitEvent(a.taskId, { type: 'turn_note', taskId: a.taskId, iteration: a.iteration, text, via: a.via })
    logger.debug('Agent', `阶段结论投递（via=${a.via}，${text.length} 字）`, a.taskId)
  } catch (err) {
    logger.warn('Agent', `阶段结论投递失败（不阻断）：${(err as Error).message}`, a.taskId)
  }
}

/* ============================================================
 * ③ 新输入的「请先判断」指令（→模型，system 通道）
 * ============================================================ */

export interface InjectInputJudgementArgs {
  taskId: string
  iteration: number
  /** 用户本次原始输入（截断到 500 字，避免长粘贴淹没上下文） */
  inputText: string
  /** 当前清单（内部 9 态；函数内部降级为对外 5 态快照） */
  items: readonly LedgerItem[]
}

/**
 * 用户追加输入后**立即**注入（不等收尾）—— 这是 P6 决策的落地：
 * 把"用户原输入 + 清单快照"摆给模型，让**它**先读先判，而不是让引擎凭
 * `isReplyContinuation` 这类代理变量预判（D155）。
 */
export async function injectInputJudgement(a: InjectInputJudgementArgs): Promise<void> {
  const snapshot = toDraftSnapshot(a.items)
  const list =
    snapshot.length === 0
      ? zh()
        ? '（当前无清单项）'
        : '(empty list)'
      : snapshot.map((s, i) => `  ${i + 1}. [${s.status}] ${s.text}${s.note ? `（${s.note}）` : ''}`).join('\n')
  const raw = a.inputText.length > 500 ? `${a.inputText.slice(0, 500)}…` : a.inputText

  const content = zh()
    ? `[内部指令 · 请勿复述] 用户刚刚追加了新输入：\n\n  「${raw}」\n\n` +
      `当前任务清单（${snapshot.length} 项）：\n${list}\n\n` +
      `请在开始处理前先做一次判断，并用 turn_note 把判断结论写给用户（1–2 句）：\n` +
      `  ① 这是**需要新增或调整工作**的指令 → 用 task_plan 更新清单，再继续执行；\n` +
      `  ② 这是**只读问答 / 闲聊**，不产生需要跟踪的工作 → 清单无需变化，直接回答用户。\n\n` +
      `判断依据是"这次输入是否产生了需要跟踪的工作"，而不是"用户是否发了消息"。\n` +
      `本条是内部指令，不要复述，也不要提及"清单同步"等机制。`
    : `[INTERNAL INSTRUCTION · DO NOT REPEAT] The user just added new input:\n\n  "${raw}"\n\n` +
      `Current task list (${snapshot.length} items):\n${list}\n\n` +
      `Before starting, make ONE judgement and tell the user via turn_note (1–2 sentences):\n` +
      `  1. This asks for NEW work → update the list via task_plan, then proceed.\n` +
      `  2. This is a read-only question / chat → the list needs no change; just answer.\n\n` +
      `Base the judgement on "did this input create work worth tracking", not on "did the user send a message".\n` +
      `This is an internal instruction — do not repeat it or mention plan-sync mechanics.`

  try {
    await appendL1({
      taskId: a.taskId,
      role: 'system',
      kind: 'input_judgement',
      iteration: a.iteration,
      content,
    })
  } catch (err) {
    logger.warn('Agent', `新输入判断指令注入失败（不阻断）：${(err as Error).message}`, a.taskId)
  }
}
