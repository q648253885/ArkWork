/**
 * v0.34.0 — 真实环境全流程测试（**非密闭**：需 Ollama + 真实 models.json）
 *
 * 与 live-e2e-smoke.mts 同族，但按用户要求覆盖「多维度 × 多中断 × 多任务」：
 *
 *   S1 正常执行：任务终态 / 清单收口 / 图封口 / 交互区三通道（真投影层）/ D37
 *   S2 清单动态：运行期轮询 planItems 状态迁移 —— 单调推进、不得回跳、终态无未收口
 *   S3 暂停恢复：运行中 pauseTask → paused 且图**不封口**（可恢复态）→ resumeTask → 再收口
 *   S4 取消：运行中 cancelTask → cancelled 且图封为 cancelled、errorMessage 可见
 *   S5 多任务交错：两个任务并发跑，交互区/清单/图互不串扰（隔离性）
 *   S6 续聊重开：终态后 appendUserMessage → 图重开 in_progress → 再收口（收口可逆）
 *
 * 用法（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     scripts/live-e2e-full.mts qwen3.5:9b [--only=S1,S2,...]
 *
 * 退出码：0 = 全部通过；1 = 有未通过项；2 = 环境不具备。
 */
import { mkdir, copyFile, rm, readFile, existsSync } from 'node:fs/promises'
import { existsSync as existsSyncSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const argv = process.argv.slice(2)
const MODEL = argv.find((a) => !a.startsWith('--')) ?? 'qwen3.5:9b'
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)?.split(',') ?? ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']

const WS = join(tmpdir(), 'arkwork-live-full')
const { setWorkspaceDir, getArkworkDir } = await import('../src/main/store/db.js')
setWorkspaceDir(WS)

async function prepareWorkspace(): Promise<'ok' | 'NO_SOURCE'> {
  const source = join(homedir(), 'Library', 'Application Support', 'ArkWork', 'arkwork-data', 'models.json')
  if (!existsSync(source)) return 'NO_SOURCE'
  await rm(WS, { recursive: true, force: true })
  const arkworkDir = getArkworkDir()
  await mkdir(arkworkDir, { recursive: true })
  await copyFile(source, join(arkworkDir, 'models.json'))
  return 'ok'
}

const { resetTaskCollection, createTask, getTask } = await import('../src/main/store/tasks.js')
const { getAgent } = await import('../src/main/store/agents.js')
const { getModel } = await import('../src/main/llm/registry.js')
const { runReActLoop } = await import('../src/main/agent/engine/index.js')
const { loadGraph } = await import('../src/main/agent/graph/index.js')
const { appendUserMessage } = await import('../src/main/store/tasks.js')
const { pauseTask, resumeTask, cancelTask } = await import('../src/main/agent/runner.js')
const { projectConversation } = await import('../src/renderer/flow/project.js')

const ok = (m: string) => console.log(`  ✅ ${m}`)
const bad = (m: string) => console.log(`  ❌ ${m}`)
const info = (m: string) => console.log(`     ${m}`)
const results: { name: string; pass: boolean; detail: string }[] = []
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail })
  pass ? ok(name + (detail ? ` —— ${detail}` : '')) : bad(name + (detail ? ` —— ${detail}` : ''))
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

console.log('════════════════════════════════════════════════════════')
console.log(' ArkWork v0.34.0 真实环境全流程测试（交互区 / 任务清单 / 多中断 / 多任务）')
console.log('════════════════════════════════════════════════════════')
console.log(`  模型: ${MODEL} ｜ 工作区: ${WS}`)
console.log(`  场景: ${ONLY.join(' / ')}`)
console.log('')

const prepared = await prepareWorkspace()
if (prepared === 'NO_SOURCE') {
  console.error('  ⚠️ 未找到真实 models.json（退出码 2）')
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

const SETTLED = new Set(['done', 'failed', 'cancelled'])
const TERMINAL = new Set(['completed', 'cancelled', 'failed'])

async function readSteps(taskId: string): Promise<Array<Record<string, unknown>>> {
  const p = join(WS, '.arkwork', 'memory', taskId, 'steps.jsonl')
  if (!existsSyncSync(p)) return []
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

function consistencyViolation(taskStatus: string, graphStatus: string | undefined): string | null {
  if (!graphStatus) return null
  if (taskStatus === 'running' || taskStatus === 'pending') return null
  const expect: Record<string, string> = {
    done: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
    paused: 'in_progress',
  }
  const want = expect[taskStatus]
  if (!want) return null
  return graphStatus === want ? null : `task=${taskStatus} 期望 graph=${want}，实际 graph=${graphStatus}`
}

/** 跑完一轮（await 到终态或守卫中止） */
async function runOnce(taskId: string, guardMs: number): Promise<{ status: string; elapsedSec: string; loopErr: Error | null }> {
  const task = await getTask(taskId)
  const agent = await getAgent(task!.agentId)
  const controller = new AbortController()
  const guard = setTimeout(() => controller.abort(), guardMs)
  const t0 = Date.now()
  let loopErr: Error | null = null
  try {
    await runReActLoop({ task: task!, agent: agent!, modelId: MODEL, signal: controller.signal })
  } catch (err) {
    loopErr = err as Error
  } finally {
    clearTimeout(guard)
  }
  const final = await getTask(taskId)
  return { status: final?.status ?? 'unknown', elapsedSec: ((Date.now() - t0) / 1000).toFixed(1), loopErr }
}

/** 启动后轮询：等首个 act 步出现（确保任务真的在跑），再触发中断 */
async function waitUntilActing(taskId: string, maxMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const steps = await readSteps(taskId)
    if (steps.some((s) => s.type === 'act')) return true
    const t = await getTask(taskId)
    if (t && SETTLED.has(t.status)) return false // 跑太快直接终态了
    await sleep(1500)
  }
  return false
}

/** 轮询至任务进入目标状态（pause/cancel 后的落库有延迟） */
async function waitStatus(taskId: string, want: string, maxMs = 30_000): Promise<string> {
  const deadline = Date.now() + maxMs
  let cur = 'unknown'
  while (Date.now() < deadline) {
    cur = (await getTask(taskId))?.status ?? 'unknown'
    if (cur === want) break
    await sleep(800)
  }
  return cur
}

/** 真投影：deriveConversation → projectConversation（与渲染层同链路） */
async function projectOf(taskId: string) {
  const task = await getTask(taskId)
  const steps = await readSteps(taskId)
  const { deriveConversation } = await import('../src/renderer/store/derive-conversation.js')
  const { listL1 } = await import('../src/main/memory/l1-working.js')
  const memory = await listL1(taskId)
  const items = deriveConversation(task!, steps as never, memory as never)
  return projectConversation({
    taskId,
    items,
    steps: steps as never,
    events: [],
    streamBuffers: {},
    planItems: task?.planItems ?? [],
    viewMode: 'standard',
    showThinking: true,
    ui: { viewMode: 'standard', showThinking: true, blockUiState: {}, turnUiState: {}, scrollAnchorByTask: {} },
    now: Date.now(),
  })
}

interface ProjectionDigest {
  turns: number
  say: string[]
  reasoning: string[]
  tools: string[]
}
function digest(turns: ReturnType<typeof Array>): ProjectionDigest {
  const d: ProjectionDigest = { turns: turns.length, say: [], reasoning: [], tools: [] }
  for (const t of turns as Array<{ steps: Array<{ blocks: Array<Record<string, unknown>> }> }>) {
    for (const st of t.steps) {
      for (const b of st.blocks) {
        const kind = (b as { kind?: string }).kind
        if (kind === 'say' && String((b as { text?: string }).text ?? '').trim())
          d.say.push((b as { text: string }).text)
        else if (kind === 'reasoning' && String((b as { text?: string }).text ?? '').trim())
          d.reasoning.push((b as { text: string }).text)
        else if (kind === 'tool')
          d.tools.push(String((b as { title?: string }).title ?? ''))
      }
    }
  }
  return d
}

/** 终态通用断言（清单收口 + 图封口 + 一致性） */
async function assertSettled(tag: string, taskId: string): Promise<void> {
  const final = await getTask(taskId)
  const status = final?.status ?? 'unknown'
  const graph = final?.graphId ? await loadGraph(final.graphId) : null
  const pItems = final?.planItems ?? []
  if (!SETTLED.has(status)) {
    check(`${tag}：任务收敛到终态`, false, `status=${status}`)
    return
  }
  check(`${tag}：任务到达终态`, true, `status=${status}${final?.errorMessage ? ` ｜ err=${final.errorMessage.slice(0, 80)}` : ''}`)
  if (status === 'failed') {
    check(`${tag}：失败原因用户可见`, Boolean(final?.errorMessage?.trim()), final?.errorMessage?.slice(0, 100) ?? '')
  }
  const nonTerminal = pItems.filter((p) => p.status === 'running' || p.status === 'pending')
  check(
    `${tag}：清单无未收口项（D36）`,
    nonTerminal.length === 0,
    nonTerminal.length ? `未收口: ${nonTerminal.map((p) => `${p.id.slice(-6)}:${p.status}`).join(', ')}` : `${pItems.length} 项全部终态`,
  )
  if (graph) {
    const violation = consistencyViolation(status, graph.status)
    check(`${tag}：图级 status 与任务终态语义一致`, violation === null, violation ?? `graph=${graph.status}`)
    if (status !== 'paused') {
      check(`${tag}：图级 status 已封口（不得停留 in_progress）`, graph.status !== 'in_progress', `graph=${graph.status}`)
    }
  }
}

/* ============================================================
 * S1 + S2 —— 正常执行（交互区全景 + 清单动态变换）
 * ============================================================ */
if (ONLY.includes('S1') || ONLY.includes('S2')) {
  console.log('───────────────────────────────────────────')
  console.log(' S1+S2｜正常执行：交互区全景 + 清单动态变换')
  console.log('───────────────────────────────────────────')
  const task = await createTask({
    title: 'full-S1',
    text: '在工作区根目录创建 notes.md，内容为三行：「计划」「执行」「完成」。然后读取该文件，确认内容无误后用一句话总结。',
    agentId: '@coding',
    modelId: MODEL,
  })

  // S2：运行期轮询清单状态迁移（每 1.2s 采样一次 planItems）
  const transitions: string[] = []
  const seenKeys = new Map<string, string>() // itemId -> 上次状态
  const pollTimer = setInterval(async () => {
    try {
      const t = await getTask(task.id)
      for (const p of t?.planItems ?? []) {
        const prev = seenKeys.get(p.id)
        if (prev && prev !== p.status) transitions.push(`${prev}→${p.status}`)
        seenKeys.set(p.id, p.status)
      }
    } catch {
      /* 轮询期任务尚未落库，忽略 */
    }
  }, 1200)

  const r = await runOnce(task.id, 6 * 60 * 1000)
  clearInterval(pollTimer)
  // 末次采样
  const finalS1 = await getTask(task.id)
  for (const p of finalS1?.planItems ?? []) {
    const prev = seenKeys.get(p.id)
    if (prev && prev !== p.status) transitions.push(`${prev}→${p.status}`)
  }
  console.log(`  ── run 结束（${r.elapsedSec}s）｜task=${r.status}${r.loopErr ? ` ｜ loopErr=${r.loopErr.message.slice(0, 120)}` : ''}`)
  info(`清单迁移序列: ${transitions.length ? transitions.join('  ') : '（未捕捉到状态变化）'}`)

  /* --- S1 断言 --- */
  await assertSettled('S1', task.id)

  const steps = await readSteps(task.id)
  const reasonSteps = steps.filter((s) => s.type === 'reason')
  const actSteps = steps.filter((s) => s.type === 'act')
  info(`steps=${steps.length}（reason ${reasonSteps.length} / act ${actSteps.length}）`)
  check('S1：引擎产生推理步骤', reasonSteps.length > 0, `reason=${reasonSteps.length}`)
  check('S1：产生工具调用（交互区工具通道有料）', actSteps.length > 0, `act=${actSteps.length}: ${actSteps.map((s) => s.toolName).slice(0, 4).join(', ')}`)

  const turns = await projectOf(task.id)
  const d = digest(turns)
  info(`投影: turns=${d.turns} ｜ say=${d.say.length} ｜ reasoning=${d.reasoning.length} ｜ tool=${d.tools.length}`)
  if (d.say.length) info(`正文样例: ${d.say[0].replace(/\s+/g, ' ').slice(0, 80)}`)
  if (d.tools.length) info(`工具样例: ${d.tools[0].slice(0, 80)}`)
  check('S1：交互区「正文」通道可见', d.say.length > 0, `say=${d.say.length}`)
  check('S1：交互区「思考」通道可见', d.reasoning.length > 0, `reasoning=${d.reasoning.length}`)
  check('S1：交互区「工具」通道可见', d.tools.length > 0, `tool=${d.tools.length}`)
  // 交互区不得出现「内部独白当正文」的退化（v0.34.0 实测教训：thought 兜底反噬）
  const monologue = d.say.filter((s) => /^收到用户|^等待用户|暂无具体任务/.test(s.trim()))
  check(
    'S1：正文通道无「内部独白」（收到用户问候类）上屏',
    monologue.length === 0,
    monologue.length ? `疑似独白: ${monologue[0].slice(0, 60)}` : '',
  )

  /* --- S2 断言：清单单调推进 --- */
  console.log('')
  console.log('【S2】清单动态变换')
  const backJumps = transitions.filter((t) => {
    const [from, to] = t.split('→')
    const rank: Record<string, number> = { pending: 0, running: 1, done: 2, failed: 2, cancelled: 2 }
    return (rank[from ?? ''] ?? 0) > (rank[to ?? ''] ?? 0)
  })
  check(
    'S2：清单状态单调推进（无 done→pending 等回跳）',
    backJumps.length === 0,
    backJumps.length ? `回跳: ${backJumps.join(', ')}` : `迁移 ${transitions.length} 次全部单调`,
  )
  const sawRunning = transitions.some((t) => t.endsWith('→running'))
  const sawDone = transitions.some((t) => t.endsWith('→done'))
  if (r.status === 'done') {
    check('S2：观察到 running 迁移（清单随执行实时变化）', sawRunning, sawRunning ? '' : '整个运行期未捕捉到 pending→running（可能是完成太快或采样太疏）')
    check('S2：观察到 done 迁移（清单随执行逐项收口）', sawDone, sawDone ? '' : '未捕捉到 →done 迁移')
    const items = finalS1?.planItems ?? []
    check('S2：终态清单全部 done', items.length > 0 && items.every((p) => p.status === 'done'), items.map((p) => `${p.id.slice(-6)}:${p.status}`).join(', ') || '(空)')
  } else {
    info(`任务终态为 ${r.status}（非 done）→ S2 的 done 迁移断言不适用，以单调性与收口断言为准`)
  }
  console.log('')
}

/* ============================================================
 * S3 —— 暂停 → 恢复（多中断之一）
 * ============================================================ */
if (ONLY.includes('S3')) {
  console.log('───────────────────────────────────────────')
  console.log(' S3｜暂停 → 恢复（多中断）')
  console.log('───────────────────────────────────────────')
  const task = await createTask({
    title: 'full-S3',
    text: '在工作区根目录创建 plan.md 写入「阶段一：调研；阶段二：实现；阶段三：验收」三行，然后读取该文件确认，再创建 done.flag 文件内容为 ok。',
    agentId: '@coding',
    modelId: MODEL,
  })
  const agent = await getAgent((await getTask(task.id))!.agentId)
  const controller = new AbortController()
  void runReActLoop({ task: (await getTask(task.id))!, agent: agent!, modelId: MODEL, signal: controller.signal }).catch(() => {})

  const acting = await waitUntilActing(task.id)
  info(`任务进入执行态（观察到 act 步=${acting}），触发暂停`)
  await pauseTask(task.id)
  const pausedStatus = await waitStatus(task.id, 'paused')
  check('S3：pauseTask 后任务进入 paused', pausedStatus === 'paused', `status=${pausedStatus}`)

  const pausedTask = await getTask(task.id)
  const pausedGraph = pausedTask?.graphId ? await loadGraph(pausedTask.graphId) : null
  check(
    'S3：暂停时图**不封口**（保持 in_progress，可恢复态）',
    !pausedGraph || pausedGraph.status === 'in_progress',
    pausedGraph ? `graph=${pausedGraph.status}` : '无图（tier 0/1）',
  )
  const pausedSteps = await readSteps(task.id)
  info(`暂停时已产出 steps=${pausedSteps.length}`)

  await sleep(2000)
  await resumeTask(task.id)
  const deadline = Date.now() + 5 * 60 * 1000
  let resumed = 'unknown'
  while (Date.now() < deadline) {
    resumed = (await getTask(task.id))?.status ?? 'unknown'
    if (SETTLED.has(resumed)) break
    await sleep(2000)
  }
  info(`恢复后终态: ${resumed}`)
  await assertSettled('S3', task.id)
  const afterSteps = await readSteps(task.id)
  check(
    'S3：恢复后在既有步骤上继续（step 序列增长而非清零重来）',
    afterSteps.length >= pausedSteps.length && afterSteps.length > pausedSteps.length,
    `暂停时 ${pausedSteps.length} → 恢复后 ${afterSteps.length}`,
  )
  const pd = digest(await projectOf(task.id))
  check('S3：恢复完成后交互区仍有完整三通道', pd.say.length > 0 && pd.reasoning.length > 0 && pd.tools.length > 0, `say=${pd.say.length} reasoning=${pd.reasoning.length} tool=${pd.tools.length}`)
  console.log('')
}

/* ============================================================
 * S4 —— 取消（多中断之二）
 * ============================================================ */
if (ONLY.includes('S4')) {
  console.log('───────────────────────────────────────────')
  console.log(' S4｜运行中取消（多中断）')
  console.log('───────────────────────────────────────────')
  const task = await createTask({
    title: 'full-S4',
    text: '在工作区根目录创建 report.md，写入五段文字（每段不少于两句话），然后读取该文件确认，最后创建 summary.txt 摘要。',
    agentId: '@coding',
    modelId: MODEL,
  })
  const agent = await getAgent((await getTask(task.id))!.agentId)
  const controller = new AbortController()
  void runReActLoop({ task: (await getTask(task.id))!, agent: agent!, modelId: MODEL, signal: controller.signal }).catch(() => {})

  const acting = await waitUntilActing(task.id)
  info(`任务进入执行态（act=${acting}），触发取消`)
  await sleep(2000)
  await cancelTask(task.id)
  const cancelledStatus = await waitStatus(task.id, 'cancelled')
  check('S4：cancelTask 后任务进入 cancelled', cancelledStatus === 'cancelled', `status=${cancelledStatus}`)

  const t4 = await getTask(task.id)
  const g4 = t4?.graphId ? await loadGraph(t4.graphId) : null
  check(
    'S4：取消后图级 status 封为 cancelled（不得停留 in_progress）',
    !g4 || g4.status === 'cancelled',
    g4 ? `graph=${g4.status}` : '无图',
  )
  const items4 = t4?.planItems ?? []
  const unfinished = items4.filter((p) => p.status === 'running' || p.status === 'pending')
  check('S4：取消后清单无 pending/running 残留（未完成项被丢弃）', unfinished.length === 0, unfinished.length ? `残留: ${unfinished.map((p) => `${p.id.slice(-6)}:${p.status}`).join(', ')}` : `${items4.length} 项`)
  // 交互区：取消态也要可见（cancelled 步骤/终态指示），且不崩溃
  const d4 = digest(await projectOf(task.id))
  check('S4：取消后交互区投影仍可产出（不崩溃、有内容）', d4.turns > 0, `turns=${d4.turns} say=${d4.say.length} tool=${d4.tools.length}`)
  console.log('')
}

/* ============================================================
 * S5 —— 多任务交错（隔离性）
 * ============================================================ */
if (ONLY.includes('S5')) {
  console.log('───────────────────────────────────────────')
  console.log(' S5｜多任务并发（隔离性）')
  console.log('───────────────────────────────────────────')
  const taskA = await createTask({
    title: 'full-S5A',
    text: '在工作区根目录创建 alpha.txt，内容为「这是任务A的文件」。然后读取该文件确认，再用一句话说明任务A完成。',
    agentId: '@coding',
    modelId: MODEL,
  })
  const taskB = await createTask({
    title: 'full-S5B',
    text: '在工作区根目录创建 beta.txt，内容为「这是任务B的文件」。然后读取该文件确认，再用一句话说明任务B完成。',
    agentId: '@coding',
    modelId: MODEL,
  })

  const runTask = async (taskId: string) => {
    const t = await getTask(taskId)
    const agent = await getAgent(t!.agentId)
    const controller = new AbortController()
    const guard = setTimeout(() => controller.abort(), 7 * 60 * 1000)
    let err: Error | null = null
    try {
      await runReActLoop({ task: t!, agent: agent!, modelId: MODEL, signal: controller.signal })
    } catch (e) {
      err = e as Error
    } finally {
      clearTimeout(guard)
    }
    return err
  }
  const t0 = Date.now()
  const [errA, errB] = await Promise.all([runTask(taskA.id), (async () => { await sleep(2500); return runTask(taskB.id) })()])
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  if (errA) info(`任务A loop 异常: ${errA.message.slice(0, 120)}`)
  if (errB) info(`任务B loop 异常: ${errB.message.slice(0, 120)}`)
  console.log(`  ── 双任务并发结束（${elapsed}s）`)

  await assertSettled('S5-A', taskA.id)
  await assertSettled('S5-B', taskB.id)

  // 隔离性：两任务图独立 + 投影互不串
  const [tA, tB] = [await getTask(taskA.id), await getTask(taskB.id)]
  check('S5：两任务持有各自的 graphId', !!tA?.graphId && !!tB?.graphId && tA.graphId !== tB.graphId, `A=${tA?.graphId?.slice(-8)} B=${tB?.graphId?.slice(-8)}`)
  const dA = digest(await projectOf(taskA.id))
  const dB = digest(await projectOf(taskB.id))
  const blobA = dA.say.join('\n') + dA.tools.join('\n')
  const blobB = dB.say.join('\n') + dB.tools.join('\n')
  check(
    'S5：任务A 的交互区不出现任务B 的内容（跨任务不串扰）',
    !blobB.replace(/任务B/g, '').includes('beta') || !/beta\.txt|任务B的文件/.test(blobA),
    /beta\.txt|任务B的文件/.test(blobA) ? 'A 的投影里出现了 B 的文件' : '',
  )
  check(
    'S5：任务B 的交互区不出现任务A 的内容',
    !/alpha\.txt|任务A的文件/.test(blobB),
    /alpha\.txt|任务A的文件/.test(blobB) ? 'B 的投影里出现了 A 的文件' : '',
  )
  check('S5：任务A 交互区三通道齐全', dA.say.length > 0 && dA.reasoning.length > 0 && dA.tools.length > 0, `say=${dA.say.length} reasoning=${dA.reasoning.length} tool=${dA.tools.length}`)
  check('S5：任务B 交互区三通道齐全', dB.say.length > 0 && dB.reasoning.length > 0 && dB.tools.length > 0, `say=${dB.say.length} reasoning=${dB.reasoning.length} tool=${dB.tools.length}`)
  console.log('')
}

/* ============================================================
 * S6 —— 续聊重开（收口可逆）
 * ============================================================ */
if (ONLY.includes('S6')) {
  console.log('───────────────────────────────────────────')
  console.log(' S6｜续聊重开（终态 → in_progress → 再收口）')
  console.log('───────────────────────────────────────────')
  const task = await createTask({
    title: 'full-S6',
    text: '在工作区根目录创建 log.txt，内容为「第一轮」。然后读取该文件确认内容。',
    agentId: '@coding',
    modelId: MODEL,
  })
  const r6 = await runOnce(task.id, 5 * 60 * 1000)
  info(`第一轮: task=${r6.status}（${r6.elapsedSec}s）`)
  const final6 = await getTask(task.id)
  const graph6 = final6?.graphId ? await loadGraph(final6.graphId) : null
  if (!SETTLED.has(r6.status) || !final6?.graphId) {
    info(`跳过续聊断言：第一轮终态=${r6.status}，graphId=${final6?.graphId ?? '无'}`)
  } else {
    const before = graph6?.status
    await appendUserMessage(task.id, '请在 log.txt 末尾追加一行「第二轮」，然后读取该文件确认两行都在。')
    let sawReopen = false
    let last = 'unknown'
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      const g = await loadGraph(final6.graphId)
      if (g?.status === 'in_progress') sawReopen = true
      last = (await getTask(task.id))?.status ?? 'unknown'
      if (SETTLED.has(last)) break
      await sleep(1500)
    }
    const afterGraph = await loadGraph(final6.graphId)
    const afterTask = await getTask(task.id)
    check('S6：续聊时图从终态重开为 in_progress（收口可逆）', sawReopen, `续聊前 graph=${before}`)
    check('S6：续聊后任务再次收敛', SETTLED.has(last), `task=${last}`)
    const v = consistencyViolation(afterTask?.status ?? 'unknown', afterGraph?.status)
    check('S6：续聊后任务态↔图态仍自洽', v === null, v ?? `task=${afterTask?.status} graph=${afterGraph?.status}`)
    if (afterTask?.status === 'done' && afterGraph) {
      const left = Object.values(afterGraph.nodes).filter((n) => n.layer !== 'goal' && !TERMINAL.has(n.status))
      check('S6：续聊完成时清单无未收口项（D39）', left.length === 0, left.length ? `未收口: ${left.map((n) => `${n.key ?? n.id}:${n.status}`).join(', ')}` : '')
    }
    const d6 = digest(await projectOf(task.id))
    info(`续聊后投影: turns=${d6.turns} say=${d6.say.length} reasoning=${d6.reasoning.length} tool=${d6.tools.length}`)
    check('S6：续聊后的交互区包含两轮内容（不丢历史）', d6.turns >= 2, `turns=${d6.turns}`)
  }
  console.log('')
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
