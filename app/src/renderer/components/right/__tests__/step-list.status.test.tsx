/* ============================================================
 * v0.14.0 Task 8 — PlanItem 六态 UI 映射单测
 * 运行方式（纯函数无 React/DOM 依赖，node:test 直跑）：
 *   cd app
 *   npx tsx --test src/renderer/components/right/__tests__/step-list.status.test.tsx
 * 覆盖：
 *   1. 六态 → 颜色/文案/语义标记映射表断言（PLAN_STATUS_META 全量 6 态）
 *   2. 六态 → CSS class 映射断言（planStatusTextClass）
 *   3. 任务行清单聚合（aggregatePlanStatus：全部 done / 任一 failed / running / cancelled / skipped / 空）
 *   4. prefers-reduced-motion 媒体查询存在性（读取 globals.css 断言）
 *   5. 清单行工具调用分段（planItemToolSteps）
 *   6. derivePlanItems：无 plan 返回空数组（不再展示 5 步兜底）
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { PlanItemStatus } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import {
  PLAN_STATUS_META,
  planStatusTextClass,
  aggregatePlanStatus,
  planItemToolSteps,
  derivePlanItems,
} from '../../../utils/plan-status'

/** 六态全集 — 必须与 PlanItemStatus 枚举严格一致 */
const ALL_STATES: readonly PlanItemStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled', 'skipped']

test('六态映射表覆盖全部 6 个状态（无缺失 / 无多余）', () => {
  assert.deepEqual(
    [...Object.keys(PLAN_STATUS_META)].sort(),
    [...ALL_STATES].sort(),
    'PLAN_STATUS_META 键集合应恰好等于六态枚举',
  )
})

test('六态 → 颜色映射：全部引用 globals.css 既有 token（无魔法色值）', () => {
  const expected: [PlanItemStatus, string][] = [
    ['pending', 'var(--text-tertiary)'], // 灰
    ['running', 'var(--accent)'],        // 蓝
    ['done', 'var(--success)'],          // 绿
    ['failed', 'var(--danger)'],         // 红
    ['cancelled', 'var(--text-tertiary)'], // 灰
    ['skipped', 'var(--warning)'],       // 黄
  ]
  for (const [state, color] of expected) {
    assert.equal(PLAN_STATUS_META[state].color, color, `${state} 应映射到 ${color}`)
  }
})

test('六态 → 文案与语义标记（删除线 / 动画 / 终态）', () => {
  assert.deepEqual(
    {
      pending: { ...PLAN_STATUS_META.pending },
      running: { ...PLAN_STATUS_META.running },
      done: { ...PLAN_STATUS_META.done },
      failed: { ...PLAN_STATUS_META.failed },
      cancelled: { ...PLAN_STATUS_META.cancelled },
      skipped: { ...PLAN_STATUS_META.skipped },
    },
    {
      pending:   { label: 'plantatus.waiting',   color: 'var(--text-tertiary)', strikethrough: false, animated: false, terminal: false },
      running:   { label: 'plantatus.running',   color: 'var(--accent)',        strikethrough: false, animated: true,  terminal: false },
      done:      { label: 'plantatus.done',      color: 'var(--success)',       strikethrough: true,  animated: false, terminal: true },
      failed:    { label: 'plantatus.failed',    color: 'var(--danger)',        strikethrough: false, animated: false, terminal: true },
      cancelled: { label: 'plantatus.cancelled', color: 'var(--text-tertiary)', strikethrough: true,  animated: false, terminal: true },
      skipped:   { label: 'plantatus.skipped',   color: 'var(--warning)',       strikethrough: false, animated: false, terminal: true },
    },
  )
})

test('六态 → CSS class 映射（planStatusTextClass）', () => {
  assert.equal(planStatusTextClass('pending'), 'text-text-secondary')
  assert.equal(planStatusTextClass('running'), 'text-accent')
  assert.equal(planStatusTextClass('done'), 'text-text-tertiary line-through decoration-success')
  assert.equal(planStatusTextClass('failed'), 'text-danger')
  assert.equal(planStatusTextClass('cancelled'), 'text-text-tertiary line-through')
  assert.equal(planStatusTextClass('skipped'), 'text-warning')
})

test('任务行清单聚合（aggregatePlanStatus）', () => {
  // 全部 done → 任务行视为 done
  assert.equal(aggregatePlanStatus(['done', 'done']), 'done')
  // 任一 failed 优先 → failed
  assert.equal(aggregatePlanStatus(['done', 'failed']), 'failed')
  // 任一 running → running
  assert.equal(aggregatePlanStatus(['done', 'running']), 'running')
  // 任一 cancelled → cancelled
  assert.equal(aggregatePlanStatus(['done', 'cancelled']), 'cancelled')
  // 任一 skipped → skipped
  assert.equal(aggregatePlanStatus(['pending', 'skipped']), 'skipped')
  // 全部 pending → pending
  assert.equal(aggregatePlanStatus(['pending', 'pending']), 'pending')
  // 空 / 缺失 → undefined（调用方回退任务级状态）
  assert.equal(aggregatePlanStatus([]), undefined)
  assert.equal(aggregatePlanStatus(undefined), undefined)
  assert.equal(aggregatePlanStatus(null), undefined)
})

test('reduced-motion：globals.css 存在 prefers-reduced-motion 媒体查询且停用动画', () => {
  const cssPath = fileURLToPath(new URL('../../../styles/globals.css', import.meta.url))
  const css = readFileSync(cssPath, 'utf8')
  assert.match(
    css,
    /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    'globals.css 应包含 prefers-reduced-motion 媒体查询',
  )
  assert.match(
    css,
    /animation-duration:\s*0\.01ms\s*!important/,
    'reduce 分支应把动画时长归零（停止 running 蓝脉冲等动画）',
  )
  // 运行中动画标记存在 → 与全局 reduce 规则配套
  assert.equal(PLAN_STATUS_META.running.animated, true, 'running 应声明动画（由 reduce 规则停用）')
})

test('清单行工具调用分段（planItemToolSteps）', () => {
  const mk = (id: string, tool: string, startedAt: number): ReActStep =>
    ({
      id,
      taskId: 't1',
      iteration: 1,
      type: 'act',
      toolName: tool,
      startedAt,
      durationMs: 100,
      status: 'success',
    }) as ReActStep

  const steps: ReActStep[] = [
    mk('a1', 'file-reader', 1000),
    mk('a2', 'file-reader', 2000),
    mk('a3', 'web-search', 3000),
  ]
  // 第 0 段 = file-reader 两次调用
  assert.deepEqual(planItemToolSteps(steps, 0).map((s) => s.id), ['a1', 'a2'])
  // 第 1 段 = web-search 一次调用
  assert.deepEqual(planItemToolSteps(steps, 1).map((s) => s.id), ['a3'])
  // 越界 → 空数组（不抛错）
  assert.deepEqual(planItemToolSteps(steps, 5), [])
})

test('derivePlanItems：无真实 plan 时返回空数组（不再返回 5 步兜底）', () => {
  // 空 steps → 空数组
  assert.deepEqual(derivePlanItems([]), [])
  // 只有 act 步骤、无 plan 步骤 → 空数组（不再按工具切换分段派生）
  const actSteps: ReActStep[] = [
    {
      id: 'a1',
      taskId: 't1',
      iteration: 1,
      type: 'act',
      toolName: 'file-reader',
      startedAt: 1000,
      durationMs: 100,
      status: 'success',
    } as unknown as ReActStep,
    {
      id: 'a2',
      taskId: 't1',
      iteration: 1,
      type: 'act',
      toolName: 'web-search',
      startedAt: 2000,
      durationMs: 100,
      status: 'success',
    } as unknown as ReActStep,
  ]
  assert.deepEqual(derivePlanItems(actSteps), [])
  // 仅 reason 类型 → 仍然空数组
  const reasonStep: ReActStep = {
    id: 'r1',
    taskId: 't1',
    iteration: 1,
    type: 'reason',
    content: 'thinking',
    startedAt: 1000,
    durationMs: 50,
    status: 'success',
  } as unknown as ReActStep
  assert.deepEqual(derivePlanItems([reasonStep]), [])
  // 真实 plan 步骤存在 → 取其 items
  const planStep: ReActStep = {
    id: 'p1',
    taskId: 't1',
    iteration: 1,
    type: 'plan',
    startedAt: 1000,
    durationMs: 0,
    plan: { items: ['步骤 A', '步骤 B'], goal: '目标' },
    status: 'success',
  } as unknown as ReActStep
  assert.deepEqual(derivePlanItems([planStep]), ['步骤 A', '步骤 B'])
  // 真实 plan.items 为空 → 回退空数组
  const emptyPlan: ReActStep = {
    id: 'p2',
    taskId: 't1',
    iteration: 1,
    type: 'plan',
    startedAt: 1000,
    durationMs: 0,
    plan: { items: [], goal: '目标' },
    status: 'success',
  } as unknown as ReActStep
  assert.deepEqual(derivePlanItems([emptyPlan]), [])
})
