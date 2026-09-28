/* ============================================================
 * ArkWork — L3a 收尾巩固用例（v0.36.3 · R3 / stage: l3a-consolidate）
 * 规格来源：docs/versions/v0.36.0/15-v0363-memory-motion-path-design.md §4.2
 *
 * 本组钉住六件缺一不可的事：
 *   ① **三态可分**：跳过（无模型 / 已巩固 / 无有效内容）≠ 成功（+N 条）≠ 失败（抛错）；
 *   ② **失败不写半成品**（本组最重要一条）：LLM 抛错或输出不可解析 → 一个字都不落
 *      暂存区、连幂等标记都不写 —— 长期记忆写脏会被后续每次 run 注入，代价极大；
 *   ③ **幂等**：同一 taskId 只巩固一次，重复收尾不重复调 LLM、不重复灌条目；
 *   ④ **有条数上限**：memory ≤8 / user ≤5，且去重、清洗（空行/前缀/超长）；
 *   ⑤ **走暂存区不直写快照**：产物进 pending，快照文件此刻不动（下次 run 才生效）；
 *   ⑥ **不删证据**：L1/L2 在巩固后原样健在（沿用 v0.25.0 F3 纪律）。
 *
 * LLM 一律**注入**（`complete` 参数）—— 密闭链不许连外网，也不许依赖本机 models.json。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs consolidate
 * ============================================================ */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CONSOLIDATE_LIMITS, consolidateL3a, markerPath } from '../consolidate.js'
import { appendL1, listL1 } from '../l1-working.js'
import { appendL2Memory, listL2Memories } from '../l2-memory.js'
import { listPending } from '../l3-curated.js'
import { agentSpaceDir } from '../agent-space.js'
import { setWorkspaceDir } from '../../store/db.js'

let WS = ''
let TASK = ''
let seq = 0

beforeEach(() => {
  WS = mkdtempSync(join(tmpdir(), 'arkwork-cons-ws-'))
  mkdirSync(join(WS, '.arkwork'), { recursive: true })
  setWorkspaceDir(WS)
  rmSync(agentSpaceDir(), { recursive: true, force: true })
  seq += 1
  TASK = `task-cons-${seq}`
})

after(() => {
  rmSync(agentSpaceDir(), { recursive: true, force: true })
})

/** 注入式 LLM：把固定 JSON 当作模型输出；fail=true 时模拟调用失败 */
function fakeLlm(payload: unknown, opts: { fail?: boolean; raw?: string } = {}) {
  const calls: string[] = []
  const complete = async (req: { system: string; user: string }): Promise<string> => {
    calls.push(req.user)
    if (opts.fail) throw new Error('连接被重置')
    return opts.raw ?? JSON.stringify(payload)
  }
  return { complete, calls }
}

async function seedTask(): Promise<void> {
  await appendL1({ taskId: TASK, role: 'user', kind: 'user_message', content: '把数据清洗一下，注意我喜欢简洁的代码' })
  await appendL1({ taskId: TASK, role: 'assistant', kind: 'observation', content: '已清洗 120 行' })
}

/* ============================================================
 * 一、跳过（条件未命中 → 不该调 LLM，也不该写任何东西）
 * ============================================================ */

test('TC-MEM-001 跳过三态：无模型 / 无有效内容 / 已巩固，都不写盘', async () => {
  // ① 无模型 id（生产里没配模型时的真实路径）
  await seedTask()
  const noModel = await consolidateL3a(TASK, {})
  assert.equal(noModel.skipped, true)
  assert.match(noModel.detail, /无模型 id/)
  assert.equal(existsSync(markerPath(TASK)), false)

  // ② 无有效内容：L1/L2 都空 —— 连 LLM 都不该调
  const empty = fakeLlm({ memory: ['不该被用上'], user: [] })
  const emptyTask = 'task-cons-empty-nonexistent'
  const none = await consolidateL3a(emptyTask, { modelId: 'm1', complete: empty.complete })
  assert.equal(none.skipped, true)
  assert.match(none.detail, /无有效内容/)
  assert.equal(empty.calls.length, 0, '空任务不该白调一次 LLM')
  assert.equal(existsSync(markerPath(emptyTask)), false)

  // ③ 已巩固（幂等标记在）
  mkdirSync(dirname(markerPath(TASK)), { recursive: true })
  writeFileSync(markerPath(TASK), '{"at":"2026-01-01"}', 'utf-8')
  const already = fakeLlm({ memory: ['x'], user: [] })
  const again = await consolidateL3a(TASK, { modelId: 'm1', complete: already.complete })
  assert.equal(again.skipped, true)
  assert.match(again.detail, /已巩固/)
  assert.equal(already.calls.length, 0)
})

/* ============================================================
 * 二、成功路径
 * ============================================================ */

test('TC-MEM-002 成功：提炼结果进暂存区 + 写幂等标记；**不直写快照**（下次 run 才生效）', async () => {
  await seedTask()
  const llm = fakeLlm({
    memory: ['本项目用 pnpm 管理依赖', '测试必须全绿才允许收尾'],
    user: ['偏好简洁优雅的 UI'],
  })
  const r = await consolidateL3a(TASK, { modelId: 'm1', complete: llm.complete })

  assert.equal(r.skipped, undefined)
  assert.deepEqual(r.memoryLines, ['本项目用 pnpm 管理依赖', '测试必须全绿才允许收尾'])
  assert.deepEqual(r.userLines, ['偏好简洁优雅的 UI'])
  assert.match(r.detail, /项目记忆 \+2 条 \/ 用户偏好 \+1 条/)

  // 产物走 pending 通道（口径：冻结快照 + 下次 run 生效）
  const pending = await listPending()
  assert.deepEqual(
    pending.map((p) => [p.targetFile, p.line]).sort(),
    [
      ['memory.md', '本项目用 pnpm 管理依赖'],
      ['memory.md', '测试必须全绿才允许收尾'],
      ['user.md', '偏好简洁优雅的 UI'],
    ].sort(),
  )
  for (const p of pending) assert.equal(p.sourceTaskId, TASK, '条目必须带来源任务（可追溯）')

  // 快照此刻**不该有内容**（只在下次 run 前 applyPending 才合并）
  assert.equal(
    existsSync(join(WS, '.arkwork', 'memory.md')),
    false,
    '巩固只进暂存区；直写快照会让正在跑的这次运行看到中途变化的记忆',
  )
  assert.equal(existsSync(markerPath(TASK)), true, '跑完必须留幂等标记')

  // 送进 LLM 的输入要包含 L1 证据与「既有长期记忆」段落（供去重）
  assert.equal(llm.calls.length, 1)
  assert.match(llm.calls[0], /本任务 L1/)
  assert.match(llm.calls[0], /我喜欢简洁的代码/)
})

/* ============================================================
 * 三、失败不写半成品（本组最重要一条）
 * ============================================================ */

test('TC-MEM-003 ★ LLM 抛错 → 抛错且**零写入**（暂存区空、标记没写、快照没动）', async () => {
  await seedTask()
  const llm = fakeLlm({}, { fail: true })

  await assert.rejects(
    () => consolidateL3a(TASK, { modelId: 'm1', complete: llm.complete }),
    /LLM 提炼失败：连接被重置/,
  )
  assert.deepEqual(await listPending(), [], '失败不得留下半截条目')
  assert.equal(existsSync(markerPath(TASK)), false, '标记也不能写 —— 否则下次再也不会重试')
  assert.equal(existsSync(join(WS, '.arkwork', 'memory.md')), false)
})

test('TC-MEM-003b ★ 输出不是严格 JSON → 抛错且零写入（宁可没巩固，不写垃圾）', async () => {
  await seedTask()
  const llm = fakeLlm({}, { raw: '好的，我总结出两条：一是用 pnpm，二是测试要全绿。' })

  await assert.rejects(() => consolidateL3a(TASK, { modelId: 'm1', complete: llm.complete }), /无法解析/)
  assert.deepEqual(await listPending(), [])
  assert.equal(existsSync(markerPath(TASK)), false)
})

/* ============================================================
 * 四、幂等
 * ============================================================ */

test('TC-MEM-004 幂等：第二次调用直接跳过，不再调 LLM、不重复灌条目', async () => {
  await seedTask()
  const llm = fakeLlm({ memory: ['本项目不用 npm'], user: [] })
  await consolidateL3a(TASK, { modelId: 'm1', complete: llm.complete })
  const second = await consolidateL3a(TASK, { modelId: 'm1', complete: llm.complete })

  assert.equal(second.skipped, true)
  assert.match(second.detail, /已巩固/)
  assert.equal(llm.calls.length, 1, 'LLM 只该被调一次（重跑收尾不重复付费）')
  assert.equal((await listPending()).length, 1, '条目也不该被灌两遍')
})

/* ============================================================
 * 五、条数上限与清洗
 * ============================================================ */

test('TC-MEM-005 条数上限 memory≤8 / user≤5，且去重、去空白、去列表前缀', async () => {
  await seedTask()
  const many = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} 第 ${i} 条`)
  const llm = fakeLlm({
    // 上限是「清洗后取前 N 条」：所以把要被清洗的样例放在前面，不然它会被截掉
    memory: ['规则 第 0 条', '- 用 pnpm 而不是 npm', '  规则 第 0 条  ', '  ', ...many(12, '规则')],
    user: [...many(9, '偏好'), '偏好 第 0 条'],
  })
  const r = await consolidateL3a(TASK, { modelId: 'm1', complete: llm.complete })

  assert.equal(r.memoryLines.length, CONSOLIDATE_LIMITS.memory)
  assert.equal(r.userLines.length, CONSOLIDATE_LIMITS.user)
  assert.equal(r.memoryLines.includes('规则 第 0 条'), true, '同一批内重复项要去重')
  assert.equal(r.memoryLines.filter((l) => l.trim() === '').length, 0, '空白项要丢弃')
  assert.equal(r.memoryLines.includes('用 pnpm 而不是 npm'), true, "列表前缀 '-' 要清洗掉")
  assert.equal(r.memoryLines.some((l) => l.startsWith('-')), false)
})

/* ============================================================
 * 六、不删证据
 * ============================================================ */

test('TC-MEM-006 巩固后 L1/L2 原样健在（蒸馏过不等于删证据）', async () => {
  await seedTask()
  await appendL2Memory(TASK, '清洗 csv 时先做列类型推断，避免整列变字符串', { intent: 'data' })
  const l1Before = (await listL1(TASK)).length
  const l2Before = (await listL2Memories(TASK)).length
  assert.ok(l2Before >= 1, '前置：L2 至少有一条')

  const llm = fakeLlm({ memory: ['本项目用 pnpm'], user: ['先给选项再让用户输入'] })
  await consolidateL3a(TASK, { modelId: 'm1', complete: llm.complete })

  assert.equal((await listL1(TASK)).length, l1Before, 'L1 条目数不得因巩固变化')
  assert.equal((await listL2Memories(TASK)).length, l2Before, 'L2 条目数不得因巩固变化')
})