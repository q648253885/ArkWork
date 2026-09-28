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
// v0.36.0 F1.5：协议归一化单一真源（finish_reason 映射 / tool_calls 容错）
import { normalizeFinishReason, normalizeToolCalls, type FinishReason } from './normalize.js'
import type { ReActAction } from '@shared/types/react'

export interface OpenAIOptions {
  apiKey: string
  /** 默认模型 ID，可在 req 中通过 metadata.modelId 覆盖（简化为每次显式传入） */
  defaultModel: string
  baseURL?: string
  /** 用于显示的适配器名 */
  name?: string
  provider?: 'openai' | 'ollama' | 'custom-openai'
  /**
   * v0.38.0（D161）：是否允许「思考 / 推理」模式。
   * `false` → 请求侧显式关闭（工具路由场景的推荐值，见 `thinkingExtrasFor` 注释）。
   * `undefined` → 沿用历史行为（对非官方 provider 注入开启参数）。
   */
  think?: boolean
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
/**
 * v0.38.0（D161）：把 `/no_think` 软开关追加到最后一条 user 消息（Qwen3 官方模板语法，ollama#14601）。
 *
 * 为什么不在 system 上：ollama/ollama#14601 明确模板只在最后一个 **user** 轮次
 * 追加该指令（`{{- if and $.IsThinkSet (eq $i $lastUserIdx) }}`），挂 system 无效。
 * 实测（本机 qwen3.5:0.8b / 局域网 qwen3.5:9b）确认：挂 system 时思考依旧开启。
 *
 * 幂等：已含 `/no_think` 则不再追加（同一轮可能被多条路径处理）。
 */
function appendNoThink(messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m && m.role === 'user' && typeof m.content === 'string') {
      if (!m.content.includes('/no_think')) m.content = `${m.content}\n/no_think`
      return
    }
  }
}

export function thinkingExtrasFor(
  provider: OpenAIOptions['provider'],
  think?: boolean,
): Record<string, unknown> {
  // v0.38.0（D161）：**思考模式会压掉原生 tool_calls**（实证 + 业界共识）。
  // 实机证据（2026-09-25，ArkWork + 局域网 Ollama qwen3.5:9b）：本函数此前无条件
  // 注入 `enable_thinking: true`，模型侧全程有「原生思考」输出（22–33s/轮），
  // 却**一次都没返回原生 tool_calls** —— 它把调用写成正文
  // （`file-reader(path=".")` / `task_plan(items=[…])`），引擎解析出 0 个动作
  // → 空转 21 轮；标题生成与计划生成同样返回空（思考块污染了 JSON 提取）。
  // 业界一手证据：
  //   · ollama/ollama#14601 —— Qwen3 经 `tools` 参数的工具定义被渲染畸形，
  //     且思考模式与工具调用互斥，官方建议绕过 tools 参数或关闭思考；
  //   · BerriAI/litellm#18922 —— qwen3 响应带 `thinking` 字段时 tool_calls 被丢弃；
  //   · 实战共识（dev.to）—— 工具路由场景应全局关闭思考（`options.think=false`），
  //     思考只增加延迟、并让下游 JSON 解析崩溃。
  // 因此：`think === false` 时显式注入**关闭**参数（三种常见形态同时发，
  // 端点不识别的由既有 400 降级路径兜底）。
  if (think === false) {
    // 显式关闭**优先于 provider 判定**：真实配置里 ollama 常被登记成 kind='openai'
    // （只把 baseURL 指向 11434），若按 provider 提前返回就永远关不掉。
    return { enable_thinking: false, chat_template_kwargs: { enable_thinking: false }, think: false }
  }
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

/**
 * v0.38.1（D167）：是否走 Ollama 原生 `/api/chat` 通道。
 *
 * D161 的三条思考关闭通道（`/no_think` 软开关、`enable_thinking`、
 * `chat_template_kwargs`）在 ollama 0.34.2 + qwen3.5:0.8b 实机 curl 直测
 * （2026-09-26）**全部被证伪**：
 *   · /v1 + 末条 user 追加 `/no_think` → 模型把它当正文分析，思考 93.8s 才出首轮；
 *   · /v1 + `reasoning_effort: 'none'` → 只隐藏 reasoning 字段，思考照烧（热测 58.3s）；
 *   · /v1 + `think: false` 透传 → 被端点忽略（max_tokens 全被思考吃光）。
 * 唯一有效通道：原生 `/api/chat` + `think: false` —— 同问题 9 eval tokens /
 * 0.5s 生成。`think` 是 /api/chat 的一等参数，/v1 网关不透传（ollama 官方行为）。
 *
 * 端点判定与 registry.resolveThink 的 isOllamaLikeEndpoint 同口径：
 * 真实配置里 ollama 常被登记成 kind='openai'，只有 baseURL 暴露 11434。
 *
 * ---------------------------------------------------------------------------
 * v0.40.0（D199）：**默认改走原生通道** —— 触发条件由「必须显式 `think === false`」
 * 放宽为「只要不是显式 `think === true`」。
 *
 * 为什么要改（实测，见 `docs/versions/v0.39.0/evidence/04-empty-response-root-cause.md` §3.2）：
 *   · 25 个工具 + 长 system（in≈3965）下，`/v1` 返回 `tc=0 / content=0ch /
 *     reasoning=217ch / out=131` —— **精确复现实机空响应形态**；
 *   · 同等规模的原生 `/api/chat` + `think:false`（in=3967 / 2782 / 1523）
 *     **三次全部**正常返回 `tool_calls`。
 *   两者唯一差异就是端点。而 `think` 在配置里缺省（undefined）是常态 →
 *   **默认路径恰好就是会空的那个路径**。
 *
 * 爆炸半径控制：
 *   · 只有**已判定为 Ollama 形态**的端点受影响（provider==='ollama' 或 baseURL
 *     含 `:11434`）；`https://api.openai.com/v1` 等恒 false（不变量 I-O6）；
 *   · 显式 `think === true`（用户主动要思考）保持走 `/v1`，既有行为不变；
 *   · 原生通道内部 `ollamaChatBody` 硬编码 `think: false`，无需调用方配合。
 * ---------------------------------------------------------------------------
 */
export function useOllamaNativeChannel(
  provider: OpenAIOptions['provider'],
  baseURL: string | undefined,
  think: boolean | undefined,
): boolean {
  // 显式要求思考 → 尊重用户配置（原生通道会强制 think:false，与用户意图冲突）
  if (think === true) return false
  if (provider === 'ollama') return true
  return /:11434\b/.test(baseURL ?? '')
}

export class OpenAIAdapter implements LlmAdapter {
  readonly name: string
  readonly provider: 'openai' | 'ollama' | 'custom-openai'
  private readonly client: OpenAI
  private readonly defaultModel: string
  /** v0.38.0（D161）：思考模式开关（false = 请求侧显式关闭） */
  private readonly think?: boolean

  constructor(opts: OpenAIOptions) {
    this.name = opts.name ?? 'OpenAI'
    this.provider = opts.provider ?? 'openai'
    this.defaultModel = opts.defaultModel
    this.think = opts.think
    this.client = new OpenAI({
      apiKey: opts.apiKey || 'dummy',
      baseURL: normalizeOpenAIBaseURL(opts.baseURL),
    })
  }

  async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    // v0.38.1（D167）：Ollama 端点 + 显式关思考 → 改走原生 /api/chat 通道
    // （/no_think 与 thinkingExtrasFor 三参数对 ollama /v1 均被实测证伪，
    // 证据见 useOllamaNativeChannel 注释）；非 ollama 端点（vLLM 等）仍走本路径。
    // v0.41.0（D208）：`req.think === true`（降级通道显式要求思考）时用
    // `useOllamaNativeChannel(…, false)` 做**形态探针** —— 只判断"是不是
    // ollama 形态"，绕开「模型配置 think===true 拒走原生」的规则（该规则
    // 存在的理由是"原生通道强制 think:false 与用户意图冲突"，而降级通道
    // 的 body 会带 req.think=true，冲突已不存在）。
    const useNative =
      req.think === true
        ? useOllamaNativeChannel(this.provider, this.client.baseURL, false)
        : useOllamaNativeChannel(this.provider, this.client.baseURL, this.think)
    if (useNative) {
      return this.completeOllamaNative(req)
    }

    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel

    // OpenAI 把 system 放进 messages 的第一条
    // v0.38.0（D161）：`/no_think` 提示词级关闭思考 —— 实测 Ollama 的 /v1 端点
    // 忽略 `think` / `enable_thinking` 参数（UI 仍显示「原生思考」）。按
    // ollama/ollama#14601：Qwen3 的思考开关在**模板层**，靠往提示词追加
    // `/no_think`（Ollama 自己也是这么做的），这是唯一对 /v1 也生效的通道。
    const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = [
      { role: 'system', content: req.system },
      ...req.messages.map(toOpenAIMessage),
    ]
    // v0.38.0（D161）：关闭思考 → 追加 `/no_think`（Ollama / Qwen3 模板层开关）。
    // 位置必须是**最后一条 user 消息**：ollama#14601 指出模板只在
    // `eq $i $lastUserIdx` 处追加该指令，挂在 system 上不生效（实测确认）。
    if (this.think === false) appendNoThink(messages)

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = req.tools?.map(toOpenAITool)

    const extras = thinkingExtrasFor(this.provider, this.think)
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
    // v0.38.1（D167）：同 complete —— Ollama 原生通道
    // v0.41.0（D208）：同 complete —— req.think=true 走形态探针（见 complete 注释）
    const useNative =
      req.think === true
        ? useOllamaNativeChannel(this.provider, this.client.baseURL, false)
        : useOllamaNativeChannel(this.provider, this.client.baseURL, this.think)
    if (useNative) {
      return this.completeStreamOllamaNative(req, handlers)
    }
    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel
    const messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam> = [
      { role: 'system', content: req.system },
      ...req.messages.map(toOpenAIMessage),
    ]
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = req.tools?.map(toOpenAITool)

    // v0.38.0（D161）：同 complete —— `/no_think` 追加到最后一条 user 消息
    if (this.think === false) appendNoThink(messages)
    const baseParams = {
      model,
      messages,
      tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
      tool_choice: tools ? ('auto' as const) : undefined,
      temperature: req.temperature ?? 0.5,
      max_tokens: req.maxTokens,
    }

    // ★ W1：思考参数注入（与 complete 同源）；不认参数的端点 400 → 去参重试
    const extras = thinkingExtrasFor(this.provider, this.think)
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

  /* ============ v0.38.1（D167）Ollama 原生 /api/chat 通道 ============ */

  /** 原生端点 URL：剥掉网关尾巴 /v1 后拼 /api/chat（保留路径前缀，兼容反代场景） */
  private ollamaChatUrl(): string {
    const base = this.client.baseURL.replace(/\/+$/, '').replace(/\/v1$/i, '')
    return `${base}/api/chat`
  }

  private ollamaChatBody(req: LlmCompleteRequest, stream: boolean, model: string): Record<string, unknown> {
    return {
      model,
      messages: toOllamaNativeMessages(req),
      stream,
      // D167 核心参数：think 是 /api/chat 的一等思考开关（/v1 不透传，实测唯一有效关闭通道）
      // v0.41.0（D208）：请求级覆盖 —— 降级通道显式 `think:true`（思考走独立
      // `message.thinking`，content 保持可解析）；缺省仍为 false（D161/D167 行为不变）。
      think: req.think === true,
      // 工具定义与 OpenAI 形态同构（ollama 原生协议兼容），直接复用 toOpenAITool
      tools: req.tools?.map(toOpenAITool),
      options: {
        temperature: req.temperature ?? 0.5,
        ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
      },
    }
  }

  private async postOllamaChat(req: LlmCompleteRequest, body: Record<string, unknown>): Promise<Response> {
    const res = await fetch(this.ollamaChatUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama /api/chat HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return res
  }

  private async completeOllamaNative(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel
    const res = await this.postOllamaChat(req, this.ollamaChatBody(req, false, model))
    const data = (await res.json()) as OllamaNativeChatResponse
    const msg = data.message
    return assembleOllamaNative(
      msg?.content ?? '',
      typeof msg?.thinking === 'string' ? msg.thinking : '',
      ollamaNativeCallsToRaw(msg?.tool_calls),
      data.done_reason,
      data.prompt_eval_count ?? 0,
      data.eval_count ?? 0,
    )
  }

  private async completeStreamOllamaNative(
    req: LlmCompleteRequest,
    handlers: LlmStreamHandlers,
  ): Promise<LlmCompleteResponse> {
    const model = (req as LlmCompleteRequest & { modelId?: string }).modelId ?? this.defaultModel
    const res = await this.postOllamaChat(req, this.ollamaChatBody(req, true, model))
    if (!res.body) throw new Error('Ollama /api/chat: empty stream body')
    return consumeOllamaNativeStream(res.body as unknown as AsyncIterable<Uint8Array>, handlers)
  }
}

/**
 * v0.27.0 R1：OpenAI tool_calls → ReAct actions 解析（complete / completeStream 共用单源）。
 * polish4 §A1：toolCallIds 与 actions 一一对应。
 * v0.36.0 F1.5：容错细则收敛至 llm/normalize.ts —— arguments 非法 JSON 降级
 * {_raw} 并计 malformed；id 缺失/空串（流式分片 slot.id 可能留 ''）合成稳定 id。
 */
function parseOpenAIToolCalls(
  calls: Array<{ id: string; function: { name: string; arguments: string } }>,
): {
  action: ReActAction | null
  actions?: ReActAction[]
  toolCallIds?: string[]
  toolCallId?: string
  malformedToolCallCount?: number
} {
  if (!calls || calls.length === 0) return { action: null }
  const normalized = normalizeToolCalls(
    calls.map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments })),
  )
  const actions: ReActAction[] = normalized.map((c) => ({ tool: c.name, args: c.args }))
  const toolCallIds = normalized.map((c) => c.id)
  return {
    action: actions[0],
    actions,
    toolCallIds,
    toolCallId: toolCallIds[0],
    malformedToolCallCount: normalized.filter((c) => c.malformed).length,
  }
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

/* ============================================================
 * v0.38.1（D167）Ollama 原生 /api/chat 协议形态
 * 与 OpenAI 兼容协议的关键差异：
 *   · tool_calls.function.arguments 是**对象**（OpenAI 是 JSON 字符串）；
 *   · 思考在 message.thinking（/v1 是 reasoning）；
 *   · 用量在顶层 prompt_eval_count / eval_count；终帧字段 done_reason；
 *   · 流式是 NDJSON 行（非 SSE `data:` 帧），每行一个完整 JSON。
 * ============================================================ */

interface OllamaNativeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  tool_name?: string
  tool_calls?: Array<{ function: { name?: string; arguments?: unknown } }>
}

interface OllamaNativeChatResponse {
  message?: OllamaNativeMessage
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

/**
 * LlmMessage → ollama 原生消息。assistant 思考不回传（think:false 路径不产生
 * 原生思考字段；历史 reasoningContent 传给 ollama 反而是未定义行为）。
 */
function toOllamaNativeMessages(req: LlmCompleteRequest): OllamaNativeMessage[] {
  const msgs: OllamaNativeMessage[] = [{ role: 'system', content: req.system }]
  for (const m of req.messages) {
    if (m.role === 'tool') {
      msgs.push({ role: 'tool', content: m.content, ...(m.name ? { tool_name: m.name } : {}) })
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      msgs.push({
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.function.name, arguments: ollamaArgsFromRaw(tc.function.arguments) },
        })),
      })
    } else {
      msgs.push({ role: m.role, content: m.content })
    }
  }
  return msgs
}

/** 历史里的 arguments 是字符串（OpenAI 形态）；ollama 期待对象。解析失败原样传字符串（ollama 兼容 string 形态） */
function ollamaArgsFromRaw(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** ollama 响应 tool_calls（arguments 为对象）→ OpenAI 字符串形态 → 既有 normalize 单源（id 缺失合成） */
function ollamaNativeCallsToRaw(
  calls: Array<{ function: { name?: string; arguments?: unknown } }> | undefined,
): Array<{ id: string; function: { name: string; arguments: string } }> {
  return (calls ?? []).map((tc) => ({
    id: '',
    function: {
      name: tc.function?.name ?? '',
      arguments:
        typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
    },
  }))
}

/** 聚合结果 → LlmCompleteResponse（complete 与流式聚合共用终装配） */
function assembleOllamaNative(
  content: string,
  reasoning: string,
  calls: Array<{ id: string; function: { name: string; arguments: string } }>,
  doneReason: string | undefined,
  tokensIn: number,
  tokensOut: number,
): LlmCompleteResponse {
  // 安全兜底：老模型把思考内嵌 content（<think>），与 /v1 路径同口径剥离
  const { think, rest } = stripThinkBlocks(content)
  let finalContent = content
  let reasoningContent = reasoning || undefined
  if (think !== null) {
    finalContent = rest
    if (think) reasoningContent = reasoningContent ? `${reasoningContent}\n${think}` : think
  }
  const parsed = parseOpenAIToolCalls(calls)
  const { thought: cleanThought, say } = extractSayMarker(finalContent)
  const hasToolCalls = (parsed.actions?.length ?? 0) > 0
  return {
    content: finalContent,
    thought: cleanThought,
    say,
    ...parsed,
    tokensIn,
    tokensOut,
    // ollama 原生协议不报告缓存统计
    finishReason: hasToolCalls ? 'tool_calls' : mapFinishReason(doneReason),
    reasoningContent,
  }
}

/** NDJSON 流消费：逐行解析（空行/噪声行跳过），增量走 handlers，聚合走 assembleOllamaNative */
async function consumeOllamaNativeStream(
  body: AsyncIterable<Uint8Array>,
  handlers: LlmStreamHandlers,
): Promise<LlmCompleteResponse> {
  const decoder = new TextDecoder()
  const stripper = createThinkStripper()
  let buffer = ''
  let content = ''
  let reasoning = ''
  const rawCalls: Array<{ id: string; function: { name: string; arguments: string } }> = []
  let doneReason: string | undefined
  let tokensIn = 0
  let tokensOut = 0
  let sawDone = false

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim()
    if (!line) return
    let evt: OllamaNativeChatResponse
    try {
      evt = JSON.parse(line) as OllamaNativeChatResponse
    } catch {
      return // NDJSON 中间夹噪声行：跳过不中断
    }
    const m = evt.message
    if (m) {
      if (m.content) {
        const split = stripper.push(m.content)
        if (split.text) {
          content += split.text
          handlers.onText(split.text)
        }
        if (split.think) {
          reasoning += split.think
          handlers.onReasoning?.(split.think)
        }
      }
      if (m.thinking) {
        reasoning += m.thinking
        handlers.onReasoning?.(m.thinking)
      }
      rawCalls.push(...ollamaNativeCallsToRaw(m.tool_calls))
    }
    if (evt.done) {
      sawDone = true
      doneReason = evt.done_reason
      tokensIn = evt.prompt_eval_count ?? 0
      tokensOut = evt.eval_count ?? 0
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
    }
  }
  buffer += decoder.decode()
  handleLine(buffer) // 收尾：最后一行可能不带换行

  const tail = stripper.finish()
  if (tail.text) {
    content += tail.text
    handlers.onText(tail.text)
  }
  if (tail.think) {
    reasoning += tail.think
    handlers.onReasoning?.(tail.think)
  }
  return assembleOllamaNative(
    content,
    reasoning,
    rawCalls,
    sawDone ? doneReason : undefined,
    tokensIn,
    tokensOut,
  )
}

/**
 * 端点终止帧 → 内部终止原因。
 *
 * **导出仅为可测性**（v0.32.1 缺陷 D35 回归）：本函数的 `default` 分支曾把
 * 「流没有终止帧」伪装成 `'stop'`，是「思考突然中断却被当成正常回合」的根因之一。
 * v0.36.0 F1.5：映射表收敛至 llm/normalize.ts（openai 词表 + 缺省 interrupted），
 * 此处保留薄包装（兼容既有 import 与行为用例）。
 */
export function mapFinishReason(
  reason: string | null | undefined,
): FinishReason {
  return normalizeFinishReason('openai', reason)
}
