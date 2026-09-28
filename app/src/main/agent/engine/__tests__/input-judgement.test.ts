/* ============================================================
 * v0.38.0 详测 — 投递通道分离（TC-INJ-001…007）
 *
 * 对应文档：docs/versions/v0.38.0/04-system-design.md §4.3 / §6.4
 *           docs/versions/v0.38.0/03-interaction.md §三 / §四
 *
 * 本模块（`gate-channel.ts`）存在的唯一理由是 **D153**：
 *   判定与投递写在同一函数里 → 两条语义完全不同的输出共用一条通道 →
 *   门禁指令写进 `appendL1({ role:'user' })` → 模型把它当最后一条用户消息
 *   **复述进了答复正文**，用户看到的是引擎的指令而不是答案。
 *
 * 所以本组用例围绕**三条出口各走各的通道**来写：
 *   ① 给模型的指令 → L1 system（kind: gate_hint / input_judgement）
 *   ② 给用户的通告 → `gate_blocked` 事件（人话，不含内部标记）
 *   ③ 给用户的结论 → `turn_note` 事件（**不写 L1**：输出不是输入）
 *
 * 观测面用的是**真实落盘文件**：L1 → `l1.jsonl`，事件 → `session.jsonl`。
 * 不看内存、不看 mock 调用次数 —— 那只能证明"函数被调了"，证明不了"通道对了"。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/engine/__tests__/input-judgement.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { setWorkspaceDir, getTaskMemoryDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, getTask, updateTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-chan-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const { ensureLedger, mutate } = await import('../../ledger/index.js')
const { injectInputJudgement, emitTurnNote, refuseViaGate } = await import('../gate-channel.js')
const { listL1 } = await import('../../../memory/l1-working.js')

/* ---------------- 夹具 ---------------- */

let n = 0

/** L1 落盘读取（绕过内存，验证"真的写进去了"） */
function l1OnDisk(taskId: string): Array<Record<string, unknown>> {
  const p = join(getTaskMemoryDir(taskId), 'l1.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** 事件落盘读取（emitEvent 的第二条路径就是 session.jsonl） */
function eventsOnDisk(taskId: string): Array<Record<string, unknown>> {
  const p = join(getTaskMemoryDir(taskId), 'session.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function newTaskWithLedger(texts: string[]): Promise<{ id: string; goal: string }> {
  n++
  const t = await createTask({ title: `chan${n}`, text: texts[0] ?? 'x', agentId: 'default', modelId: 'm1' })
  // 账本从 planItems 播种（与 ledger-e2e 同口径）—— 不先写 planItems 会得到空清单
  const now = Date.now()
  await updateTask(t.id, {
    planItems: texts.map((text, i) => ({
      id: `p${i}`,
      text,
      status: i === 0 ? 'running' : 'pending',
      createdAt: now,
      updatedAt: now,
    })),
  })
  const l = await ensureLedger((await getTask(t.id))!)
  return { id: t.id, goal: l.goal }
}

/* ============================================================
 * 一、出口①：新输入判断指令（给模型）
 * ============================================================ */

test('TC-INJ-001 ★ 判断指令走 L1 的 system 通道，绝不是 user_message（D153 同族）', async () => {
  const { id } = await newTaskWithLedger(['项一', '项二'])
  const items = (await ensureLedger((await getTask(id))!)).items

  await injectInputJudgement({ taskId: id, iteration: 2, inputText: '这个工作区是干什么的？', items })

  const injected = l1OnDisk(id).filter((m) => m.kind === 'input_judgement')
  assert.equal(injected.length, 1, '必须恰好注入一条')
  assert.equal(injected[0]!.role, 'system', '写成 user 会在渲染层显示成"用户气泡"，且被模型当用户话复述（D153）')
  assert.equal(injected[0]!.iteration, 2, '必须记住是第几轮注入的')
})

test('TC-INJ-002 指令里带着**用户原输入**（截断 500 字）—— 判断依据是内容，不是"有没有发言"', async () => {
  const { id } = await newTaskWithLedger(['项一'])
  const items = (await ensureLedger((await getTask(id))!)).items

  const short = '这个工作区是什么？'
  await injectInputJudgement({ taskId: id, iteration: 1, inputText: short, items })
  let content = String(l1OnDisk(id).find((m) => m.kind === 'input_judgement')!.content)
  assert.ok(content.includes(short), '原输入必须原样出现在指令里')

  // 超长输入被截断（避免长粘贴淹没上下文）
  const { id: id2 } = await newTaskWithLedger(['项一'])
  const items2 = (await ensureLedger((await getTask(id2))!)).items
  const long = '甲'.repeat(1200)
  await injectInputJudgement({ taskId: id2, iteration: 1, inputText: long, items: items2 })
  content = String(l1OnDisk(id2).find((m) => m.kind === 'input_judgement')!.content)
  assert.ok(!content.includes(long), '1200 字输入不得整段注入')
  assert.ok(content.includes('甲'.repeat(500)), '保留前 500 字')
  assert.match(content, /…/, '截断必须留可见标记（静默丢内容会让模型误判范围）')
})

test('TC-INJ-003 指令里带着**当前清单快照**（项文本 + 对外 5 态）', async () => {
  const { id } = await newTaskWithLedger(['搭骨架', '写核心逻辑'])
  const l = await ensureLedger((await getTask(id))!)
  await mutate(id, { kind: 'set-status', itemId: l.items[0]!.id, to: 'done', source: 'task-plan', force: true })
  const items = (await ensureLedger((await getTask(id))!)).items

  await injectInputJudgement({ taskId: id, iteration: 3, inputText: '再帮我看看文档', items })
  const content = String(l1OnDisk(id).find((m) => m.kind === 'input_judgement')!.content)

  assert.ok(content.includes('搭骨架'), '快照必须列出项文本')
  assert.ok(content.includes('写核心逻辑'))
  assert.match(content, /done/, '对外态用于快照（模型侧词表 5 态）')
  assert.doesNotMatch(content, /running/, '不得把内部 9 态原样倒给模型（认知负担与对外词表成正比）')
})

test('TC-INJ-004 指令必须写清「判断依据」并禁止复述 —— 否则模型会把引擎的话当任务', async () => {
  const { id } = await newTaskWithLedger(['项一'])
  const items = (await ensureLedger((await getTask(id))!)).items
  await injectInputJudgement({ taskId: id, iteration: 1, inputText: '这是个只读问题', items })
  const content = String(l1OnDisk(id).find((m) => m.kind === 'input_judgement')!.content)

  // 两条关键约束（语言无关：中英双版都必须含其一）
  assert.match(content, /请勿复述|DO NOT REPEAT/, '必须禁止复述')
  assert.match(content, /需要跟踪的工作|work worth tracking/, '判断依据必须显式声明为"是否产生需跟踪的工作"')
  assert.match(content, /task_plan/, '必须指明动作入口（唯一控制面）')
  assert.match(content, /turn_note/, '必须指明结论出口')
})

/* ============================================================
 * 二、出口③：阶段结论（给用户，**不写 L1**）
 * ============================================================ */

test('TC-INJ-005 ★ 阶段结论只投放给用户：写事件、**不写 L1**（输出不是输入）', async () => {
  const { id } = await newTaskWithLedger(['项一'])
  const before = l1OnDisk(id).length

  await emitTurnNote({ taskId: id, iteration: 4, text: '已确认投影层是唯一入口，下一步补用例。', via: 'plan-commit' })

  const events = eventsOnDisk(id).filter((e) => e.type === 'turn_note')
  assert.equal(events.length, 1, '结论必须落事件（渲染层据此成块）')
  assert.equal(events[0]!.via, 'plan-commit')
  assert.equal(events[0]!.taskId, id, '事件自带 taskId（渲染层按任务分桶）')
  assert.equal(l1OnDisk(id).length, before, 'turn_note **不得**进 L1 —— 否则会被当成模型上下文，重复膨胀')
})

test('TC-INJ-006 空文本结论不投递（trim 后为空即返回，不产空卡片）', async () => {
  const { id } = await newTaskWithLedger(['项一'])
  await emitTurnNote({ taskId: id, iteration: 1, text: '   \n  ', via: 'model' })
  assert.equal(eventsOnDisk(id).filter((e) => e.type === 'turn_note').length, 0)
})

/* ============================================================
 * 三、出口①②一次成型：门禁拒绝的两条通道互不污染
 * ============================================================ */

test('TC-INJ-007 ★ refuseViaGate 一次调用同时投两条通道，且用户通告不含内部标记', async () => {
  const { id } = await newTaskWithLedger(['项一'])
  const l1Before = l1OnDisk(id).length

  await refuseViaGate({
    taskId: id,
    iteration: 5,
    code: 'TREE_SYNC',
    message: '本次执行有实质动作（写文件 / 执行命令），但全程未更新任务清单。',
    refusals: 1,
  })

  // ① 给模型的控制指令
  const hints = l1OnDisk(id).filter((m) => m.kind === 'gate_hint')
  assert.equal(hints.length, 1, '指令必须进 L1（system 通道）')
  assert.equal(hints[0]!.role, 'system')
  const instruction = String(hints[0]!.content)
  assert.match(instruction, /请勿复述|DO NOT REPEAT/)
  assert.match(instruction, /task_plan/)

  // ② 给用户的通告（另一个通道，另一个文件）
  const gates = eventsOnDisk(id).filter((e) => e.type === 'gate_blocked')
  assert.equal(gates.length, 1)
  const notice = String(gates[0]!.text)
  assert.equal(gates[0]!.code, 'TREE_SYNC')
  assert.equal(gates[0]!.refusals, 1)
  assert.equal(gates[0]!.max, 3)

  // ★ 关键：通告不得复述指令原文（否则用户看到的是引擎的内部话术）
  assert.doesNotMatch(notice, /请勿复述|DO NOT REPEAT|INTERNAL INSTRUCTION/)
  assert.doesNotMatch(notice, /\[tree-sync-required\]|\[unfinished-plan\]/)
  assert.doesNotMatch(notice, /内部指令/)
  assert.notEqual(notice, instruction, '两条通道的文案必须不同 —— 同一条文案就是 D153 的复发')

  // 一次调用把两条都投出去（漏任一侧都会让用户/模型缺信息）
  assert.ok(l1OnDisk(id).length > l1Before)
})
