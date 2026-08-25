/* ============================================================
 * ArkWork — Anthropic Claude Adapter
 * 设计文档 §10.3
 * Claude 的 system 字段独立于 messages；tool_calls 走 content blocks
 * ============================================================ */
import Anthropic from '@anthropic-ai/sdk'
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

export interface AnthropicOptions {
  apiKey: string
  defaultModel: string
  baseURL?: string
  name?: string
}

export class AnthropicAdapter implements LlmAdapter {
  readonly name: string
  readonly provider = 'anthropic' as const
  private readonly client: Anthropic
  private readonly defaultModel: string

  constructor(opts: AnthropicOptions) {
    this.name = opts.name ?? 'Anthropic'
    this.defaultModel = opts.defaultModel
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel

    // v0.23.1 缓存修复：Anthropic prompt caching 必须显式标记 cache_control 断点，
    // 否则 cache_read_input_tokens 恒为 0（命中率 0 的根因）。
    // 借鉴 Claude Code 的断点布局：system 尾 + tools 尾 + 消息末尾（≤4 个断点限制内）。
    const { system, tools, messages } = withCacheBreakpoints(req)

    const response = await this.client.messages.create(
      {
        model,
        system,
        messages,
        tools,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.5,
      },
      { signal: req.signal },
    )

    // v0.27.0 R1：响应解析收敛为共享函数（complete / completeStream 同源）
    return parseAnthropicResponse(response)
  }

  /**
   * v0.27.0 R1：流式实现（SDK messages.stream）。
   * - text 增量经 'text' 事件实时回调 handlers；thinking 增量经 streamEvent 的
   *   thinking_delta 回调（extended thinking，SDK 类型未含该 delta，运行时透传有效）；
   * - finalMessage() 聚合完整响应后复用与 complete 同一解析函数，返回值同构；
   * - cache_control 断点布局与非流式完全一致（withCacheBreakpoints 单源）。
   */
  async completeStream(req: LlmCompleteRequest, handlers: LlmStreamHandlers): Promise<LlmCompleteResponse> {
    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel
    const { system, tools, messages } = withCacheBreakpoints(req)

    const stream = this.client.messages.stream(
      {
        model,
        system,
        messages,
        tools,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.5,
      },
      { signal: req.signal },
    )

    stream.on('text', (t) => handlers.onText(t))
    stream.on('streamEvent', (event) => {
      if (event.type !== 'content_block_delta') return
      const delta = event.delta as unknown as { type?: string; thinking?: string }
      if (delta.type === 'thinking_delta' && delta.thinking) handlers.onReasoning?.(delta.thinking)
    })

    const response = await stream.finalMessage()
    return parseAnthropicResponse(response)
  }
}

/** v0.27.0 R1：Anthropic Message → LlmCompleteResponse（complete / completeStream 共用单源） */
function parseAnthropicResponse(response: Anthropic.Message): LlmCompleteResponse {
  // 提取 text content block + tool_use block
  let content = ''
  let thought = ''
  let action: ReActAction | null = null
  let toolCallId: string | undefined
  const actions: ReActAction[] = []
  // polish4 §A1：收集全部 toolUse id，与 actions 一一对应
  const toolCallIds: string[] = []

  // v0.15.x 防御：API 偶发返回非数组 content（字符串或异常 shape），避免
  // `response.content is not iterable` 直接让任务失败。
  const blocks = Array.isArray(response.content)
    ? response.content
    : typeof response.content === 'string'
      ? [{ type: 'text' as const, text: response.content }]
      : []
  for (const block of blocks) {
    if (block.type === 'text') {
      content += block.text
      thought += block.text
    } else if (block.type === 'tool_use') {
      const toolBlock = block as { id: string; name: string; input: unknown }
      toolCallIds.push(toolBlock.id)
      actions.push({ tool: toolBlock.name, args: (toolBlock.input as Record<string, unknown>) ?? {} })
    }
  }
  if (actions.length > 0) {
    action = actions[0]
    toolCallId = toolCallIds[0]
  }

  return {
    content,
    thought,
    action,
    actions: actions.length > 0 ? actions : undefined,
    toolCallIds: toolCallIds.length > 0 ? toolCallIds : undefined,
    toolCallId,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    cache: extractCacheUsage(response.usage),
    finishReason: mapFinishReason(response.stop_reason),
  }
}

/**
 * v0.20.0：从 Anthropic usage 提取缓存命中统计。
 * - cache_read_input_tokens：命中缓存读取的 token 数
 * - cache_creation_input_tokens：本次新写入缓存的 token 数
 * 两者都无时返回 undefined。
 */
export function extractCacheUsage(usage: Anthropic.Usage): LlmCacheUsage | undefined {
  const raw = usage as unknown as Record<string, unknown>
  const read = raw.cache_read_input_tokens
  const write = raw.cache_creation_input_tokens
  if (typeof read !== 'number' && typeof write !== 'number') return undefined
  const hitTokens = typeof read === 'number' ? read : 0
  return {
    hitTokens,
    missTokens: Math.max(0, usage.input_tokens - hitTokens),
    writeTokens: typeof write === 'number' ? write : undefined,
  }
}

/**
 * v0.23.1 缓存修复：为请求打 cache_control 断点（借鉴 Claude Code 布局）。
 * - system：转 text block 数组，块尾标 ephemeral
 * - tools：最后一个 tool 标 ephemeral
 * - messages：最后一条消息的最后一个 content block 标 ephemeral
 * 共 3 个断点（API 上限 4 个）。ReAct 循环中 system/tools/历史消息逐字节稳定，
 * 断点随对话尾部滚动 → 前缀稳定命中，cache_read_input_tokens 不再恒为 0。
 */
export function withCacheBreakpoints(req: LlmCompleteRequest): {
  system: Anthropic.MessageCreateParams['system']
  tools: Anthropic.Tool[] | undefined
  messages: Anthropic.MessageParam[]
} {
  const system = req.system
    ? [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }]
    : undefined

  const tools = req.tools?.map((t, i) =>
    i === req.tools!.length - 1
      ? { ...toAnthropicTool(t), cache_control: { type: 'ephemeral' as const } }
      : toAnthropicTool(t),
  )

  const messages: Anthropic.MessageParam[] = req.messages
    .filter((m) => m.role !== 'system')
    .map(toAnthropicMessage)
  if (messages.length > 0) {
    const last = messages[messages.length - 1]
    messages[messages.length - 1] = markLastBlockCacheable(last)
  }

  return { system, tools, messages }
}

/** 把消息的最后一个 content block 标记为缓存断点（string content 自动转 block 数组）。
 * 注：SDK 0.30.x 的类型声明未含 cache_control（运行时透传有效），走双重断言。 */
function markLastBlockCacheable(m: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof m.content === 'string') {
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } },
      ] as unknown as NonNullable<Anthropic.MessageParam['content']>,
    }
  }
  if (!Array.isArray(m.content) || m.content.length === 0) return m
  const blocks = [...(m.content as unknown as Record<string, unknown>[])]
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: 'ephemeral' },
  }
  return {
    role: m.role,
    content: blocks as unknown as NonNullable<Anthropic.MessageParam['content']>,
  }
}

function toAnthropicMessage(m: LlmMessage): Anthropic.MessageParam {
  if (m.role === 'tool') {
    // Anthropic 把 tool result 作为 user 消息的 tool_result content
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: m.content,
        },
      ],
    }
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: [
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...m.toolCalls.map((tc) => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.function.name,
          input: safeJsonParse(tc.function.arguments),
        })),
      ],
    }
  }
  return {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }
}

function toAnthropicTool(t: LlmTool): Anthropic.Tool {
  return {
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function mapFinishReason(
  reason: string | null | undefined,
): 'stop' | 'tool_calls' | 'length' | 'content_filter' {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}
