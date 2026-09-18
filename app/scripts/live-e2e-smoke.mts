/**
 * v0.32.1 — 真实环境端到端冒烟（**非密闭**：需外网 + 真实 models.json）
 *
 * 为什么单独成脚本而不是进 `npm test` 密闭链：
 *   依赖① 本机真实 models.json（含 apiKey）；
 *   依赖② 外网可达 + 目标模型可用。
 * 与 `src/main/memory/__tests__/e2e-memory-l4-llm.test.ts` 同属「显式欠账」类，
 * 不进 `scripts/run-tests.mjs` 的密闭候选集。
 *
 * ============================================================
 * 三个真实场景（不是单测的复述，而是走真 LLM + 真落盘 + 真面板投影）
 * ============================================================
 *  A. **正常执行**（真实模型）：任务能否走到终态、清单与图级 status 能否双双收口（D35/D36）、
 *     交互区三通道（正文 / 思考 / 工具）经**投影层**后是否都可见（D37）。
 *  B. **续聊重开**：任务终结后再发一条消息 → 图必须从终态**重开**为 in_progress，
 *     跑完再次收口。覆盖「收口是单向的，但任务可以被继续」这组反向矛盾。
 *  C. **失败路径**（临时注入一个 baseURL 指向黑洞端口的模型 → 连接必然被拒）：
 *     任务必须 **failed 且错误对用户可见**（D35 反面：不得静默判完成），
 *     且**任务清单必须立刻收口**（D36 的核心：`plan-fallback` 单步清单 → 图节点 ready
 *     → 在途为空 → 兜底收第一个排队项）。这条正是用户原始报障
 *     「刚开始执行就直接失败了，而后没有立刻修复任务清单」的真实复现。
 *
 * 用法（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     scripts/live-e2e-smoke.mts [modelId] [--text="自定义任务描述"] [--only=A|B|C]
 *
 * 退出码：0 = 全部验收通过；1 = 有未通过项（并打印明细）；2 = 环境不具备（无模型配置）。
 */
import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2)
const MODEL = argv.find((a) => !a.startsWith('--')) ?? 'deepseek-ai/DeepSeek-V4.1-Flash'
const TEXT_ARG = argv.find((a) => a.startsWith('--text='))?.slice('--text='.length)
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)?.split(',') ?? ['A', 'B', 'C']
const TASK_TEXT =
  TEXT_ARG ??
  '在工作区根目录创建 hello.txt，内容为「ArkWork live smoke ok」，然后读取该文件确认内容。'
/** 黑洞端口：连接必然被立即拒绝（不依赖任何外部服务，确定性失败） */
const BROKEN_MODEL_ID = 'arkwork-live-broken'
const BROKEN_BASE_URL = 'http://127.0.0.1:9/v1'

/* ---------------- 隔离工作区 + 真实凭据 ---------------- */
const WS = join(tmpdir(), 'arkwork-live-smoke')
const { setWorkspaceDir, getArkworkDir } = await import('../src/main/store/db.js')
setWorkspaceDir(WS)

async function prepareWorkspace(): Promise<'ok' | 'NO_SOURCE'> {
  const source = join(homedir(), 'Library', 'Application Support', 'ArkWork', 'arkwork-data', 'models.json')
  if (!existsSync(source)) return 'NO_SOURCE'
  // 每次从干净工作区起步：否则上一轮的 tasks.json / graph.json 会污染本轮判定
  await rm(WS, { recursive: true, force: true })
  const arkworkDir = getArkworkDir()
  await mkdir(arkworkDir, { recursive: true })
  const dest = join(arkworkDir, 'models.json')
  await copyFile(source, dest)

  // 场景 C 用：克隆目标模型成一个「黑洞端点」模型（连接必被拒），
  // **只写进隔离工作区的副本**，绝不碰用户的真实配置。
  // 必须在此刻注入 —— registry 的 loadModels 有进程级缓存，首次加载后再写就晚了。
  if (ONLY.includes('C')) {
    try {
      const list = JSON.parse(await readFile(dest, 'utf8')) as Array<Record<string, unknown>>
      const template = list.find((m) => m.id === MODEL)
      list.push({
        id: BROKEN_MODEL_ID,
        name: 'live-broken (黑洞端点)',
        kind: template?.kind ?? 'openai',
        baseURL: BROKEN_BASE_URL,
        apiKey: 'not-a-real-key',
        enabled: true,
        supportsThinking: false,
        supportsTools: true,
      })
      await writeFile(dest, JSON.stringify(list, null, 2), 'utf8')
    } catch (err) {
      console.warn(`  ⚠️ 注入故障模型失败（场景 C 将退化为使用真实模型）：${(err as Error).message}`)
    }
  }
  return 'ok'
}

const { resetTaskCollection, createTask, getTask } = await import('../src/main/store/tasks.js')
const { getAgent } = await import('../src/main/store/agents.js')
const { getModel } = await import('../src/main/llm/registry.js')
const { runReActLoop } = await import('../src/main/agent/engine/index.js')
const { loadGraph } = await import('../src/main/agent/graph/index.js')
const { appendUserMessage } = await import('../src/main/store/tasks.js')
const { projectConversation } = await import('../src/renderer/flow/project.js')

/* ---------------- 输出工具 ---------------- */
const ok = (m: string) => console.log(`  ✅ ${m}`)
const bad = (m: string) => console.log(`  ❌ ${m}`)
const info = (m: string) => console.log(`     ${m}`)
const results: { name: string; pass: boolean; detail: string }[] = []
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail })
  pass ? ok(name + (detail ? ` —— ${detail}` : '')) : bad(name + (detail ? ` —— ${detail}` : ''))
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ============================================================
 * 主流程
 * ============================================================ */
console.log('════════════════════════════════════════════════════════')
console.log(' ArkWork v0.32.1 真实环境端到端冒烟')
console.log('════════════════════════════════════════════════════════')
console.log(`  模型    : ${MODEL}`)
console.log(`  工作区  : ${WS}`)
console.log(`  场景    : ${ONLY.join(' / ')}`)
console.log(`  任务描述: ${TASK_TEXT}`)
console.log('')

const prepared = await prepareWorkspace()
if (prepared === 'NO_SOURCE') {
  console.error('  ⚠️ 未找到真实 models.json，无法进行真实环境测试（退出码 2）')
  process.exit(2)
}
const model = await getModel(MODEL)
if (!model) {
  console.error(`  ⚠️ 模型不存在或已禁用：${MODEL}（退出码 2）`)
  process.exit(2)
}
info(`端点: ${model.baseURL}`)
console.log('')

resetTaskCollection()

/* ---------------- 通用：跑一轮并按任务/图取地面真相 ---------------- */
interface RunOutcome {
  taskId: string
  graphId?: string
  status: string
  errorMessage?: string
  elapsedSec: string
  steps: Array<Record<string, unknown>>
  loopErr: Error | null
}

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

async function runOnce(taskId: string, modelId: string, guardMs: number): Promise<RunOutcome> {
  const task = await getTask(taskId)
  const agent = await getAgent(task!.agentId)
  const controller = new AbortController()
  const guard = setTimeout(() => {
    info(`⏱ 达到 ${(guardMs / 60000).toFixed(1)} 分钟总闸，主动中止（模拟用户中断）`)
    controller.abort()
  }, guardMs)
  const t0 = Date.now()
  let loopErr: Error | null = null
  try {
    await runReActLoop({ task: task!, agent: agent!, modelId, signal: controller.signal })
  } catch (err) {
    loopErr = err as Error
  } finally {
    clearTimeout(guard)
  }
  const final = await getTask(taskId)
  return {
    taskId,
    graphId: final?.graphId,
    status: final?.status ?? 'unknown',
    errorMessage: final?.errorMessage,
    elapsedSec: ((Date.now() - t0) / 1000).toFixed(1),
    steps: await readSteps(taskId),
    loopErr,
  }
}

const SETTLED = new Set(['done', 'failed', 'cancelled'])
const TERMINAL = new Set(['completed', 'cancelled', 'failed'])

/** 终态一致性矩阵：任务终态 ↔ 图级 status 必须语义一致 */
function consistencyViolation(taskStatus: string, graphStatus: string | undefined): string | null {
  if (!graphStatus) return null
  if (taskStatus === 'running' || taskStatus === 'pending') return null
  const expect: Record<string, string> = {
    done: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
    paused: 'in_progress', // 暂停可恢复：刻意不封口
  }
  const want = expect[taskStatus]
  if (!want) return null
  return graphStatus === want ? null : `task=${taskStatus} 期望 graph=${want}，实际 graph=${graphStatus}`
}

/* ============================================================
 * 场景 A —— 正常执行（D35 / D36 成功路径 / D37）
 * ============================================================ */
if (ONLY.includes('A')) {
  console.log('───────────────────────────────────────────')
  console.log(' 场景 A｜正常执行（真实模型）')
  console.log('───────────────────────────────────────────')
  const task = await createTask({ title: 'live-A', text: TASK_TEXT, agentId: '@coding', modelId: MODEL })
  const r = await runOnce(task.id, MODEL, 6 * 60 * 1000)
  console.log(`  ── run 结束（耗时 ${r.elapsedSec}s）｜task=${r.status}`)
  if (r.loopErr) info(`runReActLoop 抛出: ${r.loopErr.name}: ${r.loopErr.message.slice(0, 200)}`)
  console.log('')

  const final = await getTask(task.id)
  const graph = final?.graphId ? await loadGraph(final.graphId) : null
  const pItems = final?.planItems ?? []
  const doneCount = pItems.filter((p) => p.status === 'done').length
  const hasBodyOrTool = r.steps.some(
    (st) => String(st.say ?? '').trim() || String(st.thought ?? '').trim() || st.type === 'act',
  )

  /* --- A1 任务终态与错误可见性（D35） --- */
  console.log('【A1】任务终态与错误可见性（D35）')
  info(`任务状态 = ${r.status} ｜ errorMessage = ${r.errorMessage ? r.errorMessage.slice(0, 160) : '(空)'}`)
  info(`planItems = ${pItems.length} 条：${pItems.map((p) => `${p.id.slice(-6)}:${p.status}`).join('  ')}`)
  check('任务离开 running（不得静默停留在进行中）', r.status !== 'running', `status=${r.status}`)
  if (r.status === 'failed') {
    check(
      '失败时 errorMessage 非空（用户可见的错误，而非只在日志里）',
      Boolean(r.errorMessage && r.errorMessage.trim()),
      r.errorMessage?.slice(0, 120) ?? '',
    )
  }
  const isSilentNoop = r.status === 'done' && !hasBodyOrTool && doneCount === 0
  check(
    '未出现「无产出却判完成」的静默收尾',
    !isSilentNoop,
    isSilentNoop
      ? 'status=done 但无正文、无工具调用、清单零推进'
      : `产出证据：steps=${r.steps.length}（有正文/工具）｜ planItems done=${doneCount}/${pItems.length}`,
  )
  console.log('')

  /* --- A2 清单与图级 status 收口（D36） --- */
  console.log('【A2】任务清单与图级 status 收口（D36）')
  if (!SETTLED.has(r.status)) {
    info(`任务处于 ${r.status}（非终态）→ **刻意不做收口**（可恢复态；封终态会让「继续」后状态失真）`)
    if (graph) {
      check(
        `${r.status} 时图级 status 未被误封为终态`,
        graph.status === 'in_progress',
        `graph.status=${graph.status}（期望保持 in_progress）`,
      )
    }
  } else if (!graph) {
    info('本任务无图（tier 0/1 轻量模式），跳过图侧断言')
    const nonTerminal = pItems.filter((p) => p.status === 'running' || p.status === 'pending')
    check(
      '任务终结后清单无未收口项（无 running/pending）',
      nonTerminal.length === 0,
      nonTerminal.length ? `未收口: ${nonTerminal.map((p) => `${p.id}:${p.status}`).join(', ')}` : '全部终态',
    )
  } else {
    const nodes = Object.values(graph.nodes)
    const taskNodes = nodes.filter((n) => n.layer !== 'goal')
    info(`图 status = ${graph.status} ｜ 节点 ${nodes.length} 个（task 层 ${taskNodes.length}）`)
    info(`节点状态: ${taskNodes.map((n) => `${n.key ?? n.id}=${n.status}`).join('  ')}`)
    const nodeNonTerminal = taskNodes.filter((n) => !TERMINAL.has(n.status))
    check(
      '任务终结后所有 task 层节点均达终态',
      nodeNonTerminal.length === 0,
      nodeNonTerminal.length
        ? `未收口: ${nodeNonTerminal.map((n) => `${n.key ?? n.id}:${n.status}`).join(', ')}`
        : '',
    )
    check(
      '★ 图级 status 已封口（D36 核心：不得停在 in_progress）',
      graph.status !== 'in_progress',
      `graph.status=${graph.status} / task.status=${r.status}`,
    )
    const violation = consistencyViolation(r.status, graph.status)
    check('图级 status 与任务终态语义一致', violation === null, violation ?? `task=${r.status} graph=${graph.status}`)
  }
  console.log('')

  /* --- A3 交互区三通道（走真实投影层，D37） --- */
  console.log('【A3】交互区三通道 —— 经投影层 projectConversation 实算（D37）')
  const reasonSteps = r.steps.filter((s) => s.type === 'reason')
  const actSteps = r.steps.filter((s) => s.type === 'act')
  const withNative = reasonSteps.filter((s) => String(s.reasoning ?? '').trim())
  const withThought = reasonSteps.filter((s) => String(s.thought ?? '').trim())
  info(
    `steps=${r.steps.length}（reason ${reasonSteps.length} / act ${actSteps.length}）｜` +
      ` 有原生思考 ${withNative.length} ｜ 有正文(thought) ${withThought.length}`,
  )
  check('至少产生一个思维步骤（引擎真的在推理）', reasonSteps.length > 0, `reason=${reasonSteps.length}`)
  check(
    '工具调用被记录为独立通道（命令可见）',
    actSteps.length > 0,
    `act=${actSteps.length}${actSteps.length ? `：${actSteps.map((s) => s.toolName).join(', ')}` : ''}`,
  )

  // 真实投影：走渲染层**同一条链路** ——
  //   deriveConversation(task, steps, memory) → projectConversation(items, steps, …)
  // 这样断言的就是「用户实际会看到什么块」，而不是我手工拼的 items（手工拼会改变分组，
  // 曾导致 step↔iteration 映射错位，属于测试脚本自身的坑）。
  const { deriveConversation } = await import('../src/renderer/store/derive-conversation.js')
  const { listL1 } = await import('../src/main/memory/l1-working.js')
  const memory = await listL1(task.id)
  const items = deriveConversation(final, r.steps as never, memory as never)
  info(`链路：memory ${memory.length} 条 → deriveConversation 产出 ${items.length} 个 item`)
  const turns = projectConversation({
    taskId: task.id,
    items,
    steps: r.steps as never,
    events: [],
    streamBuffers: {},
    planItems: pItems,
    viewMode: 'standard',
    showThinking: true,
    ui: { viewMode: 'standard', showThinking: true, blockUiState: {}, turnUiState: {}, scrollAnchorByTask: {} },
    now: Date.now(),
  })
  const sayTexts: string[] = []
  const reasoningTexts: string[] = []
  const toolTexts: string[] = []
  /** 有非空 say 块的 **ReAct iteration**（SayBlock.step 即 iteration，不是步序号） */
  const iterWithSay = new Set<number>()
  for (const t of turns) {
    for (const st of t.steps) {
      for (const b of st.blocks) {
        if (b.kind === 'say') {
          if (b.text.trim()) {
            sayTexts.push(b.text)
            iterWithSay.add(b.step)
          }
        } else if (b.kind === 'reasoning') {
          if (b.text.trim()) reasoningTexts.push(b.text)
        } else if (b.kind === 'tool') {
          toolTexts.push(String((b as { title?: string; name?: string }).title ?? ''))
        }
      }
    }
  }
  info(`投影结果：turns=${turns.length} ｜ say 块=${sayTexts.length} ｜ reasoning 块=${reasoningTexts.length} ｜ tool 块=${toolTexts.length}`)
  if (sayTexts.length) info(`正文样例：${sayTexts[0].replace(/\s+/g, ' ').slice(0, 90)}`)
  check('投影层产出「正文」通道（正式输出可见）', sayTexts.length > 0, `say 块=${sayTexts.length}`)
  check('投影层产出「思考」通道', reasoningTexts.length > 0, `reasoning 块=${reasoningTexts.length}`)
  check('投影层产出「工具」通道（命令可见）', toolTexts.length > 0, `tool 块=${toolTexts.length}`)
  // ★ D37 精确断言（两条独立证据）
  //  ① 结构：凡「有原生思考 + 有 thought」的 iteration，必须有非空 say 块
  //  ② 内容：该步的 thought 正文必须能在 say 块里**逐字找到**（回落是逐字搬运，
  //     这条比「有没有块」更强 —— 它证明界面上的正文就是模型写的那段文字）
  const d37Targets = reasonSteps.filter(
    (s) => String(s.reasoning ?? '').trim() && String(s.thought ?? '').trim(),
  )
  const norm = (v: string): string => v.replace(/\s+/g, ' ').trim()
  const sayBlob = norm(sayTexts.join('\n'))
  const missedStruct = d37Targets.filter((s) => !iterWithSay.has(Number(s.iteration)))
  const missedContent = d37Targets.filter(
    (s) => !String(s.say ?? '').trim() && !sayBlob.includes(norm(String(s.thought ?? '')).slice(0, 60)),
  )
  check(
    '★ D37 结构：原生思考不再遮蔽正文（凡两者都有，必须有正文块）',
    missedStruct.length === 0,
    d37Targets.length === 0
      ? '本轮模型未同时产出两者，断言不适用（结构性可用性由投影层单测把守）'
      : `受检 ${d37Targets.length} 步，缺正文块 ${missedStruct.length} 步`,
  )
  check(
    '★ D37 内容：界面上的正文与模型写的一致（逐字可见）',
    missedContent.length === 0,
    d37Targets.length === 0
      ? '同上'
      : `受检 ${d37Targets.length} 步，正文未可见 ${missedContent.length} 步`,
  )
  console.log('')

  /* ============================================================
   * 场景 B —— 续聊重开（终态 → in_progress → 再收口）
   * ============================================================ */
  if (ONLY.includes('B')) {
    console.log('───────────────────────────────────────────')
    console.log(' 场景 B｜续聊重开（任务终结后再跑一轮）')
    console.log('───────────────────────────────────────────')
    if (!SETTLED.has(r.status) || !final?.graphId) {
      info(`跳过：任务处于 ${r.status}（非终态）或无图，续聊语义不同`)
    } else {
      const beforeGraphStatus = graph?.status
      info(`续聊前：task=${r.status} ｜ graph=${beforeGraphStatus}`)
      await appendUserMessage(
        task.id,
        '请在 hello.txt 末尾追加一行「second run ok」，然后读取该文件确认内容。',
      )
      // 轮询：既要抓「运行期确实被重开为 in_progress」的证据，也要等到再次收敛
      let sawInProgress = false
      let lastStatus = ''
      const deadline = Date.now() + 5 * 60 * 1000
      while (Date.now() < deadline) {
        const g = final.graphId ? await loadGraph(final.graphId) : null
        if (g?.status === 'in_progress') sawInProgress = true
        const t = await getTask(task.id)
        lastStatus = t?.status ?? 'unknown'
        if (lastStatus === 'done' || lastStatus === 'failed' || lastStatus === 'cancelled') break
        await sleep(1000)
      }
      const afterGraph = final.graphId ? await loadGraph(final.graphId) : null
      const afterTask = await getTask(task.id)
      info(`续聊后：task=${afterTask?.status} ｜ graph=${afterGraph?.status}（运行期见 in_progress=${sawInProgress}）`)
      check(
        '★ 续聊时图从终态重开为 in_progress（收口是可逆的）',
        sawInProgress,
        sawInProgress
          ? `运行期观测到 in_progress（续聊前为 ${beforeGraphStatus}）`
          : `整个第二轮都没见到 in_progress —— 图卡在 ${afterGraph?.status}`,
      )
      check(
        '续聊后任务再次收敛',
        afterTask?.status === 'done' || afterTask?.status === 'failed' || afterTask?.status === 'cancelled',
        `task=${afterTask?.status}（5 分钟闸内）`,
      )
      const bViolation = consistencyViolation(afterTask?.status ?? 'unknown', afterGraph?.status)
      check('续聊后「任务态 ↔ 图态」仍自洽', bViolation === null, bViolation ?? `task=${afterTask?.status} graph=${afterGraph?.status}`)
      // 续聊后的清单也要收干净（D39：不得留下「已完成 + 待执行」）
      if (afterTask?.status === 'done' && afterGraph) {
        const left = Object.values(afterGraph.nodes).filter(
          (n) => n.layer !== 'goal' && n.status !== 'completed' && n.status !== 'cancelled' && n.status !== 'failed',
        )
        check(
          '★ 续聊完成时清单无未收口项（D39）',
          left.length === 0,
          left.length ? `未收口: ${left.map((n) => `${n.key ?? n.id}:${n.status}`).join(', ')}` : '',
        )
      }
    }
    console.log('')
  }
}

/* ============================================================
 * 场景 C —— 失败路径（D35 反面 + D36 核心）
 * ============================================================ */
if (ONLY.includes('C')) {
  console.log('───────────────────────────────────────────')
  console.log(' 场景 C｜失败路径（注入黑洞端点模型，连接必被拒）')
  console.log('───────────────────────────────────────────')
  info(`故障模型 ${BROKEN_MODEL_ID} → ${BROKEN_BASE_URL}（仅存在于隔离工作区）`)
  const broken = await getModel(BROKEN_MODEL_ID)
  if (!broken) {
    console.error('  ⚠️ 故障模型注入未生效（registry 缓存），跳过场景 C')
  } else {
    const taskC = await createTask({ title: 'live-C-broken', text: TASK_TEXT, agentId: '@coding', modelId: BROKEN_MODEL_ID })
  const rc = await runOnce(taskC.id, BROKEN_MODEL_ID, 3 * 60 * 1000)
  console.log(`  ── run 结束（耗时 ${rc.elapsedSec}s）｜task=${rc.status}`)
  if (rc.loopErr) info(`runReActLoop 抛出: ${rc.loopErr.name}: ${rc.loopErr.message.slice(0, 200)}`)
  const finalC = await getTask(taskC.id)
  const graphC = finalC?.graphId ? await loadGraph(finalC.graphId) : null
  info(`errorMessage = ${finalC?.errorMessage ? finalC.errorMessage.slice(0, 160) : '(空)'}`)
  info(`planItems = ${(finalC?.planItems ?? []).map((p) => `${p.id.slice(-6)}:${p.status}`).join('  ') || '(无)'}`)
  if (graphC) {
    const tn = Object.values(graphC.nodes).filter((n) => n.layer !== 'goal')
    info(`图 status = ${graphC.status} ｜ task 层节点: ${tn.map((n) => `${n.key ?? n.id}=${n.status}`).join('  ')}`)
  } else {
    info('无图（该任务未走到建图）')
  }

  check(
    '★ D35 反面：失败必须显性（不得静默判完成）',
    finalC?.status === 'failed',
    `task=${finalC?.status}`,
  )
  check(
    '失败原因对用户可见（errorMessage 非空）',
    Boolean(finalC?.errorMessage && finalC.errorMessage.trim()),
    finalC?.errorMessage?.slice(0, 120) ?? '',
  )
  if (graphC) {
    check(
      '★ D36 核心：失败后图级 status 立刻封口（不得停在 in_progress）',
      graphC.status === 'failed',
      `graph.status=${graphC.status}`,
    )
    const taskNodes = Object.values(graphC.nodes).filter((n) => n.layer !== 'goal')
    const failedNodes = taskNodes.filter((n) => n.status === 'failed')
    check(
      '★ D36 兜底：在途为空时也要收第一个排队项（清单不得纹丝不动）',
      failedNodes.length > 0,
      failedNodes.length
        ? `已收口节点：${failedNodes.map((n) => n.key ?? n.id).join(', ')}`
        : `无节点被收成 failed：${taskNodes.map((n) => `${n.key ?? n.id}=${n.status}`).join(', ')}`,
    )
  } else {
    const items = finalC?.planItems ?? []
    const failedItems = items.filter((p) => p.status === 'failed')
    check(
      '★ D36 兜底（无图路径）：清单里至少一项被标 failed',
      failedItems.length > 0,
      failedItems.length ? failedItems.map((p) => p.id).join(', ') : `清单=${items.map((p) => p.status).join(',') || '空'}`,
    )
  }
    console.log('')
  }
}

/* ---------------- 汇总 ---------------- */
const failedList = results.filter((r) => !r.pass)
console.log('════════════════════════════════════════════════════════')
console.log(` 结果：${results.length - failedList.length} / ${results.length} 通过`)
if (failedList.length) {
  console.log(' 未通过：')
  for (const f of failedList) console.log(`   ❌ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`)
}
console.log('════════════════════════════════════════════════════════')
process.exit(failedList.length ? 1 : 0)
