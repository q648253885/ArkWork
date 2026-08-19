/* ============================================================
 * v0.25.0 F1 — prompt/gates.ts 单测
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/prompt/__tests__/gates.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkillFrontmatter, gateMatchesText, initGateStates, checkGateBeforeAdvance, confirmGate, findGateForStageDoc, isDocDrivenAgent } from '../gates.js'
import type { GateSpec } from '@shared/types/agent'
import type { Task } from '@shared/types/task'

function makeTask(): Task {
  return {
    id: 't',
    workspaceId: 'ws',
    agentId: '@test',
    title: '',
    input: '',
    status: 'running',
    skillIds: [],
    mcpIds: [],
    kbIds: [],
    config: {},
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Task
}

test('parseSkillFrontmatter 解析 instructionMode', () => {
  const md = `---
name: x
instructionMode: always-on
---
# 正文`
  const fm = parseSkillFrontmatter(md)
  assert.equal(fm.instructionMode, 'always-on')
})

test('parseSkillFrontmatter 解析 gates 块', () => {
  const md = `---
name: x
gates:
  - id: prd-confirmed
    after: 产出 01-prd.md
    ask: PRD 要点
  - id: design-confirmed
    after: 产出 03-system-design.md
    ask: 设计确认
---
# 正文`
  const fm = parseSkillFrontmatter(md)
  assert.ok(fm.gates)
  assert.equal(fm.gates!.length, 2)
  assert.equal(fm.gates![0].id, 'prd-confirmed')
  assert.equal(fm.gates![1].after, '产出 03-system-design.md')
})

test('parseSkillFrontmatter 非法 mode 忽略', () => {
  const md = `---
instructionMode: bogus
---
`
  const fm = parseSkillFrontmatter(md)
  assert.equal(fm.instructionMode, undefined)
})

test('parseSkillFrontmatter 非法 gate（缺 after）忽略该条 + 其他保留', () => {
  const md = `---
gates:
  - id: only-id
  - id: ok
    after: 产出 01-prd.md
    ask: PRD
---
`
  const fm = parseSkillFrontmatter(md)
  assert.equal(fm.gates?.length, 1)
  assert.equal(fm.gates![0].id, 'ok')
})

test('parseSkillFrontmatter 非法 gate id（首字符非字母数字）忽略', () => {
  const md = `---
gates:
  - id: "-bad"
    after: 产出 01-prd.md
    ask: PRD
---
`
  const fm = parseSkillFrontmatter(md)
  assert.equal(fm.gates, undefined)
})

test('gateMatchesText 文件名包含匹配', () => {
  assert.equal(gateMatchesText('产出 01-prd.md', '产出 01-prd.md 阶段'), true)
})

test('gateMatchesText 不匹配', () => {
  assert.equal(gateMatchesText('产出 01-prd.md', '编码阶段开始'), false)
})

test('initGateStates 新建 + 已存在刷新 after/ask 快照', () => {
  const task = makeTask()
  const specs: GateSpec[] = [{ id: 'g1', after: 'after1', ask: 'ask1' }]
  initGateStates(task, specs)
  assert.equal(task.gateStates!.length, 1)
  assert.equal(task.gateStates![0].status, 'pending')

  // 再次初始化：保留 status，刷新 after/ask
  const updatedSpecs: GateSpec[] = [{ id: 'g1', after: 'after1-new', ask: 'ask1-new' }]
  initGateStates(task, updatedSpecs)
  assert.equal(task.gateStates!.length, 1)
  assert.equal(task.gateStates![0].status, 'pending')
  assert.equal(task.gateStates![0].after, 'after1-new')
  assert.equal(task.gateStates![0].ask, 'ask1-new')
})

test('initGateStates 新增 gate 不影响已有', () => {
  const task = makeTask()
  initGateStates(task, [{ id: 'g1', after: 'a1', ask: 'q1' }])
  confirmGate(task, 'g1', undefined, 'passed')
  const before = task.gateStates![0]
  initGateStates(task, [
    { id: 'g1', after: 'a1', ask: 'q1' },
    { id: 'g2', after: 'a2', ask: 'q2' },
  ])
  assert.equal(task.gateStates!.length, 2)
  assert.equal(task.gateStates![0].gateId, 'g1')
  assert.equal(task.gateStates![0].status, 'passed')
  assert.equal(task.gateStates![1].gateId, 'g2')
  assert.equal(task.gateStates![1].status, 'pending')
})

test('checkGateBeforeAdvance pending + 关联 → 拦截；passed → 放行', () => {
  const task = makeTask()
  initGateStates(task, [{ id: 'prd-confirmed', after: '产出 01-prd.md', ask: 'PRD' }])
  const block1 = checkGateBeforeAdvance(task, '产出 01-prd.md 阶段产物')
  assert.ok(block1)
  assert.equal(block1!.gateId, 'prd-confirmed')
  confirmGate(task, 'prd-confirmed', undefined, 'passed')
  const block2 = checkGateBeforeAdvance(task, '产出 01-prd.md 阶段产物')
  assert.equal(block2, null)
})

test('checkGateBeforeAdvance 不匹配的条目 → 放行', () => {
  const task = makeTask()
  initGateStates(task, [{ id: 'prd-confirmed', after: '产出 01-prd.md', ask: 'PRD' }])
  assert.equal(checkGateBeforeAdvance(task, '编码阶段'), null)
})

test('confirmGate 未知 gateId 抛错', () => {
  const task = makeTask()
  initGateStates(task, [{ id: 'g1', after: 'a', ask: 'q' }])
  assert.throws(() => confirmGate(task, 'nonexistent'), /unknown gateId/)
})

test('findGateForStageDoc 匹配文件路径', () => {
  const task = makeTask()
  initGateStates(task, [{ id: 'prd-confirmed', after: '产出 01-prd.md', ask: 'PRD' }])
  const hit = findGateForStageDoc(task, 'docs/v1.0/01-prd.md')
  assert.ok(hit)
  assert.equal(hit!.gateId, 'prd-confirmed')
})

test('findGateForStageDoc 不匹配返回 null', () => {
  const task = makeTask()
  initGateStates(task, [{ id: 'prd-confirmed', after: '产出 01-prd.md', ask: 'PRD' }])
  assert.equal(findGateForStageDoc(task, 'src/index.ts'), null)
})

test('isDocDrivenAgent planPrompt=doc-driven → true', () => {
  const agent = {
    id: '@coder',
    name: 'coder',
    defaultSkillIds: [],
    alwaysOnSkillIds: [],
  } as unknown as Parameters<typeof isDocDrivenAgent>[0]
  const alwaysOnSkills = [
    { id: 'S-core.react-core-skills', name: '文档驱动', planPrompt: 'doc-driven' } as never,
  ]
  assert.equal(isDocDrivenAgent(agent, alwaysOnSkills), true)
})

test('isDocDrivenAgent 默认 agent → false', () => {
  const agent = {
    id: '@general',
    name: 'general',
    defaultSkillIds: [],
    alwaysOnSkillIds: [],
  } as unknown as Parameters<typeof isDocDrivenAgent>[0]
  assert.equal(isDocDrivenAgent(agent, []), false)
})
