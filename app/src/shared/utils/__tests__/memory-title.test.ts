/* ============================================================
 * v0.27.1 Fix-2 — 记忆语义标题与引用展开 单测
 *
 * 背景：@ 引用记忆菜单此前直接展示 content 首行原始字节，
 * 无语义可辨；[memory:<id>] 标记发送后无任何解析（伪引用）。
 * 本套用例锁定 deriveMemoryTitle 的确定性派生规则与
 * expandMemoryQuotes 的展开/失效占位行为。
 *
 * 运行（cwd=app）：./node_modules/.bin/tsx --test src/shared/utils/__tests__/memory-title.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripMemoryTriggerParens,
  firstMeaningfulLine,
  extractPlanStatusTrigger,
  deriveMemoryTitle,
  expandMemoryQuotes,
} from '../memory-title.js'

/* ---------- 1. 去噪与首行提取 ---------- */

test('stripMemoryTriggerParens: 全角触发点括注被移除', () => {
  assert.equal(stripMemoryTriggerParens('清单已同步（触发点：用户发送消息），继续'), '清单已同步，继续')
})

test('stripMemoryTriggerParens: 半角触发点括注被移除', () => {
  assert.equal(stripMemoryTriggerParens('状态更新(触发点:step done)完成'), '状态更新完成')
})

test('firstMeaningfulLine: 跳过前导空行', () => {
  assert.equal(firstMeaningfulLine('\n\n  \n第三行才是正文'), '第三行才是正文')
})

test('firstMeaningfulLine: 按 max 截断并去首尾空白', () => {
  assert.equal(firstMeaningfulLine('  abcdefgh  ', 4), 'abcd')
})

/* ---------- 2. plan_status 触发描述提取 ---------- */

test('extractPlanStatusTrigger: 触发点 + 当前进度 组合', () => {
  const content = '清单状态同步（触发点：步骤完成）\n当前运行：第 2 项'
  assert.equal(extractPlanStatusTrigger(content), '步骤完成 · 当前运行第 2 项')
})

test('extractPlanStatusTrigger: 仅触发点', () => {
  assert.equal(extractPlanStatusTrigger('（触发点：任务创建）'), '任务创建')
})

test('extractPlanStatusTrigger: 半角括注回落', () => {
  assert.equal(extractPlanStatusTrigger('(触发点:on send)'), 'on send')
})

test('extractPlanStatusTrigger: 无任何标记 → 空串', () => {
  assert.equal(extractPlanStatusTrigger('普通内容'), '')
})

/* ---------- 3. deriveMemoryTitle 各 kind 规则 ---------- */

test('deriveMemoryTitle: plan → 按编号条目计数', () => {
  const content = '## 计划清单\n1. 建立目录结构\n2. 编写核心模块\n3. 提交并打标'
  assert.equal(deriveMemoryTitle({ kind: 'plan', content }), '计划清单 · 3 项')
})

test('deriveMemoryTitle: plan 无编号条目 → 无计数回落', () => {
  assert.equal(deriveMemoryTitle({ kind: 'plan', content: '自由格式计划' }), '计划清单')
})

test('deriveMemoryTitle: plan_status → 清单状态 + 触发描述', () => {
  const content = '进度同步（触发点：安装完成）当前运行：第 3 项'
  assert.equal(
    deriveMemoryTitle({ kind: 'plan_status', content }),
    '清单状态 · 安装完成 · 当前运行第 3 项',
  )
})

test('deriveMemoryTitle: plan_status 无标记 → 裸标签', () => {
  assert.equal(deriveMemoryTitle({ kind: 'plan_status', content: 'x' }), '清单状态')
})

test('deriveMemoryTitle: skill_instruction meta 含 skillName', () => {
  const meta = JSON.stringify({ skillId: 'coder', skillName: '代码生成' })
  assert.equal(deriveMemoryTitle({ kind: 'skill_instruction', content: '# 指令体', meta }), '技能指令 · 代码生成')
})

test('deriveMemoryTitle: skill_instruction meta 缺失 → 首行去 # 回落', () => {
  assert.equal(
    deriveMemoryTitle({ kind: 'skill_instruction', content: '## 重构技能指令\n正文' }),
    '技能指令 · 重构技能指令',
  )
})

test('deriveMemoryTitle: skill_instruction meta 非法 JSON → 回落不抛错', () => {
  assert.equal(
    deriveMemoryTitle({ kind: 'skill_instruction', content: '指令摘要', meta: '{broken' }),
    '技能指令 · 指令摘要',
  )
})

test('deriveMemoryTitle: kb_hit → 库名 #序号', () => {
  const content = '[知识库 · 项目规范 #3] 提交信息使用中文'
  assert.equal(deriveMemoryTitle({ kind: 'kb_hit', content }), '知识库命中 · 项目规范 #3')
})

test('deriveMemoryTitle: kb_hit 无头部标记 → 裸标签', () => {
  assert.equal(deriveMemoryTitle({ kind: 'kb_hit', content: '裸文本' }), '知识库命中')
})

test('deriveMemoryTitle: file_ref/artifact_ref → 取基名（含 Windows 路径）', () => {
  assert.equal(deriveMemoryTitle({ kind: 'file_ref', content: '/Users/me/docs/report.md' }), '文件引用 · report.md')
  assert.equal(deriveMemoryTitle({ kind: 'artifact_ref', content: 'C:\\out\\chart.png' }), '产物引用 · chart.png')
})

test('deriveMemoryTitle: 其余 kind → 去噪后首行摘要', () => {
  assert.equal(
    deriveMemoryTitle({ kind: 'user_message', content: '（触发点：x）帮我优化能力页面' }),
    '帮我优化能力页面',
  )
})

test('deriveMemoryTitle: 超长标题截断到 40 字符加省略号', () => {
  const trigger = '超长触发描述'.repeat(10)
  const title = deriveMemoryTitle({ kind: 'plan_status', content: `（触发点：${trigger}）` })
  assert.equal(title.length, 41)
  assert.ok(title.endsWith('…'))
  assert.ok(title.startsWith('清单状态 · '))
})

test('deriveMemoryTitle: 同输入同输出（确定性，缓存友好）', () => {
  const src = { kind: 'kb_hit', content: '[知识库 · 架构决策 #7] 选 electron-vite' }
  assert.equal(deriveMemoryTitle(src), deriveMemoryTitle(src))
})

/* ---------- 4. expandMemoryQuotes 引用展开 ---------- */

const MEMORIES = new Map([
  ['m1', { kind: 'plan', content: '## 计划清单\n1. 建目录\n2. 写模块' }],
  ['m2', { kind: 'kb_hit', content: '[知识库 · 项目规范 #3] 提交信息中文' }],
])

function resolve(id: string) {
  return MEMORIES.get(id)
}

test('expandMemoryQuotes: 单标记展开为语义引用块', () => {
  const out = expandMemoryQuotes('请先看 [memory:m1] 再动手', resolve)
  assert.equal(
    out,
    '请先看 \n【引用记忆 · 计划清单 · 2 项】\n## 计划清单\n1. 建目录\n2. 写模块\n 再动手',
  )
})

test('expandMemoryQuotes: 多标记全部展开', () => {
  const out = expandMemoryQuotes('[memory:m1] 与 [memory:m2]', resolve)
  assert.ok(out.includes('【引用记忆 · 计划清单 · 2 项】'))
  assert.ok(out.includes('【引用记忆 · 知识库命中 · 项目规范 #3】'))
  assert.ok(!out.includes('[memory:'))
})

test('expandMemoryQuotes: 未知 id → 失效占位文本', () => {
  const out = expandMemoryQuotes('引用 [memory:ghost] 已删', resolve)
  assert.equal(out, '引用 [引用记忆已失效：ghost] 已删')
})

test('expandMemoryQuotes: 无标记 → 原文透传', () => {
  const raw = '普通消息，不含任何引用标记'
  assert.equal(expandMemoryQuotes(raw, resolve), raw)
})
