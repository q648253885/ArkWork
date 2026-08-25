/* ============================================================
 * v0.25.0 F1 — prompt-contract.ts 单测
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/agent/prompt/__tests__/contract.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerPromptSection,
  resetPromptSectionRegistry,
  getRegisteredPromptSections,
  validatePromptSectionContract,
  assertSectionBudget,
  type PromptSectionContract,
} from '../contract.js'
import type { SystemPromptContext } from '../../prompt-assembly.js'

function makeCtx(): SystemPromptContext {
  return {
    agent: { id: '@t', name: 't' } as SystemPromptContext['agent'],
    workspaceDir: '/tmp/ws',
  }
}

test.beforeEach(() => {
  resetPromptSectionRegistry()
})

test('registerPromptSection 拒绝重复 id', () => {
  const c: PromptSectionContract = {
    id: 'dup',
    order: 0,
    slot: { kind: 'system' },
    stability: 'static',
    owner: 'core',
    maxTokens: 100,
    required: false,
    build: async () => 'hello',
  }
  registerPromptSection(c)
  assert.throws(() => registerPromptSection({ ...c }), /duplicate section id/)
})

test('validatePromptSectionContract 拒绝 system slot + volatile stability', () => {
  assert.throws(
    () =>
      validatePromptSectionContract({
        id: 'bad',
        order: 0,
        slot: { kind: 'system' },
        stability: 'volatile',
        owner: 'core',
        maxTokens: 100,
        required: false,
        build: async () => 'x',
      }),
    /volatile content must not enter system prompt/,
  )
})

test('getRegisteredPromptSections 按注册序返回', () => {
  registerPromptSection({
    id: 'a',
    order: 0,
    slot: { kind: 'system' },
    stability: 'static',
    owner: 'core',
    maxTokens: 100,
    required: false,
    build: async () => 'a',
  })
  registerPromptSection({
    id: 'b',
    order: 0,
    slot: { kind: 'system' },
    stability: 'static',
    owner: 'core',
    maxTokens: 100,
    required: false,
    build: async () => 'b',
  })
  const list = getRegisteredPromptSections()
  assert.deepEqual(list.map((c) => c.id), ['a', 'b'])
})

test('assertSectionBudget 超预算返回 overBudget=true', () => {
  // 4000 chars ≈ 1300 tokens（按 3 字/token 估算），maxTokens=10 → 超
  const report = assertSectionBudget({ id: 'big', text: 'x'.repeat(4000), maxTokens: 10 })
  assert.equal(report.overBudget, true)
  assert.ok(report.tokens > 10)
})

test('assertSectionBudget 在预算内 overBudget=false', () => {
  const report = assertSectionBudget({ id: 'small', text: 'hi', maxTokens: 100 })
  assert.equal(report.overBudget, false)
})

test('validate 允许 message-tail + volatile（不抛错）', () => {
  validatePromptSectionContract({
    id: 'transient',
    order: 0,
    slot: { kind: 'message-tail' },
    stability: 'volatile',
    owner: 'user',
    maxTokens: 100,
    required: false,
    build: async () => 'x',
  })
})

test('section.build 返回 null 表示本段省略', async () => {
  const c: PromptSectionContract = {
    id: 'nullable',
    order: 0,
    slot: { kind: 'system' },
    stability: 'run-static',
    owner: 'core',
    maxTokens: 100,
    required: false,
    build: async () => null,
  }
  registerPromptSection(c)
  const built = await c.build(makeCtx())
  assert.equal(built, null)
})
