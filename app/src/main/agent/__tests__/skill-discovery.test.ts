/* ============================================================
 * v0.19.0 M5 — skill-discovery.ts 纯函数单测
 *
 * 覆盖验收断言：
 *  1. 分层合并：project > user > bundled 优先级
 *  2. 同名遮蔽：同 id 高优先级层覆盖低优先级层
 *  3. 作用域过滤：scopes 空 = 全局；含 agentId 可见；否则隐藏
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/__tests__/skill-discovery.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSkillsByLayer, filterSkillsByScope } from '../skill-discovery.js'
import type { SkillLayer } from '../skill-discovery.js'
import type { Skill as SkillType } from '@shared/types/agent'

function makeSkill(id: string, layer?: SkillLayer, scopes?: string[]): SkillType {
  return {
    id,
    name: id,
    description: `desc of ${id}`,
    namespace: 'test',
    source: 'custom',
    enabled: true,
    ...(layer ? { layer } : {}),
    ...(scopes ? { scopes } : {}),
  }
}

/* ---------- mergeSkillsByLayer：分层合并 + 同名遮蔽 ---------- */

test('mergeSkillsByLayer: 无重叠 id 时合并全部技能', () => {
  const merged = mergeSkillsByLayer([
    { layer: 'bundled', skills: [makeSkill('a'), makeSkill('b')] },
    { layer: 'user', skills: [makeSkill('c')] },
    { layer: 'project', skills: [makeSkill('d')] },
  ])
  assert.deepEqual(
    merged.map((s) => s.id).sort(),
    ['a', 'b', 'c', 'd'],
  )
})

test('mergeSkillsByLayer: 同名 id 由 project 层遮蔽 user/bundled', () => {
  const merged = mergeSkillsByLayer([
    { layer: 'bundled', skills: [makeSkill('x', 'bundled', ['global'])] },
    { layer: 'user', skills: [makeSkill('x', 'user', ['user-scope'])] },
    { layer: 'project', skills: [makeSkill('x', 'project')] },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.layer, 'project')
  assert.equal(merged[0]!.scopes, undefined)
})

test('mergeSkillsByLayer: 同名 id 由 user 层遮蔽 bundled', () => {
  const merged = mergeSkillsByLayer([
    { layer: 'bundled', skills: [makeSkill('y', 'bundled')] },
    { layer: 'user', skills: [makeSkill('y', 'user', ['@agent-1'])] },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.layer, 'user')
  assert.deepEqual(merged[0]!.scopes, ['@agent-1'])
})

test('mergeSkillsByLayer: 合并结果为每个 id 打上其来源 layer 标签', () => {
  const merged = mergeSkillsByLayer([
    { layer: 'bundled', skills: [makeSkill('b1')] },
    { layer: 'user', skills: [makeSkill('u1')] },
    { layer: 'project', skills: [makeSkill('p1')] },
  ])
  const byId = Object.fromEntries(merged.map((s) => [s.id, s.layer]))
  assert.equal(byId['b1'], 'bundled')
  assert.equal(byId['u1'], 'user')
  assert.equal(byId['p1'], 'project')
})

/* ---------- filterSkillsByScope：作用域过滤 ---------- */

test('filterSkillsByScope: 无 agentId 返回全部技能', () => {
  const skills = [makeSkill('a', 'user', ['@x']), makeSkill('b', 'user')]
  assert.deepEqual(filterSkillsByScope(skills), skills)
})

test('filterSkillsByScope: scopes 为空/缺省 = 全局可见', () => {
  const skills = [makeSkill('a', 'user'), makeSkill('b', 'user', [])]
  const out = filterSkillsByScope(skills, '@agent-1')
  assert.deepEqual(out.map((s) => s.id), ['a', 'b'])
})

test('filterSkillsByScope: scopes 含 agentId 可见，不含则隐藏', () => {
  const skills = [
    makeSkill('a', 'user', ['@agent-1']),
    makeSkill('b', 'user', ['@agent-2']),
    makeSkill('c', 'user'),
  ]
  const out = filterSkillsByScope(skills, '@agent-1')
  assert.deepEqual(out.map((s) => s.id), ['a', 'c'])
})

test('filterSkillsByScope: scopes 多值含目标 agentId 即可见', () => {
  const skills = [makeSkill('a', 'user', ['@agent-2', '@agent-1'])]
  const out = filterSkillsByScope(skills, '@agent-1')
  assert.equal(out.length, 1)
  assert.equal(out[0]!.id, 'a')
})
