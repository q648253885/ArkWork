/* ============================================================
 * v0.32.0 — ProfileActivator 装配契约（TC-PACT-001..014）
 * 设计文档 docs/versions/v0.32.0/04-system-design.md §2.5 / §2.10
 *
 * 这里是「插件模式」最硬的四条保证，每条都必须被密闭单测按住：
 *   G1 插槽 id 重复 → **throw**（不做静默覆盖，沿用 keymap/registry 先例）
 *   G3 事务性：校验失败时**仍生效的是上一个** profile
 *   G5 永不静默半死：每一项挂不上的都进 degraded[]，含 layer/ref/reason/blocking
 *   G2 agent persona 有稳定哈希，切换后能追溯「这个任务当时用的人格」
 *
 * ⚠️ 不调用 `probeBaseInventory` / `listSkills`（会扫磁盘） —— 依赖以参数注入，
 *    保持套件密闭。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs profile-activator
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeProfile,
  flattenChain,
  resolveChain,
  setVersionResolver,
  type BaseInventory,
} from '../activator.js'
import { registerSlot, resetProfileSlots, slotStats, resolveSlots } from '../slots.js'
import { parseManifest } from '@shared/utils/profile-manifest'
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID } from '../builtins.js'
import type { SlotKind, WorkbenchProfile } from '@shared/types/profile'

setVersionResolver(() => '0.32.0')

const INV: BaseInventory = {
  skills: ['S-core.plan', 'S-core.spec'],
  mcpServers: ['mcp-alpha'],
  baseVersion: '0.32.0',
}

function must(raw: Record<string, unknown>): WorkbenchProfile {
  const { profile, issues } = parseManifest(raw, 'user')
  assert.ok(profile, `夹具非法：${JSON.stringify(issues)}`)
  return profile
}

function mkRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    id: 'wb.x',
    name: 'X 台',
    version: '1.0.0',
    agents: [{ id: '@x', name: 'X', personaText: 'persona-x' }],
    capabilities: [],
    ui: {},
    data: { memoryNamespace: 'x' },
    automation: [],
    requirements: {},
    ...over,
  }
}

/* ============================================================
 * V3 继承链：环 / 深度 / 父缺失
 * ============================================================ */

test('TC-PACT-001 继承链成环 → V3 error（否则 flatten 会死循环）', () => {
  const a = must(mkRaw({ id: 'wb.a', extends: 'wb.b' }))
  const b = must(mkRaw({ id: 'wb.b', extends: 'wb.a' }))
  const byId = (id: string) => [a, b].find((p) => p.id === id) ?? null
  const r = resolveChain(a, byId)
  assert.ok(r.issues.some((i) => i.rule === 'V3' && i.level === 'error'))
  assert.ok(r.issues.some((i) => i.message.includes('成环')))
  // 链必须在有限步内停下（环被 break 掉，不死递归）
  assert.ok(r.chain.length <= 3)
})

test('TC-PACT-002 继承深度超过上限 → V3 error', () => {
  const g = must(mkRaw({ id: 'wb.g' }))
  const p = must(mkRaw({ id: 'wb.p', extends: 'wb.g' }))
  const c = must(mkRaw({ id: 'wb.c', extends: 'wb.p' }))
  const gg = must(mkRaw({ id: 'wb.gg' }))
  const c2 = must(mkRaw({ id: 'wb.c2', extends: 'wb.gg' }))
  const byId = (id: string) => [g, p, c, gg, c2].find((x) => x.id === id) ?? null
  // g ← p ← c —— 深度 2 合法
  const okRes = resolveChain(c, byId)
  assert.equal(okRes.issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(okRes.issues))
  // 再加一层：gg ← ? 构造 3 跳
  const g2 = must(mkRaw({ id: 'wb.g2', extends: 'wb.g' }))
  const p2 = must(mkRaw({ id: 'wb.p2', extends: 'wb.g2' }))
  const c3 = must(mkRaw({ id: 'wb.c3', extends: 'wb.p2' }))
  const byId2 = (id: string) => [g, g2, p2, c3].find((x) => x.id === id) ?? null
  const deep = resolveChain(c3, byId2)
  assert.ok(
    deep.issues.some((i) => i.rule === 'V3' && i.level === 'error'),
    '超过 MAX_EXTENDS_DEPTH 必须报错',
  )
})

test('TC-PACT-003 父台不存在 → V3 error 且给出明确修复建议', () => {
  const c = must(mkRaw({ id: 'wb.orphan', extends: 'wb.nope' }))
  const r = resolveChain(c, () => null)
  const e = r.issues.find((i) => i.rule === 'V3')
  assert.ok(e && e.level === 'error')
  assert.ok(e.message.includes('wb.nope'))
  assert.ok(e.fix && e.fix.length > 0, '每条 error 都要给人话修复建议')
})

test('TC-PACT-004 flattenChain：父在前逐层被子覆盖，身份取叶子', () => {
  const parent = must(mkRaw({ id: 'wb.p', name: '父', agents: [{ id: '@p', name: 'P', personaText: '父人格' }] }))
  const child = must(mkRaw({ id: 'wb.c', name: '子', extends: 'wb.p', agents: [{ id: '@c', name: 'C', personaText: '子人格' }] }))
  const merged = flattenChain([child, parent])
  assert.equal(merged.id, 'wb.c')
  assert.equal(merged.name, '子')
  assert.deepEqual(merged.agents.map((a) => a.id).sort(), ['@c', '@p'], 'agents 取并集')
})

/* ============================================================
 * G1 插槽：重复 throw / 可逆注册 / 冲突回调
 * ============================================================ */

test('TC-PACT-005 同插槽重复 id → throw（静默覆盖会让「注册了没生效」无法定位）', () => {
  resetProfileSlots()
  const d1 = registerSlot('ui.panel', { id: 'p1', kind: 'ui.panel', label: 'A', payload: {} })
  assert.equal(typeof d1, 'function', '注册必须返回 Disposable（可逆是热切换的前提）')
  assert.throws(
    () => registerSlot('ui.panel', { id: 'p1', kind: 'ui.panel', label: 'B', payload: {} }),
    /已存在 id=p1/,
  )
  d1()
  assert.equal(slotStats()['ui.panel'], 0, 'Disposable 必须真正摘掉这一项')
  resetProfileSlots()
})

test('TC-PACT-006 未知插槽类型 → throw；resolveSlots 按 position 稳定排序', () => {
  resetProfileSlots()
  assert.throws(
    () => registerSlot('ui.none' as SlotKind, { id: 'x', kind: 'ui.none' as SlotKind, label: 'x', payload: {} }),
    /未知插槽类型/,
  )
  registerSlot('ui.action', { id: 'b', kind: 'ui.action', label: 'b', payload: {}, position: 10 })
  registerSlot('ui.action', { id: 'a', kind: 'ui.action', label: 'a', payload: {}, position: 2 })
  registerSlot('ui.action', { id: 'c', kind: 'ui.action', label: 'c', payload: {} })
  assert.deepEqual(resolveSlots('ui.action').map((s) => s.id), ['a', 'b', 'c'], 'position 升序，缺省排最后')
  resetProfileSlots()
})

/* ============================================================
 * G5 降级记账
 * ============================================================ */

test('TC-PACT-007 技能缺失 → tools 层降级；required 决定 blocking', () => {
  const p = must(
    mkRaw({
      capabilities: [
        { type: 'skill', ref: 'skill:S-core.ghost', required: true },
        { type: 'skill', ref: 'skill:S-core.spec' },
      ],
    }),
  )
  const { degraded, snapshot } = composeProfile(p, INV, true)
  const blocking = degraded.find((d) => d.ref === 'S-core.ghost')
  assert.ok(blocking && blocking.blocking === true, 'required 缺失必须阻断')
  assert.equal(blocking.layer, 'tools')
  assert.ok(blocking.reason.length > 0)
  assert.equal(snapshot.layers.tools.find((t) => t.ref === 'S-core.spec')?.found, true)
  assert.equal(snapshot.layers.tools.find((t) => t.ref === 'S-core.ghost')?.found, false)
})

test('TC-PACT-008 MCP 未连接 → 降级；panel 能力 v1 恒降级（登记不挂载）', () => {
  const p = must(
    mkRaw({
      capabilities: [
        { type: 'mcp', ref: 'mcp:mcp-beta' },
        { type: 'panel', ref: 'panel:quote' },
      ],
    }),
  )
  const { degraded } = composeProfile(p, INV, true)
  assert.ok(degraded.some((d) => d.ref === 'mcp-beta' && d.layer === 'tools'))
  const panel = degraded.find((d) => d.ref === 'quote')
  assert.ok(panel && panel.layer === 'ui' && panel.reason.includes('v1'))
})

test('TC-PACT-009 命名空间未就绪 → data 层降级，且快照里 applied=false', () => {
  const p = must(mkRaw())
  const { snapshot, degraded } = composeProfile(p, INV, false)
  assert.ok(degraded.some((d) => d.layer === 'data'))
  assert.ok(snapshot.layers.data.every((d) => d.applied === false), '未就绪就不能标 applied')
})

test('TC-PACT-010 automation v1 只登记不注册（registered=false + 逐条降级）', () => {
  const p = must(mkRaw({ automation: [{ cron: '0 9 * * 1-5', taskTemplate: '晨报', agent: '@x' }] }))
  const { snapshot, degraded } = composeProfile(p, INV, true)
  assert.equal(snapshot.layers.auto.length, 1)
  assert.equal(snapshot.layers.auto[0]!.registered, false, 'v1 绝不偷偷注册定时任务（遗留 L5）')
  assert.ok(degraded.some((d) => d.layer === 'auto'))
})

/* ============================================================
 * G2 persona 哈希 + ui 层投影
 * ============================================================ */

test('TC-PACT-011 persona 哈希稳定：同一 persona 跨会话同值，不同 persona 不同值', () => {
  const a = composeProfile(must(mkRaw({ agents: [{ id: '@x', name: 'X', personaText: '同一段人格' }] })), INV, true)
  const b = composeProfile(must(mkRaw({ agents: [{ id: '@x', name: 'X', personaText: '同一段人格' }] })), INV, true)
  const c = composeProfile(must(mkRaw({ agents: [{ id: '@x', name: 'X', personaText: '另一段人格' }] })), INV, true)
  assert.equal(a.snapshot.layers.agents[0]!.personaHash, b.snapshot.layers.agents[0]!.personaHash)
  assert.notEqual(a.snapshot.layers.agents[0]!.personaHash, c.snapshot.layers.agents[0]!.personaHash)
})

test('TC-PACT-012 ui 层：声明才有 applied=true，未声明的一律 false（不骗 UI）', () => {
  const p = must(mkRaw({ ui: { dockTabs: ['files', 'terminal'], homeModule: 'kb', composerChips: ['继续'] } }))
  const { snapshot } = composeProfile(p, INV, true)
  const dock = snapshot.layers.ui.find((u) => u.slot === 'ui.dockTabs')
  assert.ok(dock && dock.value === 'files,terminal' && dock.applied === true)
  const home = snapshot.layers.ui.find((u) => u.slot === 'ui.homeModule')
  assert.ok(home && home.value === 'kb' && home.applied === true)
  const bare = composeProfile(must(mkRaw()), INV, true).snapshot
  assert.ok(bare.layers.ui.every((u) => u.applied === false))
})

test('TC-PACT-013 插槽产出覆盖五层且 id 唯一（同一次装配可重复注册而不冲突）', () => {
  const p = must(
    mkRaw({
      agents: [{ id: '@x', name: 'X', personaText: 'p' }],
      capabilities: [{ type: 'skill', ref: 'skill:S-core.plan' }],
      ui: { dockTabs: ['files', 'context'], homeModule: 'kb' },
      automation: [{ cron: '0 9 * * 1-5', taskTemplate: 't' }],
    }),
  )
  const { slots } = composeProfile(p, INV, true)
  const ids = slots.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, '同一次装配的插槽 id 必须唯一')
  const kinds = new Set(slots.map((s) => s.kind))
  const required: SlotKind[] = ['agent', 'tool', 'ui.panel', 'ui.homeModule', 'data', 'auto']
  for (const k of required) {
    assert.ok(kinds.has(k), `插槽缺少 ${k}`)
  }
})

/* ============================================================
 * 内置 profile 的整链路可用性
 * ============================================================ */

test('TC-PACT-014 三个内置台都能 compose 成功；底座能力齐备时全部零降级', () => {
  assert.equal(BUILTIN_PROFILES.length, 3)
  const rich: BaseInventory = {
    skills: [
      'S-core.spec',
      'S-core.plan',
      'S-core.bugfix',
      'S-core.grep-search',
      'S-core.web-search',
      'S-core.fetch-url',
      'S-core.kb-search',
      'S-core.react-core-skills',
    ],
    mcpServers: [],
    baseVersion: '0.32.0',
  }
  for (const p of BUILTIN_PROFILES) {
    const { snapshot, degraded, slots } = composeProfile(p, rich, true)
    assert.equal(snapshot.profileId, p.id)
    assert.ok(slots.length > 0, `${p.id} 至少要注册出插槽`)
    // 三台全覆盖：内置台一律内联 personaText + 只用真实存在的 S-core.* 技能
    // （design §2.8 裁决 J2）—— 底座能力齐备时任何一台都不许有降级项，
    // 否则就是「开局即降级」，等于交付一个坏掉的内置台。
    assert.deepEqual(
      degraded,
      [],
      `${p.id} 在能力齐备的底座上必须零降级，实际：${JSON.stringify(degraded)}`,
    )
  }
})

test('TC-PACT-015 底座缺能力时，内置台降级但绝不阻断（required=false 的语义兑现）', () => {
  // 空库存 = 刚装完客户端、技能包还没落地的最坏情况
  const empty: BaseInventory = { skills: [], mcpServers: [], baseVersion: '0.32.0' }
  for (const p of BUILTIN_PROFILES) {
    const { snapshot, degraded } = composeProfile(p, empty, true)
    // 通用台本来就是零依赖 → 空库存下也必须零降级
    if (p.id === DEFAULT_PROFILE_ID) {
      assert.deepEqual(degraded, [], '通用台不依赖任何能力，空库存下仍须零降级')
      assert.ok(snapshot)
      continue
    }
    // 垂直台的缺失只应体现为**非阻断**降级：工作台照常可用，只是少了加速能力。
    // 若这里出现 blocking=true，用户切台会被直接挡在门外 —— 这不是我们想要的语义。
    const blocking = degraded.filter((d) => d.blocking)
    assert.deepEqual(
      blocking,
      [],
      `${p.id} 的能力缺失不得阻断激活，实际阻断项：${JSON.stringify(blocking)}`,
    )
    assert.ok(snapshot.profileId === p.id, '降级后仍必须产出可用快照')
  }
})
