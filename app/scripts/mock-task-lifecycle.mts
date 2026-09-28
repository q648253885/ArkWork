/* ============================================================
 * ArkWork — 任务生命周期端到端验证（v0.38.0）
 *
 * **为什么需要这个文件**：
 *   现场没有稳定的高性能大模型（局域网 9b 会把工具调用写成正文、本机 0.8b 只回空），
 *   但「任务处理 / 中断 / 续聊 / 补充」这四条主链路必须能被**反复回归**验证 ——
 *   靠现场蹲守真实模型，一次空转就是 8 分钟，且不可复现。
 *
 *   因此本脚本起一个 **OpenAI 兼容 HTTP 服务**（含 SSE 流式），由脚本**实时生成**
 *   模型响应（返回**真实原生 tool_calls**，走真实协议），驱动 **真实 runner + 真实
 *   runReActLoop** 跑完整生命周期。绕过的只有"模型大脑"，协议层 / 引擎 / 账本 /
 *   中断控制器 / 续聊入口全部是真的。
 *
 * 五个场景：
 *   S1 任务处理 —— task_plan 逐级推进，产物落盘，终态 done
 *   S2 任务中断 —— 运行中 pauseTask → paused，已完成项保留、未完成项不清零
 *   S3 续聊     —— paused 后 appendUserMessage → 自动重跑，已完成项不回退
 *   S4 补充     —— done 后追加"再补充一步" → 清单新增项，原 done 项不动
 *   S5 对照组   —— 模型把调用写成正文（无原生 tool_calls）→ D160 三轮内止血 + 人话
 *
 * 用法（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     scripts/mock-task-lifecycle.mts [--only=S1,S2,S3,S4,S5] [--debug]
 *
 * 退出码：0 = 全部通过；1 = 有未通过项。
 * ============================================================ */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = 8793
const WS = join(tmpdir(), 'arkwork-mock-lifecycle')
const argv = process.argv.slice(2)
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice(7).split(',') ?? ['S1', 'S2', 'S3', 'S4', 'S5']
const DEBUG = argv.includes('--debug')

/* ============================================================
 * 1. 模拟服务端（OpenAI 兼容 + SSE 流式）
 * ============================================================ */

interface ChatMessage {
  role: string
  content?: string | null
  tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>
  tool_call_id?: string
  reasoning_content?: string
}

interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: Array<{ type: string; function?: { name?: string } }>
  stream?: boolean
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 从可用工具里按关键字挑名字（不硬编码 —— 工具集换版本也不失效） */
function pickTool(req: ChatRequest, keywords: string[]): string | null {
  const names = (req.tools ?? []).map((t) => t.function?.name).filter((n): n is string => !!n)
  for (const kw of keywords) {
    const hit = names.find((n) => n.toLowerCase().includes(kw))
    if (hit) return hit
  }
  return null
}

/**
 * 从引擎注入的「当前清单快照」里取**真实**清单文本。
 *
 * 为什么不能写死：LLM 可见的工具名是 `task-plan`（不是 `task_plan`，见 D159 的
 * 归一化），清单文本也要与引擎账本**逐字一致** —— 否则 task_plan 的差异算法会把
 * 它们当成"新增项"，断言全部失真。引擎每轮把快照放进 system：
 *   `当前清单快照：\n1. [ ] 读取工作区结构\n2. [▶] 检索入口文件\n…`
 */
function snapshotTexts(messages: ChatMessage[]): string[] {
  const sys = messages.find(
    (m) => m.role === 'system' && typeof m.content === 'string' && (m.content as string).includes('当前清单快照：'),
  )
  if (!sys) return []
  const seg = (sys.content as string).split('当前清单快照：')[1] ?? ''
  const out: string[] = []
  for (const line of seg.split('\n')) {
    const m = /^\s*\d+\.\s*\[[^\]]*\]\s*(.+?)\s*$/.exec(line)
    if (!m) {
      if (out.length > 0) break
      continue
    }
    out.push(m[1]!)
  }
  return out.filter((x) => !/^…（其余/.test(x))
}

/** 消息里「模型已提交过几次 task_plan」—— 清单推进阶段的唯一驱动量 */
function countPlanSubmits(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const c of m.tool_calls ?? []) {
      if (/task[-_]plan/i.test(c.function?.name ?? '')) n += 1
    }
  }
  return n
}

/** 最后一条用户消息文本 */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : ''
  }
  return ''
}

/**
 * 「补充阶段」的推进计数器 —— **由脚本显式驱动**（不靠解析消息文本）。
 *
 * 为什么不解析消息：引擎在续聊时会注入含「追加」字样的指令文案（用户追加了新输入…），
 * 用 `/补充|追加/` 匹配历史会把**续聊**误判成**补充**（实测 S3 第 3 轮即误触发）。
 * 验证脚本的判据必须**确定性**：由调用方在真正发送补充指令前 `armSupplement()`。
 * 引擎侧路径仍是全真的（appendUserMessage → cancelTask → runTask → runReActLoop）。
 */
let suppPhase = 0
function armSupplement(): void {
  suppPhase = 1
}
function resetSupplement(): void {
  suppPhase = 0
}

interface MockReply {
  reasoning?: string
  content?: string
  calls?: Array<[string, Record<string, unknown>]>
  /** 响应前延迟（用于制造可中断的时间窗） */
  delayMs?: number
}

/** 各人格的「初始计划」产出（旁路调用 = 无 tools 的计划生成） */
const PLAN_OF: Record<string, string[]> = {
  'mock-lc-plan': ['读取工作区结构', '检索入口文件', '产出分析报告 report.md', '汇总并交付'],
  'mock-lc-slow': ['读取工作区结构', '检索入口文件', '产出分析报告 report.md', '汇总并交付'],
  'mock-lc-pseudo': ['读取工作区结构', '检索入口文件', '汇总并交付'],
}

/** 主流程清单文本（与旁路计划**逐字一致** —— 否则 diff 会当成新项，断言失真） */
const LC_TEXTS = ['读取工作区结构', '检索入口文件', '产出分析报告 report.md', '汇总并交付']
const SUPP_TEXT = '编写变更说明 changelog.md'

type PlanItemArg = { text: string; status: string; note: string }

/** 生成第 stage 阶段的完整清单（前 stage 项 done，第 stage 项 doing，其后 todo） */
function buildPlan(stage: number, texts: string[], prefixDone = 0): PlanItemArg[] {
  return texts.map((text, i) => {
    const abs = prefixDone + i
    const status = abs < stage ? 'done' : abs === stage ? 'doing' : 'todo'
    return { text, status, note: `第 ${abs + 1} 项：${status === 'done' ? '已完成' : status === 'doing' ? '进行中' : '待做'}` }
  })
}

/** 主流程人格：偶数轮交清单、奇数轮干活、清单全 done 后 task_complete */
function scriptMainFlow(req: ChatRequest, delayMs: number): MockReply {
  // ⚠️ 关键字用**引擎真实下发的连字符形态**（`task-plan` / `task-complete`）：
  // 工具名由 skill id 派生（S-core.task-plan → task-plan），写 `task_plan` 会挑不到
  // 工具，mock 退化成"零工具调用"，整轮验证测的是空气。归一化由引擎侧负责（D159）。
  const planTool = pickTool(req, ['task-plan'])
  const readTool = pickTool(req, ['file-reader'])
  const globTool = pickTool(req, ['glob-search'])
  const writeTool = pickTool(req, ['file-writer'])
  const doneTool = pickTool(req, ['task-complete'])

  const wantsSupp = suppPhase >= 1

  // 清单文本以引擎账本为准（快照解析），脚本常量只作兜底
  const snapTexts = snapshotTexts(req.messages)
  const baseTexts = (snapTexts.length > 0 ? snapTexts : LC_TEXTS).filter((t) => t !== SUPP_TEXT)

  // 补充阶段：原有项已完成，只推进新增项
  if (wantsSupp) {
    if (suppPhase === 1) {
      suppPhase = 2
      return {
        reasoning: '用户追加了一步，先把它加进清单并开工。',
        content: '收到，补充一步：编写变更说明。',
        delayMs,
        calls: planTool
          ? [[planTool, { items: [...buildPlan(baseTexts.length, baseTexts), { text: SUPP_TEXT, status: 'doing', note: '新增：用户补充要求' }], reason: '用户追加了一步' }]]
          : [],
      }
    }
    if (suppPhase === 2) {
      suppPhase = 3
      return {
        reasoning: '变更说明写好了，把文件落盘。',
        content: '写入 changelog.md。',
        delayMs,
        calls: writeTool ? [[writeTool, { path: 'changelog.md', content: '# 变更说明\n\n- 新增分析报告\n' }]] : [],
      }
    }
    if (suppPhase === 3) {
      suppPhase = 4
      return {
        reasoning: '补充项完成，清单整体收口。',
        content: '补充项已完成。',
        delayMs,
        calls: planTool
          ? [[planTool, { items: [...buildPlan(baseTexts.length, baseTexts), { text: SUPP_TEXT, status: 'done', note: '变更说明已产出' }], reason: '补充项完成' }]]
          : [],
      }
    }
    suppPhase = 5
    return {
      reasoning: '全部完成，交付。',
      content: '补充步骤已完成，任务交付。',
      delayMs,
      calls: doneTool ? [[doneTool, { summary: '已完成分析报告并补充了变更说明 changelog.md' }]] : [],
    }
  }

  const submits = countPlanSubmits(req.messages)
  const texts = baseTexts
  if (submits > texts.length) {
    return {
      reasoning: '清单四项全部完成，可以交付。',
      content: '分析报告已生成，任务完成。',
      delayMs,
      calls: doneTool ? [[doneTool, { summary: '工作区分析完成，报告已写入 report.md' }]] : [],
    }
  }

  // 轮次奇偶：偶数交清单、奇数干一件真活（引擎要看到"实质工作"，不是只会改清单）
  const assistantRounds = req.messages.filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length
  if (assistantRounds % 2 === 0) {
    return {
      reasoning: `同步清单进度（第 ${submits + 1} 次提交）。`,
      content: `清单推进到第 ${Math.min(submits, texts.length)} 项。`,
      delayMs,
      calls: planTool ? [[planTool, { items: buildPlan(submits, texts), reason: `阶段推进 ${submits}` }]] : [],
    }
  }
  const toolSeq: Array<[string | null, Record<string, unknown>]> = [
    [readTool, { path: '.' }],
    [globTool, { pattern: '**/*.md' }],
    [writeTool, { path: 'report.md', content: '# 工作区分析报告\n\n结论：结构清晰。\n' }],
    [readTool, { path: 'docs' }],
  ]
  const [name, args] = toolSeq[Math.floor(assistantRounds / 2) % toolSeq.length]!
  return {
    reasoning: '按清单执行当前项。',
    content: '执行当前清单项。',
    delayMs,
    calls: name ? [[name, args]] : [],
  }
}

function scriptFor(model: string, req: ChatRequest): MockReply {
  // 旁路调用识别：**不带 tools** 的是计划生成 / 标题生成，不是 ReAct 回合。
  const sysText = typeof req.messages.find((m) => m.role === 'system')?.content === 'string'
    ? (req.messages.find((m) => m.role === 'system')!.content as string)
    : ''
  if (!req.tools || req.tools.length === 0) {
    if (/任务命名助手/.test(sysText)) return { content: '工作区分析验证', delayMs: 0 }
    return { content: JSON.stringify(PLAN_OF[model] ?? []), delayMs: 0 }
  }

  if (model.startsWith('mock-lc-pseudo')) {
    // 对照组（D160 现场形态）：模型可达、正常说话，但把调用**写进正文**，
    // 一个原生 tool_calls 都不发 —— 引擎必须在 3 轮内止血并讲人话。
    const n = req.messages.filter((m) => m.role === 'assistant').length
    return {
      reasoning: `第 ${n + 1} 轮：我准备读取目录。`,
      content:
        '好的，我先看一下工作区结构：\n\nfile-reader(path=".")\n\n' +
        '读完之后再更新清单：\n\ntask_plan(items=[{ "text": "读取工作区结构", "status": "doing" }])',
      delayMs: 0,
      calls: [],
    }
  }

  const delayMs = model.startsWith('mock-lc-slow') ? 900 : 0
  return scriptMainFlow(req, delayMs)
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
  out.push(mk({}, (reply.calls?.length ?? 0) > 0 ? 'tool_calls' : 'stop'))
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
    void (async () => {
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
      const model = body.model ?? 'mock-lc-plan'
      const reply = scriptFor(model, body)
      const round = body.messages.filter((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0).length
      if (reply.delayMs && reply.delayMs > 0) await sleep(reply.delayMs)
      if (DEBUG) {
        const toolNames = (body.tools ?? []).map((t) => t.function?.name).join(',')
        console.log(
          `   [mock] ${model} round=${round} → calls=${(reply.calls ?? []).map(([n]) => n).join(',') || '（无）'} ` +
            `| content=${JSON.stringify(reply.content ?? '').slice(0, 40)}`,
        )
        if (toolNames) console.log(`   [mock] tools=${toolNames.slice(0, 160)}`)
      }
      if (body.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        for (const c of buildChunks(model, reply, round)) res.write(`data: ${JSON.stringify(c)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(buildNonStreamBody(model, reply, round)))
    })()
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

type TaskLike = Record<string, unknown> & {
  id: string
  status?: string
  planItems?: Array<{ text: string; status: string; id?: string }>
  pausedReason?: string
  errorMessage?: string
  pendingAskUser?: { question?: string }
  graphId?: string
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true
    await sleep(120)
  }
  info(`waitFor 超时（${label}，${timeoutMs}ms）`)
  return false
}

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
  console.log('════════════════════════════════════════════════════════')
  console.log(' ArkWork v0.38.0 — 任务生命周期端到端验证（模拟模型 + 真实引擎）')
  console.log('════════════════════════════════════════════════════════')
  console.log(`  模拟端点: http://127.0.0.1:${PORT}/v1 ｜ 工作区: ${WS}`)
  console.log('')

  await rm(WS, { recursive: true, force: true })
  await mkdir(join(WS, 'docs'), { recursive: true })
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
      ['mock-lc-plan', 'mock-lc-slow', 'mock-lc-pseudo'].map((id) => ({
        id,
        name: id,
        kind: 'openai',
        baseURL: base,
        apiKey: 'x',
        contextWindow: 128000,
        enabled: true,
      })),
      null,
      2,
    ),
    'utf-8',
  )

  const { resetTaskCollection, createTask, getTask, appendUserMessage } = await import('../src/main/store/tasks.js')
  const { runTask, pauseTask } = await import('../src/main/agent/runner.js')
  const { listSessionEvents } = await import('../src/main/agent/session-log.js')

  resetTaskCollection()

  async function newTask(modelId: string, prompt: string): Promise<string> {
    const created = await createTask({ title: `${modelId} 生命周期`, agentId: '@default', modelId, text: prompt })
    return (created as unknown as { id: string }).id
  }

  async function start(taskId: string): Promise<void> {
    resetSupplement()
    await runTask(taskId)
  }

  async function snap(taskId: string): Promise<TaskLike | null> {
    return (await getTask(taskId)) as TaskLike | null
  }

  const doneOf = (t: TaskLike | null): number => (t?.planItems ?? []).filter((i) => i.status === 'done').length
  const textsOf = (t: TaskLike | null): string[] => (t?.planItems ?? []).map((i) => i.text)

  async function waitTerminal(taskId: string, timeoutMs = 90_000): Promise<TaskLike | null> {
    await waitFor(async () => {
      const t = await snap(taskId)
      return !!t && TERMINAL.has(t.status ?? '')
    }, timeoutMs, `waitTerminal(${taskId})`)
    return snap(taskId)
  }

  /* ---------------- S1：任务处理 ---------------- */
  if (ONLY.includes('S1')) {
    console.log('── S1 任务处理（mock-lc-plan）：task_plan 逐级推进 → 产物落盘 → done ──')
    const id = await newTask('mock-lc-plan', '帮我分析工作区并产出报告')
    await start(id)
    const t = await waitTerminal(id)
    check('S1-1 任务终态为 done', t?.status === 'done', `实际 ${t?.status} / err=${t?.errorMessage ?? '无'}`)
    const items = t?.planItems ?? []
    check('S1-2 清单项齐全（4 项，未被 diff 当成新项）', items.length === 4, `${items.length} 项：${textsOf(t).join(' | ')}`)
    check('S1-3 清单全部收口为 done', doneOf(t) === items.length && items.length > 0, `${doneOf(t)}/${items.length}`)
    check('S1-4 无残留进行中/待做项', items.filter((i) => i.status === 'running' || i.status === 'pending').length === 0)
    check('S1-5 产物 report.md 已真实落盘', existsSync(join(WS, 'report.md')), 'report.md')
    const evts = await listSessionEvents(id)
    const planEvents = evts.filter((e) => (e as { type?: string }).type === 'turn_note').length
    info(`诊断：session 事件 ${evts.length} 条（turn_note ${planEvents}）｜清单 ${items.map((i) => i.status).join(',')}`)
  }

  /* ---------------- S2 + S3：中断 → 续聊 ---------------- */
  let slowId = ''
  if (ONLY.includes('S2')) {
    console.log('── S2 任务中断（mock-lc-slow）：运行中暂停 → 进度保留、不清零 ──')
    slowId = await newTask('mock-lc-slow', '帮我分析工作区并产出报告（慢速）')
    await start(slowId)
    // 等真实进度出现（至少一项 done）再中断 —— 中断必须打在"有进度可保留"的时刻
    const got = await waitFor(async () => doneOf(await snap(slowId)) >= 1, 20_000, '等到第 1 项 done')
    check('S2-0 中断前已有真实进度（第 1 项 done）', got, `done=${doneOf(await snap(slowId))}`)
    const before = await snap(slowId)
    await pauseTask(slowId)
    const paused = await waitFor(async () => (await snap(slowId))?.status === 'paused', 10_000, '等到 paused')
    const after = await snap(slowId)
    check('S2-1 ★ 暂停后状态为 paused（不是 failed / cancelled）', paused && after?.status === 'paused', `实际 ${after?.status}`)
    check('S2-2 ★ 已完成项在中断后**未被回退**', doneOf(after) >= doneOf(before ?? null), `前 ${doneOf(before ?? null)} → 后 ${doneOf(after)}`)
    check('S2-3 ★ 未完成项**未被清零/丢弃**（清单项数不减少）', (after?.planItems?.length ?? 0) >= (before?.planItems?.length ?? 0), `前 ${before?.planItems?.length} → 后 ${after?.planItems?.length}`)
    check('S2-4 暂停不是静默（有 pausedReason 或可恢复态）', after?.status === 'paused', `pausedReason=${after?.pausedReason ?? '（无）'}`)
    info(`诊断：中断时清单 ${(after?.planItems ?? []).map((i) => i.status).join(',')}`)
  }

  if (ONLY.includes('S3')) {
    console.log('── S3 续聊（中断后追加消息）：自动重跑 → 收口，且不重做已完成项 ──')
    if (!slowId) {
      slowId = await newTask('mock-lc-slow', '帮我分析工作区并产出报告（慢速）')
      await start(slowId)
      await waitFor(async () => doneOf(await snap(slowId)) >= 1, 20_000, '等到第 1 项 done')
      await pauseTask(slowId)
      await waitFor(async () => (await snap(slowId))?.status === 'paused', 10_000, '等到 paused')
    }
    const before = await snap(slowId)
    const beforeDone = doneOf(before)
    await appendUserMessage(slowId, '继续，把剩下的做完')
    const runningAgain = await waitFor(async () => (await snap(slowId))?.status === 'running', 10_000, '等到重新 running')
    check('S3-1 ★ 续聊后任务重新进入 running', runningAgain)
    const t = await waitTerminal(slowId, 90_000)
    check('S3-2 续聊跑到终态 done', t?.status === 'done', `实际 ${t?.status} / err=${t?.errorMessage ?? '无'}`)
    check('S3-3 ★ 已完成项没有被回退重做', doneOf(t) >= beforeDone, `中断时 ${beforeDone} → 结束时 ${doneOf(t)}`)
    check('S3-4 ★ 清单没有因续聊产生重复项', (t?.planItems?.length ?? 0) <= (before?.planItems?.length ?? 0) + 1, `前 ${before?.planItems?.length} → 后 ${t?.planItems?.length}`)
    check('S3-5 清单全部收口', (t?.planItems ?? []).every((i) => i.status === 'done'), `${(t?.planItems ?? []).map((i) => i.status).join(',')}`)
    check('S3-6 产物 report.md 已落盘', existsSync(join(WS, 'report.md')), 'report.md')
    info(`诊断：续聊后清单 ${textsOf(t).join(' | ')}`)
  }

  /* ---------------- S4：补充 ---------------- */
  if (ONLY.includes('S4')) {
    console.log('── S4 补充（done 后追加一步）：清单新增项，原完成项不动 ──')
    const id = ONLY.includes('S3') && slowId ? slowId : await newTask('mock-lc-plan', '帮我分析工作区并产出报告')
    if (id !== slowId) {
      await start(id)
      await waitTerminal(id)
    }
    const before = await snap(id)
    const beforeTexts = textsOf(before)
    // 先清掉可能的残留产物，避免「产物已落盘」断言吃上一轮的红利
    await rm(join(WS, 'changelog.md'), { force: true })
    armSupplement()
    await appendUserMessage(id, '再补充一步：写一份变更说明')
    const runningAgain = await waitFor(async () => (await snap(id))?.status === 'running', 10_000, '等到重新 running')
    check('S4-1 补充指令触发新一轮运行', runningAgain)
    const t = await waitTerminal(id, 90_000)
    check('S4-2 补充后跑到终态 done', t?.status === 'done', `实际 ${t?.status} / err=${t?.errorMessage ?? '无'}`)
    const afterTexts = textsOf(t)
    check('S4-3 ★ 清单新增了补充项', afterTexts.some((x) => /变更说明/.test(x)) && afterTexts.length > beforeTexts.length, `${beforeTexts.length} → ${afterTexts.length}：${afterTexts.join(' | ')}`)
    check('S4-4 ★ 原有已完成项仍为 done（未被重置）', beforeTexts.every((x) => (t?.planItems ?? []).find((i) => i.text === x)?.status === 'done'), `原 ${beforeTexts.length} 项`)
    check('S4-5 补充产物 changelog.md 已落盘', existsSync(join(WS, 'changelog.md')), 'changelog.md')
    check('S4-6 清单无残留未收口项', (t?.planItems ?? []).every((i) => i.status === 'done'), `${(t?.planItems ?? []).map((i) => i.status).join(',')}`)
  }

  /* ---------------- S5：对照组 —— 伪工具调用（D160） ---------------- */
  if (ONLY.includes('S5')) {
    console.log('── S5 对照组（mock-lc-pseudo）：模型把调用写成正文 → D160 三轮内止血 + 人话 ──')
    const id = await newTask('mock-lc-pseudo', '看一下这个工作区')
    const t0 = Date.now()
    await start(id)
    const stopped = await waitFor(async () => (await snap(id))?.status === 'paused', 60_000, '等到因伪调用暂停')
    const t = await snap(id)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    check('S5-1 ★ 伪调用被暂停（不再无限空转）', stopped && t?.status === 'paused', `实际 ${t?.status}，耗时 ${secs}s`)
    const q = t?.pendingAskUser?.question ?? ''
    check('S5-2 ★ 暂停原因讲人话（说明是"模型没发起真实工具调用"）', /工具调用|正文|function calling/i.test(q), q.slice(0, 80) || '（无 pendingAskUser）')
    const evts = await listSessionEvents(id)
    const stopNotes = evts.filter((e) => {
      const x = e as { type?: string; via?: string }
      return x.type === 'turn_note' && x.via === 'engine-stop'
    })
    check('S5-3 ★ 人话经 NoteBlock 通道投递（via=engine-stop，可见而非静默）', stopNotes.length > 0, `${stopNotes.length} 条`)
    // 止血速度：3 轮阈值，每轮一次 LLM 调用 —— 空转不应超过 10 轮
    const llmCalls = evts.filter((e) => (e as { type?: string }).type === 'reason_end').length
    check('S5-4 ★ 空转轮数被压在阈值附近（≤10 轮，现场修复前是 21 轮）', llmCalls > 0 && llmCalls <= 10, `reason_end ${llmCalls} 轮`)
    info(`诊断：session 事件 ${evts.length} 条，耗时 ${secs}s，暂停原因 ${q.slice(0, 60)}`)
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
