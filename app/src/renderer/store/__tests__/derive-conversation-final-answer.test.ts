/* ============================================================
 * TC-FIN —— v0.44.1（D219）最终答复派生回归
 *
 * 缺陷现场（T-20261002-2k584x · 2026-10-02）：模型调 `task-complete`
 * （连字符孪生）且 args.summary 携带完整四段式总结；旧版归一化晚于
 * step 落盘，steps.jsonl 存有原始拼写。deriveConversation 用正名
 * `task_complete` 精确匹配落空 → isFinalAnswer 为 false → **最终答复
 * 整条不渲染**，用户只看到最后一轮过程旁白（"报告已落盘。现在同步清单
 * 状态并收尾。"）。
 *
 * 本套件钉住（读侧容错，历史数据无需迁移）：
 *   ① 孪生拼写 `task-complete` 仍派生出 assistant 最终答复，text = summary 全文；
 *   ② 正名 `task_complete` 行为不变（防放宽过度）；
 *   ③ 孪生拼写 `ask-user` 同样派生 assistant 消息（同型缺陷）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type { MemoryItem } from '@shared/types/memory'

import { deriveConversation } from '../derive-conversation'

function makeTask(): Task {
  return {
    id: 'T-TEST-D219',
    workspaceId: 'ws',
    title: 't',
    status: 'done',
    agentId: '@@default',
    skillIds: [],
    mcpIds: [],
    modelId: 'm',
    input: { text: '对比报告任务' },
    config: {} as Task['config'],
    createdAt: 1000,
    updatedAt: 1000,
    startedAt: 1000,
    completedAt: 2000,
    parentTaskId: null,
    tags: [],
  }
}

function reasonStep(overrides: Partial<ReActStep>): ReActStep {
  return {
    id: 's1',
    taskId: 'T-TEST-D219',
    iteration: 1,
    type: 'reason',
    thought: '内部推理',
    startedAt: 1100,
    durationMs: 10,
    status: 'success',
    ...overrides,
  } as ReActStep
}

function answersOf(items: ReturnType<typeof deriveConversation>): Array<{ text: string }> {
  return items.filter((i) => i.type === 'assistant') as Array<{ text: string }>
}

test('TC-FIN-001: 连字符孪生 task-complete 仍派生最终答复（D219 回归 · 实机缺陷形态）', () => {
  const summary = '已完成对比分析。\n\n**结论先行**：差距不来自语言。'
  const steps = [
    reasonStep({
      action: { tool: 'task-complete', args: { summary } },
    } as Partial<ReActStep>),
  ]
  const items = deriveConversation(makeTask(), steps, [] as MemoryItem[])
  const answers = answersOf(items)
  assert.equal(answers.length, 1, '孪生拼写不得丢最终答复')
  assert.equal(answers[0]!.text, summary, '最终答复必须携带 task_complete 的 summary 全文')
})

test('TC-FIN-002: 正名 task_complete 行为不变', () => {
  const steps = [
    reasonStep({
      action: { tool: 'task_complete', args: { summary: '正名答复' } },
    } as Partial<ReActStep>),
  ]
  const answers = answersOf(deriveConversation(makeTask(), steps, [] as MemoryItem[]))
  assert.equal(answers.length, 1)
  assert.equal(answers[0]!.text, '正名答复')
})

test('TC-FIN-003: 连字符孪生 ask-user 同样派生 assistant 消息（同型缺陷）', () => {
  const steps = [
    reasonStep({
      action: { tool: 'ask-user', args: { question: '要先跑测试还是先拆分？' } },
    } as Partial<ReActStep>),
  ]
  const answers = answersOf(deriveConversation(makeTask(), steps, [] as MemoryItem[]))
  assert.equal(answers.length, 1, '孪生拼写不得丢提问消息')
  assert.equal(answers[0]!.text, '要先跑测试还是先拆分？')
})

test('TC-FIN-004: 普通工具轮不派生 assistant 消息（防放宽过度）', () => {
  const steps = [
    reasonStep({
      action: { tool: 'file-reader', args: { path: 'a.md' } },
    } as Partial<ReActStep>),
  ]
  const answers = answersOf(deriveConversation(makeTask(), steps, [] as MemoryItem[]))
  assert.equal(answers.length, 0)
})
