/* ============================================================
 * ArkWork — SAY 标记解析（v0.25.0 F4 / 设计文档 §6.1）
 *
 * 模型按约定在 assistant 文本回复里输出：
 *   <<<SAY>>>
 *   给用户看的阶段叙述（1~3 句：本轮结论 + 下一步）
 *   <<<END>>>
 * 解析为 LlmCompleteResponse.say 字段；正文 thought 同步剥离该块（不污染内部思考）。
 *
 * 容错策略：
 *  - 模型未输出 SAY 块 → 返回 undefined，原文保持不变
 *  - 输出不完整（缺 <<<END>>>）→ 视为没输出（容错旧任务混排）
 *  - SAY 块超过 600 字 → 截断（防模型注入过长叙述撑爆 UI）
 * ============================================================ */

const SAY_OPEN = /<<<SAY>>>\s*/i
const SAY_CLOSE = /<<<END>>>/i
const MAX_SAY_CHARS = 600

export interface ExtractSayResult {
  /** 剥离 SAY 块后的内部 thought 文本（保留其他 think 标记） */
  thought: string
  /** 解析得到的 SAY 文本；模型未输出或解析失败 → undefined */
  say?: string
}

/**
 * 从 assistant content 中抽出 SAY 标记块（区分大小写不敏感）。
 * 重复匹配只取第一段；标记配对失败则视为无 SAY，原文退回。
 */
export function extractSayMarker(content: string): ExtractSayResult {
  if (!content || !SAY_OPEN.test(content)) return { thought: content }
  const openMatch = content.match(SAY_OPEN)
  if (!openMatch || openMatch.index === undefined) return { thought: content }
  const afterOpen = content.slice(openMatch.index + openMatch[0].length)
  const closeIdx = afterOpen.search(SAY_CLOSE)
  if (closeIdx < 0) return { thought: content }
  const raw = afterOpen.slice(0, closeIdx).trim()
  // 拼接 thought：前置（在 <<<SAY>>> 之前）+ 后置（在 <<<END>>> 之后）
  const thought = (content.slice(0, openMatch.index) + afterOpen.slice(closeIdx + '<<<END>>>'.length)).trim()
  if (!raw) return { thought }
  return {
    thought,
    say: raw.length > MAX_SAY_CHARS ? raw.slice(0, MAX_SAY_CHARS) + '…' : raw,
  }
}