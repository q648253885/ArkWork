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

test('TC-PMF-007 ui.homeModule 必须在白名单内', () => {
  const bad = parseManifest(baseRaw({ ui: { homeModule: 'portfolio' } }), 'user')
  assert.ok(bad.issues.some((i) => i.level === 'error' && i.path === '$.ui.homeModule'))
  const good = parseManifest(baseRaw({ ui: { homeModule: 'kb' } }), 'user')
  assert.equal(good.profile?.ui.homeModule, 'kb')
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
