/* ============================================================
 * ArkWork — 最终答复的「输出层次」解析（v0.37.0 · PRD F9 / 设计文档 §6.1）
 *
 * 为什么需要这一层：
 *   模型最终答复原样丢进 Markdown 渲染，等于把"用户做判断必需的信息"和
 *   "过程细节"摊平在同一层 —— 用户要自己从十行里挑出「到底做完了没有」。
 *   对比 Trae / Devin 的交付卡：结论、改动、验证、下一步是**分层**呈现的，
 *   默认可见性由**可判断性**决定（结论/改动/下一步默认展开，验证细节默认折叠）。
 *
 * 本模块只做**纯解析**（无 React、无 DOM）：
 *   `parseAnswerLayers(markdown) → { prefix, layers, recognized }`
 * 渲染决策留给 AnswerBlock（默认可见性 / 折叠 / 缺段占位）。
 *
 * 设计取舍：
 *   · 只在**识别到 ≥2 段**时才启用分层渲染 —— 单段（如只写"结论：…"）
 *     极可能是普通行文，强行分层会把正常回答切碎（宁可退回 Markdown 原样）。
 *   · 识别**含标签的标题行**（`## 结论` / `**结论先行**` / `结论：`），
 *     不识别正文里出现的词（"这个结论是对的"不会触发）。
 *   · 识别不到任何段 → `layers: []`，调用方回退到原 Markdown 渲染（向后兼容）。
 * ============================================================ */

/** 四段的规范顺序与语义（顺序即渲染顺序） */
export const ANSWER_LAYER_ORDER = ['conclusion', 'changes', 'verification', 'next'] as const

export type AnswerLayerId = (typeof ANSWER_LAYER_ORDER)[number]

export interface AnswerLayer {
  id: AnswerLayerId
  /** 原文中的标题文字（用于展示，如「结论先行」） */
  label: string
  /** 段正文（不含标题行） */
  body: string
}

export interface AnswerLayers {
  /** 第一个可识别标题之前的导语（可能为空串） */
  prefix: string
  /** 识别到的段（按规范顺序排序，可能缺段） */
  layers: AnswerLayer[]
  /** 识别到的段数（≥2 才建议启用分层渲染） */
  recognized: number
}

/**
 * 关键词 → 段 id。同一 id 允许多个同义词；匹配的是**标题行**而非正文。
 *
 * ⚠️ 刻意**不加 `\b`**：JS 的 `\w` 只含 `[A-Za-z0-9_]`，中文字符是非词字符，
 * 因此 `/^(结论)\b/` 在「结论先行」这种**后面直接跟中文**的场景下永远不匹配 ——
 * 表现为"标题识别全失效、分层静默退化"（本版开发中真实踩到：
 * `recognized` 恒为 0，UI 悄悄退回整段 Markdown）。
 * 标题行本身已被 `matchHeading` 的三种形态 + 长度 ≤24 约束住，无需再靠 `\b` 收窄。
 */
const KEYWORDS: Array<{ id: AnswerLayerId; re: RegExp }> = [
  { id: 'conclusion', re: /^(结论先行|结论与结果|结论|结果|总结|conclusion|summary|result)/i },
  { id: 'changes', re: /^(变更清单|改动清单|修改清单|变更|改动|产出|交付物|changes|changed files|deliverables)/i },
  { id: 'verification', re: /^(验证结果|测试结果|验证|测试|校验|自检|verification|tests?|checks?)/i },
  { id: 'next', re: /^(下一步|后续|待确认|待办|遗留|next ?steps?|follow[- ]?ups?|todo)/i },
]

/** 剥掉 markdown 标题/加粗/列表符号与收尾冒号，得到标签文本 */
function normalizeLabel(raw: string): string {
  return raw
    .replace(/^[#>\-*+\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/[：:]\s*$/, '')
    .trim()
}

/**
 * 判定一行是否是「段标题行」。
 * 只接受三种形态，避免把正文里的词当标题：
 *   `# 结论` / `**结论**` / `结论：`（且整行长度 ≤ 24，防长句误判）
 */
function matchHeading(line: string): { id: AnswerLayerId; label: string } | null {
  const t = line.trim()
  if (!t) return null
  const isHeadingLike =
    /^#{1,6}\s+\S/.test(t) || // markdown 标题
    /^\*\*[^*]+\*\*\s*[：:]?$/.test(t) || // 整行加粗
    /^[^。！？.!?]{1,24}[：:]\s*$/.test(t) // 「标签：」独占一行
  if (!isHeadingLike) return null
  const label = normalizeLabel(t)
  if (label.length === 0 || label.length > 24) return null
  for (const k of KEYWORDS) {
    if (k.re.test(label)) return { id: k.id, label }
  }
  return null
}

/**
 * 解析最终答复为四段。
 *
 * @param text 最终答复原文（markdown）
 */
export function parseAnswerLayers(text: string): AnswerLayers {
  const lines = (text ?? '').split('\n')
  const buckets = new Map<AnswerLayerId, { label: string; lines: string[] }>()
  const prefixLines: string[] = []
  let current: AnswerLayerId | null = null

  for (const line of lines) {
    const hit = matchHeading(line)
    if (hit) {
      // 同一段重复出现：合并（后者续写，不丢内容）
      const prev = buckets.get(hit.id)
      if (prev) {
        prev.lines.push('', line)
      } else {
        buckets.set(hit.id, { label: hit.label, lines: [] })
      }
      current = hit.id
      continue
    }
    if (current === null) prefixLines.push(line)
    else buckets.get(current)!.lines.push(line)
  }

  const layers: AnswerLayer[] = []
  for (const id of ANSWER_LAYER_ORDER) {
    const b = buckets.get(id)
    if (!b) continue
    layers.push({ id, label: b.label, body: b.lines.join('\n').trim() })
  }

  return {
    prefix: prefixLines.join('\n').trim(),
    layers,
    recognized: layers.length,
  }
}

/** 是否值得启用分层渲染（识别 ≥2 段） */
export function shouldRenderLayered(l: AnswerLayers): boolean {
  return l.recognized >= 2
}

/* ---------------- 渲染策略（纯数据，供 UI 与用例共用） ---------------- */

export interface AnswerLayerSpec {
  id: AnswerLayerId
  /** 默认展开（false = 折叠摘要 + 可展开） */
  defaultOpen: boolean
  /** 缺段时的占位文案 key（i18n 由渲染层解析；此处给中文兜底） */
  missingHint: string
}

/**
 * 默认可见性：由「用户能否据此做判断」决定。
 * 验证细节默认折叠（长命令输出会把结论挤出屏幕），其余三段展开。
 */
export const ANSWER_LAYER_SPECS: readonly AnswerLayerSpec[] = [
  { id: 'conclusion', defaultOpen: true, missingHint: '未给出结论（模型遗漏了这一段，可直接追问）' },
  { id: 'changes', defaultOpen: true, missingHint: '未列出变更（可直接追问改了哪些文件）' },
  { id: 'verification', defaultOpen: false, missingHint: '未提供验证结果 —— 这不等于已验证，请谨慎采纳' },
  { id: 'next', defaultOpen: true, missingHint: '未说明下一步' },
]
