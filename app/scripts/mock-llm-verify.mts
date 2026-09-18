/* ============================================================
 * ArkWork — 模拟大模型验证（v0.34.1）
 *
 * **为什么需要这个文件**：生产环境里没有高性能大模型（deepseek / GPT 级），
 * 也没有稳定的局域网 Ollama。但「模型能力差异导致的引擎行为差异」必须用
 * **真实引擎 + 真实协议**验证 —— 用 mock adapter 绕过协议层，等于没验证。
 *
 * 因此本脚本起一个 **OpenAI 兼容 HTTP 服务**（含 SSE 流式），用三种「人格」
 * 模拟三类真实模型，再驱动**真实 runReActLoop** 跑任务：
 *
 *   · mock-strong    高性能模型（deepseek 级）：reasoning + content + 工具调用 + 收口
 *   · mock-explorer  中量模型（qwen3.5:9b 实测形态）：探索期**叙述只走 reasoning
 *                    通道**、content 恒空、每轮读不同文件 → 不得被零产出守卫误杀
 *   · mock-empty     小模型（qwen3.5:0.8b 实测形态）：全空响应 → 必须在 6 轮后暂停
 *
 * 用法（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     scripts/mock-llm-verify.mts [--only=S1,S2,S3,S4]
 *
 * 退出码：0 = 全部通过；1 = 有未通过项。
 * ============================================================ */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = 8791
const WS = join(tmpdir(), 'arkwork-mock-llm')
const argv = process.argv.slice(2)
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? ['S1', 'S2', 'S3', 'S4']

/* ============================================================
 * 1. 模拟服务端（OpenAI 兼容 + SSE 流式）
 * ============================================================ */

interface ChatMessage {
  role: string
  content?: string | null
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
  tool_call_id?: string
  reasoning_content?: string
}

interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>
  stream?: boolean
}

/** 统计「已经跑了几轮」（每个 assistant 带 tool_calls = 一轮） */
function roundsSoFar(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length
}

/** 从可用工具里按关键字挑一个名字（不硬编码 —— 工具集换版本也不失效） */
function pickTool(req: ChatRequest, keywords: string[]): string | null {
  const names = (req.tools ?? []).map((t) => t.function?.name).filter((n): n is string => !!n)
  for (const kw of keywords) {
    const hit = names.find((n) => n.toLowerCase().includes(kw))
    if (hit) return hit
  }
  return null
}

interface MockReply {
  reasoning?: string
  content?: string
  /** 要调用的工具：[工具名, 参数对象] */
  calls?: Array<[string, Record<string, unknown>]>
  finish: 'tool_calls' | 'stop'
}

/**
 * 三种人格的「剧本」。
 * round 从 0 开始；返回 null 表示不干预（不会发生，保留扩展点）。
 */
/** 各人格的「计划」产出（计划生成请求 = 无 tools 的旁路调用） */
const PLAN_OF: Record<string, string[]> = {
  'mock-strong': ['读取工作区目录结构', '检索关键入口文件', '产出分析报告 report.md'],
  // 探索型：只读探索即任务本体 → 显式输出空计划（不编造步骤，符合 PLAN_SYSTEM_PROMPT 的对话级约定）
  'mock-explorer': ['探索工作区结构并汇总结论'],
  'mock-empty': ['读取工作区目录结构'],
  'mock-long': ['收集需求并确认边界', '输出设计方案', '按方案实现', '验证并收口'],
}

function scriptFor(model: string, req: ChatRequest): MockReply {
  // 旁路调用识别：**不带 tools** 的是计划生成 / 标题生成，不是 ReAct 回合。
  // 若把它们当成第 0 轮 ReAct 处理，mock 会返回工具调用 → 计划解析失败 → 清单退化为
  // 单条兜底项，后续「子任务树」断言全部失真（本脚本早期版本正是踩了这个坑）。
  const sysText = typeof req.messages.find((m) => m.role === 'system')?.content === 'string'
    ? (req.messages.find((m) => m.role === 'system')!.content as string)
    : ''
  if (!req.tools || req.tools.length === 0) {
    if (/任务命名助手/.test(sysText)) return { content: '工作区分析验证', finish: 'stop' }
    return { content: JSON.stringify(PLAN_OF[model] ?? []), finish: 'stop' }
  }

  const round = roundsSoFar(req.messages)
  const readTool = pickTool(req, ['file-reader'])
  const globTool = pickTool(req, ['glob-search'])
  const writeTool = pickTool(req, ['file-writer'])
  const todoTool = pickTool(req, ['todo-update'])
  /** 第 n 项标为 status（todo_update 的真实入参形态：item_index + status + comment） */
  const todo = (i: number, status: string, comment: string): Array<[string, Record<string, unknown>]> =>
    todoTool ? [[todoTool, { item_index: i, status, comment }]] : []

  /* ---------- 高性能模型：规范 ReAct，叙述在 content，探索→产出→收口 ---------- */
  if (model.startsWith('mock-strong')) {
    if (round === 0) {
      return {
        reasoning: '先看清工作区结构，再决定读哪些文件。',
        content: '我先看一眼工作区结构。',
        calls: readTool ? [[readTool, { path: '.' }]] : [],
        finish: 'stop',
      }
    }
    if (round === 1) {
      return {
        reasoning: '已看到目录，接下来定位入口文件。',
        content: '目录已列出，现在读入口文件。',
        calls: globTool ? [[globTool, { pattern: '**/*.md' }]] : [],
        finish: 'stop',
      }
    }
    if (round === 2) {
      return {
        reasoning: '信息够了，把结论写进报告文件。',
        content: '信息已足够，开始产出报告。',
        calls: writeTool
          ? [[writeTool, { path: 'report.md', content: '# 工作区分析报告\n\n结论：结构清晰。\n' }]]
          : [],
        finish: 'stop',
      }
    }
    // 收口：逐项标 done（真实高性能模型的行为：先勾清单，再给最终答复）
    if (round === 3 || round === 4 || round === 5) {
      const i = round - 3
      return {
        reasoning: `第 ${i + 1} 项已完成，更新清单。`,
        content: `清单第 ${i + 1} 项完成。`,
        calls: todo(i, 'done', `第 ${i + 1} 项已完成并验证`),
        finish: 'stop',
      }
    }
    return {
      reasoning: '三项清单已全部完成，可以交付。',
      content: '分析报告已生成，任务完成。',
      calls: [],
      finish: 'stop',
    }
  }

  /* ---------- 中量模型：探索期叙述**只在 reasoning**、content 恒空（9b 实测形态） ---------- */
  if (model.startsWith('mock-explorer')) {
    // 连续 9 轮只读探索（> 6 轮阈值）—— 修复前会在第 6 轮被误杀
    if (round < 9) {
      const targets = ['.', 'docs', 'app', 'app/src', 'app/src/main', 'app/src/renderer', 'README.md', 'package.json', '.arkwork']
      const path = targets[round % targets.length]!
      return {
        // 每轮 reasoning 都不同（有信息增益）—— 这正是「不是空转」的证据
        reasoning: `第 ${round + 1} 轮探索：我还没看 ${path}，需要读它来补全对工作区的理解。`,
        content: '',
        calls: readTool ? [[readTool, { path }]] : [],
        finish: 'stop',
      }
    }
    // 探索 9 轮后收口：勾掉清单 → 下一轮最终答复即 done
    if (round === 9) {
      return {
        reasoning: '九轮探索已经覆盖主要目录，清单可以收口了。',
        content: '',
        calls: todo(0, 'done', '已探索主要目录与文件，结论已就绪'),
        finish: 'stop',
      }
    }
    return {
      reasoning: '探索结论已就绪，交付。',
      content: '已探索工作区主要目录与文件，结构如下：README.md / package.json / docs / app。',
      calls: [],
      finish: 'stop',
    }
  }

  /* ---------- 小模型：全空响应（0.8b 实测形态） ---------- */
  if (model.startsWith('mock-empty')) {
    return { content: '', finish: 'stop' }
  }

  /* ---------- 长任务模型：多子任务推进 + 中途修正（S4 用） ---------- */
  if (model.startsWith('mock-long')) {
    if (round === 0) {
      return {
        reasoning: '需求边界已清楚，第 1 项可以收口。',
        content: 'T-01 收集需求完成。',
        calls: todo(0, 'done', '需求已收集并确认边界'),
        finish: 'stop',
      }
    }
    if (round === 1) {
      return {
        reasoning: '方案已定稿，第 2 项收口。',
        content: 'T-02 设计方案完成。',
        calls: todo(1, 'done', '方案已定稿'),
        finish: 'stop',
      }
    }
    if (round === 2) {
      // 中途修正：实现一半发现方案要改 → 把「设计方案」从 done 拉回 running
      // （真实长任务的典型形态：清单不是单向推进，允许回退修正）
      return {
        reasoning: '实现过程中发现方案第 3 节需要调整，先把设计项拉回进行中。',
        content: '发现方案需要修正，回退 T-02。',
        calls: todo(1, 'running', '实现中发现方案需调整，回退修正'),
        finish: 'stop',
      }
    }
    if (round === 3) {
      return {
        reasoning: '方案修正完成，重新收口设计项。',
        content: 'T-02 修正完成。',
        calls: todo(1, 'done', '方案已修正并复核'),
        finish: 'stop',
      }
    }
    if (round === 4) {
      return {
        reasoning: '实现完成，第 3 项收口。',
        content: 'T-03 实现完成。',
        calls: todo(2, 'done', '按修正后方案实现完成'),
        finish: 'stop',
      }
    }
    if (round === 5) {
      return {
        reasoning: '验证通过，最后一项收口。',
        content: 'T-04 验证完成。',
        calls: todo(3, 'done', '验证通过'),
        finish: 'stop',
      }
    }
    return {
      reasoning: '四个子任务全部完成，可以交付。',
      content: '全部子任务完成，任务交付。',
      calls: [],
      finish: 'stop',
    }
  }

  return { content: '未识别的模型人格', finish: 'stop' }
}

function buildChunks(model: string, reply: MockReply, round: number): Array<Record<string, unknown>> {
  const id = `chatcmpl-${Date.now()}-${round}`
  const out: Array<Record<string, unknown>> = []
  const mk = (delta: Record<string, unknown>, finish: string | null): Record<string, unknown> => ({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  if (reply.reasoning) out.push(mk({ role: 'assistant', reasoning_content: reply.reasoning }, null))
  if (reply.content) out.push(mk({ role: 'assistant', content: reply.content }, null))
  ;(reply.calls ?? []).forEach(([name, args], i) => {
    out.push(
      mk(
        {
          tool_calls: [
            { index: i, id: `call_${round}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        null,
      ),
    )
  })
  // 结束块（usage 在单独一块里给，模拟 stream_options.include_usage）
  out.push(mk({}, reply.calls && reply.calls.length > 0 ? 'tool_calls' : reply.finish))
  out.push({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
  })
  return out
}

function buildNonStreamBody(model: string, reply: MockReply, round: number): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: reply.content ?? '' }
  if (reply.reasoning) message.reasoning_content = reply.reasoning
  const calls = reply.calls ?? []
  if (calls.length > 0) {
    message.tool_calls = calls.map(([name, args], i) => ({
      id: `call_${round}_${i}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }))
  }
  return {
    id: `chatcmpl-${Date.now()}-${round}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const url = req.url ?? ''
    if (!url.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    let body: ChatRequest
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as ChatRequest
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad json' } }))
      return
    }
    const model = body.model ?? 'mock-strong'
    const reply = scriptFor(model, body)
    const round = roundsSoFar(body.messages)
    if (process.env.MOCK_DEBUG) {
      const toolNames = (body.tools ?? []).map((t) => t.function?.name).join(',')
      console.log(
        `   [mock] ${model} round=${round} stream=${!!body.stream} tools=${toolNames.slice(0, 120)} ` +
          `→ calls=${(reply.calls ?? []).map(([n]) => n).join(',') || '（无）'} content=${JSON.stringify(reply.content ?? '').slice(0, 30)}`,
      )
    }

    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const c of buildChunks(model, reply, round)) {
        res.write(`data: ${JSON.stringify(c)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(buildNonStreamBody(model, reply, round)))
  })
})

/* ============================================================
 * 2. 驱动真实引擎
 * ============================================================ */

const okMark = (m: string) => console.log(`  ✅ ${m}`)
const badMark = (m: string) => console.log(`  ❌ ${m}`)
const info = (m: string) => console.log(`     ${m}`)
const results: Array<{ name: string; pass: boolean }> = []
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass })
  pass ? okMark(name + (detail ? ` —— ${detail}` : '')) : badMark(name + (detail ? ` —— ${detail}` : ''))
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
  console.log('════════════════════════════════════════════════════════')
  console.log(' ArkWork v0.34.1 — 模拟大模型验证（真实引擎 + 真实协议）')
  console.log('════════════════════════════════════════════════════════')
  console.log(`  模拟端点: http://127.0.0.1:${PORT}/v1 ｜ 工作区: ${WS}`)
  console.log('')

  await rm(WS, { recursive: true, force: true })
  await mkdir(join(WS, 'docs'), { recursive: true })
  await mkdir(join(WS, 'app', 'src'), { recursive: true })
  await writeFile(join(WS, 'README.md'), '# Demo\n', 'utf-8')
  await writeFile(join(WS, 'package.json'), '{"name":"demo"}\n', 'utf-8')
  await writeFile(join(WS, 'docs', 'a.md'), '# A\n', 'utf-8')

  const { setWorkspaceDir, getArkworkDir } = await import('../src/main/store/db.js')
  setWorkspaceDir(WS)
  const arkworkDir = getArkworkDir()
  await mkdir(arkworkDir, { recursive: true })
  const base = `http://127.0.0.1:${PORT}/v1`
  await writeFile(
    join(arkworkDir, 'models.json'),
    JSON.stringify(
      [
        { id: 'mock-strong', name: 'mock-strong', kind: 'openai', baseURL: base, apiKey: 'x', contextWindow: 128000, enabled: true },
        { id: 'mock-explorer', name: 'mock-explorer', kind: 'openai', baseURL: base, apiKey: 'x', contextWindow: 128000, enabled: true },
        { id: 'mock-empty', name: 'mock-empty', kind: 'openai', baseURL: base, apiKey: 'x', contextWindow: 32000, enabled: true },
        { id: 'mock-long', name: 'mock-long', kind: 'openai', baseURL: base, apiKey: 'x', contextWindow: 128000, enabled: true },
      ],
      null,
      2,
    ),
    'utf-8',
  )

  const { resetTaskCollection, createTask, getTask } = await import('../src/main/store/tasks.js')
  const { getAgent } = await import('../src/main/store/agents.js')
  const { getModel } = await import('../src/main/llm/registry.js')
  const { runReActLoop } = await import('../src/main/agent/engine/index.js')
  const { loadGraph } = await import('../src/main/agent/graph/index.js')
  const { projectConversation } = await import('../src/renderer/flow/project.js')
  const { deriveConversation } = await import('../src/renderer/store/derive-conversation.js')

  /**
   * 取图：loadGraph 的入参是 **graphId**，不是 taskId（传错会静默返回 null，
   * 于是所有图断言都「通过」在一个空值上 —— 这是本脚本早期版本的坑）。
   */
  async function graphOf(taskLike: unknown): Promise<{ status?: string } | null> {
    const gid = (taskLike as { graphId?: string } | undefined)?.graphId
    if (!gid) return null
    return (await loadGraph(gid)) as { status?: string } | null
  }

  resetTaskCollection()

  /** 从落盘的 steps.jsonl 读真实步骤（不手工拼 items —— 脚本铁律） */
  async function readSteps(taskId: string): Promise<Array<Record<string, unknown>>> {
    const p = join(WS, '.arkwork', 'memory', taskId, 'steps.jsonl')
    if (!existsSync(p)) return []
    const raw = await readFile(p, 'utf8')
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return {}
        }
      })
  }

  async function runTask(modelId: string, prompt: string, guardMs = 120_000) {
    const model = await getModel(modelId)
    if (!model) throw new Error(`模型未注册：${modelId}`)
    const created = await createTask({ title: `${modelId} 验证`, agentId: '@default', modelId, text: prompt })
    const taskId = (created as { id?: string })?.id ?? (created as unknown as string)
    const fresh = await getTask(taskId as string)
    const agent = await getAgent((fresh as { agentId: string })!.agentId)
    const controller = new AbortController()
    const guard = setTimeout(() => controller.abort(), guardMs)
    let loopErr: Error | null = null
    try {
      await runReActLoop({
        task: fresh!,
        agent: agent!,
        modelId,
        signal: controller.signal,
      })
    } catch (err) {
      loopErr = err as Error
    } finally {
      clearTimeout(guard)
    }
    const final = await getTask(taskId as string)
    const rtSteps = await readSteps(taskId as string)
    // 诊断：把「为什么会暂停」如实打出来（判定口径必须基于真值，不是猜）
    const f = final as Record<string, unknown> | undefined
    info(
      `诊断 status=${f?.status} ｜ steps=${rtSteps.length} ｜ graphId=${String(f?.graphId ?? '（无）')} ｜ ` +
        `plan=${((f?.planItems as Array<{ status: string }>) ?? []).map((p) => p.status).join(',') || '（无）'} ｜ ` +
        `pausedReason=${String(f?.pausedReason ?? '（无）').slice(0, 60)} ｜ ` +
        `error=${String(f?.errorMessage ?? '（无）').slice(0, 80)}`,
    )
    const ask = f?.pendingAskUser as { question?: string } | undefined
    if (ask?.question) info(`诊断 ask_user: ${ask.question.slice(0, 80)}`)
    return { taskId: taskId as string, task: final, loopErr, steps: rtSteps }
  }

  /* ---------------- S1：高性能模型完整跑通 ---------------- */
  if (ONLY.includes('S1')) {
    console.log('── S1 高性能模型（mock-strong）：完整 ReAct + 收口 ──')
    const { task, loopErr, steps } = await runTask('mock-strong', '帮我分析一下整个工作区并产出报告')
    check('S1-1 循环无异常退出', loopErr === null, loopErr?.message ?? '')
    check('S1-2 任务终态为 done', task?.status === 'done', `实际 ${task?.status}`)
    const graph = await graphOf(task)
    if (!graph) {
      info('本任务无图（tier 0/1 轻量模式）→ 跳过图封口断言，改由清单收口把守')
    } else {
      check('S1-3 图已封口为 completed', graph.status === 'completed', `实际 ${graph.status}`)
    }
    const items = (task as { planItems?: Array<{ status: string }> })?.planItems ?? []
    const unsettled = items.filter((i) => i.status === 'running' || i.status === 'pending').length
    check('S1-4 清单无未收口项', unsettled === 0, `未收口 ${unsettled} 项`)
    // 投影断言必须复用生产链路（脚本铁律：手工拼 items 会误报缺陷）
    const { listL1 } = await import('../src/main/memory/l1-working.js')
    const memory = await listL1(task!.id)
    const derived = deriveConversation(task as never, steps as never, memory as never)
    const projected = projectConversation({
      taskId: task!.id,
      items: derived,
      steps: steps as never,
      events: [],
      streamBuffers: {},
      planItems: items as never,
      viewMode: 'standard',
      showThinking: true,
      ui: { viewMode: 'standard', showThinking: true, blockUiState: {}, turnUiState: {}, scrollAnchorByTask: {} },
      now: Date.now(),
    } as never)
    check('S1-5 投影层产出非空对话（走渲染层同一链路）', (projected as unknown[]).length > 0, `${(projected as unknown[]).length} 组 / derive ${derived.length} item`)
    check('S1-6 产物文件已真实落盘', existsSync(join(WS, 'report.md')), 'report.md')
  }

  /* ---------------- S2：中量模型探索不得被误杀（D52 修复验证） ---------------- */
  if (ONLY.includes('S2')) {
    console.log('── S2 中量模型（mock-explorer，叙述只走 reasoning）：不得被零产出守卫误杀 ──')
    const { task, loopErr, steps } = await runTask('mock-explorer', '帮我分析一下整个工作区')
    check('S2-1 循环无异常退出', loopErr === null, loopErr?.message ?? '')
    // 证据强度：不只断言「没被暂停」，还要断言「探索确实跑满了 9 轮」——
    // 否则「第 1 轮就意外结束」也会让 S2-2 通过，等于把关键结论测成空气。
    const actRounds = steps.filter((s) => s.type === 'act').length
    check('S2-1b 探索确实跑满 9 轮（守卫放行，不是提前收场）', actRounds >= 9, `act 轮数 ${actRounds}`)
    check(
      'S2-2 ★ 探索 9 轮后**未被**误暂停（守卫把 reasoning 翻新算作产出）',
      task?.status !== 'paused',
      `实际 ${task?.status}`,
    )
    check('S2-3 任务正常走到 done', task?.status === 'done', `实际 ${task?.status}`)
    const reason = (task as { pausedReason?: string })?.pausedReason ?? ''
    check('S2-4 暂停原因里不出现「零产出」字样', !/零产出|stalled/i.test(reason), reason || '（无）')
  }

  /* ---------------- S3：小模型空转必须被拦（守卫没有放水） ---------------- */
  if (ONLY.includes('S3')) {
    console.log('── S3 小模型（mock-empty，全空响应）：必须在阈值后优雅暂停 ──')
    const { task } = await runTask('mock-empty', '看一下这个工作区')
    check('S3-1 ★ 空转被暂停（守卫仍生效）', task?.status === 'paused', `实际 ${task?.status}`)
    const ask = (task as { pendingAskUser?: { question?: string } })?.pendingAskUser
    check('S3-2 暂停伴随 ask_user（不静默停）', !!ask?.question, ask?.question ?? '（无）')
    const graph = await graphOf(task)
    if (!graph) {
      info('本任务无图（tier 0/1 轻量模式）→ 跳过图断言')
    } else {
      check(
        'S3-3 暂停不封图（可恢复）',
        graph.status !== 'completed',
        `实际 ${graph.status}`,
      )
    }
  }

  /* ---------------- S4：长任务 / 子任务树 ---------------- */
  if (ONLY.includes('S4')) {
    console.log('── S4 长任务（mock-long）：子任务树推进与收口 ──')
    const { task, loopErr } = await runTask('mock-long', '按步骤完成这个多阶段任务')
    check('S4-1 循环无异常退出', loopErr === null, loopErr?.message ?? '')
    check('S4-2 任务终态为 done', task?.status === 'done', `实际 ${task?.status}`)
    const items = (task as { planItems?: Array<{ title: string; status: string }> })?.planItems ?? []
    check('S4-3 清单至少 4 个子任务', items.length >= 4, `实际 ${items.length} 项`)
    const doneCount = items.filter((i) => i.status === 'done').length
    check('S4-4 子任务全部收口为 done', doneCount === items.length && items.length > 0, `${doneCount}/${items.length}`)
    const unsettled = items.filter((i) => i.status === 'running' || i.status === 'pending').length
    check('S4-5 无残留未收口项', unsettled === 0, `未收口 ${unsettled}`)
    const graph = await graphOf(task)
    if (!graph) {
      info('本任务无图（tier 0/1 轻量模式）→ 跳过图封口断言')
    } else {
      check('S4-6 图封口 completed', graph.status === 'completed', `实际 ${graph.status}`)
    }
  }

  server.close()
  const failed = results.filter((r) => !r.pass)
  console.log('')
  console.log(`  合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  for (const f of failed) console.log(`  ✗ ${f.name}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验证脚本异常：', err)
  server.close()
  process.exit(1)
})
