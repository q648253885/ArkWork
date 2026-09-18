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
  applyProfileSlots,
  type BaseInventory,
  type ComposePanels,
} from '../activator.js'
import { registerSlot, resetProfileSlots, slotStats, resolveSlots } from '../slots.js'
import { BUILTIN_PROFILES, builtinRendererSlotEntries, DEFAULT_PROFILE_ID } from '../builtins.js'
import { SAMPLE_PLUGIN_MANIFESTS } from '../../plugins/sample-plugins.js'
import { BUILTIN_PANEL_REFS } from '../../plugins/registry.js'
import { parseManifest, validateReferences } from '@shared/utils/profile-manifest'
import type {
  PanelSlotPayload,
  ProfileValidationContext,
  SlotKind,
  WorkbenchProfile,
} from '@shared/types/profile'

setVersionResolver(() => '0.32.0')

const INV: BaseInventory = {
  skills: ['S-core.plan', 'S-core.spec'],
  mcpServers: ['mcp-alpha'],
  baseVersion: '0.32.0',
}

/**
 * 引用闭合用的校验上下文（★ v0.34.0）。
 *
 * ⚠️ 与 `PANEL_CTX` **刻意不同**：这里的 skills 是**贫瘠**的，`panels` 只给恒可用内置面板。
 * 理由见 TC-PACT-028..030 —— 只在「最贫瘠的真实环境」下跑，才能测出
 * 「可选插件被关掉后内置台还能不能切过去」。`PANEL_CTX` 那种富库存适合测「正常装配」，
 * 但用它测引用闭合会把缺陷掩盖掉（v0.34.0 实测教训）。
 */
const CTX: ProfileValidationContext = {
  skills: INV.skills,
  mcpServers: INV.mcpServers,
  baseVersion: INV.baseVersion,
}

/**
 * 面板解析上下文（★ v0.33.0）。
 * 把示例插件贡献的面板也放进「库存」—— 适合测**正常装配**（TC-PACT-016..027）：
 * 「测试库存必须覆盖被测对象的引用」，否则测的是「库存不足时的降级」。
 *
 * ⚠️ v0.34.0（D55）：**富库存不能用来测内置台的引用闭合**。
 * 内置台已不再引用插件面板（TC-PACT-028），而富库存会把「用户关掉示例插件」
 * 这个真实情形掩盖掉 —— 相关用例改用 CTX + BUILTIN_PANEL_REFS 的贫瘠库存。
 */
const PANEL_CTX: ComposePanels = (() => {
  const payloads = new Map<string, PanelSlotPayload>()
  for (const m of SAMPLE_PLUGIN_MANIFESTS) {
    // v0.34.1：示例插件改为**多面板**（provides.panels）—— 库存要把每个面板都登记，
    // 否则「富库存」其实比真实环境还贫瘠，装配用例会测出假结果。
    for (const pd of [m.provides.panel, ...(m.provides.panels ?? [])]) {
      if (!pd) continue
      payloads.set(pd.panelRef, {
        panelRef: pd.panelRef,
        title: pd.title,
        icon: pd.icon,
        component: pd.component,
        data: pd.data,
        pluginId: m.id,
        interact: pd.interact,
      })
    }
  }
  const available = new Set<string>([
    'panel:files', 'panel:context', 'panel:terminal', 'panel:browser', 'panel:todos', 'panel:progress',
    'files', 'context', 'terminal', 'browser', 'todos', 'progress',
    ...payloads.keys(),
  ])
  return { payloads, available }
})()

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
  const d1 = registerSlot('ui.panel', {
    id: 'panel:p1',
    kind: 'ui.panel',
    label: 'A',
    payload: { panelRef: 'panel:p1', title: 'A', builtin: true },
  })
  assert.equal(typeof d1, 'function', '注册必须返回 Disposable（可逆是热切换的前提）')
  assert.throws(
    () =>
      registerSlot('ui.panel', {
        id: 'panel:p1',
        kind: 'ui.panel',
        label: 'B',
        payload: { panelRef: 'panel:p1', title: 'B', builtin: true },
      }),
    /已存在 id=panel:p1/,
  )
  d1()
  assert.equal(slotStats()['ui.panel'], 0, 'Disposable 必须真正摘掉这一项')
  resetProfileSlots()
})

test('TC-PACT-006 未知插槽类型 → throw；resolveSlots 按 position 稳定排序', () => {
  resetProfileSlots()
  assert.throws(
    () =>
      registerSlot('ui.none' as SlotKind, {
        id: 'x',
        kind: 'ui.none' as SlotKind,
        label: 'x',
        payload: { actionId: 'x', label: 'x', origin: 'test' },
      }),
    /未知插槽类型/,
  )
  const act = (id: string, position?: number) => ({
    id,
    kind: 'ui.action' as const,
    label: id,
    payload: { actionId: id, label: id, origin: 'test' },
    ...(position !== undefined ? { position } : {}),
  })
  registerSlot('ui.action', act('b', 10))
  registerSlot('ui.action', act('a', 2))
  registerSlot('ui.action', act('c'))
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

test('TC-PACT-008 MCP 未连接 → 降级；panel 能力未安装 → 降级（v0.33.0 改为真解析）', () => {
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
  // v0.32.0 此处恒报「面板在 v1 只登记不挂载」（缺陷 D43）；v0.33.0 起按插件注册表判定
  const panel = degraded.find((d) => d.ref === 'quote')
  assert.ok(panel && panel.layer === 'ui' && panel.blocking === false, `实际：${JSON.stringify(panel)}`)
  assert.ok(panel!.reason.includes('未安装') || panel!.reason.includes('未启用'), panel!.reason)
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
    const { snapshot, degraded, slots } = composeProfile(p, rich, true, PANEL_CTX)
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
    const { snapshot, degraded } = composeProfile(p, empty, true, PANEL_CTX)
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

/* ============================================================
 * ★ v0.33.0 — ui 层扩展（TC-PACT-016..027）
 * 设计文档 docs/versions/v0.33.0/04-system-design.md §6
 * ============================================================ */

test('TC-PACT-016 ui.dockPanels → 产出 ui.panel 条目（id = panelRef，来源 profile）', () => {
  // v0.34.1：原引用 `panel:runtime-metrics`（假数据示例，已下线）→ 改用真实股票插件的面板
  const p = must(mkRaw({ ui: { dockPanels: [{ slot: 'inspector', panelRef: 'panel:stock-quotes', position: 1 }] } }))
  const { slots } = composeProfile(p, INV, true, PANEL_CTX)
  const e = slots.find((s) => s.id === 'panel:stock-quotes')
  assert.ok(e, `必须产出面板条目，实际：${slots.map((s) => s.id).join(',')}`)
  assert.equal(e!.kind, 'ui.panel')
  assert.equal(e!.source, 'profile')
  assert.equal(e!.position, 1)
  const payload = e!.payload as PanelSlotPayload
  assert.equal(payload.component, 'DataTable')
  assert.equal(payload.pluginId, 'ark.plugin.stock', '贡献者必须可追溯')
})

test('TC-PACT-017 panelRef 未命中 → ui 层降级（非阻断）且不产条目', () => {
  const p = must(mkRaw({ ui: { dockPanels: [{ slot: 'inspector', panelRef: 'panel:ghost' }] } }))
  const { slots, degraded } = composeProfile(p, INV, true, PANEL_CTX)
  assert.ok(!slots.some((s) => s.id === 'panel:ghost'), '未命中不得产出条目')
  const d = degraded.find((d) => d.ref === 'ghost')
  assert.ok(d && d.layer === 'ui' && d.blocking === false, JSON.stringify(degraded))
})

test('TC-PACT-018 声明 required 的面板缺失 → 阻断（D43：不再恒降级）', () => {
  const p = must(
    mkRaw({
      capabilities: [{ type: 'panel', ref: 'panel:ghost', required: true }],
      ui: { dockPanels: [{ slot: 'inspector', panelRef: 'panel:ghost' }] },
    }),
  )
  const { degraded } = composeProfile(p, INV, true, PANEL_CTX)
  assert.ok(degraded.some((d) => d.blocking === true && d.layer === 'ui'), JSON.stringify(degraded))
})

test('TC-PACT-019 dockPanels 与 dockTabs 指向同一面板 → 只产一条（去重）', () => {
  const p = must(
    mkRaw({ ui: { dockTabs: ['files', 'context'], dockPanels: [{ slot: 'inspector', panelRef: 'panel:files', position: 0 }] } }),
  )
  const { slots } = composeProfile(p, INV, true, PANEL_CTX)
  assert.equal(slots.filter((s) => s.id === 'panel:files').length, 1)
  assert.equal(slots.filter((s) => s.id === 'panel:context').length, 1)
})

test('TC-PACT-020 ui.theme → 产出 ui.theme 条目 + 快照有应用项', () => {
  const p = must(mkRaw({ ui: { theme: { light: { '--r-lg': '4px' }, dark: { '--r-lg': '4px' } } } }))
  const { slots, snapshot } = composeProfile(p, INV, true)
  const e = slots.find((s) => s.kind === 'ui.theme')
  assert.ok(e, '必须产出 ui.theme 插槽条目')
  const payload = e!.payload as { light: Record<string, string>; dark: Record<string, string> }
  assert.equal(payload.light['--r-lg'], '4px')
  const uiItem = snapshot.layers.ui.find((u) => u.slot === 'ui.theme')
  assert.ok(uiItem && uiItem.applied === true && uiItem.value.includes('--r-lg'))
})

test('TC-PACT-021 ui.previewRenderers → 每个扩展名一条 ui.renderer 条目', () => {
  const p = must(mkRaw({ ui: { previewRenderers: { kchart: 'table', zchart: 'code' } } }))
  const { slots } = composeProfile(p, INV, true)
  const rs = slots.filter((s) => s.kind === 'ui.renderer')
  assert.equal(rs.length, 2)
  assert.ok(rs.every((r) => r.source === 'profile'))
  assert.ok(rs.some((r) => r.id === 'renderer:kchart'))
})

test('TC-PACT-022 ui.actionExtensions 与 composerChips 的 id 不冲突', () => {
  const p = must(mkRaw({ ui: { composerChips: ['继续'], actionExtensions: ['annotate-trend'] } }))
  const { slots } = composeProfile(p, INV, true)
  const acts = slots.filter((s) => s.kind === 'ui.action')
  assert.equal(acts.length, 2)
  const ids = acts.map((a) => a.id)
  assert.equal(new Set(ids).size, ids.length, 'id 不得冲突')
  const ext = acts.find((a) => a.id === 'action:annotate-trend')
  assert.ok(ext && (ext.payload as { origin: string }).origin.startsWith('profile:'))
  const chip = acts.find((a) => a.id === 'action:chip:0')
  assert.ok(chip && (chip.payload as { origin: string }).origin === 'chip')
})

test('TC-PACT-023 装配产出的所有条目 source === profile', () => {
  const p = must(
    mkRaw({
      capabilities: [{ type: 'skill', ref: 'skill:S-core.plan' }],
      ui: {
        dockTabs: ['files'],
        dockPanels: [{ slot: 'inspector', panelRef: 'panel:runtime-metrics' }],
        previewRenderers: { kchart: 'table' },
        actionExtensions: ['x'],
        theme: { light: { '--r-lg': '4px' } },
      },
      automation: [{ cron: '0 9 * * 1-5', taskTemplate: 't' }],
    }),
  )
  const { slots } = composeProfile(p, INV, true, PANEL_CTX)
  const bad = slots.filter((s) => s.source !== 'profile')
  assert.deepEqual(bad.map((b) => `${b.kind}:${b.id}`), [], '来源必须统一标为 profile（D42）')
})

test('TC-PACT-024 内置渲染器登记：8 条 ui.renderer，来源 builtin', () => {
  const entries = builtinRendererSlotEntries()
  assert.equal(entries.length, 8, '7 渲染器 + editor')
  assert.ok(entries.every((e) => e.kind === 'ui.renderer' && e.source === 'builtin'))
  const md = entries.find((e) => e.id === 'renderer:markdown')
  assert.ok(md && (md.payload as { extensions: string[] }).extensions.includes('md'))
  const fb = entries.find((e) => e.id === 'renderer:fallback')
  assert.ok(fb && (fb.payload as { extensions: string[] }).extensions.length === 0, 'fallback 不占扩展名')
})

test('TC-PACT-025 连续两次 applyProfileSlots → 面板条目数不翻倍（按来源清理生效）', () => {
  resetProfileSlots()
  const p = must(mkRaw({ ui: { dockTabs: ['files', 'context'] } }))
  const first = composeProfile(p, INV, true).slots
  applyProfileSlots(first)
  applyProfileSlots(first)
  assert.equal(slotStats()['ui.panel'], 2, `实际：${JSON.stringify(slotStats())}`)
  resetProfileSlots()
})

test('TC-PACT-026 换台后只保留新集合（旧 profile 的条目无残留）', () => {
  resetProfileSlots()
  const a = composeProfile(must(mkRaw({ ui: { dockTabs: ['files'] } })), INV, true).slots
  const b = composeProfile(must(mkRaw({ ui: { dockTabs: ['context', 'browser'] } })), INV, true).slots
  applyProfileSlots(a)
  applyProfileSlots(b)
  const ids = resolveSlots('ui.panel').map((s) => s.id).sort()
  assert.deepEqual(ids, ['panel:browser', 'panel:context'])
  resetProfileSlots()
})

test('TC-PACT-027 ui.homeModule 支持 module:<id> 开放引用（不被闭集拒绝）', () => {
  const p = must(mkRaw({ ui: { homeModule: 'module:market-overview' } }))
  const { slots, snapshot } = composeProfile(p, INV, true)
  const e = slots.find((s) => s.kind === 'ui.homeModule')
  assert.ok(e, '必须产出 ui.homeModule 条目')
  assert.equal((e!.payload as { module: string }).module, 'module:market-overview')
  assert.equal(snapshot.layers.ui.find((u) => u.slot === 'ui.homeModule')?.applied, true)
})

/* ============================================================
 * ★ v0.34.0（D55）—— 内置台不得依赖可选插件（TC-PACT-028..030）
 *
 * 触发事实（真实环境冒烟，非单测推断）：
 *   P4「示例插件改为默认禁用」上线后，内置台 `wb.coding` / `wb.research`
 *   因 `ui.dockPanels` 引用了**示例插件贡献的面板**，在激活入口被 V2 校验
 *   `error` 级拦下 → **整个台切不过去**。离线套件当时全绿，因为夹具的
 *   「库存」把示例插件面板也算成可用（PANEL_CTX 由 SAMPLE_PLUGIN_MANIFESTS 合成）
 *   —— 测试库存比真实环境「更富」，于是掩盖了缺陷。
 *
 * 纪律（本组用例把守）：
 *   ① 内置台只允许引用**恒可用**面板 —— `BUILTIN_PANEL_REFS`（dockTabs 注册表，
 *      不可被用户关闭）。插件贡献的面板一律可由用户在「能力 → 插件」关掉。
 *   ② 因此「插件全禁用」的库存下，内置台的引用闭合必须零 error。
 *   ③ 面板插拔的演示职责移交「能力 → 插件」的示例插件 + 工作台编辑器面板选择器
 *      （用户主动开启后即可勾进任意台），不再由内置台承担。
 *
 * ⚠️ 教训：夹具库存必须能表达「最贫瘠的真实环境」（可选插件全关），
 *    否则测的是理想态而不是线上态。与 D38 的「接线类用例要覆盖真实路径」同源。
 * ============================================================ */

/** 恒可用面板的裸名集（`panel:x` 与 `x` 两种写法都算命中） */
const ALWAYS_AVAILABLE = new Set<string>([
  ...BUILTIN_PANEL_REFS,
  ...BUILTIN_PANEL_REFS.map((r) => r.slice('panel:'.length)),
])

/**
 * 找出内置台里引用了**插件贡献**面板的 ref（恒可用集之外的都算）。
 * 返回空数组 = 合规。抽成函数是为了让 TC-PACT-030 能证明这扇门**会响**。
 */
function pluginBackedPanelRefs(
  profiles: readonly WorkbenchProfile[],
  alwaysAvailable: ReadonlySet<string> = ALWAYS_AVAILABLE,
): string[] {
  const out: string[] = []
  for (const p of profiles) {
    for (const d of p.ui.dockPanels ?? []) {
      if (!alwaysAvailable.has(d.panelRef)) out.push(`${p.id}: ${d.panelRef}`)
    }
  }
  return out
}

test('TC-PACT-028 硬门：内置台 dockPanels 只许引用恒可用面板（禁依赖可选插件）', () => {
  const bad = pluginBackedPanelRefs(BUILTIN_PROFILES)
  assert.deepEqual(
    bad,
    [],
    `内置台不得依赖插件贡献的面板（用户可在「能力 → 插件」关掉它，届时该台切不过去）：\n${bad.join('\n')}\n` +
      '插拔演示请交由示例插件 + 工作台编辑器面板选择器承担。',
  )
  // 反向确认门本身有效：塞一个插件 ref 进去必须被检出（否则上面恒真）
  const victim = BUILTIN_PROFILES[0]!
  const mutated = [
    { ...victim, ui: { ...victim.ui, dockPanels: [{ slot: 'inspector', panelRef: 'panel:runtime-metrics' }] } },
  ] as WorkbenchProfile[]
  assert.deepEqual(
    pluginBackedPanelRefs(mutated),
    [`${victim.id}: panel:runtime-metrics`],
    '门必须能响 —— 不是恒真判据',
  )
})

test('TC-PACT-029 回归门：示例插件全禁用（库存只剩恒可用面板）→ 内置台零 error', () => {
  // 贫瘠库存 = 与真实环境一致：**不含**任何示例插件贡献的面板
  const starved: ProfileValidationContext = { ...CTX, panels: [...BUILTIN_PANEL_REFS] }
  for (const p of BUILTIN_PROFILES) {
    const errs = validateReferences(p, starved).filter((i) => i.level === 'error')
    assert.deepEqual(errs.map((e) => `${e.rule} ${e.path}: ${e.message}`), [], `内置台 ${p.id} 在插件全禁用时被拦下`)
    // 面板相关**连 warning 都不该有**（内置台不该引用非恒可用面板）
    const panelIssues = validateReferences(p, starved).filter((i) => String(i.path).includes('dockPanels'))
    assert.deepEqual(panelIssues, [], `内置台 ${p.id} 出现面板引用问题：${JSON.stringify(panelIssues)}`)
  }
})

test('TC-PACT-030 语义闭环：非恒可用面板未命中 → 非阻断降级（不产条目，不阻断整台）', () => {
  // V2 已由 error 降为 warning（TC-PMF-025），此处在装配侧确认同一语义：
  // 同一情形在 composeProfile 里是「ui 层降级 + blocking:false」。
  // 两层语义必须同向 —— 否则又是「校验说能过、装配说不给挂」或反之。
  const p = must(mkRaw({ ui: { dockPanels: [{ slot: 'inspector', panelRef: 'panel:runtime-metrics', position: 1 }] } }))
  const starvedPanels: ComposePanels = { payloads: new Map(), available: new Set<string>([...BUILTIN_PANEL_REFS]) }
  const { slots, degraded } = composeProfile(p, INV, true, starvedPanels)
  assert.ok(!slots.some((s) => s.id === 'panel:runtime-metrics'), '未命中不得产出条目')
  const d = degraded.find((x) => x.ref === 'runtime-metrics')
  assert.ok(d, `必须进 degraded（不静默半死）：${JSON.stringify(degraded)}`)
  assert.equal(d!.blocking, false, 'dockPanels 缺失一律非阻断')
  const warnings = validateReferences(p, { ...CTX, panels: [...BUILTIN_PANEL_REFS] }).filter((i) => String(i.path).includes('dockPanels'))
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]!.level, 'warning', '校验侧也必须非阻断 —— 与装配侧同向')
})
