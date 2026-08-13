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
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  /** DeepSeek/o1 等思考模型的 reasoning_content，需原样传回 API */
  reasoningContent?: string
}

export interface LlmAdapter {
  readonly name: string
  readonly provider: 'openai' | 'anthropic' | 'ollama' | 'custom-openai'
  /** 单次完整响应（非流式） */
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>
}
