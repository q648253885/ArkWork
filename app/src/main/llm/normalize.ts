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
 * v0.48.1（D227）不可见格式字符剥离（v0.48.2 提取为独立 helper，D228 截断修复复用；
 * 正则与原内联版逐字节一致，行为不变）。
 */
function stripInvisibleFormatChars(s: string): string {
  return s.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200D\u2060-\u2064\u200E\u200F\uFEFF]/g,
    '',
  )
}

/** 对象（非数组、非 null）→ Record；其余 → undefined（数组/标量不做隐式转换） */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * v0.48.2（D228①）：整体双重编码剥离 —— arguments 整体被二次 JSON.stringify
 * （parse 出来是字符串，其内容才是真正的参数对象）。业界惯例（vLLM tool parser
 * 的协议归一化层）：网关层剥码。字段级双重编码由 act.ts 的 items 抢救兜底
 * （D225），本处收口整体形态。非字符串 / 内层解析不出对象 → 原样返回。
 */
function peelDoubleEncodedArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    const inner = JSON.parse(v)
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) return inner
  } catch {
    // 不是双层编码形态，原样返回（交给上层按旧路径降级 _raw）
  }
  return v
}

/**
 * v0.48.2（D228②）：截断 JSON 轻量闭合补全（partial-json 思路的静态版，业界
 * vLLM tool parser 的流式增量解析同源）。字符串感知扫描未闭合引号与括号栈，
 * 逆序补齐；尾部悬空的逗号/冒号一并剥掉。补全结果必须再过 JSON.parse 验证
 * （调用方负责），验证失败即放弃 —— 宁可 _raw 回喂，不执行修不出来的半截参数。
 *
 * 已知不覆盖（有意从简）：截断停在**键名中间**（如 `{"te`）补出的 `{"te"}` 不合法，
 * 验证失败自然回落 _raw；数组形态同理（asRecord 拒收数组）。
 */
function closeTruncatedJson(s: string): string | null {
  const t = s.length > 200_000 ? '' : s.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  // 结构已闭合就不是截断形态（是别的损坏），不画蛇添足
  if (!inString && stack.length === 0) return null
  let out = t
  if (inString) out += '"'
  out = out.replace(/[,:]\s*$/, '')
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']'
  return out
}

/** 单次解析 + 剥码（parse 失败 / 非对象形态 → undefined；null 按 '{}' 语义 = 空参数） */
function parseArgsLoose(s: string): Record<string, unknown> | undefined {
  try {
    return asRecord(peelDoubleEncodedArgs(JSON.parse(s || '{}') ?? {}))
  } catch {
    return undefined
  }
}

/**
 * tool_calls 容错解析（openai 分片聚合后的完整调用数组 → NormalizedToolCall[]）：
 * - id 缺失 / 空串 → 按下标合成稳定 id（同轮内不冲突）；
 * - arguments 为 string → JSON.parse；失败保留原文于 args._raw 并标 malformed；
 * - arguments 为空串 → 按 '{}' 解析（兼容端点省略 arguments 的形态）；
 * - v0.48.1（D224）：arguments 为**对象**（OpenAI 是 JSON 字符串，但兼容网关实测
 *   存在对象形态；ollama 原生通道早有 `ollamaNativeCallsToRaw` 同款容错）→ 直接
 *   作为 args 采用。此前被静默降级为 `{}` —— 模型提交的 items 等参数在到达
 *   act.ts 前消失，报出与事实不符的「items 必须是非空数组」（真机 qwen3.8 27b）。
 * - v0.48.2（D228，业界调研收口）：① 整体双重编码剥离（parse 出字符串且其内容
 *   再 parse 出对象 → 二次采用）；② 截断闭合补全（`allowTruncationRepair` 开启时，
 *   补齐未闭合引号/括号后重验）。**安全阀**：`finish_reason=length` 的响应上层
 *   关闭 ② —— 被长度截断的调用即使可补全也不执行（Pi agent loop 原则：半截参数
 *   比失败更危险）。
 */
export function normalizeToolCalls(
  calls: Array<{ id?: string | null; name?: string | null; arguments?: string | null }>,
  opts?: { allowTruncationRepair?: boolean },
): NormalizedToolCall[] {
  return calls.map((call, index) => {
    const name = typeof call.name === 'string' ? call.name : ''
    const rawArguments = typeof call.arguments === 'string' ? call.arguments : ''
    const id = typeof call.id === 'string' && call.id ? call.id : syntheticToolCallId(index, name, rawArguments)
    // v0.48.1（D224）：对象形态 arguments 直接采用（数组 / null 不在此列，仍走下方解析路径）
    const rawAny = call.arguments as unknown
    if (rawAny !== null && typeof rawAny === 'object' && !Array.isArray(rawAny)) {
      return {
        id,
        name,
        args: rawAny as Record<string, unknown>,
        malformed: false,
        rawArguments: JSON.stringify(rawAny),
      }
    }
    try {
      // v0.48.2（D228）：修复阶梯 = 直解（含剥码）→ 剥不可见字符重试（D227）→
      // 截断闭合补全（仅 allowTruncationRepair）。每步都必须产出对象形态才算成功。
      let args = parseArgsLoose(rawArguments) ?? parseArgsLoose(stripInvisibleFormatChars(rawArguments))
      if (args === undefined && opts?.allowTruncationRepair === true) {
        const closed = closeTruncatedJson(stripInvisibleFormatChars(rawArguments))
        if (closed !== null) args = parseArgsLoose(closed)
      }
      if (args === undefined) {
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
  const finishReason = normalizeFinishReason(kind, raw.finishReason)
  // v0.48.2（D228②）安全阀：finish_reason=length 的截断调用不启用闭合补全
  //（Pi agent loop 原则 —— 半截参数执行比失败更危险）；其余终止帧允许补全。
  const toolCalls = normalizeToolCalls(Array.isArray(raw.toolCalls) ? raw.toolCalls : [], {
    allowTruncationRepair: finishReason !== 'length',
  })
  return {
    text,
    reasoning,
    toolCalls,
    finishReason,
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
