/* ============================================================
 * ArkWork — 记忆转化管线用例（v0.36.0 · B4 / F1.2；v0.36.3 增补 L3a 巩固）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §3.2 ·
 *          docs/versions/v0.36.0/15-v0363-memory-motion-path-design.md §4.2
 *
 * 本组钉住七件缺一不可的事：
 *   ① **顺序只有一处真源**：触发点 → 步骤序列（改序必须改这张表）；
 *   ② **跳过 ≠ 失败**：未达门槛是正常跳过（ok:true, skipped:true），
 *      抛错才是失败（ok:false）—— 混为一谈就永远是「静默降级」；
 *   ③ **单步炸不拖垮整条链**：前一步抛错，后续步骤照跑（记忆转化宁可丢一步，
 *      不能丢整条链）；
 *   ④ **可观测**：每跑一次必发 memory_pipeline 事件（落在会话日志里）；
 *   ⑤ **真动作**：task-done 的 L3b 归档与 user-memorize 的 L3a 合并必须真落盘；
 *   ⑥ **v0.36.3 新增环节真接线**：`l3a-consolidate`（收尾巩固）与 `skill-forge`
 *      必须是**真实现**在跑（不是只出现在表里）；
 *   ⑦ **L4 定期写入**：画像按周期（24h / 5 任务 / 首次）合成，未到周期明确跳过。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs memory-pipeline
 * ============================================================ */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PIPELINE_STAGES,
  buildDistillContext,
  isTaskDoneTrigger,
  runMemoryPipeline,
  type PipelineStage,
} from '../pipeline.js'
import { appendL1, listL1 } from '../l1-working.js'
import { addPendingLine } from '../l3-curated.js'
import { L4_CYCLE, evaluateProfileCycle } from '../l4-profile.js'
import { agentSpaceDir, agentSpacePath } from '../agent-space.js'
import { setWorkspaceDir } from '../../store/db.js'

let WS = ''
// ⚠️ 每个用例用**独立 taskId**：l1-working 的 collection 是按 taskId 缓存的（模块级 Map），
// 换个工作区不会换缓存 —— 复用同一 id 会让上一条用例的 L1 条目漏进来（实测：归档数 2 变 3）。
// 这不是产品缺陷（生产里 taskId 本来就唯一），而是测试必须尊重的既有缓存语义。
let TASK = ''
let seq = 0

beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), 'arkwork-mpl-ws-'))
  mkdirSync(join(WS, '.arkwork'), { recursive: true })
  setWorkspaceDir(WS)
  rmSync(agentSpaceDir(), { recursive: true, force: true })
  seq += 1
  TASK = `task-mpl-${seq}`
})

after(() => {
  rmSync(agentSpaceDir(), { recursive: true, force: true })
})

const sessionLog = (): string => join(WS, '.arkwork', 'memory', TASK, 'session.jsonl')
const archiveItems = (): string => join(WS, '.arkwork', 'archive', 'items.jsonl')

const stepOf = (run: { steps: Array<{ stage: PipelineStage; ok: boolean; skipped?: boolean; detail: string }> }, s: PipelineStage) => {
  const x = run.steps.find((y) => y.stage === s)
  assert.ok(x, `管线结果里必须有 ${s} 这一步`)
  return x!
}

/* ============================================================
 * 一、编排表（顺序的唯一真源）
 * ============================================================ */

test('TC-MPL-001 触发点 → 步骤序列恰为设计值（顺序即契约）', () => {
  assert.deepEqual(PIPELINE_STAGES.turn, ['l1-append', 'l2-spill'])
  assert.deepEqual(PIPELINE_STAGES['task-done'], [
    'l3b-archive',
    'l3a-consolidate',
    'l4-synthesize',
    'distill-evaluate',
    'skill-forge',
  ])
  assert.deepEqual(PIPELINE_STAGES['user-memorize'], ['l3a-merge'])
  // 三态互不重叠：一个触发点只干自己那一段，避免「顺手多跑一段」的隐性成本
  const all = Object.values(PIPELINE_STAGES).flat()
  assert.equal(new Set(all).size, all.length, '同一 stage 不得出现在两个触发点里')
})

test('TC-MPL-002 任务终态判定：done/failed/cancelled 都算收尾，running/paused 不算', () => {
  assert.equal(isTaskDoneTrigger('done'), true)
  assert.equal(isTaskDoneTrigger('failed'), true)
  assert.equal(isTaskDoneTrigger('cancelled'), true)
  assert.equal(isTaskDoneTrigger('running'), false)
  assert.equal(isTaskDoneTrigger('paused'), false)
})

/* ============================================================
 * 二、turn：核对而非重复写入
 * ============================================================ */

test('TC-MPL-003 turn：L1 有内容时如实报数；无大结果溢出时报「无溢出」而不是失败', async () => {
  await appendL1({ taskId: TASK, role: 'assistant', kind: 'observation', content: '工具返回 42' })
  const run = await runMemoryPipeline(TASK, 'turn')

  assert.equal(run.ok, true)
  const l1 = stepOf(run, 'l1-append')
  assert.equal(l1.ok, true)
  assert.match(l1.detail, /L1 在册 1 条/)
  const spill = stepOf(run, 'l2-spill')
  assert.equal(spill.ok, true)
  assert.match(spill.detail, /无溢出/)
})

test('TC-MPL-004 turn：该任务还没有 L1 时是**正常跳过**（不是失败，也不是报错）', async () => {
  const run = await runMemoryPipeline('task-empty', 'turn')
  assert.equal(run.ok, true, '空任务不该让管线「失败」')
  const l1 = stepOf(run, 'l1-append')
  assert.equal(l1.skipped, true)
  assert.match(l1.detail, /暂无 L1/)
})

/* ============================================================
 * 三、task-done：真动作 + 跳过语义
 * ============================================================ */

test('TC-MPL-005 task-done（无模型）：L3b 真归档落盘；需 LLM 的四步如实跳过', async () => {
  await appendL1({ taskId: TASK, role: 'user', kind: 'user_message', content: '帮我把数据清洗一下' })
  await appendL1({ taskId: TASK, role: 'assistant', kind: 'observation', content: '已清洗 120 行' })

  const run = await runMemoryPipeline(TASK, 'task-done', { l1Items: await listL1(TASK) })
  assert.equal(run.ok, true)

  const archive = stepOf(run, 'l3b-archive')
  assert.equal(archive.ok, true)
  assert.equal(archive.skipped, undefined, 'L3b 是纯本地动作，不该跳过')
  assert.match(archive.detail, /归档 2 条/)
  assert.equal(existsSync(archiveItems()), true, 'L3b 必须真落盘')
  assert.match(readFileSync(archiveItems(), 'utf-8'), /已清洗 120 行/)

  for (const s of ['l3a-consolidate', 'l4-synthesize', 'distill-evaluate', 'skill-forge'] as const) {
    const st = stepOf(run, s)
    assert.equal(st.ok, true, `${s} 是「跳过」不是「失败」`)
    assert.equal(st.skipped, true, `${s} 无模型时必须明确跳过（不能让用户以为跑过了）`)
    assert.match(st.detail, /无模型 id/)
  }
})

test('TC-MPL-006 全是 system_prompt 时 L3b 跳过（没有可归档的实质内容）', async () => {
  await appendL1({ taskId: TASK, role: 'system', kind: 'system_prompt', content: '你是 ArkWork' })
  const run = await runMemoryPipeline(TASK, 'task-done', { modelId: undefined })
  const archive = stepOf(run, 'l3b-archive')
  assert.equal(archive.skipped, true)
  assert.match(archive.detail, /system_prompt/)
  assert.equal(existsSync(archiveItems()), false, '没有实质内容就不该产生归档文件')
})

/* ============================================================
 * 四、失败隔离（用注入的步骤实现验证，不靠「构造恰好会崩的环境」）
 * ============================================================ */

test('TC-MPL-007 ★ 单步抛错 → 该步记 ok:false，后续步骤照跑（不拖垮整条链）', async () => {
  await appendL1({ taskId: TASK, role: 'assistant', kind: 'observation', content: 'x' })
  const visited: string[] = []
  const run = await runMemoryPipeline(TASK, 'task-done', {
    modelId: 'm1',
    overrides: {
      'l3b-archive': async () => {
        visited.push('l3b')
        throw new Error('磁盘满了')
      },
      'l3a-consolidate': async () => {
        visited.push('consolidate')
        return { detail: '巩固完成' }
      },
      'l4-synthesize': async () => {
        visited.push('l4')
        return { detail: '合成完成' }
      },
      'distill-evaluate': async () => {
        visited.push('distill')
        return { skipped: true, detail: '未达门槛' }
      },
      'skill-forge': async () => {
        visited.push('forge')
        return { detail: '产出技能' }
      },
    },
  })

  assert.deepEqual(
    visited,
    ['l3b', 'consolidate', 'l4', 'distill', 'forge'],
    '前一步炸了，后面四步仍必须执行',
  )
  assert.equal(run.ok, false, '整体结果要如实反映「有步骤失败」')
  const bad = stepOf(run, 'l3b-archive')
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /磁盘满了/)
  assert.equal(stepOf(run, 'skill-forge').ok, true)
})

test('TC-MPL-008 跳过与失败在结果上可分辨（skipped=正常，ok:false=异常）', async () => {
  const run = await runMemoryPipeline(TASK, 'task-done', {
    modelId: 'm1',
    overrides: {
      'l3b-archive': async () => ({ skipped: true, detail: '条件未命中' }),
      'l3a-consolidate': async () => ({ skipped: true, detail: '无有效内容' }),
      'l4-synthesize': async () => {
        throw new Error('boom')
      },
      'distill-evaluate': async () => ({ skipped: true, detail: '未达门槛' }),
      'skill-forge': async () => ({ skipped: true, detail: '无候选' }),
    },
  })
  assert.equal(stepOf(run, 'l3b-archive').ok, true)
  assert.equal(stepOf(run, 'l3b-archive').skipped, true)
  assert.equal(stepOf(run, 'l3a-consolidate').ok, true)
  assert.equal(stepOf(run, 'l3a-consolidate').skipped, true)
  assert.equal(stepOf(run, 'l4-synthesize').ok, false)
  assert.equal(stepOf(run, 'l4-synthesize').skipped, undefined)
})

/* ============================================================
 * 五、user-memorize：L3a 真合并
 * ============================================================ */

test('TC-MPL-009 user-memorize：暂存区为空 → 跳过；有暂存条目 → 真合并（memory.md 落工作区 / user.md 落 Agent 空间）', async () => {
  const empty = await runMemoryPipeline(TASK, 'user-memorize')
  assert.equal(stepOf(empty, 'l3a-merge').skipped, true)

  await addPendingLine('memory.md', '用户要求所有输出都写中文', TASK)
  await addPendingLine('user.md', '偏好简洁优雅的界面', TASK)
  const run = await runMemoryPipeline(TASK, 'user-memorize')
  const merge = stepOf(run, 'l3a-merge')
  assert.equal(merge.ok, true)
  assert.equal(merge.skipped, undefined, '有条目就该真合并')
  assert.match(merge.detail, /已合并 2 条/)

  // ★ v0.36.3 归属：项目记忆落工作区，用户偏好落 Agent 空间
  const memoryFile = join(WS, '.arkwork', 'memory.md')
  assert.equal(existsSync(memoryFile), true, '项目记忆落在工作区（随项目走）')
  assert.match(readFileSync(memoryFile, 'utf-8'), /所有输出都写中文/)
  assert.equal(existsSync(agentSpacePath('user.md')), true, '用户偏好落在 Agent 空间（跨工作区）')
  assert.match(readFileSync(agentSpacePath('user.md'), 'utf-8'), /偏好简洁优雅的界面/)
})

/* ============================================================
 * 六、可观测：每次运行必发一条 memory_pipeline 事件
 * ============================================================ */

test('TC-MPL-010 ★ 每次运行都上报 memory_pipeline 事件（逐步结果落会话日志）', async () => {
  await appendL1({ taskId: TASK, role: 'assistant', kind: 'observation', content: 'y' })
  await runMemoryPipeline(TASK, 'turn')

  assert.equal(existsSync(sessionLog()), true, '事件必须落盘（这是「哪一步没跑到」的唯一取证点）')
  const lines = readFileSync(sessionLog(), 'utf-8').trim().split('\n').filter(Boolean)
  const evt = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'memory_pipeline')
  assert.ok(evt, `会话日志里应有 memory_pipeline 事件（实际类型：${lines.length} 行）`)
  assert.equal(evt.trigger, 'turn')
  assert.deepEqual(evt.steps.map((s: { stage: string }) => s.stage), ['l1-append', 'l2-spill'])
  for (const s of evt.steps) {
    assert.equal(typeof s.ok, 'boolean')
    assert.equal(typeof s.skipped, 'boolean')
    assert.equal(typeof s.detail, 'string')
  }
})

test('TC-MPL-011 全文法：任何触发点的结果都带耗时且步骤可从结果里逐条读出', async () => {
  await appendL1({ taskId: TASK, role: 'assistant', kind: 'observation', content: 'z' })
  for (const trigger of ['turn', 'task-done', 'user-memorize'] as const) {
    const run = await runMemoryPipeline(TASK, trigger)
    assert.equal(run.trigger, trigger)
    assert.deepEqual(
      run.steps.map((s) => s.stage),
      [...PIPELINE_STAGES[trigger]],
      `${trigger} 的实际步骤必须与编排表一致`,
    )
    for (const s of run.steps) {
      assert.equal(typeof s.durationMs, 'number')
      assert.ok(s.detail.length > 0, '每步都要有人话说明（诊断不留空）')
    }
  }
})

/* ============================================================
 * 七、蒸馏上下文（启发式信号）
 * ============================================================ */

test('TC-MPL-012 蒸馏上下文从 L1 提取信号：工具失败后又恢复 / 用户纠偏 / 偏好表达', () => {
  const items = [
    ['user_message', '不对，应该用 pandas 而不是手写循环'],
    ['user_message', '我喜欢简洁的代码'],
    ['observation', 'shell] failed: 命令不存在'],
    ['observation', 'shell] ok'],
  ].map(([kind, content], i) => ({
    id: `m${i}`,
    taskId: TASK,
    layer: 'L1' as const,
    role: 'assistant' as const,
    kind: kind as 'user_message' | 'observation',
    content: content!,
    enabled: true,
    iteration: -1,
    tokens: 1,
    createdAt: i,
    archivedAt: null,
  }))

  const ctx = buildDistillContext(TASK, items)
  assert.equal(ctx.toolCallCount, 2, 'observations 计数')
  assert.equal(ctx.hadErrorRecovery, true, '失败后又成功 = 有恢复过程（值得提炼）')
  assert.equal(ctx.hadUserCorrection, true)
  assert.equal(ctx.hadPreferenceExpression, true)
  assert.equal(ctx.taskId, TASK)
})

test('TC-MPL-013 已归档条目不计入观察数（避免同一份经验被反复蒸馏）', () => {
  const items = [
    { kind: 'observation', content: 'a', archivedAt: null },
    { kind: 'observation', content: 'b', archivedAt: 123 },
  ].map((x, i) => ({
    id: `n${i}`,
    taskId: TASK,
    layer: 'L1' as const,
    role: 'assistant' as const,
    kind: x.kind as 'observation',
    content: x.content,
    enabled: true,
    iteration: -1,
    tokens: 1,
    createdAt: i,
    archivedAt: x.archivedAt,
  }))
  assert.equal(buildDistillContext(TASK, items).toolCallCount, 1)
})

/* ============================================================
 * 八、★ v0.36.3 收尾链路增补：顺序 / L4 周期 / 真接线
 * ============================================================ */

test('TC-MEM-007 收尾顺序即契约：先归档全量证据，再巩固长期记忆，最后才是合成与蒸馏', () => {
  const stages = [...PIPELINE_STAGES['task-done']]
  const idx = (s: PipelineStage): number => stages.indexOf(s)

  assert.ok(idx('l3a-consolidate') >= 0, 'L3a 巩固必须在这条链上（否则长期记忆只靠用户手写）')
  assert.ok(idx('l3b-archive') < idx('l3a-consolidate'), '归档在前：巩固是**有损**的，全量证据必须先落 L3b')
  assert.ok(
    idx('l3a-consolidate') < idx('l4-synthesize'),
    '巩固在合成前：画像合成要读到刚巩固过的项目/用户口径',
  )
  assert.ok(idx('l4-synthesize') < idx('distill-evaluate'), '合成 → 蒸馏 → 炼制的既有顺序不得被插队')
  assert.ok(idx('distill-evaluate') < idx('skill-forge'))
  // 巩固不属于 turn / user-memorize（每轮都提炼会烧钱且污染长期记忆）
  assert.equal(PIPELINE_STAGES.turn.includes('l3a-consolidate'), false)
  assert.equal(PIPELINE_STAGES['user-memorize'].includes('l3a-consolidate'), false)
})

const HOUR = 60 * 60 * 1000

function seedProfile(p: Record<string, unknown>): void {
  mkdirSync(agentSpaceDir(), { recursive: true })
  writeFileSync(
    agentSpacePath('profile.json'),
    JSON.stringify({
      version: 0,
      synthesis: '',
      traits: [],
      observations: [],
      history: [],
      ...p,
    }),
    'utf-8',
  )
}

test('TC-MEM-008 L4 定期写入：首次必合成；未到周期跳过并记账；满 24h 或满 5 个任务再合成', async () => {
  const now = Date.now()

  // ① 从未合成 → 必跑
  const first = await evaluateProfileCycle(now)
  assert.equal(first.run, true)
  assert.match(first.detail, /首次合成/)

  // ② 1 小时前刚合成过 → 跳过，且计数 +1 **落盘**（否则进程重启后永远等不到第 5 个任务）
  seedProfile({ version: 3, lastSynthesizedAt: now - HOUR, tasksSinceSynthesis: 0 })
  const skip = await evaluateProfileCycle(now)
  assert.equal(skip.run, false)
  assert.match(skip.detail, /未到周期（已 1h \/ 已 1 任务）/)
  const persisted = JSON.parse(readFileSync(agentSpacePath('profile.json'), 'utf-8')) as {
    tasksSinceSynthesis: number
  }
  assert.equal(persisted.tasksSinceSynthesis, 1)

  // ③ 攒满 5 个任务 → 跑
  seedProfile({ version: 3, lastSynthesizedAt: now - 2 * HOUR, tasksSinceSynthesis: 4 })
  const byTasks = await evaluateProfileCycle(now)
  assert.equal(byTasks.run, true)
  assert.match(byTasks.detail, /累计 5 个任务/)

  // ④ 距上次 ≥24h → 跑
  seedProfile({ version: 3, lastSynthesizedAt: now - 25 * HOUR, tasksSinceSynthesis: 1 })
  const byTime = await evaluateProfileCycle(now)
  assert.equal(byTime.run, true)
  assert.match(byTime.detail, /≥ 24h/)

  // 阈值口径即导出的常量（免得用例与实现各写一份 magic number）
  assert.equal(L4_CYCLE.ms, 24 * HOUR)
  assert.equal(L4_CYCLE.tasks, 5)
})

test('TC-MEM-009 ★ 收尾链路真接线：l3a-consolidate 与 skill-forge 跑的都是真实现', async () => {
  await appendL1({ taskId: TASK, role: 'user', kind: 'user_message', content: '记住本项目用 pnpm' })

  // 故意给一个**不存在的模型 id**：真实现会去 registry 取 adapter 并如实失败 ——
  // 这恰好证明「链路上跑的是真实现 + 真注册表」，而不是只在该表里出现个名字。
  const run = await runMemoryPipeline(TASK, 'task-done', { modelId: 'model-that-does-not-exist' })

  const cons = stepOf(run, 'l3a-consolidate')
  assert.equal(cons.ok, false, 'LLM 不可用必须如实记失败（不是静默跳过）')
  assert.match(cons.detail, /LLM 提炼失败：.*Model not found/)
  assert.equal(
    existsSync(join(WS, '.arkwork', 'memory.md')),
    false,
    '失败不得写半成品（含标记与暂存条目）',
  )

  const forge = stepOf(run, 'skill-forge')
  assert.equal(forge.skipped, true)
  assert.match(
    forge.detail,
    /阶段 candidate/,
    'skill-forge 必须真被调用（走到阶段 1 才发现没有 L2 证据）',
  )

  // 单步失败不阻断整条链：五步全都有结果
  assert.deepEqual(
    run.steps.map((s) => s.stage),
    [...PIPELINE_STAGES['task-done']],
  )
})
