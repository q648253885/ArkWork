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
      baseURL: opts.baseURL,
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

    const completion = await this.client.chat.completions.create(
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

    const choice = completion.choices[0]
    const message = choice.message
    const content = message.content ?? ''
    const toolCalls = message.tool_calls ?? []
    // DeepSeek/o1 等思考模型返回的 reasoning_content，需原样传回
    const reasoningContent = (message as unknown as Record<string, unknown>).reasoning_content as string | undefined

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

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
    try {
      stream = await this.client.chat.completions.create(
        { ...baseParams, stream: true, stream_options: { include_usage: true } },
        { signal: req.signal },
      )
    } catch (err) {
      if (err instanceof Error && err.message.includes('stream_options')) {
        stream = await this.client.chat.completions.create({ ...baseParams, stream: true }, { signal: req.signal })
      } else {
        throw err
      }
    }

    let content = ''
    let reasoning = ''
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
        content += delta.content
        handlers.onText(delta.content)
      }
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content
        handlers.onReasoning?.(delta.reasoning_content)
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

function mapFinishReason(
  reason: string | null | undefined,
): 'stop' | 'tool_calls' | 'length' | 'content_filter' {
  switch (reason) {
    case 'tool_calls':
      return 'tool_calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}
