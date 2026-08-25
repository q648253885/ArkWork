/* ============================================================
 * ArkWork — 任务标题简化工具
 *
 * 任务标题基于首条用户消息首行 / 句号截断 / 限 30 字
 * 设计文档:polish-workspace-task-title-skills-context-help §Task 1
 * ============================================================ */

/** 标题最大字符数 */
const TITLE_MAX_LEN = 30

/** 句子结束标点(中英文) */
const SENT_END = /[。!！?？;；…\.\!\?;]/m

/**
 * 把首条用户消息简化为任务标题:
 *   1. 取首非空行
 *   2. 若该行在中英文标点前出现,截断标点前(若标点不在前 4 字内,保留整行)
 *   3. 限 TITLE_MAX_LEN 字
 *   4. 去前后空白
 *
 * 空字符串输入返回空字符串(由调用方决定兜底)。
 */
export function simplifyFirstLine(text: string): string {
  if (!text) return ''
  // 1) 首非空行
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  let line = firstLine.trim()
  if (!line) return ''
  // 2) 在前 8 个字符之后遇到的第一个标点处截断(避免短句被截断)
  const minScan = Math.min(8, line.length)
  const rest = line.slice(minScan)
  const match = rest.match(SENT_END)
  if (match && match.index !== undefined) {
    line = line.slice(0, minScan + match.index)
  }
  // 3) 限长
  if (line.length > TITLE_MAX_LEN) {
    line = line.slice(0, TITLE_MAX_LEN)
  }
  // 4) trim
  return line.trim()
}