/* ============================================================
 * ArkWork — `<think>` 标签剥离器（v0.33.1 W1）
 *
 * 背景（用户实测，OpenAI 协议接 qwen3）：大量 OpenAI 兼容端点
 * （llama.cpp / Ollama 旧版 / 部分网关）**不返回**独立的
 * `reasoning_content` 字段，而是把思考以 `<think>…</think>` 内嵌在
 * content 里。此前这段文本被原样当正文渲染 —— 思考混进对话流、
 * 思考通道反而空白，正是「没有思考过程」症状的根因之一。
 *
 * 与 `stream-strip.ts`（SAY 协议剥离）的分工一致：本模块只管
 * `<think>` 标签的**分流**（think → 原生思考通道；其余 → 正文），
 * 最终落盘口径不变（流式聚合后仍走 `extractSayMarker`）。
 *
 * 三条硬约束：
 *  ① 跨 delta 切分安全：`<thi` + `nk>` 分两批到达必须识别（未决前缀滞留）；
 *  ② 一个字符不丢：finish() 必须把滞留字符按当前态交还（THINK 态未闭合
 *     的残余归 think —— 思考被流截断比混进正文更接近事实）；
 *  ③ 大小写不敏感（`<Think>` 也认）。
 * ============================================================ */

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

export interface ThinkSplit {
  /** 归入思考通道的增量（onReasoning / reasoning 聚合用） */
  think: string
  /** 归入正文通道的增量（onText / content 聚合用） */
  text: string
}

export interface ThinkStripper {
  push(delta: string): ThinkSplit
  finish(): ThinkSplit
}

/** 字面量后缀真前缀长度（跨批切分检测用；大小写不敏感） */
function trailingHold(text: string, tokenLower: string): number {
  const max = Math.min(text.length, tokenLower.length - 1)
  for (let n = max; n > 0; n--) {
    if (text.slice(text.length - n).toLowerCase() === tokenLower.slice(0, n)) return n
  }
  return 0
}

/** 流式期：逐 delta 分流（每次 LLM 调用一个新实例） */
export function createThinkStripper(): ThinkStripper {
  let inThink = false
  let buf = ''

  function drain(): ThinkSplit {
    const out: ThinkSplit = { think: '', text: '' }
    for (;;) {
      const token = inThink ? THINK_CLOSE : THINK_OPEN
      const idx = buf.toLowerCase().indexOf(token)
      if (idx >= 0) {
        const body = buf.slice(0, idx)
        if (body) {
          if (inThink) out.think += body
          else out.text += body
        }
        buf = buf.slice(idx + token.length)
        inThink = !inThink
        continue
      }
      const hold = trailingHold(buf, token)
      if (buf.length > hold) {
        const body = buf.slice(0, buf.length - hold)
        if (inThink) out.think += body
        else out.text += body
      }
      buf = buf.slice(buf.length - hold)
      return out
    }
  }

  return {
    push(delta: string): ThinkSplit {
      if (!delta) return { think: '', text: '' }
      buf += delta
      return drain()
    },
    finish(): ThinkSplit {
      const tail = buf
      buf = ''
      // THINK 态未闭合：残余按思考处理（`</think>` 被流截断比混进正文更接近事实）
      if (inThink) return { think: tail, text: '' }
      return { text: tail, think: '' }
    },
  }
}

/**
 * 落定期：整串剥离全部 `<think>…</think>` 块。
 * 多块依次剥离并拼接；未闭合（无 `</think>`）→ 从 `<think>` 起全部算思考。
 * 大小写不敏感；无标签时原样返回（think 为 null）。
 */
export function stripThinkBlocks(content: string): { think: string | null; rest: string } {
  if (!content) return { think: null, rest: content }
  const lower = content.toLowerCase()
  const out: string[] = []
  const thinks: string[] = []
  let pos = 0
  for (;;) {
    const open = lower.indexOf(THINK_OPEN, pos)
    if (open < 0) {
      out.push(content.slice(pos))
      break
    }
    if (open > pos) out.push(content.slice(pos, open))
    const close = lower.indexOf(THINK_CLOSE, open + THINK_OPEN.length)
    if (close < 0) {
      // 未闭合：其余全部算思考（流截断容错）
      thinks.push(content.slice(open + THINK_OPEN.length))
      pos = content.length
      break
    }
    thinks.push(content.slice(open + THINK_OPEN.length, close))
    pos = close + THINK_CLOSE.length
  }
  const think = thinks.length > 0 ? thinks.join('\n').replace(/^\s+|\s+$/g, '') : null
  const rest = out.join('').replace(/^\s+|\s+$/g, '')
  return { think, rest }
}
