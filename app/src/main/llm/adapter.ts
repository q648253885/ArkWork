/* ============================================================
 * ArkWork — LLM Adapter Interface
 * 设计文档 §10.3
 * 统一接口让 Agent 引擎与具体厂商解耦
 * ============================================================ */
import type { ReActAction } from '@shared/types/react'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 用于 tool 角色消息 */
  toolCallId?: string
  /** assistant 消息可以包含 tool_calls */
  toolCalls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  /** 用于 tool 角色消息显示是哪个工具的结果 */
  name?: string
  /** DeepSeek/o1 等思考模型的 reasoning_content，需原样传回 API */
  reasoningContent?: string
}

export interface LlmTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * v0.20.0 缓存命中统计（跨厂商统一口径）：
 * DeepSeek → prompt_cache_hit_tokens / prompt_cache_miss_tokens；
 * MiniMax → prompt_tokens_details.cached_tokens；
 * Anthropic → cache_read_input_tokens / cache_creation_input_tokens。
 */
export interface LlmCacheUsage {
  /** 本次输入命中缓存的 token 数 */
  hitTokens: number
  /** 本次输入未命中缓存的 token 数 */
  missTokens: number
  /** 本次新写入缓存的 token 数（部分厂商提供，可缺省） */
  writeTokens?: number
}

export interface LlmCompleteRequest {
  system: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface LlmCompleteResponse {
  content: string                  // assistant 的文本回复
  thought: string                  // 解析后的 Reasoning（去掉 tool_call 部分）
  /** v0.25.0 F4：给用户看的阶段叙述（结论 + 下一步），由模型通过 JSON `say` 字段或单独 marker 输出；
   * 与 thought 分离，不进入 L1 对话历史（仅 step 展示层负载） */
  say?: string
  action: ReActAction | null       // 工具调用解析结果（兼容旧单调用路径）
  /** 同一轮返回的工具调用；多个调用可在无依赖时并行执行 */
  actions?: ReActAction[]
  /**
   * polish4-react-tool-call-id §A1：与 actions 一一对应的 tool_call id 列表。
   * 并行多 tool 时每条 tool 消息需配对到独立 id（OpenAI 兼容 API 强约束）。
   * 单 tool 时长度 = 1。
   */
  toolCallIds?: string[]
  /** 向后兼容：toolCallIds[0] 的别名 */
  toolCallId?: string             // 用于回写 tool result
  tokensIn: number
  tokensOut: number
  /** v0.20.0：缓存命中统计（厂商未返回时为 undefined） */
  cache?: LlmCacheUsage
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  /** DeepSeek/o1 等思考模型的 reasoning_content，需原样传回 API */
  reasoningContent?: string
}

/** v0.27.0 R1：流式增量回调集合（渲染加速用；聚合结果仍以返回值为准） */
export interface LlmStreamHandlers {
  /** assistant 文本增量（content delta） */
  onText: (delta: string) => void
  /** 思考模型 reasoning 增量（可选；DeepSeek reasoning_content / Anthropic thinking） */
  onReasoning?: (delta: string) => void
}

export interface LlmAdapter {
  readonly name: string
  readonly provider: 'openai' | 'anthropic' | 'ollama' | 'custom-openai'
  /** 单次完整响应（非流式） */
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>
  /**
   * v0.27.0 R1：可选流式接口。返回值与 complete 完全同构（聚合后的完整响应，
   * 含 usage/tool_calls/say 解析），增量仅通过 handlers 回调加速渲染。
   * 引擎侧 completeWithStream 在适配器未实现本方法时自动回退 complete
   * （静默降级，见 docs/versions/v0.27.0/03-system-design.md §2.3）。
   */
  completeStream?(req: LlmCompleteRequest, handlers: LlmStreamHandlers): Promise<LlmCompleteResponse>
}
