/* ============================================================
 * ArkWork — 流式期 SAY 协议剥离器（v0.31.0 B1）
 *
 * 设计依据：docs/versions/v0.31.0/04-system-design.md §6.1
 *          agent_learn/docs/interaction-display-v1.0/04 §八（G14 防协议泄漏）
 * 验收：C-4（协议标记零泄漏）/ R5（畸形标记不永久吞内容）
 *
 * ── 与 `say-marker.ts` 的分工（互补，不替换） ──────────────────
 *   extractSayMarker（既有，落定期）  ← 完整 content 到手后的**整串解析**，产出权威 {thought, say}
 *   createSayStripper（本文件，流式期）← 每个 delta 到达时的**渲染分流**，产出 StripChunk[]
 *
 * ★ 硬约束（TC-STREAM-009 把守）：本模块**不得改变最终落盘的 thought / say**。
 *   它只决定"流式期间这段字往哪个通道送"。最终 step.thought / step.say 一律来自
 *   `extractSayMarker`。两者结论不一致时**以 extractSayMarker 为准**。
 *
 * ── 状态机 ───────────────────────────────────────────────────
 *   CONTENT ──匹配前缀──► MAYBE_MARK ──闭合──► SAY ──匹配闭合──► CONTENT
 *                             │                  │
 *                       不匹配 → 回吐 CONTENT   超 MAX_SAY_CHARS×2 未闭合
 *                                                → 回退（全部按 text）+ passthrough
 *
 * ── 三条关键不变式 ──────────────────────────────────────────
 *   ① 跨 delta 切分安全：`<<<SA` + `Y>>>` 分两批到达也必须识别（未决前缀缓存，不提前吐）
 *   ② 只看不说：SAY 态内容绝不进 text 通道
 *   ③ 超长兜底必做（R5）：阈值 = MAX_SAY_CHARS × 2，且**复用 say-marker 的同一常量**
 *
 * 纪律：本模块不 import electron / window（保持可密闭单测，沿用 llm-stream.ts 既有纪律）。
 * ============================================================ */

import { MAX_SAY_CHARS, SAY_CLOSE_TOKEN, SAY_OPEN_TOKEN } from './say-marker.js'

/** 分流通道：text = 叙述/正文（可展示）；say = 给用户看的结论（落定期由 step.say 接管） */
export type StripChannel = 'text' | 'say'

export interface StripChunk {
  channel: StripChannel
  text: string
}

export interface SayStripper {
  /**
   * 喂入一个流式增量，取回需要分流的片段。
   * @param delta 模型输出的增量碎片（可能把 `<<<SAY>>>` / `<<<END>>>` 切成两批）
   * @returns 分流结果；未决前缀会滞留在内部，**不返回**（不得提前吐字）
   */
  push(delta: string): StripChunk[]
  /**
   * 流结束收尾：把滞留的未决字符全部落地。
   * - CONTENT 态：滞留的是 `<<<SAY>>>` 的半截前缀 → 按 text 吐出
   * - SAY 态：块从未闭合 → 按 text 回退（与 `extractSayMarker` 的"未闭合视为无 SAY"一致）
   * @returns 残余分流结果（调用方按 channel 投递）
   */
  finish(): StripChunk[]
  /** 已识别到的完整 SAY 段数（可观测；用于诊断模型是否在滥用该协议） */
  readonly saySegments: number
}

/** 字面量小写形态，供逐字符前缀比较（与 say-marker 的大写不敏感语义一致） */
const OPEN_LOWER = SAY_OPEN_TOKEN.toLowerCase()
const CLOSE_LOWER = SAY_CLOSE_TOKEN.toLowerCase()

/**
 * R5 兜底阈值：进入 SAY 态后累计正文超此长度仍未闭合 → 判定模型输出畸形标记。
 * 注意取值来源：`MAX_SAY_CHARS × 2` —— 必须复用 say-marker 的常量（TC-STREAM-006），
 * 由正本 §6.1 规定，不得硬编码为字面量。
 */
const OVERFLOW_LIMIT = MAX_SAY_CHARS * 2

/**
 * 计算 `text` 末尾需要滞留在内部、等待下一批增量补齐的字符数。
 *
 * 用途：`<<<SA` 到达时若立即输出，下一批 `Y>>>` 就无法再重组为完整标记。
 * 返回「text 的最长后缀，且该后缀是 token 的真前缀」的长度（0 表示无需滞留）。
 * 比较大小写不敏感（与 `SAY_OPEN` / `SAY_CLOSE` 正则的 /i 语义对齐）。
 */
function trailingHold(text: string, tokenLower: string): number {
  const max = Math.min(text.length, tokenLower.length - 1)
  for (let n = max; n > 0; n--) {
    if (text.slice(text.length - n).toLowerCase() === tokenLower.slice(0, n)) return n
  }
  return 0
}

/**
 * 创建有状态 SAY 剥离器（每次 LLM 调用一个新实例，不可跨轮复用）。
 *
 * 无副作用、无 IO、无外部依赖 —— 可在 `node:test` 中密闭断言。
 */
export function createSayStripper(): SayStripper {
  /** 'content' = 正常叙述流；'say' = 已进入 SAY 块正文 */
  let state: 'content' | 'say' = 'content'
  /** CONTENT 态未决尾（可能是 OPEN 的半截前缀） */
  let buf = ''
  /** SAY 态已确认正文（待闭合后一次性交出；这样 R5 回退时才能"全部按 text"重定向） */
  let sayOut = ''
  /** SAY 态未决尾（可能是 CLOSE 的半截前缀） */
  let sayBuf = ''
  /** R5 回退后进入透传模式：一律按 text，且继续过滤 CLOSE 标记（C-4 不得泄漏） */
  let passthrough = false
  /** 透传模式下未决尾（可能是 CLOSE 的半截前缀） */
  let passBuf = ''
  let segments = 0

  /**
   * CONTENT 态排空：找出开标记并转入 SAY；末尾可能是 OPEN 真前缀的部分滞留不吐。
   * 零标记路径为**逐字符透传**（TC-STREAM-008：输出 === 输入）。
   */
  function drainContent(): StripChunk[] {
    const idx = buf.toLowerCase().indexOf(OPEN_LOWER)
    if (idx >= 0) {
      const head = idx > 0 ? [{ channel: 'text' as const, text: buf.slice(0, idx) }] : []
      sayBuf = buf.slice(idx + OPEN_LOWER.length)
      buf = ''
      state = 'say'
      sayOut = ''
      segments += 1
      return [...head, ...drainSay()]
    }
    const hold = trailingHold(buf, OPEN_LOWER)
    const out: StripChunk[] = []
    if (buf.length > hold) out.push({ channel: 'text', text: buf.slice(0, buf.length - hold) })
    buf = buf.slice(buf.length - hold)
    return out
  }

  /**
   * SAY 态排空：找闭合标记 → 一次性交出整段 say；未闭合则继续积累并做 R5 长度兜底。
   *
   * 为什么整段积累而非边到边吐：R5 要求「超长未闭合 → **全部**按 text 输出」。
   * 若已把前半段作为 say 交出，回退时就无法收回，通道归属会前后矛盾。
   * 代价是合法 SAY 块的流式呈现被推迟到闭合时刻（B1 不消费 say 通道，无观感损失）。
   */
  function drainSay(): StripChunk[] {
    const idx = sayBuf.toLowerCase().indexOf(CLOSE_LOWER)
    if (idx >= 0) {
      const body = sayOut + sayBuf.slice(0, idx)
      const rest = sayBuf.slice(idx + CLOSE_LOWER.length)
      state = 'content'
      buf = rest
      sayOut = ''
      sayBuf = ''
      const out: StripChunk[] = body ? [{ channel: 'say', text: body }] : []
      return [...out, ...drainContent()]
    }
    const hold = trailingHold(sayBuf, CLOSE_LOWER)
    sayOut += hold > 0 ? sayBuf.slice(0, sayBuf.length - hold) : sayBuf
    sayBuf = hold > 0 ? sayBuf.slice(sayBuf.length - hold) : ''
    if (sayOut.length + sayBuf.length > OVERFLOW_LIMIT) {
      // R5：畸形标记（超长未闭合）→ 全部按 text 回退，并进入透传模式。
      // 不重吐 `<<<SAY>>>` 本身：C-4 要求协议标记零泄漏。
      //
      // 注意 `sayBuf`（可能是闭合标记的半截前缀，如 `<<<EN`）**不随回退一起吐出**，
      // 而是转交给透传缓冲：若后续 `D>>>` 补上，它必须仍被识别为标记并剔除，
      // 否则就是把半截标记当正文泄漏出去（C-4 失败）。
      const rollback = sayOut
      state = 'content'
      buf = ''
      sayOut = ''
      passthrough = true
      passBuf = sayBuf
      sayBuf = ''
      return rollback ? [{ channel: 'text', text: rollback }] : []
    }
    return []
  }

  /**
   * 透传模式排空：按 text 输出，但继续剔除 CLOSE 标记（含跨批切分）。
   * 理由：R5 回退后可能仍会到达原 SAY 块的闭合标记，若原样吐出即 C-4 泄漏。
   */
  function drainPassthrough(delta: string): StripChunk[] {
    passBuf += delta
    const out: StripChunk[] = []
    for (;;) {
      const idx = passBuf.toLowerCase().indexOf(CLOSE_LOWER)
      if (idx < 0) break
      if (idx > 0) out.push({ channel: 'text', text: passBuf.slice(0, idx) })
      passBuf = passBuf.slice(idx + CLOSE_LOWER.length)
    }
    const hold = trailingHold(passBuf, CLOSE_LOWER)
    if (passBuf.length > hold) out.push({ channel: 'text', text: passBuf.slice(0, passBuf.length - hold) })
    passBuf = passBuf.slice(passBuf.length - hold)
    return out
  }

  return {
    push(delta: string): StripChunk[] {
      if (!delta) return []
      if (passthrough) return drainPassthrough(delta)
      if (state === 'say') {
        sayBuf += delta
        return drainSay()
      }
      buf += delta
      return drainContent()
    },

    finish(): StripChunk[] {
      // 透传模式：把滞留的半截 CLOSE 前缀按 text 吐出
      if (passthrough) {
        const tail = passBuf
        passBuf = ''
        return tail ? [{ channel: 'text', text: tail }] : []
      }
      // SAY 态：从未闭合 → 与 extractSayMarker「未闭合视为无 SAY」一致，按 text 回退
      if (state === 'say') {
        const rollback = sayOut + sayBuf
        state = 'content'
        sayOut = ''
        sayBuf = ''
        return rollback ? [{ channel: 'text', text: rollback }] : []
      }
      // CONTENT 态：滞留的是开标记的半截前缀 → 按 text 吐出（一个字符不丢）
      const tail = buf
      buf = ''
      return tail ? [{ channel: 'text', text: tail }] : []
    },

    get saySegments(): number {
      return segments
    },
  }
}
