/* ============================================================
 * v0.36.0 F2.1/F2.2 — CapabilityRegistry 单测
 *
 * 覆盖验收断言：
 *  1. 行为锁定（设计 §3.1）：project() 输出与改造前 assembleTools 逐字节
 *     一致 —— 测试内保留改造前装配逻辑的 golden 镜像，同输入双实现比对
 *  2. F2.2 新增行为：profile mcp 引用（tail = M-{ns}.{tool}）汇入工具集
 *  3. 失效链路：markCapabilityDirty → 订阅者通知 + skill provider 惰性重扫；
 *     invalidateSkillCache 单点接线（行为验证，不做源码 grep —— D97 教训）
 *  4. sync 集成：真 listSkills 填充 / 插件运行时缺席降级 / 控制工具恒在
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/capability/__tests__/capability-registry.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CapabilityRegistry,
  capabilityRegistry,
  markCapabilityDirty,
  resetCapabilitySyncState,
  skillToCapabilityEntry,
  pluginDeclaredToolToEntry,
  pluginControlToolToEntry,
  syncCapabilityRegistry,
  type CapabilityEntry,
  type ProjectRequest,
} from '../registry.js'
import { skillToLlmTool, assessToolRisk, invalidateSkillCache } from '../../agent/registry.js'
import type { Skill } from '@shared/types/agent'
import type { LlmTool } from '../../llm/adapter.js'

/* ============================================================
 * fixtures
 * ============================================================ */

function makeSkill(partial: Partial<Skill> & { id: string }): Skill {
  return {
    name: partial.id,
    description: `desc of ${partial.id}`,
    namespace: 'test',
    source: 'custom',
    enabled: true,
    ...partial,
  } as Skill
}

const SKILL_A = makeSkill({ id: 'S-core.alpha', toolName: 'alpha' })
const SKILL_B = makeSkill({ id: 'S-core.beta', toolName: 'beta' })
const SKILL_DISABLED = makeSkill({ id: 'S-core.gamma', toolName: 'gamma', enabled: false })
const SKILL_MCP = makeSkill({
  id: 'M-github.create_issue',
  name: 'create_issue',
  source: 'mcp',
  mcpRef: { serverId: 'srv-github', toolName: 'create_issue' },
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
})

function skillsToEntries(skills: Skill[]): CapabilityEntry[] {
  return skills.map((s) => skillToCapabilityEntry(s, assessToolRisk(s, {}).level))
}

const DECLARED_TOOL = {
  pluginId: 'ark.plugin.demo',
  name: 'demo_tool',
  description: 'demo tool of plugin',
  inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
  globalName: 'plugin__ark.plugin.demo__demo_tool',
}

function declaredEntries(): CapabilityEntry[] {
  return [pluginDeclaredToolToEntry(DECLARED_TOOL)]
}

/* ============================================================
 * golden 镜像 —— 改造前 assembleTools 的逐字逻辑（行为锁定基准）
 * ============================================================ */

const CONTROL_TOOLS: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'zz_control',
      description: 'control tool',
      parameters: { type: 'object', properties: {} },
    },
  },
]

/** 与改造前 messages.assembleTools 完全同构（仅 undefined→[] 差异由调用方对齐） */
function legacyAssembleTools(
  skills: Skill[],
  agent: { defaultSkillIds: string[]; defaultMcpIds: string[] },
  task: { skillIds?: string[]; mcpIds?: string[] },
  profileSnapTools: Array<{ kind: 'skill' | 'mcp'; ref: string; found: boolean }>,
  declared: Array<typeof DECLARED_TOOL>,
  controlTools: LlmTool[],
): LlmTool[] {
  const skillIdSet = new Set<string>([...agent.defaultSkillIds, ...(task.skillIds || [])])
  for (const t of profileSnapTools) {
    if (t.kind === 'skill' && t.found) skillIdSet.add(t.ref)
  }
  const mcpServerIdSet = new Set<string>([
    ...(agent.defaultMcpIds || []),
    ...(task.mcpIds || []),
  ])
  for (const s of skills) {
    if (s.source === 'mcp' && s.mcpRef && mcpServerIdSet.has(s.mcpRef.serverId)) {
      skillIdSet.add(s.id)
    }
  }
  const mergedIds = [...skillIdSet]
  const available = skills.filter((s) => mergedIds.includes(s.id) && s.enabled !== false)
  const out: LlmTool[] = available.map(skillToLlmTool)
  for (const t of declared) {
    out.push({
      type: 'function',
      function: {
        name: t.globalName,
        description: `[插件 ${t.pluginId}] ${t.description}`,
        parameters: t.inputSchema,
      },
    })
  }
  out.push(...controlTools)
  return out.sort((a, b) => a.function.name.localeCompare(b.function.name))
}

/** 新投影路径：同一批输入 → upsert → project */
function projectViaRegistry(
  skills: Skill[],
  agent: { defaultSkillIds: string[]; defaultMcpIds: string[] },
  task: { skillIds?: string[]; mcpIds?: string[] },
  profileToolRefs: ProjectRequest['profileToolRefs'],
  declared: Array<typeof DECLARED_TOOL> = [],
  controlTools: LlmTool[] = [],
): LlmTool[] {
  const reg = new CapabilityRegistry()
  reg.upsert(skillsToEntries(skills), 'skill')
  if (declared.length > 0) reg.upsert(declared.map(pluginDeclaredToolToEntry), 'plugin:declared')
  if (controlTools.length > 0) reg.upsert(controlTools.map(pluginControlToolToEntry), 'plugin:control')
  return reg.project({
    agentDefaultSkillIds: [...agent.defaultSkillIds],
    taskSkillIds: [...(task.skillIds || [])],
    profileToolRefs,
    connectedMcpIds: [...(agent.defaultMcpIds || []), ...(task.mcpIds || [])],
  })
}

function assertGolden(
  skills: Skill[],
  agent: { defaultSkillIds: string[]; defaultMcpIds: string[] },
  task: { skillIds?: string[]; mcpIds?: string[] },
  profileToolRefs: ProjectRequest['profileToolRefs'] = [],
  declared: Array<typeof DECLARED_TOOL> = [],
  controlTools: LlmTool[] = [],
): void {
  // 镜像只认 skill 引用（改造前行为）；新实现通过 project 比对
  const legacyProfileRefs = profileToolRefs.filter((t) => t.kind === 'skill')
  const legacy = legacyAssembleTools(skills, agent, task, legacyProfileRefs, declared, controlTools)
  const fresh = projectViaRegistry(skills, agent, task, profileToolRefs, declared, controlTools)
  assert.equal(
    JSON.stringify(fresh),
    JSON.stringify(legacy),
    `project 输出应与改造前 assembleTools 逐字节一致\nlegacy=${JSON.stringify(legacy, null, 2)}\nfresh=${JSON.stringify(fresh, null, 2)}`,
  )
}

/* ============================================================
 * 组 A：registry 基础（纯内存）
 * ============================================================ */

test('TC-CR-001 upsert: 同 provider 键重复 upsert 整体替换（幂等覆盖）', () => {
  const reg = new CapabilityRegistry()
  reg.upsert(skillsToEntries([SKILL_A]), 'skill')
  reg.upsert(skillsToEntries([SKILL_B]), 'skill')
  assert.deepEqual(reg.list().map((e) => e.id), ['S-core.beta'])
})

test('TC-CR-002 revoke: 清空对应 provider，可逆（可重新 upsert）', () => {
  const reg = new CapabilityRegistry()
  reg.upsert(skillsToEntries([SKILL_A, SKILL_MCP]), 'skill')
  assert.equal(reg.list().length, 2)
  reg.revoke('skill')
  assert.equal(reg.list().length, 0)
  reg.upsert(skillsToEntries([SKILL_B]), 'skill')
  assert.deepEqual(reg.list().map((e) => e.id), ['S-core.beta'])
})

test('TC-CR-003 list/get: 跨 provider 聚合且 get 按 id 命中', () => {
  const reg = new CapabilityRegistry()
  reg.upsert(skillsToEntries([SKILL_A]), 'skill')
  reg.upsert(declaredEntries(), 'plugin:declared')
  assert.equal(reg.list().length, 2)
  assert.equal(reg.get('S-core.alpha')?.id, 'S-core.alpha')
  assert.equal(reg.get('plugin__ark.plugin.demo__demo_tool')?.source, 'plugin')
  assert.equal(reg.get('nope'), undefined)
})

test('TC-CR-004 project: 无命中返回空数组（assembleTools 层负责 [] → undefined）', () => {
  const reg = new CapabilityRegistry()
  reg.upsert(skillsToEntries([SKILL_A]), 'skill')
  const out = reg.project({
    agentDefaultSkillIds: [],
    taskSkillIds: [],
    profileToolRefs: [],
    connectedMcpIds: [],
  })
  assert.deepEqual(out, [])
})

/* ============================================================
 * 组 B：golden 镜像（行为锁定 —— 设计 §3.1 验收门槛）
 * ============================================================ */

test('TC-CR-005 golden① 仅 agent 默认技能', () => {
  assertGolden(
    [SKILL_A, SKILL_B, SKILL_DISABLED],
    { defaultSkillIds: ['S-core.alpha'], defaultMcpIds: [] },
    {},
  )
})

test('TC-CR-006 golden② agent + task 会话技能叠加去重', () => {
  assertGolden(
    [SKILL_A, SKILL_B],
    { defaultSkillIds: ['S-core.alpha'], defaultMcpIds: [] },
    { skillIds: ['S-core.alpha', 'S-core.beta'] },
  )
})

test('TC-CR-007 golden③ enabled=false 过滤（即使被 id 集命中）', () => {
  assertGolden(
    [SKILL_A, SKILL_DISABLED],
    { defaultSkillIds: ['S-core.alpha', 'S-core.gamma'], defaultMcpIds: [] },
    {},
  )
})

test('TC-CR-008 golden④ MCP server 级展开（agent 默认 + task 会话）', () => {
  assertGolden(
    [SKILL_A, SKILL_MCP],
    { defaultSkillIds: ['S-core.alpha'], defaultMcpIds: ['srv-github'] },
    { mcpIds: ['srv-github'] },
  )
})

test('TC-CR-009 golden⑤ profile skill 引用叠加（found 才加 —— 只加不减）', () => {
  assertGolden(
    [SKILL_A, SKILL_B],
    { defaultSkillIds: ['S-core.alpha'], defaultMcpIds: [] },
    {},
    [
      { kind: 'skill', ref: 'S-core.beta', found: true },
      { kind: 'skill', ref: 'S-core.missing', found: false },
    ],
  )
})

test('TC-CR-010 golden⑥ 插件声明工具（描述前缀）+ 控制工具 + 混排确定性排序', () => {
  assertGolden(
    [SKILL_A, SKILL_MCP],
    { defaultSkillIds: ['S-core.alpha'], defaultMcpIds: ['srv-github'] },
    {},
    [],
    [DECLARED_TOOL],
    CONTROL_TOOLS,
  )
})

test('TC-CR-011 golden⑦ 全空输入 → 空投影', () => {
  assertGolden([], { defaultSkillIds: [], defaultMcpIds: [] }, {})
})

test('TC-CR-012 双源一致：skillToCapabilityEntry(s).def 与 skillToLlmTool(s) 逐字节一致', () => {
  for (const s of [SKILL_A, SKILL_B, SKILL_DISABLED, SKILL_MCP, makeSkill({ id: 'S-core.中文名' })]) {
    const entryDef = skillToCapabilityEntry(s, 'medium').def
    const direct = skillToLlmTool(s)
    assert.equal(
      JSON.stringify(entryDef),
      JSON.stringify(direct),
      `def 双源漂移：${s.id}`,
    )
  }
})

/* ============================================================
 * 组 C：F2.2 profile mcp 引用汇入（新行为，不参与 golden）
 * ============================================================ */

test('TC-CR-013 F2.2 profile mcp ref found → M-xxx 工具进入投影（server 不在 connectedMcpIds）', () => {
  const out = projectViaRegistry(
    [SKILL_A, SKILL_MCP],
    { defaultSkillIds: ['S-core.alpha'], defaultMcpIds: [] },
    {},
    [{ kind: 'mcp', ref: 'M-github.create_issue', found: true }],
  )
  assert.deepEqual(
    out.map((t) => t.function.name),
    // MCP 工具名与 skillToLlmTool 同规则（无 toolName → name slug 派生）
    ['alpha', 'create-issue'],
  )
})

test('TC-CR-014 F2.2 profile mcp ref not found → 不进入投影', () => {
  const out = projectViaRegistry(
    [SKILL_A, SKILL_MCP],
    { defaultSkillIds: ['S-core.alpha'], defaultMcpIds: [] },
    {},
    [{ kind: 'mcp', ref: 'M-github.create_issue', found: false }],
  )
  assert.deepEqual(
    out.map((t) => t.function.name),
    ['alpha'],
  )
})

test('TC-CR-015 F2.2 server 级 + 工具级双通道命中不产生重复条目', () => {
  const out = projectViaRegistry(
    [SKILL_MCP],
    { defaultSkillIds: [], defaultMcpIds: ['srv-github'] },
    {},
    [{ kind: 'mcp', ref: 'M-github.create_issue', found: true }],
  )
  assert.equal(out.length, 1)
  assert.equal(out[0]!.function.name, 'create-issue')
})

/* ============================================================
 * 组 D：失效订阅与惰性重扫
 * ============================================================ */

test('TC-CR-016 markCapabilityDirty 触发订阅者', () => {
  let calls = 0
  const unsub = capabilityRegistry.subscribeInvalidated(() => {
    calls++
  })
  markCapabilityDirty('plugin')
  assert.equal(calls, 1)
  unsub()
})

test('TC-CR-017 退订后不再触发', () => {
  let calls = 0
  const unsub = capabilityRegistry.subscribeInvalidated(() => {
    calls++
  })
  unsub()
  markCapabilityDirty('plugin')
  assert.equal(calls, 0)
})

test('TC-CR-018 订阅者抛异常不阻断其他订阅者', () => {
  let secondCalled = false
  const unsub1 = capabilityRegistry.subscribeInvalidated(() => {
    throw new Error('subscriber boom')
  })
  const unsub2 = capabilityRegistry.subscribeInvalidated(() => {
    secondCalled = true
  })
  markCapabilityDirty('plugin')
  assert.equal(secondCalled, true)
  unsub1()
  unsub2()
})

test('TC-CR-019 惰性重扫：未失效时 sync 保留手工条目；markDirty 后重扫覆盖', async () => {
  resetCapabilitySyncState()
  await syncCapabilityRegistry()
  // 污染：往 skill provider 塞探针
  const probe = skillToCapabilityEntry(makeSkill({ id: 'S-probe.capability', toolName: 'probe_capability' }), 'medium')
  capabilityRegistry.upsert([probe], 'skill')
  await syncCapabilityRegistry() // 未失效 → 不重扫 → 探针仍在
  assert.ok(capabilityRegistry.get('S-probe.capability'), '未失效时不应重扫')
  markCapabilityDirty('skill')
  await syncCapabilityRegistry() // 失效 → 重扫 → 探针被真数据覆盖
  assert.equal(capabilityRegistry.get('S-probe.capability'), undefined, '失效后应重扫并覆盖探针')
  assert.ok(capabilityRegistry.get('S-core.file-reader'), '重扫后应含真技能')
})

/* ============================================================
 * 组 E：sync 集成（真 listSkills）
 * ============================================================ */

test('TC-CR-020 sync: skill provider 来自 listSkills（真技能落位）', async () => {
  resetCapabilitySyncState()
  await syncCapabilityRegistry()
  const entry = capabilityRegistry.get('S-core.file-reader')
  assert.ok(entry, '内置技能应进入注册表')
  assert.equal(entry!.providerId, 'skill')
  assert.equal(entry!.enabled, true)
  assert.ok(entry!.def.function.name.length > 0)
})

test('TC-CR-021 sync: 插件运行时缺席 → plugin:declared 撤销（退回无插件语义）', async () => {
  resetCapabilitySyncState()
  await syncCapabilityRegistry()
  const pluginTools = capabilityRegistry
    .list()
    .filter((e) => e.id.startsWith('plugin__'))
  assert.deepEqual(pluginTools, [], '单测环境插件宿主缺席，声明位应被撤销')
})

test('TC-CR-022 sync: 插件控制工具恒在（宿主自有工具，不依赖插件进程）', async () => {
  resetCapabilitySyncState()
  await syncCapabilityRegistry()
  for (const name of ['plugin_list', 'plugin_detail', 'plugin_set_enabled', 'plugin_open_view']) {
    const entry = capabilityRegistry.get(name)
    assert.ok(entry, `控制工具 ${name} 应恒在`)
    assert.equal(entry!.providerId, 'plugin:control')
  }
})

test('TC-CR-023 mcp 条目 providerId 形如 mcp:<serverId>（server 级展开判定载体）', async () => {
  resetCapabilitySyncState()
  await syncCapabilityRegistry()
  const mcpEntries = capabilityRegistry.list().filter((e) => e.source === 'mcp')
  for (const e of mcpEntries) {
    assert.match(e.providerId, /^mcp:.+/, `mcp 条目 ${e.id} 的 providerId 应为 mcp:<serverId>`)
  }
})

/* ============================================================
 * 组 F：接线契约（invalidateSkillCache → registry 失效，行为验证）
 * ============================================================ */

test('TC-CR-024 接线契约：invalidateSkillCache 触发 registry skill provider 重扫', async () => {
  resetCapabilitySyncState()
  await syncCapabilityRegistry()
  const probe = skillToCapabilityEntry(makeSkill({ id: 'S-probe.wire', toolName: 'probe_wire' }), 'medium')
  capabilityRegistry.upsert([probe], 'skill')
  invalidateSkillCache() // 既有单点（16+ 调用点全继承）→ 应联动 registry 失效
  await syncCapabilityRegistry()
  assert.equal(
    capabilityRegistry.get('S-probe.wire'),
    undefined,
    'invalidateSkillCache 必须联动 registry 失效（D78/D79 同型风险的把守）',
  )
})

test('TC-CR-025 插件声明条目：def 描述带 [插件 id] 前缀（模型可见归属）', () => {
  const entry = pluginDeclaredToolToEntry(DECLARED_TOOL)
  assert.equal(entry.def.function.name, 'plugin__ark.plugin.demo__demo_tool')
  assert.equal(entry.def.function.description, '[插件 ark.plugin.demo] demo tool of plugin')
  assert.equal(entry.enabled, true)
})

test('TC-CR-026 控制工具条目 invoke 如实说明路由归属（不假装可调）', async () => {
  const entry = pluginControlToolToEntry(CONTROL_TOOLS[0]!)
  await assert.rejects(
    () => entry.invoke({}, {} as never),
    /act 阶段路由/,
  )
})
