/* ============================================================
 * ArkWork — 工具名孪生拼写比较（v0.44.1 · D219）
 *
 * 病：模型输出的工具名是不可信输入（D159 的渲染层延伸）。引擎在摄取点把
 * 孪生拼写归一到正名（main/agent/engine/work-class.ts normalizeToolName），
 * 但**历史任务**落盘的 steps.jsonl / L1 meta 里仍可能存有未归一的孪生形态
 * —— 实机证据（T-20261002-2k584x）：模型调 `task-complete`，step 落盘仍是
 * `task-complete`，渲染层 deriveConversation 用正名 `task_complete` 精确
 * 匹配落空 → 最终答复整条不渲染，用户只能看到最后一轮过程旁白。
 *
 * 设计口径：
 *  - **纯函数、零依赖**：node:test 可密闭真值表（TC-TWIN 组）。
 *  - 渲染层 / 存储消费方对 step 里的工具名**一律经本函数比较**，
 *    不得直接 `=== 正名`（旧数据永远存在，容错必须落在读侧）。
 *  - 只做 `_` ↔ `-` 孪生判定，不做词根近似（那是 tool-name-hint 的职责）。
 * ============================================================ */

/**
 * 判断实际工具名是否等价于正名（含下划线 ↔ 连字符孪生形态）。
 * 空值安全：actual 为空一律 false。
 */
export function sameToolName(actual: string | null | undefined, canonical: string): boolean {
  if (!actual) return false
  if (actual === canonical) return true
  const twin = canonical.includes('_')
    ? canonical.replace(/_/g, '-')
    : canonical.replace(/-/g, '_')
  return actual === twin
}
