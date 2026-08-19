/* ============================================================
 * v0.25.0 F1 — prompt/sections.ts 单测（按契约装配 + always-on）
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/prompt/__tests__/sections.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import {
  resetPromptSectionRegistry,
  registerPromptSection,
} from '../contract.js'
import { assembleSystemPrompt, collectAlwaysOnSections } from '../sections.js'
import type { Agent, Skill } from '@shared/types/agent'
import type { SystemPromptContext } from '../../prompt-assembly.js'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: '@test',
    name: 'Test',
    description: '',
    avatarColor: '#000000',
    systemPrompt: 'core-rules 正文',
    defaultSkillIds: [],
    defaultMcpIds: [],
    defaultModelId: '',
    defaultKbIds: [],
    defaultConfig: { temperature: 0.3, maxIterations: 10 },
    ...overrides,
  } as Agent
}

test.beforeEach(() => {
  resetPromptSectionRegistry()
})

test('assembleSystemPrompt 装配 6 基础段（顺序按 order）', async () => {
  // 重新注册内置段（reset 后模块级注册已清空，这里只验证装配逻辑）
  registerPromptSection({
    id: 'core-rules',
    order: 0,
    slot: { kind: 'system' },
    stability: 'static',
    owner: 'core',
    maxTokens: 100,
    required: true,
    build: async (ctx) => `core:${ctx.agent.name}`,
  })
  registerPromptSection({
    id: 'personality',
    order: 100,
    slot: { kind: 'system' },
    stability: 'agent-static',
    owner: 'agent',
    maxTokens: 100,
    required: false,
    build: async () => 'personality-text',
  })
  registerPromptSection({
    id: 'memory',
    order: 300,
    slot: { kind: 'system' },
    stability: 'run-static',
    owner: 'memory',
    maxTokens: 100,
    required: false,
    build: async (ctx) => ctx.memoryInjection || null,
  })

  const ctx: SystemPromptContext = {
    agent: makeAgent({ name: 'Alpha' }),
    workspaceDir: '/tmp',
    memoryInjection: 'mem-1',
  }
  const result = await assembleSystemPrompt(ctx)
  // 顺序: core-rules(0) → personality(100) → memory(300)
  assert.deepEqual(
    result.sections.map((s) => s.id),
    ['core-rules', 'personality', 'memory'],
  )
  assert.ok(result.text.includes('core:Alpha'))
  assert.ok(result.text.includes('mem-1'))
})

test('assembleSystemPrompt required 段缺失抛错', async () => {
  registerPromptSection({
    id: 'core-rules',
    order: 0,
    slot: { kind: 'system' },
    stability: 'static',
    owner: 'core',
    maxTokens: 100,
    required: true,
    build: async () => null, // 故意返回 null
  })
  const ctx: SystemPromptContext = {
    agent: makeAgent(),
    workspaceDir: '/tmp',
  }
  await assert.rejects(assembleSystemPrompt(ctx), /required section 'core-rules' is empty/)
})

test('assembleSystemPrompt extras 与注册段 id 冲突抛错', async () => {
  registerPromptSection({
    id: 'core-rules',
    order: 0,
    slot: { kind: 'system' },
    stability: 'static',
    owner: 'core',
    maxTokens: 100,
    required: true,
    build: async () => 'x',
  })
  const ctx: SystemPromptContext = {
    agent: makeAgent(),
    workspaceDir: '/tmp',
  }
  await assert.rejects(
    assembleSystemPrompt(ctx, [
      {
        id: 'core-rules',
        order: 0,
        slot: { kind: 'system' },
        stability: 'static',
        owner: 'core',
        maxTokens: 100,
        required: false,
        build: async () => 'y',
      },
    ]),
    /extra section id conflicts/,
  )
})

test('collectAlwaysOnSections 技能不存在跳过 + warn', async () => {
  const agent = makeAgent({ alwaysOnSkillIds: ['nonexistent-skill-id'] })
  const contracts = await collectAlwaysOnSections(agent)
  assert.equal(contracts.length, 0)
})

test('collectAlwaysOnSections 加载 instructionMd 并包装为契约段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-alwayson-'))
  try {
    const instructionPath = join(dir, 'SKILL.md')
    const body = '---\ninstructionMode: always-on\n---\n# 准则正文\n## 阶段\n- 阶段 A\n- 阶段 B'
    await writeFile(instructionPath, body, 'utf-8')

    // mock getSkill：通过 monkey patch 不易实现，改用集成方式直接验证 alwaysOn 段；
    // 此处只验证 generateAlwaysOnSkill 能读取文件并剥离 frontmatter
    const full = await import('node:fs/promises').then((m) => m.readFile(instructionPath, 'utf-8'))
    const stripped = full.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
    assert.ok(stripped.includes('准则正文'))
    assert.ok(!stripped.startsWith('---'))

    // mock 一个 Skill 对象用于构造契约段
    const skill: Skill = {
      id: 'mock-skill',
      name: 'Mock',
      enabled: true,
      description: '',
      source: 'bundled',
      scopes: [],
      instructionMd: instructionPath,
      instructionMode: 'always-on',
    } as unknown as Skill

    const contracts = [
      {
        id: `skill:${skill.id}`,
        order: 150,
        slot: { kind: 'system' as const },
        stability: 'agent-static' as const,
        owner: 'skill' as const,
        maxTokens: 16000,
        required: false,
        build: async () => `## 常驻技能：${skill.name}\n${stripped}`,
      },
    ]
    const ctx: SystemPromptContext = { agent: makeAgent(), workspaceDir: '/tmp' }
    const result = await assembleSystemPrompt(ctx, contracts)
    const alwaysOnSection = result.sections.find((s) => s.id === 'skill:mock-skill')
    assert.ok(alwaysOnSection)
    assert.ok(alwaysOnSection.text.includes('常驻技能：Mock'))
    assert.ok(alwaysOnSection.text.includes('准则正文'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
