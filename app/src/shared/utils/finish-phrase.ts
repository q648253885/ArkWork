/* ============================================================
 * ArkWork — 「就此结束」终局短语（v0.41.0 / D207）
 *
 * 为什么要有这个文件：
 *   v0.38.1（D171）只堵了建议项 chip 点击路径（AskUserGate 的
 *   `action === 'finish'` → onStop）；用户实机（会话导出轮 #9）暴露第二条
 *   泄漏路径 —— 自由文本输入「就此结束」走 appendUserMessage 被当成新指令，
 *   触发规划通道重排并**继续执行**。终局指令必须终止任务，而不是发回模型。
 *
 * 硬规则：
 *   · 短语清单 = 主进程 i18n `suggest.finishHere.label` 的四语言值
 *     （messages.ts zh:49 / en:230 / ja:382 / ko:534）—— 由 TC-FH-003
 *     契约用例钉住「改文案必须同步本清单」。
 *   · **精确匹配**（trim + 小写归一后全等），不子串、不模糊 ——
 *     该短语是引擎停止卡片明示给用户的动作名；「好，就此结束」「就此结束。」
 *     这类自然语句不命中，仍按普通消息处理（宁缺毋滥）。
 *   · 渲染层 / 主进程共用本谓词（shared 无 Electron 依赖）。
 * ============================================================ */

/** 终局短语唯一事实源（四语言，来自 suggest.finishHere.label） */
export const FINISH_HERE_PHRASES = ['就此结束', 'Finish here', 'ここで終了', '여기서 마침'] as const

/** 终局短语是否命中（精确匹配；非字符串 / 空白一律 false） */
export function isFinishHerePhrase(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false
  const t = text.trim().toLowerCase()
  if (t === '') return false
  return (FINISH_HERE_PHRASES as readonly string[]).some((p) => p.toLowerCase() === t)
}

/** 拦截动作：未终态任务 → 完整终局；已终态任务 → 只回执、不动状态 */
export type FinishHereAction = 'cancel' | 'ack-only'

/** 任务终态集合（与 store/tasks.ts 的 TERMINAL_TASK_STATUSES 同口径；此处独立成纯函数避免循环依赖） */
const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

/**
 * 由（消息文本, 任务状态）推导拦截动作：
 *   · 短语未命中 → null（走普通消息链路）
 *   · 命中 + 任务已终态 → 'ack-only'（只发人话回执，不改状态、不重跑）
 *   · 命中 + 未终态（running/paused/pending…）→ 'cancel'（完整终局，与 D171 chip 同语义）
 */
export function resolveFinishHereAction(
  text: string | null | undefined,
  status: string | null | undefined,
): FinishHereAction | null {
  if (!isFinishHerePhrase(text)) return null
  return TERMINAL.has(status ?? '') ? 'ack-only' : 'cancel'
}
