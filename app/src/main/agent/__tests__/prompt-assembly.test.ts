/* ============================================================
 * v0.19.0 M1 — prompt-assembly.ts 纯函数单测
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/__tests__/prompt-assembly.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSystemSections,
  renderSystemPrompt,
  buildPersonalitySegment,
} from '../prompt-assembly.js'
import type { Agent } from '@shared/types/agent'
import type { PlanItem } from '@shared/types/task'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: '@test',
    name: 'Test',
    description: '',
    avatarColor: '#000000',
    systemPrompt: '## 核心规则\n规则内容',
    ...overrides,
  } as Agent
}

function makePlanItems(): PlanItem[] {
  return [
    { id: 'p1', text: '步骤一', status: 'done', createdAt: 0, updatedAt: 0 },
    { id: 'p2', text: '步骤二', status: 'running', createdAt: 0, updatedAt: 0 },
    { id: 'p3', text: '步骤三', status: 'pending', createdAt: 0, updatedAt: 0 },
  ]
}

/* ---------- buildPersonalitySegment ---------- */

test('buildPersonalitySegment: 有任一字段则注入格式化模板', () => {
  const out = buildPersonalitySegment(makeAgent({ role: '审查员', goal: '找 bug' }))
  assert.ok(out.startsWith('## 人格设定\n'))
  assert.ok(out.includes('- 角色：审查员'))
  assert.ok(out.includes('- 目标：找 bug'))
})

test('buildPersonalitySegment: 全空返回空串', () => {
  assert.equal(buildPersonalitySegment(makeAgent()), '')
})

/* ---------- buildSystemSections 排序 ---------- */

test('buildSystemSections: 按 order 升序输出（workspace-context 最先 → core-rules → personality → workspace → memory → plan-constraint）', () => {
  const ctx = {
    agent: makeAgent({ role: '审查员', goal: '找 bug' }),
    workspaceDir: '/tmp/ws',
    memoryInjection: '## 记忆\n策展',
    planItems: makePlanItems(),
  }
  const sections = buildSystemSections(ctx)
  assert.deepEqual(
    sections.map((s) => s.id),
    ['workspace-context', 'core-rules', 'personality', 'workspace', 'memory', 'plan-constraint'],
  )
  // v0.24.x 用户明确要求：ArkWork 系统提示词最先（位于 coreRules 之前）
  assert.equal(sections[0].id, 'workspace-context')
  assert.equal(sections[1].id, 'core-rules')
})

/* ---------- buildSystemSections 空段跳过 ---------- */

test('buildSystemSections: 空人格 / 无记忆 / 无技能 / 无计划时对应段被跳过', () => {
  const sections = buildSystemSections({ agent: makeAgent(), workspaceDir: '/tmp/ws' })
  assert.deepEqual(sections.map((s) => s.id), ['workspace-context', 'core-rules', 'workspace'])
})

/* ---------- v0.20.0 缓存优化：system 静态化 ---------- */

test('buildSystemSections: plan-constraint 为纯静态文本（不随计划状态变化）', () => {
  const agent = makeAgent({ role: '审查员', goal: '找 bug' })
  const workspaceDir = '/tmp/ws'

  const a = renderSystemPrompt(
    buildSystemSections({ agent, workspaceDir, planItems: makePlanItems() }),
  )
  const changed = makePlanItems()
  changed[0].status = 'pending'
  changed[1].status = 'done'
  const b = renderSystemPrompt(
    buildSystemSections({ agent, workspaceDir, planItems: changed }),
  )

  // 计划状态变化不得改变 system prompt（动态进度已移出 system）
  assert.equal(a, b)
  // 静态约束指令仍在
  assert.ok(a.includes('## 计划执行约束'))
  // 但不再内嵌每轮进度列表
  assert.ok(!a.includes('[x]'))
  assert.ok(!a.includes('[~]'))
})

test('buildSystemSections: 无 skill-hint 段（skill 指令已移出 system）', () => {
  const agent = makeAgent({ role: '审查员', goal: '找 bug' })
  const sections = buildSystemSections({
    agent,
    workspaceDir: '/tmp/ws',
    memoryInjection: '## 记忆\n策展',
    planItems: makePlanItems(),
  })
  assert.ok(!sections.some((s) => s.id === 'skill-hint'))
})

/* ---------- systemSections 回退 ---------- */

test('buildSystemSections: systemSections 缺省时回退用 systemPrompt 作 core-rules 单段', () => {
  const agent = makeAgent() // 无 systemSections
  const sections = buildSystemSections({ agent, workspaceDir: '/tmp/ws' })
  const core = sections.find((s) => s.id === 'core-rules')
  assert.ok(core)
  assert.equal(core.text, agent.systemPrompt)
})

test('buildSystemSections: systemSections 存在时逐段展开（不读 systemPrompt）', () => {
  const agent = makeAgent({
    systemSections: [
      { id: 'core-rules', order: 0, text: '## 规则A\nA' },
      { id: 'core-rules-2', order: 10, text: '## 规则B\nB' },
    ],
  })
  const sections = buildSystemSections({ agent, workspaceDir: '/tmp/ws' })
  assert.equal(sections[0].id, 'workspace-context') // v0.24.x：ArkWork 系统提示词最先
  assert.equal(sections[1].id, 'core-rules')
  assert.equal(sections[2].id, 'core-rules-2')
  assert.equal(sections[3].id, 'workspace')
})

/* ---------- renderSystemPrompt ---------- */

test('renderSystemPrompt: 空列表返回空串', () => {
  assert.equal(renderSystemPrompt([]), '')
})

test('renderSystemPrompt: 单段时不含分隔符', () => {
  assert.equal(renderSystemPrompt([{ id: 'a', order: 0, text: 'AAA' }]), 'AAA')
})

test('renderSystemPrompt: 多段用 \\n\\n---\\n 连接', () => {
  const out = renderSystemPrompt([
    { id: 'a', order: 0, text: 'AAA' },
    { id: 'b', order: 1, text: 'BBB' },
  ])
  assert.equal(out, 'AAA\n\n---\nBBB')
})
