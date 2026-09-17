/* ============================================================
 * v0.31.0 D22 — 引擎自愈提示的「归属修复」契约测试
 *
 * 缺陷（用户实测）：loop.ts 守卫把「任务清单仍有 N 项未完成…」自救提示以
 * `kind:'user_message'` 落 L1 → deriveConversation 把它渲染成**用户气泡**，
 * 用户重开任务看到一句自己没说过的话；且该提示永久以「用户发言」身份
 * 留在模型上下文。
 *
 * 双向契约：
 *  A. 源头（loop.ts）：自救提示走 pendingSystemHint 瞬时通道，不落 L1
 *     （断言在 premature-complete-guard.test.ts，此处只做标签联动）。
 *  B. 存量（l1-repair.ts）：签名匹配 loop.ts 现行模板，命中即归档。
 *     —— 模板若改文案而签名未同步，修复会静默失效，本套件当场失败。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isEngineHintUserMessage, ENGINE_HINT_PREFIXES } from '../l1-repair.js'
import type { MemoryItem } from '@shared/types/memory'

const loopSrc = readFileSync(
  fileURLToPath(new URL('../../agent/engine/loop.ts', import.meta.url)),
  'utf-8',
)

function item(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: 'mem-x',
    taskId: 'T-x',
    layer: 'L1',
    role: 'user',
    kind: 'user_message',
    content: '',
    enabled: true,
    iteration: 3,
    tokens: 10,
    createdAt: Date.now(),
    archivedAt: null,
    ...overrides,
  }
}

/* ---------- 1. 行为：isEngineHintUserMessage ---------- */

test('repair: 引擎提示签名命中（温和 / 强指令 / 截断）→ 归档', () => {
  for (const content of [
    '任务清单仍有 2 项未完成（running/pending），而上一轮回复未调用任何工具。',
    '【重要】任务清单仍有 2 项未完成（running/pending），但你已连续 2 轮未调用任何工具。',
    '你上一轮回复被输出长度截断（finish=length），工具调用可能被截掉。请直接继续。',
    '你上一轮回复被输出长度截断（finish=length），工具调用可能被截掉。\n任务清单仍有 1 项未完成（running/pending）…',
  ]) {
    assert.equal(isEngineHintUserMessage(item({ content })), true, content.slice(0, 24))
  }
})

test('repair: 非引擎提示不命中（真实用户消息 / 其他 kind / 已归档 / 非前缀）', () => {
  // 用户引用或复述该文案但不是以提示原文开头 → 不误伤
  assert.equal(
    isEngineHintUserMessage(item({ content: '我看到了「任务清单仍有 2 项未完成」的提示，帮我看看' })),
    false,
  )
  // 引擎提示一律 role:user + kind:user_message；其他形态不是对话气泡来源
  assert.equal(
    isEngineHintUserMessage(item({ content: '任务清单仍有 2 项未完成（running/pending）…', role: 'assistant' })),
    false,
  )
  assert.equal(
    isEngineHintUserMessage(item({ content: '任务清单仍有 2 项未完成（running/pending）…', kind: 'plan_status' })),
    false,
  )
  // 已归档的不重复处理（幂等）
  assert.equal(
    isEngineHintUserMessage(item({ content: '任务清单仍有 2 项未完成（running/pending）…', archivedAt: Date.now() })),
    false,
  )
})

/* ---------- 2. 契约：签名 ↔ loop.ts 模板保持同步 ---------- */

test('contract: loop.ts 三段提示模板都被 l1-repair 签名覆盖（改模板必须同步改签名）', () => {
  for (const marker of [
    '项未完成（running/pending）',
    '你上一轮回复被输出长度截断（finish=length）',
  ]) {
    assert.ok(loopSrc.includes(marker), `loop.ts 提示模板应含「${marker}」——若已改文案，请同步 l1-repair.ts 的签名前缀`)
  }
  // 签名前缀必须能匹配由模板渲染出的实际文本（取模板里唯一的动态量：数字）
  const sample = '任务清单仍有 3 项未完成（running/pending），而上一轮回复未调用任何工具。'
  assert.ok(
    ENGINE_HINT_PREFIXES.some((p) => sample.startsWith(p)),
    '签名前缀应能匹配 loop.ts 模板的实际渲染结果',
  )
})

test('contract: reason-phase 兜底标签存在（产出方漏标时补 [引擎提示]）', () => {
  const reasonSrc = readFileSync(
    fileURLToPath(new URL('../../agent/engine/reason-phase.ts', import.meta.url)),
    'utf-8',
  )
  assert.match(reasonSrc, /labelEngineHint\(pendingSystemHint\)/, '瞬时通道应有兜底标注')
  const hintsSrc = readFileSync(
    fileURLToPath(new URL('../../agent/engine/hints.ts', import.meta.url)),
    'utf-8',
  )
  assert.match(hintsSrc, /ENGINE_HINT_LABEL = '\[引擎提示\]'/)
  assert.match(hintsSrc, /SKILL_HINT_LABEL = '\[Skill 指令\]'/)
})
