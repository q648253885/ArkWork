/* ============================================================
 * v0.43.0（R4）— 「本轮任务 / 全部任务」分区判据 单测
 *
 * 背景（真值来源：docs/versions/v0.43.0/03-interaction.md §四）：
 *   · 轮次的**唯一真相源是账本**（`file.round` / `item.round`），
 *     而非 `Task.planItems` —— 后者自 v0.37.0 起是派生镜像（不带 round）。
 *   · `行 id ↔ 账本项 id` 在 `plan-sync.ts:reconcileLocked()` 结构对账后**会断链**，
 *     故必须回落到 `key = T-{index+1}` 序号口径（与 applyPlanItemStatusesRobust 同约定）。
 *
 * 用户诉求（本次反馈②）：「下一轮时，以前的任务应该在全部中，不应该在本轮任务中」
 *   → 无法归属的行（历史行）归 `null`，**只进「全部任务」**。
 *
 * 运行（cwd=app）：./node_modules/.bin/tsx --test src/renderer/utils/__tests__/round-filter.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRoundIndex } from '../round-filter.js'

/** 账本快照最小投影：round 3，15 项（T-01…T-15）里 10 项属第 3 轮、5 项属第 2 轮 */
function ledgerFixture() {
  const items = Array.from({ length: 15 }, (_, i) => ({
    id: `led-${i + 1}`,
    round: i < 10 ? 3 : 2,
  }))
  return { round: 3, items }
}

test('TC-ROUND-001 current 以账本 file.round 为准（不取来源项最大值）', () => {
  // 账本 round=3，项里最大轮次也是 3 —— 但若 file.round 更小/更大，也必须以它为准
  const idx = buildRoundIndex({ ledger: { round: 5, items: [{ id: 'a', round: 1 }] } })
  assert.equal(idx.current, 5, '当前轮次必须等于 file.round')
})

test('TC-ROUND-002 id 直查命中 → 返回该账本项轮次', () => {
  const idx = buildRoundIndex({ ledger: ledgerFixture() })
  assert.equal(idx.roundOf({ id: 'led-1' }), 3)
  assert.equal(idx.roundOf({ id: 'led-10' }), 3)
  assert.equal(idx.roundOf({ id: 'led-11' }), 2, '第 11 项起属上一轮')
  assert.equal(idx.roundOf({ id: 'led-15' }), 2)
})

test('TC-ROUND-003 id 断链（对账后节点保留原 id）→ 回落 T-NN 序号命中账本第 NN 项', () => {
  const idx = buildRoundIndex({ ledger: ledgerFixture() })
  // 图节点 id 与账本 id 不同（断链），但 key 由对账按账本顺序重排 → 序号即账本序
  assert.equal(idx.roundOf({ id: 't_stale01', key: 'T-01' }), 3, 'T-01 → 账本第 1 项')
  assert.equal(idx.roundOf({ id: 't_stale11', key: 'T-11' }), 2, 'T-11 → 账本第 11 项（上一轮）')
  assert.equal(idx.roundOf({ id: 't_stale15', key: 'T-15' }), 2)
})

test('TC-ROUND-004 用户诉求②：无法归属的行归 null → 只进「全部任务」，不进「本轮任务」', () => {
  const idx = buildRoundIndex({ ledger: ledgerFixture() })
  assert.equal(idx.roundOf({ id: 'unknown', key: 'T-99' }), null, 'key 越界 → 历史行')
  assert.equal(idx.roundOf({ id: 'unknown', key: 'BAD-KEY' }), null, '非法 key → 历史行')
  assert.equal(idx.roundOf({ id: 'unknown' }), null, '既无 id 命中又无 key → 历史行')
  // 「本轮任务」判据 = roundOf(row) === current；null 恒不等于 current
  assert.notEqual(idx.roundOf({ id: 'unknown' }), idx.current)
})

test('TC-ROUND-005 旧账本项无 round → 归一 1；key 归档同为 1', () => {
  const idx = buildRoundIndex({ ledger: { round: 2, items: [{ id: 'a' }, { id: 'b' }] } })
  assert.equal(idx.roundOf({ id: 'a' }), 1, '缺 round 归一 1')
  assert.equal(idx.roundOf({ id: 'zzz', key: 'T-02' }), 1, 'key 兜底同样归一 1')
  assert.equal(idx.current, 2)
})

test('TC-ROUND-006 账本未就绪（无快照）→ 宽松旧行为：全部行算本轮，避免首帧空列表', () => {
  const idx = buildRoundIndex({})
  assert.equal(idx.current, 1)
  assert.equal(idx.roundOf({ id: 'anything' }), 1)
  assert.equal(idx.roundOf({ id: 'x', key: 'T-99' }), 1, '无账本时不做历史行判定')
})

test('TC-ROUND-007 无账本但有 planItems → 仅 id 直查生效，key 序号兜底**不启用**', () => {
  // planItems 兜底来源的顺序契约不成立（派生镜像顺序 ≠ 账本序），故只认 id
  const planItems = [
    { id: 'p1', round: 2 },
    { id: 'p2', round: 2 },
  ]
  const idx = buildRoundIndex({ planItems })
  assert.equal(idx.current, 2, '无 file.round 时取来源项最大轮次')
  assert.equal(idx.roundOf({ id: 'p1' }), 2)
  assert.equal(idx.roundOf({ id: 'zzz', key: 'T-01' }), null, 'planItems 来源不做 key 兜底 → 历史行')
})

test('TC-ROUND-008 空账本（items 为空）→ 退化为无来源，仍然宽松不空列', () => {
  const idx = buildRoundIndex({ ledger: { round: 3, items: [] } })
  assert.equal(idx.current, 3, 'file.round 仍作为当前轮次')
  assert.equal(idx.roundOf({ id: 'whatever' }), 3, '空账本不裁行 → 避免面板空白')
})

test('TC-ROUND-009 账本优先于 planItems：两者同时存在时以账本为准', () => {
  // planItems 全 round=1（派生镜像不带 round 的真实症状）；账本为 3
  const idx = buildRoundIndex({
    ledger: { round: 3, items: [{ id: 'led-1', round: 3 }] },
    planItems: [{ id: 'led-1', round: 1 }],
  })
  assert.equal(idx.current, 3)
  assert.equal(idx.roundOf({ id: 'led-1' }), 3, '同 id 冲突时账本胜出')
})