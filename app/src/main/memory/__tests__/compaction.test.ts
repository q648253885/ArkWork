/* ============================================================
 * v0.14.0 Task 12 — Context Compaction 模块单测
 *
 * 覆盖：
 *   1. token 计量正确性（countTokens）
 *   2. compact 后 token 下降（构造 L1 长对话，端到端写回 + 审计）
 *   3. 保留最近 N 轮断言（computeCompaction 纯计算）
 *   4. 关键实体提取断言（extractKeyEntities）
 *
 * 运行方式：
 *   cd app
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/memory/__tests__/compaction.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { countTokens } from '../token-counter.js'
import { computeCompaction, computeTwoStageCompactionPlan, compact, extractKeyEntities, buildSummary } from '../compaction.js'
import { appendL1, listL1, listEnabledL1, clearL1 } from '../l1-working.js'
import { setWorkspaceDir } from '../../store/db.js'
import type { L1Snapshot, MemoryItem } from '@shared/types/memory'

/* ============================================================
 * 1. token 计量正确性
 * ============================================================ */

test('countTokens: 空数组 → 0', () => {
  assert.equal(countTokens([]), 0)
})

test('countTokens: 英文 4 字符 ≈ 1 token', () => {
  assert.equal(countTokens([{ role: 'user', content: 'abcd' }]), 1)
  // 'hello world foo' = 14 chars → ceil(14/4) = 4
  assert.equal(countTokens([{ role: 'assistant', content: 'hello world foo' }]), 4)
})

test('countTokens: 中英文混合', () => {
  // '你好 world'：cjk=2 → 2/1.5≈1.333；other=5 → 5/4=1.25 → ceil(2.583)=3
  assert.equal(countTokens([{ role: 'user', content: '你好 world' }]), 3)
})

/* ============================================================
 * 2. compact 后 token 下降（端到端：真实临时目录 + 写回 + 审计）
 * ============================================================ */

function makeItem(over: Partial<MemoryItem> & { id: string }): MemoryItem {
  return {
    taskId: 'T-test-1',
    layer: 'L1',
    role: 'user',
    kind: 'reasoning',
    content: '',
    enabled: true,
    iteration: 0,
    tokens: 0,
    createdAt: Date.now(),
    archivedAt: null,
    ...over,
  }
}

test('compact: 长对话压缩后保留最近上下文，写回 + 审计', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arkwork-compaction-'))
  setWorkspaceDir(tmp)
  const taskId = 'T-comp-e2e'
  try {
    // 30 轮，每轮 user + assistant 各 ~2000 字符英文 → tokenBefore ≈ 50K（明显超过 keep.tokens 15K）
    for (let iter = 0; iter < 30; iter++) {
      await appendL1({
        taskId,
        role: 'user',
        kind: 'user_message',
        content: `user message round ${iter} ` + 'detail'.repeat(600),
        iteration: iter,
      })
      await appendL1({
        taskId,
        role: 'assistant',
        kind: 'observation',
        content: `assistant action round ${iter} ` + 'step'.repeat(600),
        iteration: iter,
      })
    }

    const items = await listEnabledL1(taskId)
    const snapshot: L1Snapshot = { taskId, items, budgetTokens: 16_000, createdAt: Date.now() }
    const result = await compact(snapshot)

    // v0.15.0：keep.tokens 保留最近 ~15K，早期条目被裁掉并生成摘要 → token 下降
    assert.ok(result.tokenAfter < result.tokenBefore)
    assert.ok(result.tokenAfter > 0)
    assert.ok(result.stats.droppedMessageCount > 0, '早期条目应被裁剪')
    assert.ok(result.keptRounds >= 1)
    assert.equal(typeof result.stats.durationMs, 'number')
    assert.ok(result.summary.length > 0)
    assert.ok(Array.isArray(result.entities))

    // 审计 compaction.log 存在且含关键字段
    const logPath = join(tmp, '.arkwork', 'memory', taskId, 'compaction.log')
    assert.ok(existsSync(logPath), 'compaction.log should exist')
    const lines = (await readFileSync(logPath, 'utf-8')).trim().split('\n').filter(Boolean)
    const log = JSON.parse(lines[lines.length - 1]!)
    assert.equal(log.tokenBefore, result.tokenBefore)
    assert.equal(log.tokenAfter, result.tokenAfter)
    assert.equal(log.keptRounds, result.keptRounds)
    assert.equal(typeof log.durationMs, 'number')
    assert.equal(log.droppedMessageCount, result.stats.droppedMessageCount)

    // L1 写回：追加了 compressed_summary，旧条目已归档
    const after = await listL1(taskId)
    const summaryItem = after.find((m) => m.kind === 'compressed_summary')
    assert.ok(summaryItem, 'compressed_summary should be appended')
    assert.equal(summaryItem!.enabled, true)
    assert.equal(summaryItem!.iteration, -1)
    const archivedCount = after.filter((m) => !m.enabled || m.archivedAt).length
    assert.ok(archivedCount >= result.stats.droppedMessageCount)
  } finally {
    await clearL1(taskId)
    setWorkspaceDir('')
    await rm(tmp, { recursive: true, force: true })
  }
})

/* ============================================================
 * 3. keep.tokens 保留最近上下文（纯计算）
 * ============================================================ */

test('computeCompaction: 数据未超 keep.tokens 时全部保留', () => {
  const items: MemoryItem[] = []
  for (let iter = 0; iter < 5; iter++) {
    items.push(makeItem({ id: `u${iter}`, iteration: iter, content: 'user detail '.repeat(50), role: 'user' }))
    items.push(makeItem({ id: `a${iter}`, iteration: iter, content: 'assistant step '.repeat(50), role: 'assistant' }))
  }
  items.push(makeItem({ id: 'sys', iteration: -1, content: 'system prompt', role: 'system', kind: 'system_prompt' }))

  const snapshot: L1Snapshot = { taskId: 'T-test-1', items, budgetTokens: 100_000, createdAt: 0 }
  // v0.15.0：keep.tokens=15K，测试数据总量远小于该值 → 全部保留，无裁剪
  const plan = computeCompaction(snapshot)

  assert.equal(plan.keptRounds, 5)
  assert.equal(plan.dropped.length, 0, '数据未超 keep.tokens 不应裁剪')
  assert.equal(plan.kept.length, items.length)
})

test('computeCompaction: 超 keep.tokens 保留最近、裁掉最早', () => {
  const items: MemoryItem[] = []
  // 20 轮 × 每项 ~800 字符 ≈ 200 tokens → 总量 ≈ 8K；使用小 keepTokens 覆盖触发裁剪
  for (let iter = 0; iter < 20; iter++) {
    items.push(makeItem({ id: `u${iter}`, iteration: iter, content: 'content '.repeat(200), role: 'user' }))
    items.push(makeItem({ id: `a${iter}`, iteration: iter, content: 'result '.repeat(200), role: 'assistant' }))
  }
  const snapshot: L1Snapshot = { taskId: 'T-test-1', items, budgetTokens: 100_000, createdAt: 0 }
  // 显式紧凑 keepTokens 模拟超预算场景
  const plan = computeTwoStageCompactionPlan(snapshot, 600)

  assert.ok(plan.dropped.length > 0, '超出预算的早期条目应被裁剪')
  assert.ok(plan.recentContext.length > 0)
  // 保留的是最新条目，裁掉的是最旧条目
  const droppedIters = plan.dropped.map((m) => m.iteration)
  const keptIters = plan.recentContext.map((m) => m.iteration)
  assert.ok(Math.max(...droppedIters) <= Math.min(...keptIters), 'kept 应全部比 dropped 更新（允许边界同轮）')
})

test('computeCompaction: 轮数不足时保留全部轮次', () => {
  const items = [
    makeItem({ id: 'u0', iteration: 0, content: 'x'.repeat(80), role: 'user' }),
    makeItem({ id: 'a0', iteration: 0, content: 'y'.repeat(80), role: 'assistant' }),
  ]
  const snapshot: L1Snapshot = { taskId: 'T-test-1', items, budgetTokens: 100_000, createdAt: 0 }
  const plan = computeCompaction(snapshot)
  assert.equal(plan.keptRounds, 1)
  assert.equal(plan.dropped.length, 0)
})

test('buildSummary: 按角色标注合并，超长截断', () => {
  const dropped = [
    makeItem({ id: 'u1', role: 'user', content: '第一轮提问', iteration: 0 }),
    makeItem({ id: 'a1', role: 'assistant', content: '第一轮回答', iteration: 0 }),
  ]
  const summary = buildSummary(dropped)
  assert.match(summary, /【用户】第一轮提问/)
  assert.match(summary, /【助手】第一轮回答/)

  const long = buildSummary([makeItem({ id: 'u2', role: 'user', content: '长'.repeat(5000), iteration: 0 })], 100)
  assert.ok(long.length <= 100 + 6, `summary should be capped, got ${long.length}`)
})

/* ============================================================
 * 4. 关键实体提取断言
 * ============================================================ */

test('extractKeyEntities: 中文高频片段与英文词', () => {
  const ents = extractKeyEntities([
    '数据库连接失败，需要检查数据库配置',
    '数据库迁移脚本需要重跑，配置已更新',
    'vite 配置和 webpack 配置对比',
  ], 6)
  assert.ok(ents.includes('数据库'), `entities should include 数据库, got ${ents.join(',')}`)
  assert.ok(ents.includes('配置'), `entities should include 配置, got ${ents.join(',')}`)
})

test('extractKeyEntities: 英文停用词过滤与词频', () => {
  const ents = extractKeyEntities([
    'database connection failed, check database config',
    'database migration needs rerun and check the config again',
  ], 6)
  assert.ok(ents.includes('database'))
  assert.ok(!ents.includes('the'))
  assert.ok(!ents.includes('and'))
})
