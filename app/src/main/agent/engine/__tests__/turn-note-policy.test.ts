/* ============================================================
 * v0.38.0 详测 — 阶段结论投递策略（TC-NOTE-001…008）
 *
 * 对应文档：docs/versions/v0.38.0/04-system-design.md §6.5、03-interaction.md §三
 *
 * 为什么这组用例重要（用户原话）：
 *   「现在的内容思考 8 次，然后直接得出最终结果了，应该思考几次后，得出一个结论
 *     或者要做的事情，在交互区显示，然后再继续下一个小任务的思考和处理。」
 *   —— 这正是本模块要治的病：过程零输出。故用例必须同时钉住两件事：
 *     ① **节奏**（几轮该出一次结论）；② **不刷屏**（注入了就清账）。
 *
 * 硬规则：纯函数、叶子模块。本组不碰 IO。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --test src/main/agent/engine/__tests__/turn-note-policy.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceNotePolicy,
  buildPlanCommitNote,
  createNotePolicyState,
  MAX_ROUNDS_WITHOUT_NOTE,
} from '../turn-note-policy.js'
import type { NotePolicyState } from '../turn-note-policy.js'
import type { PlanDiffResult } from '../../ledger/plan-diff.js'
import type { LedgerItemStatus } from '../../ledger/types.js'

/** 最小 PlanDiffResult 夹具 */
function diff(ops: PlanDiffResult['ops'], changed = ops.length): PlanDiffResult {
  return { ops, layout: [], changed, protectedIds: [], warnings: [], summary: '' }
}

function statusOp(text: string, to: LedgerItemStatus) {
  return { kind: 'status' as const, itemId: 'i1', text, from: 'pending' as LedgerItemStatus, to }
}

/* ============================================================
 * 一、节流节奏
 * ============================================================ */

test('TC-NOTE-001 初始状态为 0，且常量真源为 4（改动常量必须同步本用例）', () => {
  assert.equal(createNotePolicyState().roundsSinceNote, 0)
  assert.equal(MAX_ROUNDS_WITHOUT_NOTE, 4)
})

test('TC-NOTE-002 本轮提交了计划 → 计数归零、不注入', () => {
  const s: NotePolicyState = { roundsSinceNote: 3 }
  const r = advanceNotePolicy(s, { plan: true, note: false })
  assert.equal(r.inject, false, '模型已经动过手（提交计划）就不该再被催')
  assert.equal(r.state.roundsSinceNote, 0)
})

test('TC-NOTE-003 本轮投递了结论 → 计数归零、不注入', () => {
  const s: NotePolicyState = { roundsSinceNote: 3 }
  const r = advanceNotePolicy(s, { plan: false, note: true })
  assert.equal(r.inject, false)
  assert.equal(r.state.roundsSinceNote, 0)
})

test('TC-NOTE-004 连续 1~3 轮无输出 → 不注入（不能每轮都打扰）', () => {
  let s = createNotePolicyState()
  for (let i = 1; i <= MAX_ROUNDS_WITHOUT_NOTE - 1; i++) {
    const r = advanceNotePolicy(s, { plan: false, note: false })
    assert.equal(r.inject, false, `第 ${i} 轮不该注入`)
    assert.equal(r.state.roundsSinceNote, i)
    s = r.state
  }
})

test('TC-NOTE-005 ★ 第 4 轮无输出 → 恰好注入一次，且计数随即归零（防刷屏）', () => {
  let s = createNotePolicyState()
  const decisions: boolean[] = []
  for (let i = 0; i < MAX_ROUNDS_WITHOUT_NOTE; i++) {
    const r = advanceNotePolicy(s, { plan: false, note: false })
    decisions.push(r.inject)
    s = r.state
  }
  assert.deepEqual(decisions, [false, false, false, true], '前 3 轮静默、第 4 轮催一次')
  assert.equal(s.roundsSinceNote, 0, '注入后必须清账 —— 否则会变成"从此每轮都催"')
})

test('TC-NOTE-006 注入后重新起算：再静默 3 轮才会再次注入（节奏稳定，不退化）', () => {
  let s = createNotePolicyState()
  for (let i = 0; i < MAX_ROUNDS_WITHOUT_NOTE; i++) s = advanceNotePolicy(s, { plan: false, note: false }).state
  assert.equal(s.roundsSinceNote, 0)

  const again: boolean[] = []
  for (let i = 0; i < MAX_ROUNDS_WITHOUT_NOTE; i++) {
    const r = advanceNotePolicy(s, { plan: false, note: false })
    again.push(r.inject)
    s = r.state
  }
  assert.deepEqual(again, [false, false, false, true])
})

test('TC-NOTE-007 纯函数：不改动入参对象本身', () => {
  const s: NotePolicyState = { roundsSinceNote: 1 }
  advanceNotePolicy(s, { plan: false, note: false })
  assert.equal(s.roundsSinceNote, 1, '入参必须保持不变（调用方靠回写返回值推进）')
})

/* ============================================================
 * 二、自动结论文案（由计划差异生成）
 * ============================================================ */

test('TC-NOTE-008 只有"有项转为 done"才自动出结论；其余情况静默', () => {
  // ① 无变化 → 不投（changed 0 是"已检视"，不是"有进展要汇报"）
  assert.equal(buildPlanCommitNote(diff([], 0)), null)

  // ② 只新增 / 只改 doing → 不投（过程细节，清单面板可见）
  assert.equal(
    buildPlanCommitNote(diff([{ kind: 'create', text: '新项', to: 'pending' }])),
    null,
  )
  assert.equal(buildPlanCommitNote(diff([statusOp('A', 'running')])), null)

  // ③ 有 done 转移 → 投，且文案含项名
  const withDone = buildPlanCommitNote(diff([statusOp('实现投影层', 'done')]))
  assert.ok(withDone)
  assert.match(withDone, /已完成/)
  assert.match(withDone, /实现投影层/)

  // ④ 带 nextDoingText → 追加"接下来…"，让用户知道下一步
  const withNext = buildPlanCommitNote(diff([statusOp('实现投影层', 'done')]), '跑全量测试')
  assert.ok(withNext)
  assert.match(withNext, /接下来/)
  assert.match(withNext, /跑全量测试/)

  // ⑤ 结论是人话：不含内部状态名
  assert.doesNotMatch(withNext, /pending|running|done\b|status/)
})
