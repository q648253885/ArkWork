/* ============================================================
 * ArkWork — 子 agent 并行委派用例（v0.36.0 · B7 / F4.1–F4.2）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §3.6
 *
 * 本组钉住的九件缺一不可的事：
 *   ① **并发上限真的是 4**：不是"代码里写了个 4"，而是实测峰值 ≤4 且确实并行；
 *   ② **失败隔离**：一个子任务炸掉不拖垮整批（allSettled 的真实语义）；
 *   ③ **级联取消**：父任务中断 → 每个子任务都进 cancelled，不留孤儿在跑；
 *   ④ **单卡取消**：只中断点名的那一个（cancelled 只影响一个）；
 *   ⑤ **生命周期事件真的落了父会话**：queued → running → 终态，且都带 childTaskId；
 *   ⑥ **校验失败也是"结果"而非异常**：agent 不存在 / 自委派 / 过深 → per-target failed；
 *   ⑦ **白名单继承**：子 agent 的技能集合必须是父 ∪ 子默认（不可越权）；
 *   ⑧ **旧入参形态不破**：{agentId, task} 与 {targets: 单对象} 都要能跑；
 *   ⑨ **摘要优先 task_complete**（父 agent 拿到的是子 agent 的结论，不是它的碎碎念）。
 *
 * 引擎用注入口替换（`__setDelegateEngineForTests`）—— 本组测的是**编排语义**
 * （并发/取消/事件/校验），不是 ReAct 循环本身；真循环由 loop 自己的套件覆盖。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs delegate-parallel
 * ============================================================ */
import { test, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { delegateAgent, __setDelegateEngineForTests, cancelDelegateChild } from '../skills/delegate.js'
import { createTask, updateTaskStatus, resetTaskCollection, getTask } from '../../store/tasks.js'
import { appendL1 } from '../../memory/l1-working.js'
import { setWorkspaceDir } from '../../store/db.js'
import type { Task } from '@shared/types/task'
import type { Agent } from '@shared/types/agent'
import type { SkillContext } from '../registry.js'

let WS = ''
let seq = 0

/** 每次用例独立工作区：L1 集合按 taskId 缓存，复用 id 会串味 */
beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), 'arkwork-dp-ws-'))
  mkdirSync(join(WS, '.arkwork'), { recursive: true })
  setWorkspaceDir(WS)
  resetTaskCollection()
  seq += 1
})

afterEach(() => {
  // v0.37.0（D148）逐用例清工作区：原实现在 `after()` 里只删**最后一个** WS，
  // 而 `beforeEach` 每个用例都建一个新的 —— 每个用例漏一个目录。
  // 实测累积 `arkwork-dp-ws-*` 1301 个，把 TMPDIR 拖慢到让本文件的 5s 门槛抖动
  // （D147）。清理必须在 `afterEach`，不在 `after`。
  if (WS) rmSync(WS, { recursive: true, force: true })
})

after(() => {
  __setDelegateEngineForTests(null)
})

/* ============================================================
 * 引擎假体（并发计量 + 可编排行为）
 * ============================================================ */

interface RunOpts {
  task: Task
  agent: Agent
  modelId: string
  signal: AbortSignal
  maxIterations?: number
}

let active = 0
let peak = 0
/** 每次 run 的入参留档（顺序 = 真实启动顺序，用于白名单/模型断言） */
let runs: RunOpts[] = []
/** 用例自定义行为（缺省：等 20ms；被 abort 则抛错） */
let onRun: ((o: RunOpts) => Promise<void>) | null = null

function installFakeEngine(): void {
  active = 0
  peak = 0
  runs = []
  onRun = null
  __setDelegateEngineForTests(async (o: RunOpts) => {
    active += 1
    peak = Math.max(peak, active)
    runs.push(o)
    try {
      if (onRun) return await onRun(o)
      // 默认行为 = 一个"正常跑完的 ReAct 循环"：等一会儿 → 任务落 done。
      // 不设这个默认值的话，"只关心编排、不关心引擎"的用例会拿到 pending 状态，
      // 被判成失败 —— 那是夹具的错，不是被测量的错。
      await sleep(20)
      if (o.signal.aborted) throw new Error('aborted')
      await updateTaskStatus(o.task.id, 'done')
    } finally {
      active -= 1
    }
  })
}
installFakeEngine()
beforeEach(() => installFakeEngine())

/* ---------- ctx / 目标构造 ---------- */

function makeAgent(id: string, name: string, skills: string[] = []): Agent {
  return {
    id,
    name,
    description: `test agent ${id}`,
    avatarColor: '#123456',
    systemPrompt: `prompt of ${id}`,
    defaultSkillIds: skills,
    defaultMcpIds: [],
    defaultModelId: 'm-test',
    defaultKbIds: [],
    defaultConfig: { maxIterations: 25 } as Agent['defaultConfig'],
    isBuiltin: false,
    version: '0.36.0',
    source: 'custom',
  } as Agent
}

/** 造一个父任务 + 父 ctx（delegate 只读 ctx.taskId / task / agent / signal / parentTaskId） */
async function makeParentCtx(
  over: Partial<SkillContext> = {},
): Promise<{ ctx: SkillContext; task: Task; ctrl: AbortController }> {
  const task = await createTask({
    title: `父任务 ${seq}`,
    text: '父任务输入',
    agentId: '@default',
    skillIds: ['S-parent-only'],
    modelId: 'm-parent',
  })
  const controller = new AbortController()
  const ctx: SkillContext = {
    taskId: task.id,
    signal: controller.signal,
    workspaceDir: WS,
    agent: makeAgent('@default', 'Default'),
    task,
    ...over,
  }
  return { ctx, task, ctrl: controller }
}

/** 父任务 session.jsonl 中的 subagent-progress 事件 */
function subagentEvents(taskId: string): Array<Record<string, unknown>> {
  const p = join(WS, '.arkwork', 'memory', taskId, 'session.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === 'task:subagent-progress')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 确定性等待：轮询直到谓词成立，否则超时报错。
 *
 * 为什么不能用固定 sleep 等「N 个子任务已启动」：本文件与其它测试文件
 * **并行**执行（node --test 多文件并发），负载抖动会让 80ms 这种窗口时灵时不灵 ——
 * 那是用例的时钟假设在赌机器闲暇，不是在测被测对象。D99 的根因即此。
 */
async function waitFor(pred: () => boolean, timeoutMs = 5000, label = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(5)
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）：${label} 始终不成立`)
}

/**
 * 子任务行为：等待 ms 后自然结束；期间被 abort 则立刻抛错（abort 优先）。
 *
 * 入口先查 `signal.aborted` —— addEventListener('abort') **不会补发**已发生的 abort，
 * 若父中断恰好落在"拿到 signal"与"挂监听"之间，只挂监听就会空等满 ms
 * （表现为取消用例慢 5s 才收敛，而不是立即 cancelled）。
 *
 * `also` 是"另一个可以提前放行的信号"（如测试闸门）：它一到就先撤掉定时器，
 * 否则那个长定时器会一直挂在事件循环上吊住整个测试进程（实测单文件从 1.5s 拖到 10.9s）。
 */
const waitOrAbort = (signal: AbortSignal, ms: number, also?: Promise<void>): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(t)
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => finish(() => reject(new Error('aborted')))
    const t = setTimeout(() => finish(resolve), ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (also) void also.then(() => finish(resolve))
  })

/* ============================================================
 * 一、入参形态与结果形状
 * ============================================================ */

test('TC-DP-001 targets 数组：结果条数与入参一致，且按入参顺序返回', async () => {
  onRun = async (o) => {
    // 故意让第一个目标慢、后两个快 —— 用完成顺序反序来证明结果按**入参**序而非完成序
    const delay = o.task.input.text.includes('慢') ? 60 : 10
    await sleep(delay)
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent(
    {
      targets: [
        { agentId: '@coder', objective: '慢任务' },
        { agentId: '@coder', objective: '快任务A' },
        { agentId: '@coder', objective: '快任务B' },
      ],
    },
    ctx,
  )
  assert.equal(r.results.length, 3)
  assert.deepEqual(
    r.results.map((x) => x.objective),
    ['慢任务', '快任务A', '快任务B'],
    '结果必须与入参同序（否则父 agent 会把结论安到别人的任务上）',
  )
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['done', 'done', 'done'],
  )
})

test('TC-DP-002 旧单对象入参 {agentId, task} 自动包裹（存量调用不破）', async () => {
  onRun = async (o) => {
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent({ agentId: '@coder', task: '旧形态目标' } as never, ctx)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0]!.objective, '旧形态目标')
  assert.equal(r.results[0]!.status, 'done')
})

test('TC-DP-003 targets 传单对象（非数组）同样自动包裹', async () => {
  onRun = async (o) => {
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent({ targets: { agentId: '@coder', objective: '单对象' } } as never, ctx)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0]!.objective, '单对象')
})

/* ============================================================
 * 二、并发与失败隔离
 * ============================================================ */

test('TC-DP-004 并发上限 4：6 个目标实测峰值 ≤4 且确实并行（峰值 >1）', async () => {
  // 闸门式测量：子任务进入执行段后停在闸门前，直到「首批全部就位」才放行。
  // 为什么不用"睡 60ms 看重叠"：信号量包住的是含 createTask/emit 落盘的整段前置，
  // 负载抖动下第 5 个可能在第 1 个睡醒之后才进执行段 —— 那样峰值会假性 <4（D99 同型）。
  let opened = false
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((r) => {
    releaseGate = r
  })
  onRun = async (o) => {
    await waitOrAbort(o.signal, 10_000, gate)
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx } = await makeParentCtx()
  const p = delegateAgent(
    {
      targets: Array.from({ length: 6 }, (_, i) => ({ agentId: '@coder', objective: `目标${i}` })),
    },
    ctx,
  )
  let gateErr: unknown = null
  try {
    await waitFor(() => active === 4, 5000, '首批 4 个子任务同时处于执行段')
  } catch (e) {
    gateErr = e
  }
  if (!gateErr) {
    // 观测点即证据：此刻确有 4 个在执行段 ⇒ 峰值必然 ≥4；信号量只放 4 ⇒ 必然 ≤4
    assert.equal(peak, 4, '6 目标 + 上限 4 → 峰值应恰好顶到 4')
    opened = true
    releaseGate()
  } else {
    releaseGate()
  }
  const r = await p
  if (gateErr) throw gateErr
  assert.ok(opened, '闸门应已被打开')
  assert.ok(peak <= 4, `并发峰值必须 ≤4，实测 ${peak}`)
  assert.ok(peak > 1, `必须真的并行（峰值应 >1），实测 ${peak}`)
  assert.equal(r.results.length, 6)
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['done', 'done', 'done', 'done', 'done', 'done'],
  )
})

test('TC-DP-005 失败隔离：一个子任务抛错不影响同批其它子任务', async () => {
  onRun = async (o) => {
    if (o.task.input.text.includes('炸')) throw new Error('子任务内部爆炸')
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent(
    {
      targets: [
        { agentId: '@coder', objective: '会炸的目标' },
        { agentId: '@coder', objective: '正常目标' },
      ],
    },
    ctx,
  )
  assert.equal(r.results[0]!.status, 'failed', '抛错的目标应落 failed')
  assert.equal(r.results[1]!.status, 'done', '另一个目标必须照常完成（失败隔离）')
})

/* ============================================================
 * 三、取消
 * ============================================================ */

test('TC-DP-006 级联取消：父任务中断 → 每个子任务都进 cancelled，不留孤儿', async () => {
  let started = 0
  onRun = async (o) => {
    started += 1
    // 一直等，直到被子任务自己的 signal 中断 —— 模拟真实的"跑到一半被叫停"
    // 窗口给足（10s）：中断由下面的 ctrl.abort() 触发，不靠这个数收尾。
    await waitOrAbort(o.signal, 10_000)
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx, task, ctrl } = await makeParentCtx()
  const p = delegateAgent(
    {
      targets: [
        { agentId: '@coder', objective: '长任务A' },
        { agentId: '@coder', objective: '长任务B' },
      ],
    },
    ctx,
  )
  // 确定性等到两个子任务都进入执行段（证明是并行跑的），再中断
  let gateErr: unknown = null
  try {
    await waitFor(() => started === 2, 5000, '两个子任务都已启动')
  } catch (e) {
    gateErr = e
  }
  ctrl.abort()
  // 无论上面是否超时都必须 await —— 漏 await 会留下在跑的子任务污染后续用例
  const r = await p
  if (gateErr) throw gateErr
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['cancelled', 'cancelled'],
    '父中断后每个子任务都应是 cancelled（不能留在 running）',
  )
  assert.ok(subagentEvents(task.id).length > 0, '取消也要留事件（否则卡片停在运行中态）')
})

test('TC-DP-007 父任务已中断时不建子任务：taskId=null 且 status=cancelled', async () => {
  onRun = async (o) => {
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx, ctrl } = await makeParentCtx()
  ctrl.abort()
  const r = await delegateAgent({ targets: [{ agentId: '@coder', objective: 'x' }] }, ctx)
  assert.equal(r.results[0]!.status, 'cancelled')
  assert.equal(r.results[0]!.taskId, null, '父已中断就不该产生子任务')
  assert.equal(runs.length, 0, '不应调用引擎')
})

test('TC-DP-008 单卡取消：cancelDelegateChild 只中断点名的那一个', async () => {
  // 双窗口设计：被取消者等 10s（必被中断，不靠时间收尾）；
  // 被保留者只等 30ms（自然完成）。取消动作发生在「两者都已启动」之后，
  // 所以"取消一个不影响另一个"是被测语义本身，而不是调度运气。
  onRun = async (o) => {
    const long = o.task.input.text.includes('被取消的')
    await waitOrAbort(o.signal, long ? 10_000 : 30)
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx } = await makeParentCtx()
  const p = delegateAgent(
    {
      targets: [
        { agentId: '@coder', objective: '被取消的' },
        { agentId: '@coder', objective: '被保留的' },
      ],
    },
    ctx,
  )
  let gateErr: unknown = null
  try {
    await waitFor(() => runs.length === 2, 5000, '两个子任务都已进入执行段')
  } catch (e) {
    gateErr = e
  }
  if (!gateErr) {
    const victim = runs.find((o) => o.task.input.text.includes('被取消的'))!.task.id
    assert.equal(cancelDelegateChild(victim), true, '活动中的子任务应可被取消')
  }
  const r = await p
  if (gateErr) throw gateErr
  const byObjective = new Map(r.results.map((x) => [x.objective, x]))
  assert.equal(byObjective.get('被取消的')!.status, 'cancelled')
  assert.equal(byObjective.get('被保留的')!.status, 'done', '取消一个不得影响另一个')
})

test('TC-DP-009 cancelDelegateChild 对不存在/已结束的子任务返回 false（不静默成功）', () => {
  assert.equal(cancelDelegateChild('child-does-not-exist'), false)
})

/* ============================================================
 * 四、校验失败（per-target failed，不 throw 整批）
 * ============================================================ */

test('TC-DP-010 目标 agent 不存在 → per-target failed，不 throw 整批', async () => {
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent(
    {
      targets: [
        { agentId: '@no-such-agent', objective: '找不到人' },
        { agentId: '@coder', objective: '正常' },
      ],
    },
    ctx,
  )
  assert.equal(r.results[0]!.status, 'failed')
  assert.equal(r.results[0]!.taskId, null)
  assert.match(r.results[0]!.summary, /不存在/)
  assert.equal(r.results[1]!.status, 'done', '同批其它目标应照常执行')
})

test('TC-DP-011 自委派（子 agent == 父 agent）→ per-target failed，防死循环', async () => {
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent({ targets: [{ agentId: '@default', objective: '自己派自己' }] }, ctx)
  assert.equal(r.results[0]!.status, 'failed')
  assert.match(r.results[0]!.summary, /不允许委派给自身/)
  assert.equal(runs.length, 0)
})

test('TC-DP-012 防过深：ctx.parentTaskId 存在（说明自己就是子 agent）→ per-target failed', async () => {
  const { ctx } = await makeParentCtx({ parentTaskId: 'some-parent' })
  const r = await delegateAgent({ targets: [{ agentId: '@coder', objective: '再往下派' }] }, ctx)
  assert.equal(r.results[0]!.status, 'failed')
  assert.match(r.results[0]!.summary, /最多 1 层/)
  assert.equal(runs.length, 0)
})

test('TC-DP-013 整批级错误才 throw：空 targets / 全空白 objective / 父任务无 modelId', async () => {
  const { ctx } = await makeParentCtx()
  await assert.rejects(() => delegateAgent({ targets: [] } as never, ctx), /targets 不能为空/)
  await assert.rejects(
    () => delegateAgent({ targets: [{ agentId: '@coder', objective: '   ' }] }, ctx),
    /所有委派目标均缺少任务描述/,
  )
  const noModel = await makeParentCtx()
  const bare: SkillContext = { ...noModel.ctx, task: { ...noModel.task, modelId: '' } }
  await assert.rejects(
    () => delegateAgent({ targets: [{ agentId: '@coder', objective: 'x' }] }, bare),
    /父任务未指定 modelId/,
  )
})

test('TC-DP-014 部分目标 objective 空白 → 只有那一个 failed，其余照跑', async () => {
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent(
    {
      targets: [
        { agentId: '@coder', objective: '' },
        { agentId: '@coder', objective: '有活干' },
      ],
    },
    ctx,
  )
  assert.equal(r.results[0]!.status, 'failed')
  assert.equal(r.results[1]!.status, 'done')
  assert.equal(runs.length, 1, '空白目标不应触发引擎调用')
})

/* ============================================================
 * 五、白名单继承 / 模型继承 / 摘要
 * ============================================================ */

test('TC-DP-015 白名单继承：子任务技能 = 子 agent 默认 ∪ 父任务声明（去重，不可越权）', async () => {
  const { ctx } = await makeParentCtx()
  await delegateAgent({ targets: [{ agentId: '@coder', objective: '看技能集合' }] }, ctx)
  const child = runs[0]!.task
  assert.equal(runs[0]!.agent.id, '@coder', '子任务必须跑在目标 agent 上')
  assert.ok(child.skillIds.includes('S-parent-only'), '必须继承父任务声明的技能（白名单不下放）')
  const parentOnly = ['S-parent-only']
  assert.ok(parentOnly.every((s) => child.skillIds.includes(s)))
  assert.equal(new Set(child.skillIds).size, child.skillIds.length, '不得有重复项')
  assert.equal(child.parentTaskId, ctx.taskId, '子任务必须挂父任务 id（UI 委派链依赖它）')
  assert.equal(runs[0]!.modelId, 'm-parent', '模型继承父任务（当前语义）')
})

test('TC-DP-016 摘要优先 task_complete；无则回落最后一条 reasoning', async () => {
  onRun = async (o) => {
    await appendL1({
      taskId: o.task.id,
      role: 'assistant',
      kind: 'reasoning',
      content: '先看目录，再定位入口。',
      iteration: 1,
    })
    await appendL1({
      taskId: o.task.id,
      role: 'assistant',
      kind: 'reasoning',
      content: '内部碎碎念（不该被当成结论）',
      iteration: 2,
      meta: JSON.stringify({ tool: 'task_complete', args: { summary: '结论：已补全 12 个用例' } }),
    })
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx } = await makeParentCtx()
  const r = await delegateAgent({ targets: [{ agentId: '@coder', objective: '写用例' }] }, ctx)
  assert.equal(r.results[0]!.summary, '结论：已补全 12 个用例', 'task_complete 的 summary 才是结论')
  assert.equal(r.results[0]!.iterations, 2, '迭代次数取 L1 最大 iteration')
  assert.ok(r.results[0]!.durationMs >= 0)
})

/* ============================================================
 * 六、生命周期事件（父会话可观测）
 * ============================================================ */

test('TC-DP-017 生命周期事件：queued → running → 终态，全部落在父会话且带 childTaskId', async () => {
  onRun = async (o) => {
    await updateTaskStatus(o.task.id, 'done')
  }
  const { ctx, task } = await makeParentCtx()
  const r = await delegateAgent({ targets: [{ agentId: '@coder', objective: '跑一下' }] }, ctx)
  const childId = r.results[0]!.taskId!
  const evs = subagentEvents(task.id).filter((e) => e.childTaskId === childId)
  assert.deepEqual(
    evs.map((e) => e.status),
    ['queued', 'running', 'done'],
    '状态序列必须是 queued → running → 终态（渲染层的五态卡直接吃这串）',
  )
  for (const e of evs) {
    assert.equal(e.parentTaskId, task.id)
    assert.equal(e.agentId, '@coder')
    assert.equal(e.modelId, 'm-parent', '事件要带模型（P5 卡的模型徽标）')
    assert.equal(e.objective, '跑一下')
  }
  assert.ok(
    typeof evs[2]!.durationMs === 'number',
    '终态事件必须带耗时（否则卡片只能显示 --:--）',
  )
})

test('TC-DP-018 校验失败也发进度事件：用稳定的 preflight 伪 id 落一条 failed', async () => {
  const { ctx, task } = await makeParentCtx()
  await delegateAgent({ targets: [{ agentId: '@no-such-agent', objective: '找不到人' }] }, ctx)
  const evs = subagentEvents(task.id)
  assert.equal(evs.length, 1, '校验失败必须也留下一条事件（否则卡片上凭空少一行）')
  assert.equal(evs[0]!.status, 'failed')
  assert.equal(evs[0]!.childTaskId, `delegate-preflight-${task.id}-@no-such-agent`)
})

test('TC-DP-019 失败事件的日志级别：渲染层按 failed 判 ERROR（事件本身带得出去）', async () => {
  onRun = async () => {
    throw new Error('boom')
  }
  const { ctx, task } = await makeParentCtx()
  await delegateAgent({ targets: [{ agentId: '@coder', objective: '会失败' }] }, ctx)
  const last = subagentEvents(task.id).at(-1)!
  assert.equal(last.status, 'failed', '失败的子任务终态事件必须是 failed（渲染层据此着色与显示重试）')
})
