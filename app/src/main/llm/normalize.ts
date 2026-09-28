/* ============================================================
 * ArkWork — LLM 协议响应归一化层（v0.36.0 F1.5，设计文档 §3.3）
 *
 * 四类协议 kind（openai / anthropic / ollama / vllm）的响应差异此前散落在
 * 各 adapter 内部（openai.ts mapFinishReason / parseOpenAIToolCalls、
 * anthropic.ts mapFinishReason 各写一份）。本模块收敛为单一真源：
 *
 *   ① finish_reason 映射表（openai 精确 / anthropic 精确 / ollama·vllm 宽松）；
 *   ② tool_calls 容错（arguments JSON.parse 失败保留原文并标 malformed；
 *      缺失 id 生成合成 id —— 流式分片 slot.id 可能留 ''，回写 tool result
 *      时 tool_call_id='' 会触发部分端点 400）；
 *   ③ normalizeResponse 聚合入口（空文本 + 空 toolCalls → empty，交由既有
 *      补试链路 reason-phase.ts 接管）；
 *   ④ greeting-loop 防御泛化：createGreetingLoopGuard —— 连续 N(3) 轮响应
 *      与历史首条 user 消息同前缀 → 判定重复；endpoint unhealthy 计数。
 *
 * 纯 Node 模块（零 electron / i18n 依赖），可独立单测。
 * ============================================================ */
import { createHash } from 'node:crypto'
import type { ReActAction } from '@shared/types/react'

/* ============================================================
 * ① finish_reason 映射表
 * ============================================================ */

export type ProtocolKind = 'openai' | 'anthropic' | 'ollama' | 'vllm'

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'interrupted'

/**
 * 端点终止帧 → 内部终止原因。
 *
 * 缺省分支（value null/undefined/未知值）一律 `'interrupted'`（缺陷 D35 语义：
 * 「没有终止帧」≠「模型正常说完」，如实上报交引擎决定重试或失败收尾）。
 *
 * - openai：官方枚举精确匹配（'function_call' 为 legacy 形态，归 tool_calls）；
 * - anthropic：end_turn/stop_sequence → stop、tool_use → tool_calls；
 * - ollama / vllm：OpenAI 兼容生态，各网关实现不一 → **宽松容错**，
 *   同时接受 openai 与 anthropic 两种词表（vLLM 曾实测返回 'abort'/'aborted'，
 *   语义是被截断 → interrupted 缺省分支正确兜住）。
 */
export function normalizeFinishReason(kind: ProtocolKind, reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      // ollama/vllm 宽松：三词皆收；openai 只应出现 'stop'；anthropic 前两词。
      return 'stop'
    case 'tool_calls':
    case 'tool_use':
    case 'function_call':
      return 'tool_calls'
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      // 缺陷 D35：缺终止帧 / 未知值 ≠ 正常说完。
      return 'interrupted'
  }
}

/* ============================================================
 * ② tool_calls 容错
 * ============================================================ */

export interface NormalizedToolCall {
  /** 缺失时合成的 id：call_{index}_{hash8}（对 name+arguments 稳定） */
  id: string
  name: string
  /** JSON.parse 成功的对象；失败时 { _raw: 原始 arguments 文本 } */
  args: Record<string, unknown>
  /** arguments 非法 JSON（args 已降级 _raw） */
  malformed: boolean
  /** 原始 arguments 文本（malformed 排查用） */
  rawArguments: string
}

/** 合成 id：call_{index}_{hash 前 8 位}（对 name+arguments 稳定，轮内唯一由 index 保证） */
function syntheticToolCallId(index: number, name: string, rawArguments: string): string {
  const hash = createHash('md5').update(`${name}::${rawArguments}`).digest('hex').slice(0, 8)
  return `call_${index}_${hash}`
}

/**
 * tool_calls 容错解析（openai 分片聚合后的完整调用数组 → NormalizedToolCall[]）：
 * - id 缺失 / 空串 → 按下标合成稳定 id（同轮内不冲突）；
 * - arguments 为 string → JSON.parse；失败保留原文于 args._raw 并标 malformed；
 * - arguments 为空串 → 按 '{}' 解析（兼容端点省略 arguments 的形态）。
 */
export function normalizeToolCalls(
  calls: Array<{ id?: string | null; name?: string | null; arguments?: string | null }>,
): NormalizedToolCall[] {
  return calls.map((call, index) => {
    const name = typeof call.name === 'string' ? call.name : ''
    const rawArguments = typeof call.arguments === 'string' ? call.arguments : ''
    const id = typeof call.id === 'string' && call.id ? call.id : syntheticToolCallId(index, name, rawArguments)
    try {
      const args = (JSON.parse(rawArguments || '{}') ?? {}) as Record<string, unknown>
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return { id, name, args: { _raw: rawArguments }, malformed: true, rawArguments }
      }
      return { id, name, args, malformed: false, rawArguments }
    } catch {
      return { id, name, args: { _raw: rawArguments }, malformed: true, rawArguments }
    }
  })
}

/* ============================================================
 * ③ normalizeResponse 聚合入口
 * ============================================================ */

/** 各 adapter 上报的原始响应（宽容 shape：字段名可有别名） */
export interface RawProtocolResponse {
  /** 文本正文（openai content / anthropic text blocks 拼接后） */
  content?: string | null
  /** 思考正文（openai reasoning_content|reasoning / anthropic thinking） */
  reasoningContent?: string | null
  /** 工具调用（分片聚合后） */
  toolCalls?: Array<{ id?: string | null; name?: string | null; arguments?: string | null }>
  finishReason?: string | null
  usage?: { tokensIn?: number; tokensOut?: number } | null
}

export interface NormalizedResponse {
  text: string
  reasoning?: string
  toolCalls: NormalizedToolCall[]
  finishReason: FinishReason
  tokensIn: number
  tokensOut: number
  /** 空文本 + 空 toolCalls → true（既有补试链路 reason-phase.ts 接管） */
  empty: boolean
  /** malformed tool call 数（>0 时上层可注入自纠提示） */
  malformedToolCallCount: number
}

/** 协议响应归一化：四类 kind 统一出口（容错细则见 ①②） */
export function normalizeResponse(raw: RawProtocolResponse, kind: ProtocolKind): NormalizedResponse {
  const text = typeof raw.content === 'string' ? raw.content : ''
  const reasoning = typeof raw.reasoningContent === 'string' && raw.reasoningContent ? raw.reasoningContent : undefined
  const toolCalls = normalizeToolCalls(Array.isArray(raw.toolCalls) ? raw.toolCalls : [])
  return {
    text,
    reasoning,
    toolCalls,
    finishReason: normalizeFinishReason(kind, raw.finishReason),
    tokensIn: raw.usage?.tokensIn ?? 0,
    tokensOut: raw.usage?.tokensOut ?? 0,
    empty: !text.trim() && toolCalls.length === 0,
    malformedToolCallCount: toolCalls.filter((c) => c.malformed).length,
  }
}

/* ============================================================
 * ④ greeting-loop 防御（连接守护）
 * ============================================================ */

export interface GreetingLoopGuardOptions {
  /** 历史首条 user 消息（本轮会话的重复判定基准；空串则守卫不激活） */
  reference: string
  /** 连续多少轮与基准同前缀判定为问候循环（缺省 3） */
  maxRepeat?: number
  /** 前缀比较长度（缺省 80 字符） */
  prefixChars?: number
}

export interface GreetingLoopVerdict {
  /** 连续重复轮数达到 maxRepeat（触发后内部归零，重新累计） */
  repeated: boolean
  /** 当前连续重复轮数（触发前） */
  streak: number
}

export interface GreetingLoopGuard {
  observe(responseText: string): GreetingLoopVerdict
}

/**
 * 问候循环守卫（纯有状态）：每轮把模型响应正文与首条 user 消息做同前缀比较，
 * 连续 maxRepeat 轮一致 → repeated=true（上层注入纠正指令 + unhealthy 计数）。
 *
 * 背景（2026-09-18 实测）：Ollama/OpenAI 兼容端点对「帮我分析整个工作区」
 * 逐轮回复同一句问候语；既有 stall 守卫靠 thought 签名可拦，但 responses 与
 * 用户输入同前缀的形态是更本质的信号（模型根本没读任务），在此显式泛化。
 */
export function createGreetingLoopGuard(opts: GreetingLoopGuardOptions): GreetingLoopGuard {
  const maxRepeat = opts.maxRepeat ?? 3
  const prefixChars = opts.prefixChars ?? 80
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim()
  // 判定锚 = 基准的前 prefixChars 字符；响应该前缀开头即判重复（基准短于
  // prefixChars 时按基准全长 —— 响应「复读用户输入再展开」同样算重复）
  const referencePrefix = normalize(opts.reference).slice(0, prefixChars)
  const active = referencePrefix.length > 0
  let streak = 0
  return {
    observe(responseText: string): GreetingLoopVerdict {
      if (!active) return { repeated: false, streak: 0 }
      const normalized = normalize(responseText)
      if (normalized && normalized.startsWith(referencePrefix)) {
        streak += 1
        if (streak >= maxRepeat) {
          streak = 0 // 触发后归零：纠正指令注入后重新累计，避免逐轮刷提示
          return { repeated: true, streak: maxRepeat }
        }
        return { repeated: false, streak }
      }
      streak = 0
      return { repeated: false, streak: 0 }
    },
  }
}

/* ============================================================
 * endpoint unhealthy 计数（module-level，跨任务聚合）
 * ============================================================ */

const unhealthyCounts = new Map<string, number>()

/** unhealthy 计数键（endpoint 为空时退化为 modelId 维度） */
export function endpointUnhealthyKey(endpoint: string | undefined | null, modelId: string): string {
  return `${(endpoint ?? '').trim()}|${modelId}`
}

/** 标记一次 unhealthy 事件，返回累计次数 */
export function markEndpointUnhealthy(endpoint: string | undefined | null, modelId: string): number {
  const key = endpointUnhealthyKey(endpoint, modelId)
  const next = (unhealthyCounts.get(key) ?? 0) + 1
  unhealthyCounts.set(key, next)
  return next
}

export function getEndpointUnhealthyCount(endpoint: string | undefined | null, modelId: string): number {
  return unhealthyCounts.get(endpointUnhealthyKey(endpoint, modelId)) ?? 0
}

/** 端点恢复正常（如一次成功带正文的响应）后可清零 */
export function resetEndpointUnhealthy(endpoint: string | undefined | null, modelId: string): void {
  unhealthyCounts.delete(endpointUnhealthyKey(endpoint, modelId))
}

/** 预留：供测试重置内部状态 */
export function __resetUnhealthyForTest(): void {
  unhealthyCounts.clear()
}

/** 供引擎构造 ReActAction（保持 actions 与 toolCallIds 同序） */
export function normalizedToolCallToAction(call: NormalizedToolCall): ReActAction {
  return { tool: call.name, args: call.args }
}
