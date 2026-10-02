/* ============================================================
 * TC-TWIN —— v0.44.1（D219）工具名孪生拼写比较契约
 *
 * 缺陷现场（T-20261002-2k584x · 2026-10-02）：模型调 `task-complete`
 * （连字符孪生），旧版本归一化晚于 step 落盘 → steps.jsonl 存有原始拼写；
 * 渲染层用正名 `task_complete` 精确匹配落空 → 最终答复整条不渲染。
 * 本套件钉住：读侧比较必须双向容错 `_` ↔ `-`，且不得误吞第三方案名。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sameToolName } from '../tool-name'

test('TC-TWIN-001: 真名与孪生拼写双向命中', () => {
  // 精确相等
  assert.equal(sameToolName('task_complete', 'task_complete'), true)
  assert.equal(sameToolName('ask_user', 'ask_user'), true)
  // 孪生：下划线正名 ↔ 连字符拼写（实机缺陷形态）
  assert.equal(sameToolName('task-complete', 'task_complete'), true)
  assert.equal(sameToolName('ask-user', 'ask_user'), true)
  // 孪生：连字符正名 ↔ 下划线拼写（file-reader 族）
  assert.equal(sameToolName('file_reader', 'file-reader'), true)
  assert.equal(sameToolName('file-reader', 'file-reader'), true)
  // 多段名的全串替换（turn_note / task_plan 同理）
  assert.equal(sameToolName('turn-note', 'turn_note'), true)
  assert.equal(sameToolName('plan-ops-tick', 'plan_ops_tick'), true)
})

test('TC-TWIN-002: 不同名 / 未知名 / 空值一律 false', () => {
  assert.equal(sameToolName('task_complete_x', 'task_complete'), false, '前缀污染不得命中')
  assert.equal(sameToolName('task', 'task_complete'), false)
  assert.equal(sameToolName('unknown-skill', 'task_complete'), false)
  // MCP / 市场技能命名空间：本函数做的是**全串**孪生替换 —— `mcp__` 前缀的
  // 下划线同样参与替换（`mcp__foo_bar` 的孪生是 `mcp--foo-bar`）。因此调用方
  // 只应把引擎正名（控制/只读/清单族）作为 canonical 传入，不应对 MCP 名做
  // 孪生判定（它们不是"同一工具的两种拼写"）。
  assert.equal(sameToolName('mcp__foo_bar', 'mcp__foo_bar'), true)
  assert.equal(sameToolName('mcp--foo-bar', 'mcp__foo_bar'), true, '全串替换语义')
  assert.equal(sameToolName('mcp__foo-bar', 'mcp__foo_bar'), false, '前缀下划线不豁免替换')
  // 空值安全
  assert.equal(sameToolName(undefined, 'task_complete'), false)
  assert.equal(sameToolName(null, 'task_complete'), false)
  assert.equal(sameToolName('', 'task_complete'), false)
})
