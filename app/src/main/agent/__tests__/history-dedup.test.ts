/* ============================================================
 * v0.34.x — 历史降噪（问候循环修复）行为单测
 *
 * 实测根因（T-20260918-4c1l4h，qwen3.5:9b）：
 *  ① 引擎每轮迭代写一条 plan_status 进 L1，assembleMessages 全量回放
 *    （单任务 30+ 条「[清单状态…]/[NOW]…」噪声块），用户指令被淹没，
 *    模型对「帮我分析一下整个工作区」回复问候语；
 *  ② 计划被中断收口后全部条目 cancelled（死计划），却仍注入
 *    「请严格按此计划执行」+ system「计划执行约束」；
 *  ③ 空 assistant 回合被回放，诱导模型继续空产出。
 *  ④ 死清单使无工具调用守卫（unfinishedCount=0）失效，纯文本问候被
 *    判「最终答复」→ 任务 done → 用户重发 → 再问候（循环）。
 *
 * 覆盖：
 *  - decideHistoryDedup 纯函数真值表（最新下标选取 / 归档排除 / 死计划判定）
 *  - messages.ts 装配接线源契约（判定必须真实接入装配路径 —— D38-a 教训）
 *  - sections.ts 计划执行约束对死计划静默
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/__tests__/history-dedup.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { decideHistoryDedup } from '../engine/messages.js'

/* ---------- decideHistoryDedup 纯函数真值表 ---------- */

const item = (kind?: string, archivedAt?: number) => ({ kind, archivedAt })

test('decideHistoryDedup: 取各类别的最后一条下标，归档条目不参与', () => {
  const items = [
    item('plan'), // 0 旧计划快照
    item('plan_status'), // 1 旧状态
    item('user_message'),
    item('plan'), // 3 新计划快照
    item('plan_status', 123), // 4 已归档状态（不参与）
    item('plan_status'), // 5 最新状态
    item('skill_instruction'), // 6
    item('skill_instruction'), // 7 最新指令
  ]
  const d = decideHistoryDedup(items, undefined)
  assert.equal(d.lastPlanIdx, 3)
  assert.equal(d.lastPlanStatusIdx, 5)
  assert.equal(d.lastSkillInstructionIdx, 7)
})

test('decideHistoryDedup: 空历史 → 全部 -1', () => {
  const d = decideHistoryDedup([], [{ status: 'pending' }])
  assert.equal(d.lastPlanIdx, -1)
  assert.equal(d.lastPlanStatusIdx, -1)
  assert.equal(d.lastSkillInstructionIdx, -1)
})

test('decideHistoryDedup: 死计划（全部终态）→ planDead=true', () => {
  for (const statuses of [
    ['cancelled'],
    ['cancelled', 'failed', 'skipped'],
    ['done', 'cancelled'],
  ]) {
    const d = decideHistoryDedup([], statuses.map((status) => ({ status })))
    assert.equal(d.planDead, true, `statuses=${statuses.join(',')} 应判死计划`)
  }
})

test('decideHistoryDedup: 有 pending/running → 非死计划', () => {
  for (const statuses of [
    ['pending'],
    ['running'],
    ['done', 'pending'],
    ['cancelled', 'running'],
  ]) {
    const d = decideHistoryDedup([], statuses.map((status) => ({ status })))
    assert.equal(d.planDead, false, `statuses=${statuses.join(',')} 不应判死计划`)
  }
})

test('decideHistoryDedup: planItems 空/未定义 → 不算死（老任务向后兼容）', () => {
  assert.equal(decideHistoryDedup([], []).planDead, false)
  assert.equal(decideHistoryDedup([], undefined).planDead, false)
})

/* ---------- 装配接线源契约（判定必须真实接入装配路径） ---------- */

const messagesSrc = readFileSync(
  fileURLToPath(new URL('../engine/messages.ts', import.meta.url)),
  'utf-8',
)

test('v0.34.x: assembleMessages 接线 decideHistoryDedup（判定接入装配）', () => {
  assert.match(
    messagesSrc,
    /decideHistoryDedup\(items,\s*task\.planItems\)/,
    '装配入口必须调用 decideHistoryDedup',
  )
})

test('v0.34.x: plan_status 摘出历史位置、最新一条置尾、死计划静默', () => {
  // 按 kind 匹配（图路径 role='user' / 扁平路径 role='assistant' 两形态统一）
  assert.match(messagesSrc, /if\s*\(\s*m\.kind\s*===\s*'plan_status'\s*\)/)
  // 置尾消息变量 + 末尾注入
  assert.match(messagesSrc, /planStatusTail/)
  assert.match(
    messagesSrc,
    /if\s*\(planStatusTail\)\s*messages\.push\(planStatusTail\)/,
    '最新清单状态必须置于消息列表末尾',
  )
  // 死计划静默
  assert.match(messagesSrc, /!dedup\.planDead && idx === dedup\.lastPlanStatusIdx/)
})

test('v0.34.x: plan 只注入最新一条且死计划不注入', () => {
  assert.match(
    messagesSrc,
    /if\s*\(dedup\.planDead\s*\|\|\s*idx !== dedup\.lastPlanIdx\)\s*continue/,
  )
})

test('v0.34.x: skill_instruction 只注入最新一条（补齐注释声称的去重）', () => {
  assert.match(messagesSrc, /if\s*\(idx !== dedup\.lastSkillInstructionIdx\)\s*continue/)
})

test('v0.34.x: 空 assistant 回合（无 toolCalls）不回放', () => {
  assert.match(
    messagesSrc,
    /if\s*\(!toolCalls && typeof m\.content === 'string' && !m\.content\.trim\(\)\)\s*continue/,
    '哑回合必须跳过；带 toolCalls 的空 content 不受影响',
  )
})

/* ---------- sections.ts：死计划不再注入「计划执行约束」 ---------- */

const sectionsSrc = readFileSync(
  fileURLToPath(new URL('../prompt/sections.ts', import.meta.url)),
  'utf-8',
)

test('v0.34.x: 计划执行约束段对死计划静默（与装配 planDead 同口径）', () => {
  const constraintIdx = sectionsSrc.indexOf('## 计划执行约束')
  assert.ok(constraintIdx > 0, '计划执行约束段应存在')
  const head = sectionsSrc.slice(Math.max(0, constraintIdx - 1200), constraintIdx)
  assert.match(
    head,
    /hasActionable[\s\S]*pending[\s\S]*running[\s\S]*if\s*\(!hasActionable\)\s*return null/,
    '约束段构建前必须做死计划判定并静默',
  )
})
