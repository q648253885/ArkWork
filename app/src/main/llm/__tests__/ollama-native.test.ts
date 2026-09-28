/* ============================================================
 * ArkWork — Ollama 原生 /api/chat 通道（v0.38.1 · D167 · TC-ON-001..007）
 *
 * 背景（S1 实测暴露）：D161 的三条思考关闭通道（/no_think、enable_thinking、
 * chat_template_kwargs）对 ollama 0.34.2 的 /v1 端点全部无效（curl 直测：
 * 思考 58–125s/轮，ReAct 首调 120s 超时连锁）。唯一有效通道是原生
 * `/api/chat` + `think: false`（同问题 9 eval tokens / 0.5s 生成）。
 *
 * 本组用本地 mock 端点回放 ollama 原生协议形态，钉住：
 *  - 路由真值表：仅「显式关思考 + ollama 形态端点」走原生（/v1 行为不动）；
 *  - 请求体：think:false 必达；被证伪参数不得注入；/no_think 不再追加；
 *  - 协议差异：tool_calls.arguments 对象形态、thinking 字段、NDJSON 流、
 *    prompt_eval_count/eval_count、done_reason；
 *  - 终帧语义：无 done:true 终帧 → interrupted（D35 语义在原生通道同样生效）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs ollama-native
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { OpenAIAdapter, useOllamaNativeChannel } from '../openai.js'

/* ---------------- mock 端点基建（同 protocol-shapes 形态） ---------------- */

interface MockCtx {
  url: string
  close: () => Promise<void>
  bodies: unknown[]
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

/** 只响应 /api/chat：走错通道（/v1 SDK 路径）即刻 404 暴露 */
function chatOnly(handler: (body: unknown, req: IncomingMessage, res: ServerResponse) => void) {
  return (req: IncomingMessage, res: ServerResponse, body: unknown) => {
    if (!req.url || !req.url.endsWith('/api/chat')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `D167: expected native /api/chat, got ${req.url}` }))
      return
    }
    handler(body, req, res)
  }
}

function ollamaAdapterOf(url: string): OpenAIAdapter {
  return new OpenAIAdapter({
    apiKey: 'ollama',
    defaultModel: 'qwen3.5:0.8b',
    baseURL: `${url}/v1`,
    provider: 'ollama',
    think: false,
  })
}

/* ============================================================
 * 1. 路由真值表
 * ============================================================ */

test('TC-ON-001 useOllamaNativeChannel：ollama 形态端点**默认**走原生（显式要思考才不走）', () => {
  assert.equal(useOllamaNativeChannel('ollama', 'http://127.0.0.1:11434/v1', false), true)
  // 真实配置：ollama 常被登记成 kind='openai'，仅 baseURL 暴露 11434
  assert.equal(useOllamaNativeChannel('openai', 'http://192.168.1.5:11434/v1', false), true)
  // -------------------------------------------------------------------------
  // v0.40.0（D199）**反转**：未配置思考 → **走**原生。
  //
  // 原断言是 `undefined → false`（要求「必须显式 think===false」）。实测
  // （evidence/04 §3.2）：25 工具 + 长 system（in≈3965）下 `/v1` 返回
  // `tc=0 / content=0ch / reasoning=217ch / out=131`（精确复现实机空响应），
  // 而同等规模的原生 `/api/chat`+`think:false` 三次全部正常返回 tool_calls。
  // `think` 在配置里缺省是常态 → **默认路径恰好就是会空的那个路径**。
  // -------------------------------------------------------------------------
  assert.equal(useOllamaNativeChannel('ollama', 'http://127.0.0.1:11434/v1', undefined), true)
  // 显式**要**思考 → 尊重用户配置，不走原生（原生通道会强制 think:false）
  assert.equal(useOllamaNativeChannel('ollama', 'http://127.0.0.1:11434/v1', true), false)
  // 非 ollama 端点（vLLM custom-openai / 官方 openai）不走原生
  assert.equal(useOllamaNativeChannel('custom-openai', 'http://10.0.0.2:8000/v1', false), false)
  assert.equal(useOllamaNativeChannel('openai', 'https://api.openai.com/v1', false), false)
  // 无 baseURL 时按 provider 判定
  assert.equal(useOllamaNativeChannel('ollama', undefined, false), true)
  assert.equal(useOllamaNativeChannel(undefined, 'http://127.0.0.1:11434/v1', false), true)
})

/**
 * TC-OPS-016（v0.40.0 · D199）：Ollama 类端点**默认**走原生通道。
 *
 * 与 TC-ON-001 的差别：这里专门钉住「配置里 `think` 缺省」这个**真实默认**，
 * 因为 D199 的病灶正是「默认路径 = 会空的路径」（`/v1` 在 25 工具 + in≈3965
 * 下实测 `tc=0 / content=0ch`，见 `evidence/04` §3.2 用例 G）。
 */
test('TC-OPS-016 useOllamaNativeChannel：think 缺省也走原生（D199 核心变化）', () => {
  assert.equal(useOllamaNativeChannel('ollama', 'http://127.0.0.1:11434/v1', undefined), true)
  assert.equal(useOllamaNativeChannel('ollama', undefined, undefined), true)
  // 真实配置：局域网 Ollama 常被登记成 kind='openai'，只有 baseURL 暴露 11434
  assert.equal(useOllamaNativeChannel('openai', 'http://192.168.31.57:11434/v1', undefined), true)
  assert.equal(useOllamaNativeChannel('openai', 'http://192.168.31.57:11434/v1', false), true)
  // 显式**要**思考 → 尊重用户配置（原生通道会强制 think:false，与意图冲突）
  assert.equal(useOllamaNativeChannel('ollama', 'http://127.0.0.1:11434/v1', true), false)
})

/** TC-OPS-017（v0.40.0 · I-O6）：非 Ollama 端点恒 false —— 通道改动零影响面 */
test('TC-OPS-017 useOllamaNativeChannel：非 Ollama 端点恒 false（零影响）', () => {
  for (const base of [
    'https://api.openai.com/v1',
    'http://10.0.0.2:8000/v1',
    'https://my-proxy.example.com/v1',
    'https://open.bigmodel.cn/api/paas/v4',
  ]) {
    assert.equal(useOllamaNativeChannel('openai', base, undefined), false, `${base} 不该走原生`)
    assert.equal(useOllamaNativeChannel('openai', base, false), false)
    assert.equal(useOllamaNativeChannel('custom-openai', base, undefined), false)
  }
})

/* ============================================================
 * 2. 非流式：请求体形态 + 响应归一
 * ============================================================ */

test('TC-ON-002 原生非流式：think:false 落到请求体（被证伪参数零注入），thinking/用量/done_reason 归一', async () => {
  const mock = await startMock(
    chatOnly((body, _req, res) => {
      const b = body as Record<string, unknown>
      assert.equal(b['think'], false, 'D167 核心：think:false 必须出现在 /api/chat 请求体')
      assert.equal(b['stream'], false)
      assert.equal('enable_thinking' in b, false, '被证伪参数（/v1 无效）不得注入')
      assert.equal('chat_template_kwargs' in b, false)
      assert.equal('reasoning_effort' in b, false)
      const msgs = b['messages'] as Array<{ role: string; content: string }>
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      assert.equal(lastUser?.content.includes('/no_think'), false, '/no_think 已证伪，原生通道不得追加')
      const options = b['options'] as Record<string, unknown>
      assert.equal(options['temperature'], 0.3)
      assert.equal(options['num_predict'], 512, 'maxTokens → ollama 原生 num_predict')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'qwen3.5:0.8b',
          message: { role: 'assistant', content: '1+1=2', thinking: '用户问的是加法' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 33,
          eval_count: 9,
        }),
      )
    }),
  )
  try {
    const resp = await ollamaAdapterOf(mock.url).complete({
      system: 'sys',
      messages: [{ role: 'user', content: '1+1=?' }],
      temperature: 0.3,
      maxTokens: 512,
    })
    assert.equal(resp.content, '1+1=2')
    assert.equal(resp.reasoningContent, '用户问的是加法', 'ollama 原生 thinking 字段必须进思考通道')
    assert.equal(resp.tokensIn, 33, 'prompt_eval_count → tokensIn')
    assert.equal(resp.tokensOut, 9, 'eval_count → tokensOut')
    assert.equal(resp.finishReason, 'stop')
    assert.equal(resp.action, null)
  } finally {
    await mock.close()
  }
})

test('TC-ON-003 原生 tool_calls：arguments 对象形态 → ReAct 解析；finishReason=tool_calls；id 合成', async () => {
  const mock = await startMock(
    chatOnly((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'file-reader', arguments: { path: '.' } } },
              { function: { name: 'task_plan', arguments: { items: [{ text: 'x', status: 'todo' }] } } },
            ],
          },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 20,
        }),
      )
    }),
  )
  try {
    const resp = await ollamaAdapterOf(mock.url).complete({
      system: 'sys',
      messages: [{ role: 'user', content: '列清单' }],
      tools: [{ type: 'function', function: { name: 'file-reader', description: 'd', parameters: {} } }],
    })
    assert.equal(resp.finishReason, 'tool_calls', '有 tool_calls 必须映射为 tool_calls（对齐 /v1 语义）')
    assert.equal(resp.actions?.length, 2)
    assert.deepEqual(resp.actions?.[0]?.args, { path: '.' }, '对象形态 arguments 必须正确解析')
    assert.equal(resp.actions?.[1]?.tool, 'task_plan')
    for (const id of resp.toolCallIds ?? []) {
      assert.match(id, /^call_/, 'ollama 原生不带 id → 既有 normalize 单源合成')
    }
    assert.deepEqual(
      (mock.bodies[0] as Record<string, unknown>)['tools'],
      [{ type: 'function', function: { name: 'file-reader', description: 'd', parameters: {} } }],
      '工具定义与 OpenAI 形态同构（ollama 原生协议兼容）',
    )
  } finally {
    await mock.close()
  }
})

test('TC-ON-004 历史回传：assistant tool_calls 字符串参数 → 原生对象；tool 结果回传 role=tool', async () => {
  const mock = await startMock(
    chatOnly((body, _req, res) => {
      const msgs = (body as Record<string, unknown>)['messages'] as Array<Record<string, unknown>>
      res.writeHead(200, { 'content-type': 'application/json' })
      if (msgs.length < 4) {
        // 第一轮（system+user）：返回 tool_calls，供引擎按 toolCallId 回写结果
        res.end(
          JSON.stringify({
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file-reader', arguments: { path: '.' } } }] },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 1,
            eval_count: 1,
          }),
        )
        return
      }
      // 第二轮：校验历史回传形态
      const asst = msgs.find((m) => m['role'] === 'assistant') as
        | { tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }
        | undefined
      assert.deepEqual(asst?.tool_calls?.[0]?.function?.arguments, { path: '.' }, 'ollama 期待 arguments 对象（历史字符串须转换）')
      const tool = msgs.find((m) => m['role'] === 'tool')
      assert.equal(tool?.['content'], '<file>ok</file>', 'tool 结果必须回传')
      res.end(
        JSON.stringify({ message: { role: 'assistant', content: '读完' }, done: true, done_reason: 'stop', prompt_eval_count: 2, eval_count: 2 }),
      )
    }),
  )
  try {
    const adapter = ollamaAdapterOf(mock.url)
    // 第一轮：拿到 tool_calls
    const r1 = await adapter.complete({ system: 'sys', messages: [{ role: 'user', content: '读文件' }] })
    assert.equal(r1.actions?.[0]?.tool, 'file-reader')
    // 第二轮：按引擎既有流程回写 tool result
    await adapter.complete({
      system: 'sys',
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'assistant', content: '', toolCalls: [{ id: r1.toolCallId!, type: 'function', function: { name: 'file-reader', arguments: '{"path":"."}' } }] },
        { role: 'tool', content: '<file>ok</file>', toolCallId: r1.toolCallId },
      ],
    })
  } finally {
    await mock.close()
  }
})

/* ============================================================
 * 3. 流式：NDJSON 逐行解析 + 终帧语义
 * ============================================================ */

test('TC-ON-005 原生流式：NDJSON 逐行解析，content/thinking 增量回调 + 用量/终帧归一', async () => {
  const mock = await startMock(
    chatOnly((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      const lines = [
        { model: 'qwen3.5:0.8b', message: { role: 'assistant', content: '你' }, done: false },
        { model: 'qwen3.5:0.8b', message: { role: 'assistant', content: '好' }, done: false },
        { model: 'qwen3.5:0.8b', message: { role: 'assistant', content: '', thinking: '问候语' }, done: false },
        { model: 'qwen3.5:0.8b', message: { role: 'assistant', content: '！' }, done: false },
        { model: 'qwen3.5:0.8b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 4 },
      ]
      for (const l of lines) res.write(`${JSON.stringify(l)}\n`)
      res.end()
    }),
  )
  try {
    const texts: string[] = []
    const thinks: string[] = []
    const resp = await ollamaAdapterOf(mock.url).completeStream(
      { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
      { onText: (d) => texts.push(d), onReasoning: (d) => thinks.push(d) },
    )
    assert.equal(resp.content, '你好！')
    assert.equal(resp.reasoningContent, '问候语')
    assert.equal(resp.finishReason, 'stop')
    assert.equal(resp.tokensIn, 11)
    assert.equal(resp.tokensOut, 4)
    assert.equal(texts.join(''), '你好！', 'onText 必须收到逐行增量')
    assert.equal(thinks.join(''), '问候语', 'onReasoning 必须收到 thinking 增量')
  } finally {
    await mock.close()
  }
})

test('TC-ON-006 原生流式 tool_calls：整调到达（非 OpenAI 分片）→ 聚合解析 + finishReason=tool_calls', async () => {
  const mock = await startMock(
    chatOnly((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: false })}\n`)
      res.write(
        `${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'task_plan', arguments: { items: [{ text: '步1', status: 'todo' }] } } }] }, done: false })}\n`,
      )
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 8 })}\n`)
      res.end()
    }),
  )
  try {
    const resp = await ollamaAdapterOf(mock.url).completeStream(
      { system: 'sys', messages: [{ role: 'user', content: 'p' }] },
      { onText: () => {} },
    )
    assert.equal(resp.finishReason, 'tool_calls')
    assert.equal(resp.actions?.[0]?.tool, 'task_plan')
    assert.deepEqual(resp.actions?.[0]?.args, { items: [{ text: '步1', status: 'todo' }] })
  } finally {
    await mock.close()
  }
})

test('TC-ON-007 原生流式无终帧 → interrupted（D35 语义在原生通道同样生效）', async () => {
  const mock = await startMock(
    chatOnly((_body, _req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '半截' }, done: false })}\n`)
      res.end()
    }),
  )
  try {
    const resp = await ollamaAdapterOf(mock.url).completeStream(
      { system: 'sys', messages: [{ role: 'user', content: 'x' }] },
      { onText: () => {} },
    )
    assert.equal(resp.finishReason, 'interrupted', 'done:true 终帧缺失必须如实上报，不得伪装 stop')
  } finally {
    await mock.close()
  }
})
