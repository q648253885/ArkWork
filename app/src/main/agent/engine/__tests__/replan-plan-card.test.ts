/* ============================================================
 * ArkWork — 重排计划卡（v0.43.1 · TC-PLANCARD，对应 D216）
 *
 * 实机根因（DeepSeek Flash v4.1，任务 T-20261001-2r3063）：交互区唯一的
 * 计划卡是开局 9 项（run-setup 是全仓唯一 plan 步骤发射点）；规划通道重排
 * 9→12 经 commitPlanDraft 落库成功但不发卡 → 投影层数量相等守卫（12≠9）
 * 使旧卡冻结在 0/9，与右侧面板 12/12 完成矛盾。
 *
 * 修复：commitPlanDraft 落库成功且含新建项 → broadcastStep 一条 type:'plan'
 * 步骤（自带 persistStep 持久化 + task:step 实时推送）；纯状态提交不发。
 * 本套件走账本真执行（临时工作区）并直接断言 steps.jsonl 落盘结果。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs replan-plan-card
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, updateTask, getTask } = await import('../../../store/tasks.js')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-v0431-plancard-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

const { ensureLedger, loadLedger } = await import('../../ledger/index.js')
const { commitPlanDraft } = await import('../plan-commit-pipeline.js')
const { listSteps } = await import('../../events.js')
import type { ReActStep } from '@shared/types/react'

/* ---------------- 夹具（同 v043-round-goal-evidence） ---------------- */

async function newTask(texts: string[]): Promise<string> {
  const t = await createTask({
    title: `PLANCARD-${texts.length}`,
    text: texts[0] ?? '任务',
    agentId: 'default',
    modelId: 'm1',
  })
  const now = Date.now()
  await updateTask(t.id, {
    planItems: texts.map((text, i) => ({
      id: `p${i}`,
      text,
      status: i === 0 ? ('running' as const) : ('pending' as const),
      createdAt: now,
      updatedAt: now,
    })),
  })
  await ensureLedger((await getTask(t.id))!)
  return t.id
}

/** 空账本任务（无 planItems 播种）—— 用于「初始建计划兜底」场景 */
async function emptyTask(): Promise<string> {
  const t = await createTask({ title: 'PLANCARD-empty', text: '空任务', agentId: 'default', modelId: 'm1' })
  await ensureLedger((await getTask(t.id))!)
  return t.id
}

async function planStepCount(taskId: string): Promise<number> {
  const steps = (await listSteps(taskId)) as ReActStep[]
  return steps.filter((s) => s.type === 'plan').length
}

async function lastPlanStep(taskId: string): Promise<ReActStep | undefined> {
  const steps = (await listSteps(taskId)) as ReActStep[]
  return steps.filter((s) => s.type === 'plan').at(-1)
}

/* ============================================================ */

test('TC-PLANCARD-001 ★ 真 replan（既有项>0 且含新建项）→ 持久化计划卡：goal=账本目标、items=落库后条目', async () => {
  const id = await newTask(['任务 A', '任务 B'])
  const before = (await loadLedger(id))!
  const ids = before.items.map((it) => it.id)
  assert.equal(await planStepCount(id), 0, '夹具前置：开局无任何 plan 步骤')

  const r = await commitPlanDraft({
    task: { id, graphId: undefined },
    iteration: 5,
    draft: [
      { text: '任务 A', status: 'doing' },
      { text: '任务 B', status: 'doing' },
      { text: '本轮新增 C', status: 'todo' },
    ],
    reason: '依据新证据：需要补做 C',
    source: 'planner',
  })
  assert.ok(r.ok, r.errorMessage)

  const l = (await loadLedger(id))!
  assert.equal(l.round, 2, '前置：该提交构成真 replan（轮次晋升）')

  const step = await lastPlanStep(id)
  assert.ok(step, '真 replan 落库成功后必须广播并持久化一条 plan 步骤（D216）')
  assert.equal(step!.taskId, id)
  assert.equal(step!.iteration, 5)
  assert.equal(step!.status, 'success')
  assert.equal(step!.plan?.goal, l.goal, '计划卡 goal 必须与账本轮次目标同源（与面板标题 R1 同源）')
  assert.deepEqual(step!.plan?.items, l.items.map((it) => it.text), '计划卡条目 = 落库后清单文本')
  assert.equal(step!.plan?.items?.length, 3, '新卡条数与实时 planItems 一致 → 投影层数量守卫天然成立')
  assert.deepEqual(step!.plan?.parentIds, [null, null, null], '无层级时 parentIds 全 null（D209 平铺口径）')
})

test('TC-PLANCARD-002 ★ 负腿：纯状态提交（无新建项）不产生计划卡', async () => {
  const id = await newTask(['任务 A', '任务 B'])
  const ids = (await loadLedger(id))!.items.map((it) => it.id)
  const before = await planStepCount(id)

  const r = await commitPlanDraft({
    task: { id, graphId: undefined },
    iteration: 2,
    draft: [
      { text: '任务 A', status: 'done', artifact: { path: 'out/a.md', kind: 'file' } },
      { text: '任务 B', status: 'doing' },
    ],
    reason: 'A 已完成，产物 out/a.md 已落盘',
    source: 'task-plan',
  })
  assert.ok(r.ok, r.errorMessage)
  assert.equal(await planStepCount(id), before, '纯状态提交不得发卡（计划形态未变，交互区不应出现新卡）')
  assert.ok(ids.length > 0)
})

test('TC-PLANCARD-003 初始建计划兜底（提交前无项 + 含新建项）同样发卡；goal 落首轮目标', async () => {
  const id = await emptyTask()
  assert.equal(await planStepCount(id), 0)

  const r = await commitPlanDraft({
    task: { id, graphId: undefined },
    iteration: 1,
    draft: [
      { text: '第一步', status: 'doing' },
      { text: '第二步', status: 'todo' },
    ],
    reason: '首轮目标：搭好骨架',
    source: 'planner',
  })
  assert.ok(r.ok, r.errorMessage)

  const step = await lastPlanStep(id)
  assert.ok(step, '开局计划兜底路径（plan-ops create / 规划通道首建）也应在交互区有卡')
  assert.equal(step!.plan?.goal, '首轮目标：搭好骨架')
  assert.deepEqual(step!.plan?.items, ['第一步', '第二步'])
})
