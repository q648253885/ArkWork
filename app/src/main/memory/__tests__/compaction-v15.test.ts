/* ============================================================
 * v0.15.0 上下文压缩单测
 * 覆盖：阈值计算、prune 阶段、buildSummarizePrompt、keep.tokens、fuse 机制
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/memory/__tests__/compaction-v15.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getEffectiveContextWindow,
  getAutoCompactThreshold,
  getWarningThreshold,
  getBlockingThreshold,
  classifyTokenUsage,
  MAX_CONSECUTIVE_FAILURES,
  KEEP_TOKENS,
  PRUNE_PROTECT,
  PRUNE_MINIMUM,
  pruneStage,
  buildSummarizePrompt,
  sliceRecentContext,
  computeTwoStageCompactionPlan,
  recordCompactionFailure,
  recordCompactionSuccess,
  isAutoCompactDisabled,
  resetFuseState,
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_SUMMARY_TEMPLATE,
} from '../compaction.js'
import type { L1Snapshot, MemoryItem } from '@shared/types/memory'

/* ============================================================
 * 辅助：构造完整 MemoryItem
 * ============================================================ */
function makeItem(
  over: Partial<MemoryItem> & { id: string; role: MemoryItem['role'] },
): MemoryItem {
  return {
    taskId: 'T-test-1',
    layer: 'L1',
    kind: 'observation',
    content: '',
    enabled: true,
    iteration: 0,
    tokens: 0,
    createdAt: Date.now(),
    archivedAt: null,
    ...over,
  }
}

function makeUser(id: string, iteration: number, createdAt: number): MemoryItem {
  return makeItem({
    id,
    role: 'user',
    kind: 'user_message',
    content: '用户提问',
    iteration,
    createdAt,
    tokens: 8,
  })
}

function makeTool(id: string, iteration: number, createdAt: number, tokens: number): MemoryItem {
  return makeItem({
    id,
    role: 'tool',
    kind: 'observation',
    content: 'x'.repeat(2000),
    iteration,
    createdAt,
    tokens,
  })
}

/* ============================================================
 * 1. 阈值计算
 * ============================================================ */

test('阈值: 200K 模型下 autoCompact 阈值 ≈ 167K', () => {
  const threshold = getAutoCompactThreshold(200_000)
  assert.ok(threshold > 165_000 && threshold < 170_000, `实际 ${threshold}`)
})

test('阈值: 200K 模型下 blocking 阈值 > autoCompact > warning', () => {
  const warning = getWarningThreshold(200_000)
  const auto = getAutoCompactThreshold(200_000)
  const blocking = getBlockingThreshold(200_000)
  assert.ok(warning < auto)
  assert.ok(auto < blocking)
})

test('effectiveContextWindow = modelMax - reserved', () => {
  const w = getEffectiveContextWindow(200_000)
  assert.equal(w, 200_000 - 20_000)
})

test('classifyTokenUsage: 200K 模型下四级判定', () => {
  assert.equal(classifyTokenUsage(150_000, 200_000), 'normal')
  assert.equal(classifyTokenUsage(165_000, 200_000), 'warning')
  assert.equal(classifyTokenUsage(170_000, 200_000), 'autoCompact')
  assert.equal(classifyTokenUsage(178_000, 200_000), 'blocking')
})

/* ============================================================
 * 2. prune 阶段
 * ============================================================ */

test('pruneStage: 小于 PRUNE_MINIMUM 不裁剪', () => {
  const items: MemoryItem[] = [makeTool('o-0', 1, 1, 100)]
  const r = pruneStage(items)
  assert.equal(r.savedTokens, 0)
  assert.equal(r.prunedIds.length, 0)
})

test('pruneStage: 多个 tool 输出超过阈值则裁剪占位符', () => {
  // 结构：3 个 user turn；第 1 与第 2 个 user turn 之间 100 个 tool 输出（各 1000 tokens）
  // 走查：最近 2 个 user turn 内的 tool 输出受保护，第 1 个 user turn 后的 tool 输出
  // 先累积 PRUNE_PROTECT(40K) 保护额度，超出部分进入 candidates；saved > PRUNE_MINIMUM(20K) 才裁剪
  const items: MemoryItem[] = [
    ...Array.from({ length: 100 }).map((_, i) => makeTool(`o-${i}`, i + 1, i + 1, 1000)),
    makeUser('u-mid', 101, 1000),
    makeUser('u-last', 102, 2000),
  ]
  const r = pruneStage(items)
  assert.ok(r.prunedIds.length > 0)
  const pruned = r.items.find((m) => m.id === r.prunedIds[0])
  assert.equal(pruned?.content, '[output compacted]')
})

/* ============================================================
 * 3. summarize / keep.tokens
 * ============================================================ */

test('computeTwoStageCompactionPlan: 生成摘要 + 保留最近上下文', () => {
  const items: MemoryItem[] = Array.from({ length: 10 }).map((_, i) =>
    makeItem({ id: `m-${i}`, role: 'assistant', kind: 'reasoning', content: 'x'.repeat(400), iteration: i, createdAt: i, tokens: 100 }),
  )
  const l1: L1Snapshot = { taskId: 't', items, budgetTokens: 100_000, createdAt: 0 }
  const plan = computeTwoStageCompactionPlan(l1, 300)
  assert.ok(plan.summary.length > 0)
  assert.ok(plan.recentContext.length > 0)
  assert.ok(plan.tokenAfter < plan.tokenBefore)
})

test('sliceRecentContext: keepTokens 边界裁剪', () => {
  const items: MemoryItem[] = Array.from({ length: 10 }).map((_, i) =>
    makeItem({ id: `m-${i}`, role: 'assistant', kind: 'reasoning', content: 'x'.repeat(100), iteration: i, createdAt: i, tokens: 50 }),
  )
  const { recentContext, dropped } = sliceRecentContext(items, 120)
  assert.ok(recentContext.length > 0)
  assert.ok(dropped.length > 0)
  assert.equal(recentContext.length + dropped.length, 10)
})

test('v0.23.2 sliceRecentContext: user_message 永不归档（交互区用户输入不消失）', () => {
  const items: MemoryItem[] = [
    makeItem({ id: 'u1', role: 'user', kind: 'user_message', content: '第一轮指令', iteration: 0, createdAt: 0, tokens: 10 }),
    ...Array.from({ length: 10 }).map((_, i) =>
      makeItem({ id: `m-${i}`, role: 'assistant', kind: 'reasoning', content: 'x'.repeat(100), iteration: i + 1, createdAt: i + 1, tokens: 50 }),
    ),
  ]
  const { recentContext, dropped } = sliceRecentContext(items, 120)
  // 预算只够保留 ~2 条，但 user_message 必须钉在 recentContext
  assert.ok(dropped.length > 0)
  assert.ok(recentContext.some((m) => m.id === 'u1'), 'user_message 不应被归档')
  assert.ok(!dropped.some((m) => m.id === 'u1'))
  // 顺序保持
  assert.ok(recentContext.findIndex((m) => m.id === 'u1') === 0)
})

test('buildSummarizePrompt: 拼接 items 并附带模板', () => {
  const items: MemoryItem[] = [
    makeItem({ id: 'a', role: 'user', kind: 'user_message', content: 'hello', iteration: 0, createdAt: 0 }),
    makeItem({ id: 'b', role: 'assistant', kind: 'reasoning', content: 'world', iteration: 1, createdAt: 1 }),
  ]
  const prompt = buildSummarizePrompt(items)
  assert.ok(prompt.includes('hello'))
  assert.ok(prompt.includes('world'))
  assert.ok(prompt.includes('## 输出格式'))
  assert.ok(prompt.includes(COMPACTION_SUMMARY_TEMPLATE))
})

test('buildSummarizePrompt: 自定义指令注入', () => {
  const items: MemoryItem[] = [
    makeItem({ id: 'a', role: 'user', kind: 'user_message', content: '保留测试输出', iteration: 0, createdAt: 0 }),
  ]
  const prompt = buildSummarizePrompt(items, '保留测试输出')
  assert.ok(prompt.includes('## 额外保留要求'))
  assert.ok(prompt.includes('保留测试输出'))
})

/* ============================================================
 * 4. 熔断机制
 * ============================================================ */

test('fuse: 连续失败 3 次后禁用自动压缩', () => {
  resetFuseState()
  assert.equal(isAutoCompactDisabled(), false)
  recordCompactionFailure()
  recordCompactionFailure()
  assert.equal(isAutoCompactDisabled(), false)
  recordCompactionFailure()
  assert.equal(isAutoCompactDisabled(), true)
  assert.equal(MAX_CONSECUTIVE_FAILURES, 3)
  recordCompactionSuccess()
  assert.equal(isAutoCompactDisabled(), false)
})

/* ============================================================
 * 5. 常量和模板非空
 * ============================================================ */

test('常量和模板非空', () => {
  assert.ok(KEEP_TOKENS > 0)
  assert.ok(PRUNE_PROTECT > 0)
  assert.ok(PRUNE_MINIMUM > 0)
  assert.ok(COMPACTION_SYSTEM_PROMPT.length > 100)
  assert.ok(COMPACTION_SUMMARY_TEMPLATE.includes('Objective'))
  assert.ok(COMPACTION_SUMMARY_TEMPLATE.includes('Next moves'))
})