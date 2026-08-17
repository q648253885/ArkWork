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
  LlmTool,
} from './adapter.js'
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

    // Claude 的 system 单独传入
    // messages 必须以 user 开头，且 system 不算
    const messages: Anthropic.MessageParam[] = req.messages
      .filter((m) => m.role !== 'system')
      .map(toAnthropicMessage)

    const tools: Anthropic.Tool[] | undefined = req.tools?.map(toAnthropicTool)

    const response = await this.client.messages.create(
      {
        model,
        system: req.system,
        messages,
        tools: tools as Anthropic.Tool[] | undefined,
        max_tokens: req.maxTokens ?? 4096,
        temperature: req.temperature ?? 0.5,
      },
      { signal: req.signal },
    )

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
        ? [{ type: 'text', text: response.content }]
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
}

/**
 * v0.20.0：从 Anthropic usage 提取缓存命中统计。
 * - cache_read_input_tokens：命中缓存读取的 token 数
 * - cache_creation_input_tokens：本次新写入缓存的 token 数
 * 两者都无时返回 undefined。
 */
function extractCacheUsage(usage: Anthropic.Usage): LlmCacheUsage | undefined {
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
