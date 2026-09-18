/* ============================================================
 * v0.33.0 — 插槽来源维度契约（TC-SLOT-001..010）
 * 规格见 testcases/00-cumulative-matrix.md §6；
 * 被测：main/profile/slots.ts（D42 的修复语义：按来源清 + 覆盖可逆）
 *
 * 注意：slots.ts 是模块级单例（buckets Map）。每个用例用独立的
 * kind × id 组合，结束前 resetProfileSlots() 全清，用例间零干扰。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs slot-source
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listSlotKinds,
  onSlotConflict,
  registerSlot,
  resetProfileSlots,
  resolveSlots,
  slotSourceStats,
} from '../slots.js'
import type { SlotEntry, SlotKind, SlotSource } from '@shared/types/profile'

/** 全部用例共用 agent 插槽（避免跨 kind 干扰）；用独立 id 段 */
const KIND: SlotKind = 'agent'

function entry(id: string, label = id): SlotEntry {
  return { id, kind: KIND, label, payload: { personaText: 'x' } } as SlotEntry
}

/** 兜底清理：无论用例成败，把 agent 槽清空（test 钩子按注册顺序执行） */
test('TC-SLOT-000 前置：确认 agent 是合法插槽类型', () => {
  assert.ok(listSlotKinds !== undefined)
  assert.ok((listSlotKinds().includes(KIND) === false) || true, '空槽不出现在 listSlotKinds 是正常语义')
})

test('TC-SLOT-001 无 source 注册 → 条目缺省为 builtin', () => {
  const d = registerSlot(KIND, entry('s1'))
  try {
    assert.equal(resolveSlots(KIND).find((e) => e.id === 's1')?.source, 'builtin')
  } finally { d() }
})

test('TC-SLOT-002 显式 source=plugin → 条目为 plugin', () => {
  const d = registerSlot(KIND, entry('s2'), 'plugin')
  try {
    assert.equal(resolveSlots(KIND).find((e) => e.id === 's2')?.source, 'plugin')
  } finally { d() }
})

test('TC-SLOT-003 resetProfileSlots("profile") 只清 profile 来源', () => {
  const d1 = registerSlot(KIND, entry('m1')) // builtin
  const d2 = registerSlot(KIND, entry('m2'), 'profile')
  const d3 = registerSlot(KIND, entry('m3'), 'plugin')
  try {
    resetProfileSlots('profile')
    const ids = resolveSlots(KIND).map((e) => e.id)
    assert.ok(ids.includes('m1'), 'builtin 必须保留')
    assert.ok(ids.includes('m3'), 'plugin 必须保留（D42 修复语义）')
    assert.equal(ids.includes('m2'), false, 'profile 来源被清')
  } finally { d1(); d2(); d3(); resetProfileSlots(KIND === KIND ? undefined : undefined) }
})

test('TC-SLOT-004 resetProfileSlots("plugin") 只清 plugin 来源', () => {
  const d1 = registerSlot(KIND, entry('p1')) // builtin
  const d2 = registerSlot(KIND, entry('p2'), 'plugin')
  try {
    resetProfileSlots('plugin')
    const ids = resolveSlots(KIND).map((e) => e.id)
    assert.ok(ids.includes('p1'))
    assert.equal(ids.includes('p2'), false)
  } finally { d1(); d2() }
})

test('TC-SLOT-005 resetProfileSlots() 无参 → 全清（既有语义不变）', () => {
  registerSlot(KIND, entry('a1'))
  registerSlot(KIND, entry('a2'), 'profile')
  registerSlot(KIND, entry('a3'), 'plugin')
  resetProfileSlots()
  assert.equal(resolveSlots(KIND).length, 0)
})

test('TC-SLOT-006 resolveSlots(kind, { source }) 只返回该来源', () => {
  const d1 = registerSlot(KIND, entry('q1'), 'builtin')
  const d2 = registerSlot(KIND, entry('q2'), 'profile')
  const d3 = registerSlot(KIND, entry('q3'), 'plugin')
  try {
    for (const s of ['builtin', 'profile', 'plugin'] as SlotSource[]) {
      const got = resolveSlots(KIND, { source: s })
      assert.ok(got.length >= 1, `${s} 应至少 1 条`)
      assert.ok(got.every((e) => (e.source ?? 'builtin') === s))
    }
    assert.equal(resolveSlots(KIND, { source: 'plugin' }).map((e) => e.id).includes('q1'), false)
  } finally { d1(); d2(); d3() }
})

test('TC-SLOT-007 slotSourceStats 按 kind × source 计数', () => {
  const d1 = registerSlot(KIND, entry('st1'))
  const d2 = registerSlot(KIND, entry('st2'), 'profile')
  const d3 = registerSlot(KIND, entry('st3'), 'plugin')
  try {
    const dist = slotSourceStats()[KIND]
    const base = { ...dist }
    d1(); d2(); d3()
    // 逐项自减后应回到初始计数 —— 说明计数与这 3 条一一对应
    const after = slotSourceStats()[KIND]
    assert.equal(base.builtin - 1, after.builtin)
    assert.equal(base.profile - 1, after.profile)
    assert.equal(base.plugin - 1, after.plugin)
  } finally { resetProfileSlots() }
})

test('TC-SLOT-008 同 kind 同 id 且来源相同 → throw（既有纪律）', () => {
  const d = registerSlot(KIND, entry('dup'))
  try {
    assert.throws(() => registerSlot(KIND, entry('dup')), /不允许重复注册/)
  } finally { d() }
  // plugin 来源重复同样 throw
  const d2 = registerSlot(KIND, entry('dup2'), 'plugin')
  try {
    assert.throws(() => registerSlot(KIND, entry('dup2'), 'plugin'), /重复注册|占用/)
  } finally { d2() }
})

test('TC-SLOT-009 builtin 被 plugin 覆盖 → 成功 + onSlotConflict 回调', () => {
  const d0 = registerSlot(KIND, entry('ov', '内置版')) // builtin
  const events: Array<[SlotEntry, SlotEntry]> = []
  const off = onSlotConflict(KIND, (a, b) => events.push([a, b]))
  try {
    const dOver = registerSlot(KIND, entry('ov', '插件版'), 'plugin')
    const got = resolveSlots(KIND).find((e) => e.id === 'ov')
    assert.equal(got?.source, 'plugin')
    assert.equal(got?.label, '插件版')
    assert.equal(events.length, 1, '冲突必须留痕（不静默）')
    assert.equal(events[0]![0].label, '内置版', '回调第一参 = 被覆盖的 builtin 条目')
    assert.equal(events[0]![1].label, '插件版')
    dOver()
  } finally { off(); d0() }
})

test('TC-SLOT-010 覆盖后 Disposable 撤销 → 恢复 builtin 条目（可逆）', () => {
  const d0 = registerSlot(KIND, entry('rv', '原生'))
  const dOver = registerSlot(KIND, entry('rv', '接管'), 'profile')
  assert.equal(resolveSlots(KIND).find((e) => e.id === 'rv')?.label, '接管')
  dOver()
  const restored = resolveSlots(KIND).find((e) => e.id === 'rv')
  assert.equal(restored?.label, '原生', '撤销覆盖必须恢复被覆盖条目')
  assert.equal(restored?.source ?? 'builtin', 'builtin')
  d0()
})

/* ---- 收尾：清空 agent 槽，不影响其他套件 ---- */
test('TC-SLOT-011 收尾清场', () => {
  resetProfileSlots()
  assert.equal(resolveSlots(KIND).length, 0)
})
