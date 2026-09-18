/* ============================================================
 * ArkWork — 多协议响应形态仿真测试（v0.34.x · TC-PS-001..011）
 *
 * 背景（用户报障「Agent 问候循环 / 空响应空转」）：同一台局域网 Ollama
 * 在应用里切换 kind（ollama ↔ openai）后症状不同。局域网端点离线时无法
 * 真连，本组用**本地 mock 端点回放各协议的真实响应形态**，驱动 ArkWork
 * 的真实 adapter（OpenAIAdapter / AnthropicAdapter）全链路归一化，钉住：
 *  - 思考字段三种形态：reasoning_content（DeepSeek 系）/ reasoning
 *    （Ollama ≥0.9 OpenAI 兼容、OpenRouter）/ `<think>` 内嵌（llama.cpp、
 *    旧版 Ollama）—— 少认任何一种，思考就被静默丢弃；
 *  - 空响应形态：`<think></think>` 空转对、空 content、流式无终止帧；
 *  - tool_calls：空 arguments、截断 JSON；
 *  - 思考参数注入差异：kind=openai（官方口径）不注入，kind=ollama /
 *    custom-openai（vLLM）注入 enable_thinking。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs protocol-shapes
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { OpenAIAdapter, pickReasoningField, thinkingExtrasFor } from '../openai.js'
import { AnthropicAdapter } from '../anthropic.js'
import { isIncompleteLlmResponse } from '../../agent/llm-call.js'

/* ---------------- mock 端点基建 ---------------- */

interface MockCtx {
  url: string
  close: () => Promise<void>
  bodies: unknown[] // 捕获到的请求体（供注入差异断言）
}

async function startMock(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
): Promise<MockCtx> {
  const bodies: unknown[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown = undefined
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
      } catch {
        body = undefined
      }
      bodies.push(body)
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    bodies,
  }
}

/** SSE 流式响应端点：chunks 逐条下发，最后补 [DONE]（speakFinish 为 false 时不发终止帧） */
function sseHandler(chunks: Array<Record<string, unknown>>, speakFinish = true) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
    if (speakFinish) res.write('data: [DONE]\n\n')
    res.end()
  }
}

function jsonHandler(payload: unknown) {
  return (_req: IncomingMessage, res: ServerResponse, _body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
}

function openaiAdapterOf(url: string, provider: 'openai' | 'ollama' | 'custom-openai' = 'openai'): OpenAIAdapter {
  return new OpenAIAdapter({ apiKey: 'test', defaultModel: 'test-model', baseURL: `${url}/v1`, provider })
}

const REQ = { system: 'sys', messages: [{ role: 'user' as const, content: '你好' }], maxTokens: 512 }

/* ============================================================
 * 1. 思考字段归一化（纯函数真值表）
 * ============================================================ */

test('TC-PS-001 pickReasoningField：三种生态字段 + 优先级 + 噪声免疫', () => {
  // DeepSeek 系
  assert.equal(pickReasoningField({ reasoning_content: '思考A' }), '思考A')
  // Ollama ≥0.9 / OpenRouter 系
  assert.equal(pickReasoningField({ reasoning: '思考B' }), '思考B')
  // 双字段并存 → reasoning_content 优先（生态更广）
  assert.equal(pickReasoningField({ reasoning_content: 'A', reasoning: 'B' }), 'A')
  // 空串不算「有思考」→ 落到下一个字段
  assert.equal(pickReasoningField({ reasoning_content: '', reasoning: 'B' }), 'B')
  // 噪声免疫
  assert.equal(pickReasoningField({}), undefined)
  assert.equal(pickReasoningField({ reasoning_content: 42 }), undefined)
  assert.equal(pickReasoningField(null), undefined)
  assert.equal(pickReasoningField('str'), undefined)
})

test('TC-PS-002 thinkingExtrasFor：kind=openai 不注入（官方 400 风险），ollama/custom-openai 注入', () => {
  // 用户实测场景：同一台 Ollama，kind 在 ollama ↔ openai 之间切换
  assert.deepEqual(thinkingExtrasFor('openai'), {}, 'openai 官方口径对未知顶层参数 400，禁止注入')
  assert.deepEqual(thinkingExtrasFor(undefined), {})
  const forOllama = thinkingExtrasFor('ollama')
  assert.equal(forOllama['enable_thinking'], true)
  assert.deepEqual(forOllama['chat_template_kwargs'], { enable_thinking: true })
  assert.equal(thinkingExtrasFor('custom-openai')['enable_thinking'], true, 'vLLM 走 chat_template_kwargs 注入')
})

/* ============================================================
 * 2. 非流式：各协议真实响应形态 → adapter 全链路归一化
 * ============================================================ */

test('TC-PS-003 空响应形态（qwen3.5 空转对 `<think></think>`）→ 判定为不完整回合', async () => {
  // 空转任务 T-20260918-316o0p 实测形态：completion 仅 1~2 token，content 只有一对空 think 标签
  const mock = await startMock(
    jsonHandler({
      choices: [{ message: { content: '<think>\n\n</think>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4090, completion_tokens: 2 },
    }),
  )
  try {
    const resp = await openaiAdapterOf(mock.url, 'ollama').complete(REQ)
    assert.equal(resp.content, '')
    assert.equal(resp.finishReason, 'stop')
    assert.equal(resp.action, null)
    assert.equal(isIncompleteLlmResponse(resp), true, '空 think 对必须被判为不完整 —— 引擎据此补试，不烧迭代')
  } finally {
    await mock.close()
  }
})

test('TC-PS-004 Ollama ≥0.9 OpenAI 兼容：思考在 `reasoning` 字段（此前被静默丢弃）', async () => {
  const mock = await startMock(
    jsonHandler({
      choices: [{ message: { content: '你好，我是 ArkWork。', reasoning: '用户在打招呼，直接回应' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  )
  try {
    const resp = await openaiAdapterOf(mock.url, 'ollama').complete(REQ)
    assert.equal(resp.content, '你好，我是 ArkWork。')
    assert.equal(resp.reasoningContent, '用户在打招呼，直接回应', 'reasoning 字段必须被识别并保留（回传/落 L1 raw 依赖它）')
    assert.equal(isIncompleteLlmResponse(resp), false)
  } finally {
    await mock.close()
  }
})

test('TC-PS-005 DeepSeek 系：`reasoning_content` 字段（既有行为回归）', async () => {
  const mock = await startMock(
    jsonHandler({
      choices: [{ message: { content: '答案', reasoning_content: '思考过程' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  )
  try {
    const resp = await openaiAdapterOf(mock.url).complete(REQ)
    assert.equal(resp.content, '答案')
    assert.equal(resp.reasoningContent, '思考过程')
  } finally {
    await mock.close()
  }
})

test('TC-PS-006 `<think>` 内嵌思考分流（llama.cpp / 旧版 Ollama，W1 回归）', async () => {
  const mock = await startMock(
    jsonHandler({
      choices: [{ message: { content: '<think>先分析工作区</think>你好！有什么可以帮你？' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    }),
  )
  try {
    const resp = await openaiAdapterOf(mock.url, 'ollama').complete(REQ)
    assert.equal(resp.content, '你好！有什么可以帮你？', '思考必须从正文剥离，不能混进对话流')
    assert.equal(resp.reasoningContent, '先分析工作区')
  } finally {
    await mock.close()
  }
})

test('TC-PS-007 tool_calls：空 arguments → {}；截断 JSON → _raw 降级；finish=tool_calls', async () => {
  const mock = await startMock(
    jsonHandler({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'file-reader', arguments: '' } },
              { id: 'call_2', type: 'function', function: { name: 'shell', arguments: '{"command":"ls' /* 被截断 */ } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }),
  )
  try {
    const resp = await openaiAdapterOf(mock.url).complete(REQ)
    assert.equal(resp.finishReason, 'tool_calls')
    assert.equal(resp.actions?.length, 2)
    assert.deepEqual(resp.actions?.[0]?.args, {}, '空 arguments 必须归一为空对象（Ollama 实测形态）')
    assert.deepEqual(resp.actions?.[1]?.args, { _raw: '{"command":"ls' }, '非法 JSON 降级 _raw，不得让任务崩')
    assert.deepEqual(resp.toolCallIds, ['call_1', 'call_2'])
  } finally {
    await mock.close()
  }
})

test('TC-PS-008 思考参数注入随 provider 差异落到真实请求体（kind 切换的直接证据）', async () => {
  // kind=ollama → 注入 enable_thinking
  const mockOllama = await startMock(
    jsonHandler({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  )
  try {
    await openaiAdapterOf(mockOllama.url, 'ollama').complete(REQ)
    assert.equal((mockOllama.bodies[0] as Record<string, unknown>)['enable_thinking'], true, 'ollama kind 必须注入思考开关')
  } finally {
    await mockOllama.close()
  }
  // kind=openai → 不注入（官方端点对未知参数 400）
  const mockOpenai = await startMock(
    jsonHandler({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  )
  try {
    await openaiAdapterOf(mockOpenai.url, 'openai').complete(REQ)
    const body = mockOpenai.bodies[0] as Record<string, unknown>
    assert.equal('enable_thinking' in body, false, 'openai kind 禁止注入')
    assert.equal('chat_template_kwargs' in body, false)
  } finally {
    await mockOpenai.close()
  }
})

/* ============================================================
 * 3. 流式：增量聚合 + 终止帧语义
 * ============================================================ */

test('TC-PS-009 流式：`reasoning` 增量（Ollama/OpenRouter）与 `<think>` 混排都能归位', async () => {
  const mkChunk = (delta: Record<string, unknown>, finish?: string): Record<string, unknown> => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  })
  const mock = await startMock(
    sseHandler([
      mkChunk({ role: 'assistant' }),
      mkChunk({ reasoning: '正在' }), // Ollama ≥0.9 增量形态
      mkChunk({ reasoning: '思考' }),
      mkChunk({ content: '<thi' }), // `<think>` 跨 delta 切分
      mkChunk({ content: 'nk>标签内思考</think>' }),
      mkChunk({ content: '正文回复' }),
      mkChunk({}, 'stop'),
    ]),
  )
  try {
    const seen: string[] = []
    const resp = await openaiAdapterOf(mock.url, 'ollama').completeStream(REQ, {
      onText: () => {},
      onReasoning: (d) => seen.push(d),
    })
    assert.equal(resp.content, '正文回复', '正文必须剥离 think 后聚合')
    assert.equal(resp.reasoningContent, '正在思考标签内思考', '`reasoning` 增量与 think 内嵌思考并入同一思考通道')
    assert.ok(seen.join('').includes('正在'), 'onReasoning 必须收到增量')
    assert.equal(resp.finishReason, 'stop')
  } finally {
    await mock.close()
  }
})

test('TC-PS-010 流式无终止帧 → interrupted（D35 回归：不许伪装成正常说完）', async () => {
  const mkChunk = (delta: Record<string, unknown>): Record<string, unknown> => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta }],
  })
  const mock = await startMock(sseHandler([mkChunk({ content: '半截' })], false))
  try {
    const resp = await openaiAdapterOf(mock.url).completeStream(REQ, { onText: () => {} })
    assert.equal(resp.finishReason, 'interrupted', '缺终止帧必须如实上报，引擎据此重试/失败收尾')
    assert.equal(isIncompleteLlmResponse(resp), false, '有正文时不算空回合（半截内容仍应交由上层裁决）')
  } finally {
    await mock.close()
  }
})

/* ============================================================
 * 4. Anthropic 协议（对照面）：空 content / tool_use / stop_reason 映射
 * ============================================================ */

test('TC-PS-011 Anthropic：空 content blocks → 不完整形态；tool_use → actions；stop_reason 映射', async () => {
  // 空回合形态（对照 OpenAI 系空响应）：content 数组为空、end_turn
  const emptyMock = await startMock(
    jsonHandler({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 0 } }),
  )
  try {
    const adapter = new AnthropicAdapter({ apiKey: 'test', defaultModel: 'claude-test', baseURL: emptyMock.url })
    const resp = await adapter.complete(REQ)
    assert.equal(resp.content, '')
    assert.equal(resp.finishReason, 'stop')
    assert.equal(isIncompleteLlmResponse(resp), true, '空 content 回合同样进入引擎补试防御（协议无关）')
  } finally {
    await emptyMock.close()
  }
  // tool_use + max_tokens 映射
  const toolMock = await startMock(
    jsonHandler({
      content: [
        { type: 'text', text: '先读文件' },
        { type: 'tool_use', id: 'toolu_1', name: 'file-reader', input: { path: '.' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  )
  try {
    const adapter = new AnthropicAdapter({ apiKey: 'test', defaultModel: 'claude-test', baseURL: toolMock.url })
    const resp = await adapter.complete(REQ)
    assert.equal(resp.finishReason, 'tool_calls')
    assert.equal(resp.actions?.[0]?.tool, 'file-reader')
    assert.deepEqual(resp.actions?.[0]?.args, { path: '.' })
  } finally {
    await toolMock.close()
  }
})
