/* ============================================================
 * v0.32.0 — Workbench Profile manifest 纯函数契约
 * 用例编号 TC-PMF-001..018（见 testcases/00-cumulative-matrix.md §3.19）
 *
 * 覆盖：V1 结构校验 / V2 引用闭合 / V3 继承链（环 + 深度）/ V4 内部闭合 /
 *       V5 冲突去重 / V6 底座版本 / 单继承合并 / 快照 diff / 摘要
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs profile-manifest
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_EXTENDS_DEPTH,
  diffSnapshots,
  meetsMinVersion,
  mergeProfile,
  parseManifest,
  parseSemver,
  refResolves,
  refTail,
  stableHash,
  summarize,
  validateReferences,
  type ParseResult,
} from '../profile-manifest.js'
import type { ProfileValidationContext, WorkbenchProfile } from '@shared/types/profile'
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID, RAW_BUILTIN_MANIFESTS } from '../../../main/profile/builtins.js'

/* ---------- 夹具 ---------- */

const CTX: ProfileValidationContext = {
  skills: ['S-core.plan', 'S-core.spec', 'S-core.web-search'],
  mcpServers: ['mcp-alpha'],
  baseVersion: '0.32.0',
}

function baseRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    id: 'wb.test',
    name: '测试台',
    version: '1.0.0',
    agents: [{ id: '@tester', name: '测试员', personaText: '你是一个测试员。' }],
    capabilities: [],
    ui: {},
    data: { memoryNamespace: 'test' },
    automation: [],
    requirements: {},
    ...over,
  }
}

function must(raw: Record<string, unknown>): WorkbenchProfile {
  const r: ParseResult = parseManifest(raw, 'user')
  assert.equal(r.issues.filter((i) => i.level === 'error').length, 0, `不应有 error：${JSON.stringify(r.issues)}`)
  assert.ok(r.profile)
  return r.profile
}

/* ============================================================
 * V1 结构校验
 * ============================================================ */

test('TC-PMF-001 缺 schemaVersion → warning 而非 error（向前兼容，不阻断导入）', () => {
  const raw = baseRaw()
  delete raw.schemaVersion
  const r = parseManifest(raw, 'user')
  const v1 = r.issues.find((i) => i.rule === 'V1' && i.path === '$.schemaVersion')
  assert.ok(v1)
  assert.equal(v1.level, 'warning')
  assert.ok(r.profile, '缺 schemaVersion 仍应产出可用 profile')
})

test('TC-PMF-002 schemaVersion 不匹配 → error（宁可阻断也不静默误读）', () => {
  const r = parseManifest(baseRaw({ schemaVersion: '2.0' }), 'user')
  const errs = r.issues.filter((i) => i.level === 'error')
  assert.ok(errs.some((i) => i.path === '$.schemaVersion'))
  assert.equal(r.profile, null)
})

test('TC-PMF-003 id 必须满足「命名空间.名称」；非法即 error', () => {
  for (const bad of ['wb', 'Wb.Coding', 'wb.coding.x.y', 'wb_coding']) {
    const r = parseManifest(baseRaw({ id: bad }), 'user')
    assert.ok(
      r.issues.some((i) => i.level === 'error' && i.path === '$.id'),
      `${bad} 应被判非法`,
    )
  }
  const okp = parseManifest(baseRaw({ id: 'acme.stock-cn' }), 'user')
  assert.ok(okp.profile, 'acme.stock-cn 应合法')
})

test('TC-PMF-004 agent id 必须以 @ 开头', () => {
  const r = parseManifest(baseRaw({ agents: [{ id: 'coder', name: '工程师' }] }), 'user')
  assert.ok(r.issues.some((i) => i.level === 'error' && i.path === '$.agents[0].id'))
})

test('TC-PMF-005 data.memoryNamespace 必填且限字符集（同时阻断路径穿越）', () => {
  assert.ok(parseManifest(baseRaw({ data: {} }), 'user').issues.some((i) => i.level === 'error'))
  for (const bad of ['../etc', '中文ns', 'a b']) {
    const r = parseManifest(baseRaw({ data: { memoryNamespace: bad } }), 'user')
    assert.ok(r.issues.some((i) => i.level === 'error' && i.path === '$.data.memoryNamespace'), bad)
  }
})

test('TC-PMF-006 ui.dockTabs 取值越界 → error（D4：不许拿未知面板 id 静默失败）', () => {
  const r = parseManifest(baseRaw({ ui: { dockTabs: ['files', 'stock-quote'] } }), 'user')
  const issue = r.issues.find((i) => i.path === '$.ui.dockTabs')
  assert.ok(issue && issue.level === 'error')
  assert.ok(issue.message.includes('stock-quote'))
})

test('TC-PMF-007 ui.homeModule 结构放宽：解析期只校验类型，取值交由引用期（V1/V2 分工）', () => {
  // v0.33.0 起 homeModule 从「闭集白名单」放宽为 string：内置名 或 'module:<id>'。
  // 分工纪律：V1 只管「是不是非空字符串」，取值合法性一律由 V2 判定 ——
  // 否则插件模块永远无法被 profile 引用（闭集天然排斥外部贡献）。
  const widened = parseManifest(baseRaw({ ui: { homeModule: 'portfolio' } }), 'user')
  assert.equal(
    widened.issues.filter((i) => i.level === 'error' && i.path === '$.ui.homeModule').length,
    0,
    '解析期不得再对取值报错（那是 V2 的职责）',
  )
  assert.equal(widened.profile?.ui.homeModule, 'portfolio')
  assert.equal(must(baseRaw({ ui: { homeModule: 'kb' } })).ui.homeModule, 'kb')

  // 类型错仍然在 V1 被拦下（放宽的是取值，不是类型）
  const badType = parseManifest(baseRaw({ ui: { homeModule: 42 } }), 'user')
  assert.ok(badType.issues.some((i) => i.level === 'error' && i.path === '$.ui.homeModule'))

  // 通道一 · V2 无 homeModules 上下文（未接插件体系）：
  //   内置名放行 / 'module:<id>' 放行 / 其余 → error
  const pBuiltin = must(baseRaw({ ui: { homeModule: 'kb' } }))
  assert.equal(validateReferences(pBuiltin, CTX).some((i) => i.path === '$.ui.homeModule'), false, '内置名不得被 V2 判错')
  const pMod = must(baseRaw({ ui: { homeModule: 'module:watchlist' } }))
  assert.equal(
    validateReferences(pMod, CTX).some((i) => i.path === '$.ui.homeModule'),
    false,
    'module: 开放引用不得被判错（TC-PACT-027 的另一侧）',
  )
  const pGhost = must(baseRaw({ ui: { homeModule: 'portfolio' } }))
  const e = validateReferences(pGhost, CTX).find((i) => i.path === '$.ui.homeModule')
  assert.ok(e && e.level === 'error' && e.rule === 'V2', '非内置且非 module: 的裸名必须报 error')

  // 通道二 · V2 有 homeModules 上下文（插件体系已接线）：
  //   已注册模块无 issue / 未注册只降级 warning（绝不阻断装配）
  const ctxKnown: ProfileValidationContext = { ...CTX, homeModules: ['module:watchlist'] }
  assert.equal(
    validateReferences(pMod, ctxKnown).some((i) => i.path === '$.ui.homeModule'),
    false,
    '已注册模块不得产生任何 issue',
  )
  const missing = must(baseRaw({ ui: { homeModule: 'module:ghost' } }))
  const w = validateReferences(missing, ctxKnown).find((i) => i.path === '$.ui.homeModule')
  assert.ok(w && w.level === 'warning', '未注册模块只降级提示，绝不阻断装配')
})

test('TC-PMF-008 automation.cron 必须五段式（面向用户的明确错误）', () => {
  const r = parseManifest(
    baseRaw({ automation: [{ cron: '每天 9 点', taskTemplate: '生成晨报' }] }),
    'user',
  )
  assert.ok(r.issues.some((i) => i.level === 'error' && i.path === '$.automation[0].cron'))
})

/* ============================================================
 * V2 引用闭合
 * ============================================================ */

test('TC-PMF-009 required 技能缺失 → error；非必需 → warning（差别就是「该不该阻断」）', () => {
  const req = must(baseRaw({ capabilities: [{ type: 'skill', ref: 'skill:S-core.missing', required: true }] }))
  const reqIssues = validateReferences(req, CTX)
  const e = reqIssues.find((i) => i.path === '$.capabilities[0].ref')
  assert.ok(e && e.level === 'error' && e.rule === 'V2')

  const opt = must(baseRaw({ capabilities: [{ type: 'skill', ref: 'skill:S-core.missing' }] }))
  const w = validateReferences(opt, CTX).find((i) => i.path === '$.capabilities[0].ref')
  assert.ok(w && w.level === 'warning')
})

test('TC-PMF-010 引用前缀与裸 id 双向命中（refResolves / refTail）', () => {
  assert.equal(refTail('skill:S-core.plan'), 'S-core.plan')
  assert.equal(refTail('S-core.plan'), 'S-core.plan')
  assert.ok(refResolves('skill:S-core.plan', CTX.skills))
  assert.ok(refResolves('S-core.plan', CTX.skills))
  assert.ok(!refResolves('skill:nope', CTX.skills))
  assert.ok(!refResolves('', CTX.skills))
})

test('TC-PMF-011 mcp 走 mcpServers 池，不误用 skills 池', () => {
  const p = must(baseRaw({ capabilities: [{ type: 'mcp', ref: 'mcp:mcp-alpha' }] }))
  assert.equal(validateReferences(p, CTX).filter((i) => i.level === 'error').length, 0)
  const bad = must(baseRaw({ capabilities: [{ type: 'mcp', ref: 'mcp:S-core.plan' }] }))
  assert.ok(validateReferences(bad, CTX).some((i) => i.level === 'warning'))
})

test('TC-PMF-012 panel 类型 v1 恒为 warning 降级（登记不挂载，绝不假装生效）', () => {
  const p = must(baseRaw({ capabilities: [{ type: 'panel', ref: 'panel:quote-board' }] }))
  const issues = validateReferences(p, CTX)
  const panel = issues.find((i) => i.path === '$.capabilities[0].ref')
  assert.ok(panel && panel.level === 'warning' && panel.rule === 'V2')
})

/* ============================================================
 * V3 / V4 / V5 / V6
 * ============================================================ */

test('TC-PMF-013 V4 automation.agent 必须落在 agents[] 内', () => {
  const p = must(baseRaw({ automation: [{ cron: '0 9 * * 1-5', taskTemplate: '晨报', agent: '@ghost' }] }))
  const issues = validateReferences(p, CTX)
  assert.ok(issues.some((i) => i.rule === 'V4' && i.level === 'error' && i.path.endsWith('.agent')))
})

test('TC-PMF-014 V5 同 type:ref 重复声明与 dockTabs 重复项都要报出来', () => {
  const p = must(
    baseRaw({
      capabilities: [
        { type: 'skill', ref: 'skill:S-core.plan' },
        { type: 'skill', ref: 'S-core.plan' },
      ],
      ui: { dockTabs: ['files', 'files'] },
    }),
  )
  const issues = validateReferences(p, CTX)
  assert.ok(issues.some((i) => i.rule === 'V5' && i.path === '$.capabilities[1]'))
  assert.ok(issues.some((i) => i.rule === 'V5' && i.path === '$.ui.dockTabs'))
})

test('TC-PMF-015 V6 底座版本：低于 minBaseVersion → error；相等通过', () => {
  const p = must(baseRaw({ requirements: { minBaseVersion: '0.33.0' } }))
  const issues = validateReferences(p, CTX)
  assert.ok(issues.some((i) => i.rule === 'V6' && i.level === 'error'))
  assert.ok(!meetsMinVersion('0.31.9', '0.32.0'))
  assert.ok(meetsMinVersion('0.32.0', '0.32.0'))
  assert.ok(meetsMinVersion('0.33.1', '0.32.0'))
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3])
  assert.deepEqual(parseSemver('x'), [0, 0, 0], '非法版本绝不抛，按 0 处理')
})

/* ============================================================
 * §2.4 单继承合并
 * ============================================================ */

test('TC-PMF-016 合并语义：agents/capabilities 按键覆盖，ui/data 浅覆盖，automation 取并集', () => {
  const parent = must(
    baseRaw({
      id: 'wb.parent',
      agents: [
        { id: '@a', name: '父A', personaText: 'p' },
        { id: '@b', name: '父B', personaText: 'p' },
      ],
      capabilities: [{ type: 'skill', ref: 'skill:S-core.plan' }],
      ui: { homeModule: 'kb', dockTabs: ['files', 'context'] },
      data: { memoryNamespace: 'parent', shareCoreProfile: true },
      automation: [{ cron: '0 9 * * 1-5', taskTemplate: '父任务' }],
      requirements: { minBaseVersion: '0.30.0' },
    }),
  )
  const childRaw = baseRaw({
      id: 'wb.child',
      extends: 'wb.parent',
      agents: [{ id: '@a', name: '子A', personaText: 'c' }],
      capabilities: [{ type: 'skill', ref: 'skill:S-core.spec' }],
      ui: { dockTabs: ['terminal'] },
      automation: [
        { cron: '0 9 * * 1-5', taskTemplate: '父任务' },
        { cron: '0 18 * * 1-5', taskTemplate: '子任务' },
      ],
      requirements: { minBaseVersion: '0.31.0' },
  })
  // 继承子台省略 data —— 记忆命名空间必须落回父台（TC-PMF-016 的核心断言）
  delete childRaw.data
  const child = must(childRaw)
  const merged = mergeProfile(parent, child)

  assert.equal(merged.id, 'wb.child', '身份取子')
  assert.equal(merged.agents.length, 2, 'agents 按 id 合并')
  assert.equal(merged.agents.find((a) => a.id === '@a')?.name, '子A', '同名子覆盖父')
  assert.equal(merged.capabilities.length, 2, 'capabilities 取并集')
  assert.deepEqual(merged.ui.dockTabs, ['terminal'], 'ui 子键整体覆盖')
  assert.equal(merged.ui.homeModule, 'kb', '子未声明处沿用父')
  assert.equal(merged.data.memoryNamespace, 'parent', 'data 子未声明处沿用父')
  assert.equal(merged.automation.length, 2, 'automation 同键去重')
  assert.equal(merged.requirements.minBaseVersion, '0.31.0', 'minBaseVersion 取更高者')
})

test('TC-PMF-017 stableHash 稳定且跨平台一致（persona 可追溯的前提）', () => {
  const a = stableHash('same text')
  const b = stableHash('same text')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.notEqual(stableHash('x'), stableHash('y'))
})

test('TC-PMF-018 内置三个 profile 必须全部通过 V1 结构校验且 id 唯一', () => {
  assert.equal(BUILTIN_PROFILES.length, RAW_BUILTIN_MANIFESTS.length)
  const ids = BUILTIN_PROFILES.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, '内置 id 必须唯一')
  assert.ok(ids.includes(DEFAULT_PROFILE_ID), `兜底 ${DEFAULT_PROFILE_ID} 必须存在`)
  for (const p of BUILTIN_PROFILES) {
    assert.ok(p.data.memoryNamespace.length > 0, `${p.id} 缺命名空间`)
    assert.ok(p.agents.length > 0, `${p.id} 至少要有一个 agent（否则装配出空壳台）`)
    const errors = validateReferences(p, { ...CTX, skills: ['S-core.spec', 'S-core.plan', 'S-core.bugfix', 'S-core.grep-search', 'S-core.web-search', 'S-core.fetch-url', 'S-core.kb-search'], baseVersion: '999.0.0' })
      .filter((i) => i.level === 'error')
    assert.deepEqual(errors, [], `${p.id} 不应有 error 级引用问题`)
  }
  assert.ok(MAX_EXTENDS_DEPTH >= 1)
})

/* ============================================================
 * 摘要与 diff
 * ============================================================ */

test('TC-PMF-019 summarize 标记 active / deletable：内置台永不 deletable', () => {
  const s = summarize(BUILTIN_PROFILES[0]!, BUILTIN_PROFILES[0]!.id)
  assert.equal(s.active, true)
  assert.equal(s.deletable, false, '内置台不可删')
  const user = must(baseRaw({ id: 'acme.x' }))
  assert.equal(summarize(user, null).active, false)
  assert.equal(summarize({ ...user, source: 'user' }, null).deletable, true)
})

test('TC-PMF-020 diffSnapshots 产出人话差异行（可追溯的前提）', () => {
  const a = must(baseRaw({ id: 'wb.a', agents: [{ id: '@x', name: 'X' }] }))
  const b = must(baseRaw({ id: 'wb.b', agents: [{ id: '@x', name: 'X' }, { id: '@y', name: 'Y' }] }))
  const snapA = { profileId: a.id, profileVersion: '1.0.0', resolvedAt: 1, layers: { agents: a.agents.map((x) => ({ id: x.id, name: x.name, personaHash: stableHash(x.id), defaultForNewTasks: false, skills: [] })), tools: [], ui: [], data: [], auto: [] }, degraded: [] }
  const snapB = { ...snapA, profileId: b.id, layers: { ...snapA.layers, agents: b.agents.map((x) => ({ id: x.id, name: x.name, personaHash: stableHash(x.id), defaultForNewTasks: false, skills: [] })) } }
  const lines = diffSnapshots(snapA, snapB)
  assert.ok(lines.some((l) => l.includes('wb.a → wb.b')))
  assert.ok(lines.some((l) => l.startsWith('agents:') && l.includes('@y')))
  assert.deepEqual(diffSnapshots(null, null), [])
})

/* ============================================================
 * v0.33.0 追加（TC-PMF-021..033）
 * V1 解析新 ui 字段 + V2 引用闭合扩展 + V5 冲突落地
 * ============================================================ */

/** 带面板上下文的 V2 校验 ctx（激活器实际传入形态：裸名 + panel: 前缀双写法） */
const PANEL_CTX: ProfileValidationContext = {
  ...CTX,
  panels: ['panel:watchlist', 'watchlist', 'panel:files', 'files'],
}

test('TC-PMF-021 parseManifest 解析 ui.dockPanels（slot/panelRef/position 三字段齐全）', () => {
  const p = must(baseRaw({
    ui: { dockPanels: [{ slot: 'inspector', panelRef: 'panel:watchlist', position: 2 }, { slot: 'inspector', panelRef: 'panel:files' }] },
  }))
  assert.equal(p.ui.dockPanels?.length, 2)
  assert.deepEqual(p.ui.dockPanels?.[0], { slot: 'inspector', panelRef: 'panel:watchlist', position: 2 })
  assert.equal(p.ui.dockPanels?.[1]?.position, undefined, 'position 缺省 = 追加末尾')
})

test('TC-PMF-022 parseManifest 解析 ui.theme.light / .dark', () => {
  const p = must(baseRaw({ ui: { theme: { light: { '--accent': '#3b82f6' }, dark: { '--accent': '#60a5fa' } } } }))
  assert.deepEqual(p.ui.theme, { light: { '--accent': '#3b82f6' }, dark: { '--accent': '#60a5fa' } })
  // 非字符串值被 V1 丢弃（合法性在 V2 判）
  const loose = must(baseRaw({ ui: { theme: { light: { '--a': '#fff', '--b': 42 } } } }))
  assert.deepEqual(loose.ui.theme, { light: { '--a': '#fff' }, dark: {} })
})

test('TC-PMF-023 parseManifest 解析 ui.previewRenderers（Record<string,string>）', () => {
  const p = must(baseRaw({ ui: { previewRenderers: { kchart: 'table', md: 'code' } } }))
  assert.deepEqual(p.ui.previewRenderers, { kchart: 'table', md: 'code' })
  // 非法键被拦
  const bad = parseManifest(baseRaw({ ui: { previewRenderers: { 'K.CHART': 'table' } } }), 'user')
  assert.ok(
    bad.issues.some((i) => i.level === 'error' && String(i.path).includes('previewRenderers') && String(i.path).includes('K.CHART')),
    JSON.stringify(bad.issues),
  )
})

test('TC-PMF-024 parseManifest 解析 ui.homeModule 为 module:<id>（不被闭集拒绝）', () => {
  const p = must(baseRaw({ ui: { homeModule: 'module:market-overview' } }))
  assert.equal(p.ui.homeModule, 'module:market-overview')
  const builtin = must(baseRaw({ ui: { homeModule: 'kb' } }))
  assert.equal(builtin.ui.homeModule, 'kb')
})

test('TC-PMF-025 V2：dockPanels[].panelRef 不在可用面板集 → **warning（非阻断）**，path 指向下标', () => {
  const p = must(baseRaw({ ui: { dockPanels: [{ slot: 'inspector', panelRef: 'panel:ghost', position: 0 }] } }))
  const hit = validateReferences(p, PANEL_CTX).find((i) => i.path === '$.ui.dockPanels[0].panelRef')
  assert.ok(hit, '未命中面板必须报 issue（不得静默）')
  // v0.34.0（D55）：由 error 改为 warning —— 面板由**用户可随时关闭的可选插件**提供，
  // 报 error 会让整个台切不过去（配置陷阱）。与 composeProfile 的
  // 「ui 层降级（非阻断）」语义（TC-PACT-017）对齐。
  assert.equal(hit!.level, 'warning', '必须是非阻断级：可选插件未启用不该让整台激活失败')
  assert.match(hit!.message, /不显示/)
  // 已命中的不报
  const ok = must(baseRaw({ ui: { dockPanels: [{ slot: 'inspector', panelRef: 'panel:watchlist' }] } }))
  assert.equal(validateReferences(ok, PANEL_CTX).some((i) => String(i.path).includes('dockPanels')), false)
})

test('TC-PMF-026 dockPanels[].slot 不是 inspector → error（解析期 V1 拦下）', () => {
  const r = parseManifest(baseRaw({ ui: { dockPanels: [{ slot: 'sidebar', panelRef: 'panel:x' }] } }), 'user')
  assert.ok(r.issues.some((i) => i.level === 'error' && String(i.path).includes('slot')))
  // 且该元素不进入内存形态（slot 目前只有 inspector）
  assert.equal((r.profile?.ui.dockPanels ?? []).length, 0)
})

test('TC-PMF-027 V2：previewRenderers 值不在 RendererKind 白名单 → error', () => {
  const p = must(baseRaw({ ui: { previewRenderers: { kchart: '3d' } } }))
  const hit = validateReferences(p, PANEL_CTX).find((i) => i.path === '$.ui.previewRenderers.kchart')
  assert.ok(hit)
  assert.equal(hit!.level, 'error')
  const ok = must(baseRaw({ ui: { previewRenderers: { kchart: 'table' } } }))
  assert.equal(validateReferences(ok, PANEL_CTX).some((i) => String(i.path).includes('previewRenderers')), false)
})

test('TC-PMF-028 V2：theme token 键非法 → error；值非法 → error（各一条）', () => {
  const p = must(baseRaw({ ui: { theme: { light: { 'accent': '#fff', '--accent': 'url(x)' } } } }))
  const issues = validateReferences(p, PANEL_CTX).filter((i) => String(i.path).startsWith('$.ui.theme.'))
  assert.equal(issues.length, 2)
  assert.ok(issues.every((i) => i.level === 'error'))
})

test('TC-PMF-029 V5 落地：两个面板同 position → error，消息同时点出两个面板', () => {
  const p = must(baseRaw({
    ui: {
      dockPanels: [
        { slot: 'inspector', panelRef: 'panel:watchlist', position: 1 },
        { slot: 'inspector', panelRef: 'panel:files', position: 1 },
      ],
    },
  }))
  const hit = validateReferences(p, PANEL_CTX).find((i) => i.rule === 'V5' && i.path === '$.ui.dockPanels')
  assert.ok(hit, '同 position 冲突必须报 V5')
  assert.equal(hit!.level, 'error')
  assert.ok(hit!.message.includes('panel:watchlist') && hit!.message.includes('panel:files'))
  assert.ok(hit!.message.includes('父包或本包'), '合并后无法区分来源 → 提示语必须说明')
})

test('TC-PMF-030 previewRenderers 合并语义：ui 层浅覆盖，child 整体接管（无冲突可报）', () => {
  // 实现决策：previewRenderers 是 Record（同对象内键天然唯一），继承合并采用
  // 「child 有值即整体覆盖」—— 因此「同扩展名冲突」在 manifest 层不可构造。
  // 这条把守的是该决策本身：合并后 child 的表完整生效，parent 的键不残留。
  const parent = must(baseRaw({ id: 'wb.parent', ui: { previewRenderers: { kchart: 'table', extra: 'code' } } }))
  const child = must(baseRaw({ id: 'wb.child', extends: 'wb.parent', ui: { previewRenderers: { kchart: 'svg' } } }))
  const merged = mergeProfile(parent, child)
  assert.deepEqual(merged.ui.previewRenderers, { kchart: 'svg' })
  assert.equal(validateReferences(merged, PANEL_CTX).some((i) => String(i.path).includes('previewRenderers')), false)
})

test('TC-PMF-031 V5：单台内 dockPanels 同 panelRef 重复声明 → error', () => {
  const p = must(baseRaw({
    ui: {
      dockPanels: [
        { slot: 'inspector', panelRef: 'panel:watchlist', position: 1 },
        { slot: 'inspector', panelRef: 'panel:watchlist', position: 2 },
      ],
    },
  }))
  const issues = validateReferences(p, PANEL_CTX).filter((i) => i.rule === 'V5')
  assert.ok(issues.length >= 1, '同 position 或同 ref 至少命中一条 V5')
  assert.ok(issues.every((i) => i.level === 'error'))
})

test('TC-PMF-032 合法新字段组合 → 零 error 零 warning（不误报）', () => {
  const raw = baseRaw({
    capabilities: [{ type: 'panel', ref: 'panel:watchlist', required: false }],
    ui: {
      dockPanels: [{ slot: 'inspector', panelRef: 'panel:watchlist', position: 0 }],
      homeModule: 'module:market-overview',
      previewRenderers: { kchart: 'table' },
      theme: { light: { '--accent': '#3b82f6' }, dark: { '--accent': '#60a5fa' } },
    },
  })
  const p = must(raw)
  const issues = validateReferences(p, PANEL_CTX)
  assert.deepEqual(issues, JSON.parse(JSON.stringify(issues)), '可序列化（无 undefined 悬挂）')
  assert.equal(issues.filter((i) => i.level === 'error' || i.level === 'warning').length, 0, `不应有任何 error/warning：${JSON.stringify(issues)}`)
})

test('TC-PMF-033 回归：v0.32.1 合法 manifest（无新字段）→ 校验行为不变', () => {
  // 内置工作台不含任何 v0.33.0 新字段 —— 校验必须零 error（旧行为回归）
  for (const raw of Object.values(RAW_BUILTIN_MANIFESTS) as Record<string, unknown>[]) {
    const r = parseManifest(raw, 'builtin')
    const errs = r.issues.filter((i) => i.level === 'error')
    assert.equal(errs.length, 0, `${String((raw as { id?: string }).id)} 不应有 error：${JSON.stringify(errs)}`)
    assert.ok(r.profile)
    const refs = validateReferences(r.profile!, CTX)
    assert.equal(refs.filter((i) => i.level === 'error').length, 0)
  }
})
