/* ============================================================
 * ArkWork — OpenAI Adapter (官方 SDK，同时用于 OpenAI 兼容端点)
 * 设计文档 §10.3 — 支持 OpenAI / DeepSeek / Moonshot / 本地 Ollama 的 OpenAI 兼容接口
 * ============================================================ */
import OpenAI from 'openai'
import type {
  LlmAdapter,
  LlmCacheUsage,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmMessage,
  LlmStreamHandlers,
  LlmTool,
} from './adapter.js'
import { extractSayMarker } from './say-marker.js'
import { createThinkStripper, stripThinkBlocks } from './think-strip.js'
import type { ReActAction } from '@shared/types/react'

export interface OpenAIOptions {
  apiKey: string
  /** 默认模型 ID，可在 req 中通过 metadata.modelId 覆盖（简化为每次显式传入） */
  defaultModel: string
  baseURL?: string
  /** 用于显示的适配器名 */
  name?: string
  provider?: 'openai' | 'ollama' | 'custom-openai'
}

/**
 * ★ v0.33.1 W1：思考开启参数注入（用户实测：OpenAI 协议接 qwen3 无思考过程）。
 *
 * qwen3 / DeepSeek 等思考模型在 OpenAI 兼容端点上的思考开关**没有统一标准**：
 *  - vLLM / SGLang：`chat_template_kwargs: { enable_thinking: true }`
 *  - DashScope 兼容模式：顶层 `enable_thinking: true`
 * 两者同时注入（不识别未知参数的端点由 400 降级路径兜底）。
 * **只对非官方 provider 注入** —— OpenAI 官方对未知顶层参数会 400，
 * 且官方模型的思考开关走 `reasoning_effort`（本产品暂不暴露）。
 */
export function thinkingExtrasFor(provider: OpenAIOptions['provider']): Record<string, unknown> {
  if (provider === 'openai' || !provider) return {}
  return { enable_thinking: true, chat_template_kwargs: { enable_thinking: true } }
}

/** 降级判定：端点不认注入的思考参数（各端点报错文案不一，按关键词宽匹配） */
export function isThinkingParamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /enable_thinking|chat_template_kwargs|unrecognized|unknown.*(argument|parameter|field)|unexpected.*keyword|invalid.*request/i.test(
    msg,
  )
}

/**
 * v0.34.x 多协议思考字段归一化（导出仅为可测性）：
 * OpenAI 兼容生态的思考字段**没有统一标准** ——
 *  - DeepSeek / 多数网关 / LM Studio：`reasoning_content`
 *  - Ollama（≥0.9 OpenAI 兼容）/ OpenRouter：`reasoning`
 * 只读其一时，另一形态的思考会被**静默丢弃**（L1 raw 缺思考、下一轮无法原样传回，
 * 客户端要求回传时还会 400）。顺序：reasoning_content 优先（生态更广），两者都取首
 * 个非空字符串。
 */
export function pickReasoningField(src: unknown): string | undefined {
  if (!src || typeof src !== 'object') return undefined
  const raw = src as Record<string, unknown>
  for (const key of ['reasoning_content', 'reasoning'] as const) {
    const v = raw[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/**
 * v0.31.1：baseURL 归一化（用户实测缺陷）。
 * 官方 SDK 会在 baseURL 后自动拼 `/chat/completions`；若用户在设置里填的
 * 就是**完整对话端点**（以 `/chat/completions` 结尾），SDK 会二次拼接成
 * `.../chat/completions/chat/completions` → 404。
 * 规则：剥掉尾部的 `/chat/completions`（大小写不敏感、容忍尾斜杠），
 * 其余情况原样返回 —— 用户填 base 或完整端点都能正确工作。
 * registry 的 `/models` 连通性检查也走本函数，保证两处口径一致。
 */
export function normalizeOpenAIBaseURL(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const url = raw.trim()
  if (!url) return raw
  return url.replace(/\/chat\/completions\/?$/i, '')
}

export class OpenAIAdapter implements LlmAdapter {
  readonly name: string
  readonly provider: 'openai' | 'ollama' | 'custom-openai'
  private readonly client: OpenAI
  private readonly defaultModel: string

  constructor(opts: OpenAIOptions) {
    this.name = opts.name ?? 'OpenAI'
    this.provider = opts.provider ?? 'openai'
    this.defaultModel = opts.defaultModel
    this.client = new OpenAI({
      apiKey: opts.apiKey || 'dummy',
      baseURL: normalizeOpenAIBaseURL(opts.baseURL),
    })
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel

    // OpenAI 把 system 放进 messages 的第一条
    const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = [
      { role: 'system', content: req.system },
      ...req.messages.map(toOpenAIMessage),
    ]

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = req.tools?.map(toOpenAITool)

    const extras = thinkingExtrasFor(this.provider)
    let completion: OpenAI.Chat.Completions.ChatCompletion
    try {
      completion = await this.client.chat.completions.create(
        {
          model,
          messages,
          tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
          tool_choice: tools ? 'auto' : undefined,
          temperature: req.temperature ?? 0.5,
          max_tokens: req.maxTokens,
          ...extras,
        },
        { signal: req.signal },
      )
    } catch (err) {
      if (Object.keys(extras).length > 0 && isThinkingParamError(err)) {
        // 端点不认思考参数 → 去掉重试一次（宁可无思考参数也不能让请求挂掉）
        completion = await this.client.chat.completions.create(
          {
            model,
            messages,
            tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
            tool_choice: tools ? 'auto' : undefined,
            temperature: req.temperature ?? 0.5,
            max_tokens: req.maxTokens,
          },
          { signal: req.signal },
        )
      } else {
        throw err
      }
    }

    const choice = completion.choices[0]
    const message = choice.message
    let content = message.content ?? ''
    const toolCalls = message.tool_calls ?? []
    // DeepSeek/o1 等思考模型返回的 reasoning_content，需原样传回
    // v0.34.x：多协议归一化 —— Ollama(≥0.9)/OpenRouter 用 `reasoning` 字段，一并识别
    let reasoningContent = pickReasoningField(message)

    // ★ W1：`<think>` 内嵌思考剥离（llama.cpp / Ollama 等端点把思考混在 content 里）
    // v0.34.x 修正：stripThinkBlocks 对「空 body 的 think 对」（`<think>\n\n</think>`，
    // qwen3.5 空转实测形态）返回 think=''，此前 `if (think)` 为假导致**不剥离** ——
    // 裸标签泄漏进 content，回合被误判为「有内容」空转。改为按 null 判「无标签」。
    const { think, rest } = stripThinkBlocks(content)
    if (think !== null) {
      content = rest
      if (think) reasoningContent = reasoningContent ? `${reasoningContent}\n${think}` : think
    }

    // v0.20.0：提取缓存命中统计（DeepSeek / MiniMax 等 OpenAI 兼容端点）
    const cache = extractCacheUsage(completion.usage)

    // v0.27.0 R1：tool_calls 解析收敛为共享函数（complete / completeStream 同源）
    const parsed = parseOpenAIToolCalls(toolCalls)

    // v0.25.0 F4：从 content 抽取 SAY 标记块（剥离后 thought 不污染内部思考）
    const { thought: cleanThought, say } = extractSayMarker(content)
    return {
      content,
      thought: cleanThought,
      say,
      ...parsed,
      tokensIn: completion.usage?.prompt_tokens ?? 0,
      tokensOut: completion.usage?.completion_tokens ?? 0,
      cache,
      finishReason: mapFinishReason(choice.finish_reason),
      reasoningContent,
    }
  }

  /**
   * v0.27.0 R1：流式实现（SDK stream + stream_options.include_usage）。
   * - content / reasoning_content / tool_calls 增量实时回调 handlers（渲染加速）；
   * - 返回值与 complete 同构（聚合 usage、tool_calls、say 后的完整响应）；
   * - 部分旧兼容端点不认 stream_options 参数（400）：自动去掉重试一次，
   *   此时该端点不回 usage → tokensIn/Out 为 0（可接受的降级，非流式路径不受影响）。
   */
  async completeStream(req: LlmCompleteRequest, handlers: LlmStreamHandlers): Promise<LlmCompleteResponse> {
    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel
    const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = [
      { role: 'system', content: req.system },
      ...req.messages.map(toOpenAIMessage),
    ]
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = req.tools?.map(toOpenAITool)

    const baseParams = {
      model,
      messages,
      tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
      tool_choice: tools ? ('auto' as const) : undefined,
      temperature: req.temperature ?? 0.5,
      max_tokens: req.maxTokens,
    }

    // ★ W1：思考参数注入（与 complete 同源）；不认参数的端点 400 → 去参重试
    const extras = thinkingExtrasFor(this.provider)
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
    try {
      stream = await this.client.chat.completions.create(
        { ...baseParams, ...extras, stream: true, stream_options: { include_usage: true } },
        { signal: req.signal },
      )
    } catch (err) {
      if (Object.keys(extras).length > 0 && isThinkingParamError(err)) {
        stream = await this.client.chat.completions.create(
          { ...baseParams, stream: true, stream_options: { include_usage: true } },
          { signal: req.signal },
        )
      } else if (err instanceof Error && err.message.includes('stream_options')) {
        stream = await this.client.chat.completions.create({ ...baseParams, ...extras, stream: true }, { signal: req.signal })
      } else {
        throw err
      }
    }

    let content = ''
    let reasoning = ''
    // ★ W1：`<think>` 内嵌思考的流式分流（think → reasoning 通道，正文 → content）
    const thinkStripper = createThinkStripper()
    let finishReason: string | null | undefined
    let usage: OpenAI.Completions.CompletionUsage | undefined
    // 按 index 聚合分片到达的 tool_calls（name/arguments 可能拆成多段）
    const rawCalls: Array<{ id: string; function: { name: string; arguments: string } }> = []

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta as ((typeof choice.delta) & { reasoning_content?: string }) | undefined
      if (delta?.content) {
        const split = thinkStripper.push(delta.content)
        if (split.text) {
          content += split.text
          handlers.onText(split.text)
        }
        if (split.think) {
          reasoning += split.think
          handlers.onReasoning?.(split.think)
        }
      }
      // v0.34.x：多协议归一化 —— `reasoning_content`（DeepSeek 系）与
      // `reasoning`（Ollama/OpenRouter 系）两种增量字段都识别
      const reasoningDelta = pickReasoningField(delta)
      if (reasoningDelta) {
        reasoning += reasoningDelta
        handlers.onReasoning?.(reasoningDelta)
      }
      for (const tc of delta?.tool_calls ?? []) {
        while (rawCalls.length <= tc.index) rawCalls.push({ id: '', function: { name: '', arguments: '' } })
        const slot = rawCalls[tc.index]
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.function.name += tc.function.name
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    // 流结束：把滞留字符按当前态交还（THINK 未闭合 → 归思考）
    const tail = thinkStripper.finish()
    if (tail.text) {
      content += tail.text
      handlers.onText(tail.text)
    }
    if (tail.think) {
      reasoning += tail.think
      handlers.onReasoning?.(tail.think)
    }

    const parsed = parseOpenAIToolCalls(rawCalls)
    const { thought: cleanThought, say } = extractSayMarker(content)
    return {
      content,
      thought: cleanThought,
      say,
      ...parsed,
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0,
      cache: extractCacheUsage(usage),
      finishReason: mapFinishReason(finishReason),
      reasoningContent: reasoning || undefined,
    }
  }
}

/**
 * v0.27.0 R1：OpenAI tool_calls → ReAct actions 解析（complete / completeStream 共用单源）。
 * polish4 §A1：toolCallIds 与 actions 一一对应；arguments 非法 JSON 时降级 _raw。
 */
function parseOpenAIToolCalls(
  calls: Array<{ id: string; function: { name: string; arguments: string } }>,
): {
  action: ReActAction | null
  actions?: ReActAction[]
  toolCallIds?: string[]
  toolCallId?: string
} {
  const actions: ReActAction[] = []
  const toolCallIds: string[] = []
  for (const call of calls) {
    toolCallIds.push(call.id)
    try {
      const args = JSON.parse(call.function.arguments || '{}')
      actions.push({ tool: call.function.name, args })
    } catch {
      actions.push({ tool: call.function.name, args: { _raw: call.function.arguments } })
    }
  }
  if (actions.length === 0) return { action: null }
  return { action: actions[0], actions, toolCallIds, toolCallId: toolCallIds[0] }
}

/**
 * v0.20.0：从 OpenAI 兼容端点的 usage 提取缓存命中统计。
 * v0.23.1：补齐字段口径（此前只认 DeepSeek/MiniMax 两种，其他端点一律返回
 * undefined，UI 命中率恒为 0）——
 * - DeepSeek：usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - Moonshot Kimi：usage.cached_tokens（顶层）
 * - OpenAI / MiniMax / 智谱：usage.prompt_tokens_details.cached_tokens
 * 都没有时返回 undefined（表示该端点未报告缓存信息）。
 */
export function extractCacheUsage(
  usage: OpenAI.Completions.CompletionUsage | null | undefined,
): LlmCacheUsage | undefined {
  if (!usage) return undefined
  const raw = usage as unknown as Record<string, unknown>
  const promptTokens = usage.prompt_tokens ?? 0

  // DeepSeek 风格：prompt_cache_hit_tokens / prompt_cache_miss_tokens
  const hit = raw.prompt_cache_hit_tokens
  const miss = raw.prompt_cache_miss_tokens
  if (typeof hit === 'number' || typeof miss === 'number') {
    const hitTokens = typeof hit === 'number' ? hit : 0
    const missTokens =
      typeof miss === 'number' ? miss : Math.max(0, promptTokens - hitTokens)
    return { hitTokens, missTokens }
  }

  // Moonshot Kimi 风格：顶层 cached_tokens（v0.23.1 补）
  const topLevelCached = raw.cached_tokens
  if (typeof topLevelCached === 'number') {
    return { hitTokens: topLevelCached, missTokens: Math.max(0, promptTokens - topLevelCached) }
  }

  // OpenAI / MiniMax / 智谱风格：prompt_tokens_details.cached_tokens
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined
  const cached = details?.cached_tokens
  if (typeof cached === 'number') {
    return { hitTokens: cached, missTokens: Math.max(0, promptTokens - cached) }
  }

  return undefined
}

function toOpenAIMessage(m: LlmMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.toolCallId ?? '',
    }
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
      // DeepSeek 思考模式要求原样传回 reasoning_content；空串也要保留字段
      // （服务端只校验字段存在性，缺字段会 400 "must be passed back"）
      ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam
  }
  return {
    role: m.role as 'system' | 'user',
    content: m.content,
  }
}

function toOpenAITool(t: LlmTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as unknown as Record<string, unknown>,
    },
  }
}

/**
 * 端点终止帧 → 内部终止原因。
 *
 * **导出仅为可测性**（v0.32.1 缺陷 D35 回归）：本函数的 `default` 分支曾把
 * 「流没有终止帧」伪装成 `'stop'`，是「思考突然中断却被当成正常回合」的根因之一。
 * 行为语义（而非文本形态）必须被用例钉住，故导出后直接断言其返回值。
 */
export function mapFinishReason(
  reason: string | null | undefined,
): 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'interrupted' {
  switch (reason) {
    case 'stop':
      // 显式列出：OpenAI 兼容端点的正常终止值就是 'stop'。
      // 加这一 case 是为了把 default 让给「没有终止帧」这一异常情形（见下）。
      return 'stop'
    case 'tool_calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      // ⚠️ 缺陷 D35：此处原为 `default: return 'stop'` —— 把「流根本没有终止帧」
      // 伪装成「模型正常说完」。实测（ModelScope/GLM-5.3-Flash）表现为：调用
      // 恰好 120s 后被超时中止、usage 为 0+0、只有 reasoning 没有 content，
      // 而 finishReason='stop' 让引擎把它当成一个合法的「无工具调用回合」，
      // 于是任务被静默判为完成、清单纹丝不动。
      // 现在如实上报 'interrupted'，由引擎决定重试或失败收尾。
      return 'interrupted'
  }
}
