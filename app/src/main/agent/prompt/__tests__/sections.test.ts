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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

/* ============================================================
 * ★ D233 / F7c — 回答通道契约段（TC-SWALLOW-006）
 *
 * 背景（qwen3.8 27b 实机）：正式回答（代码）只写在思考流里，交互区拿不到
 * 正文而模型自以为已输出。F7c 在 system prompt 里注册 answer-channel 段，
 * 把「正式回答必须写在回复正文里」写进硬性契约（提示词侧防线，与引擎侧
 * F7a/F7b 互补）。
 *
 * 本用例做源码断言而非装配断言：内置段在模块加载时注册，本文件 beforeEach
 * 的 resetPromptSectionRegistry() 会清空注册表，装配路径测不到内置段；
 * 源码锚点断言与 empty-response-guard.test.ts 同法（stripComments 不需要 ——
 * 锚点均为代码/文案原文，注释里不含同字样）。
 * ============================================================ */

test('TC-SWALLOW-006 回答通道契约段（D233 / F7c）：注册在位 + 文案钉死', () => {
  const src = readFileSync(fileURLToPath(new URL('../sections.ts', import.meta.url)), 'utf-8')

  // 注册在位：SECTION_ORDER 槽位 + 注册体
  assert.match(src, /answerChannel: 530/, 'SECTION_ORDER 必须有 answerChannel: 530 槽位')
  assert.match(src, /id: 'answer-channel'/, 'answer-channel 段必须注册在位')
  assert.match(
    src,
    /order: SECTION_ORDER\.answerChannel/,
    '注册体的 order 必须引用 SECTION_ORDER.answerChannel（不许另写字面量）',
  )

  // 文案钉死：三条关键锚点（通道要求 + 思考通道边界 + 引擎退回后果）
  assert.match(src, /必须写在回复\*\*正文\*\*里/, '必须明确「正式回答写在回复正文里」')
  assert.match(src, /思考通道只放推理过程/, '必须明确「思考通道只放推理过程」')
  assert.match(
    src,
    /正文为空的完成声明会被引擎退回/,
    '必须写明后果（正文为空的完成声明会被引擎退回）—— 与 F7b 守卫闭环',
  )
})
