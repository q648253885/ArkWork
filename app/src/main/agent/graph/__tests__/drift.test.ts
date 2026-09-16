/* ============================================================
 * v0.30.2 D13 — 漂移检测误报根治（TC-DRIFT 001–006）
 *
 * 用户实测：调研类任务（节点未声明 contextRefs）连续 16 轮 0.00 分
 * `[drift-alert]` hard 刷屏。根因链见 docs/versions/v0.30.2/04-system-design.md §2.5：
 *   ① act 从不传 descriptions → 语义信号退化为「工具名 vs 意图」恒 0 分；
 *   ② 无声明 refs 时唯一活信号（语义）权重独占 100%；
 *   ③ hard 无冷却每轮触发；
 *   ④ E2 'ask' 事件引擎零消费，文案却宣称「已提请用户确认」。
 *
 * 001–003：computeDrift 纯函数真单测（内存构造 TaskGraph，密闭无 IO）；
 * 004–006：act.ts / sync.ts 源码契约（依赖引擎模块图，node:test 无渲染环境）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  GRAPH_SCHEMA_VERSION,
  defaultPolicy,
  defaultVerification,
  generateGraphId,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import { computeDrift, renderDriftHardBlock } from '../drift.js'

/* ---------- 构造器（与 graph-kernel.test.ts 同款最小面） ---------- */

function node(over: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.id}`,
    intent: '测试用意图',
    status: 'in_progress',
    assignee: { kind: 'system' },
    priority: 'p1',
    children: [],
    dependsOn: [],
    acceptance: [],
    evidence: [],
    verification: defaultVerification(),
    contextRefs: [],
    tokensUsed: 0,
    attempts: 0,
    sessionIds: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...over,
  }
}

function graph(nodes: TaskNode[]): TaskGraph {
  const map: Record<string, TaskNode> = {}
  for (const n of nodes) map[n.id] = n
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    id: generateGraphId(),
    title: 'D13 测试图',
    goal: '验证漂移检测误报根治',
    status: 'in_progress',
    graphRevision: 1,
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      acceptance: [],
      contextRefs: [],
    },
    nodes: map,
    rootIds: nodes.filter((n) => n.parentId === null).map((n) => n.id),
    policy: defaultPolicy(),
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

/* ============================================================
 * 纯函数单测（computeDrift）
 * ============================================================ */

test('TC-DRIFT-001 无声明不 hard：节点无 file/symbol refs 时语义 0 重合连续 ≥2 轮最多 soft', () => {
  // 用户实测 D13 形态：调研任务节点未声明任何 contextRefs，动作描述与意图零重合
  const g = graph([node({ id: 'a', key: 'T-01', intent: '调研开源 FPS 网页项目', contextRefs: [] })])
  const r1 = computeDrift(
    g,
    { toolNames: ['web-search'], files: [], symbols: [], descriptions: ['web-search'] },
    0,
    'a',
  )
  assert.equal(r1.score < 0.4, true, `期望低分，实际 ${r1.score}`)
  assert.equal(r1.action, 'soft', '第 1 轮 soft')
  const r2 = computeDrift(
    g,
    { toolNames: ['web-search'], files: [], symbols: [], descriptions: ['web-search'] },
    r1.streak,
    'a',
  )
  assert.equal(r2.streak, 2, 'streak 继续累计（不洗白）')
  assert.equal(r2.action, 'soft', '★ 无声明 refs 时 hard 必须被降级为 soft（D13 核心断言）')
  const r3 = computeDrift(
    g,
    { toolNames: ['web-search'], files: [], symbols: [], descriptions: ['web-search'] },
    r2.streak,
    'a',
  )
  assert.equal(r3.action, 'soft', 'streak ≥3 仍 soft —— 声明不全不被惩罚为硬干预')
})

test('TC-DRIFT-002 hard 能力保留：有声明 refs 且动作与其零交集 + 语义 0 → 2 轮 hard', () => {
  const g = graph([
    node({
      id: 'a',
      intent: '修复 auth token 过期判定',
      contextRefs: [{ kind: 'file', ref: 'src/auth/session.ts' }],
    }),
  ])
  const off1 = computeDrift(
    g,
    { toolNames: ['file-editor'], files: ['src/billing/invoice.ts'], symbols: [], descriptions: ['重构 billing 模块'] },
    0,
    'a',
  )
  assert.equal(off1.action, 'soft', '第 1 轮 soft')
  const off2 = computeDrift(
    g,
    { toolNames: ['file-editor'], files: ['src/billing/invoice.ts'], symbols: [], descriptions: ['继续重构 billing'] },
    off1.streak,
    'a',
  )
  assert.equal(off2.action, 'hard', '有声明可比对且确实无交集 → 真漂移仍能硬干预（能力不回退）')
  assert.equal(off2.streak, 2)
})

test('TC-DRIFT-003 第三信号喂真实描述：score 出偏离区 streak 归零（对照 toolName 兜底恒 0）', () => {
  const g = graph([node({ id: 'a', key: 'T-01', intent: '调研开源 FPS 网页项目', contextRefs: [] })])
  // 对照：D13 旧行为 —— descriptions 只有工具名 → 语义 0 → 偏离区
  const old0 = computeDrift(
    g,
    { toolNames: ['web-search'], files: [], symbols: [], descriptions: ['web-search'] },
    2,
    'a',
  )
  assert.equal(old0.score, 0, 'toolName 兜底时重合度恒 0（D13 根因①的形态）')
  // 修复后：extractActionDescriptions 产出「tool | key: 值」段拼接 → 重合度被拉起
  const hit = computeDrift(
    g,
    {
      toolNames: ['web-search'],
      files: [],
      symbols: [],
      descriptions: ['web-search | query: 开源 FPS 网页游戏 引擎对比'],
    },
    2, // 前两轮已累计的偏离 streak
    'a',
  )
  assert.equal(hit.score >= 0.4, true, `真实描述应把 score 拉出偏离区（≥0.4），实际 ${hit.score}`)
  assert.equal(hit.streak, 0, 'score 出偏离区 → streak 归零')
  assert.notEqual(hit.action, 'hard', '不再触发硬干预')
})

/* ============================================================
 * 源码契约（act.ts / sync.ts）
 * ============================================================ */

const ACT_SRC = readFileSync(fileURLToPath(new URL('../../engine/act.ts', import.meta.url)), 'utf-8')
const SYNC_SRC = readFileSync(fileURLToPath(new URL('../sync.ts', import.meta.url)), 'utf-8')

test('TC-DRIFT-004 act.ts 存在 extractActionDescriptions 且作为 descriptions 喂给 syncPostAct', () => {
  assert.match(
    ACT_SRC,
    /export function extractActionDescriptions\(tool: string, args: Record<string, unknown> \| undefined\): string\[\]/,
    'D13 根因修复：第三信号的信号源函数必须存在',
  )
  assert.match(
    ACT_SRC,
    /descriptions: extractActionDescriptions\(action\.tool, action\.args \?\? \{\}\)/,
    'syncPostAct 调用必须传入 descriptions（不再依赖 toolName 兜底）',
  )
  assert.match(ACT_SRC, /PAYLOAD_KEYS/, '大载荷字段黑名单必须存在（content/code 等不喂语义信号）')
})

test('TC-DRIFT-005 sync.ts hardAlerted：hard 只提请一次，streak 归零清除，dropGraphCache 一并清理', () => {
  assert.match(SYNC_SRC, /const hardAlerted = new Set<string>\(\)/, 'hard 已提请状态集合必须存在')
  assert.match(
    SYNC_SRC,
    /else if \(drift\.action === 'hard' && !hardAlerted\.has\(key\)\)/,
    'hard 必须受 hardAlerted 门控（同 focus 只提请一次，防 16 轮刷屏）',
  )
  assert.match(SYNC_SRC, /hardAlerted\.add\(key\)/, '首次 hard 触发时登记')
  assert.match(
    SYNC_SRC,
    /if \(drift\.streak === 0\) hardAlerted\.delete\(key\)/,
    'score 回升（streak 归零）→ 解除已提请状态，允许下次再报',
  )
  assert.match(
    SYNC_SRC,
    /for \(const key of \[\.\.\.hardAlerted\]\)/,
    'dropGraphCache 必须同步清理 hardAlerted（防泄漏）',
  )
})

test('TC-DRIFT-006 [drift-alert] 文案实话：不再宣称「已提请用户确认」', () => {
  assert.doesNotMatch(
    ACT_SRC,
    /已提请用户确认/,
    'E2 ask 事件引擎零消费，不得虚假宣称已提请用户确认（D13 根因④）',
  )
  assert.match(ACT_SRC, /只提请一次/, '文案必须如实说明 hard 提示的一次性语义')
})

test('TC-DRIFT-007 技能加载不判漂移：act 传 metaTool → sync.ts 跳过 S2（streak 保持不洗白）', () => {
  // act.ts：技能调用（skillToolName 动态名匹配）必须打 metaTool 标记
  assert.match(ACT_SRC, /let skillAct = false/, 'act 须有技能调用标记')
  assert.match(ACT_SRC, /skillAct = true/, '技能解析命中后须置位')
  assert.match(ACT_SRC, /metaTool: skillAct/, 'syncPostAct 传入必须带 metaTool')
  // sync.ts：metaTool 轮跳过判定，streak 保持（不洗白）
  assert.match(
    SYNC_SRC,
    /if \(input\.metaTool === true\) \{[\s\S]{0,200}?driftStreaks\.set\(key, prev\)/,
    'metaTool 轮须跳过 computeDrift 并保持既有 streak（加载技能不算漂移也不洗白）',
  )
})

test('TC-DRIFT-008 迁移意图净化：渲染/取词经 cleanIntent 剥机器前缀，migrate 不再新增', () => {
  // 存量图自愈：污染 intent 渲染为干净原文（用户实测形态）
  const g2 = graph([
    node({
      id: 'a',
      title: '阶段 1：调研开源 FPS 网页项目',
      intent: '迁移自 v0.29 清单项：阶段 1：调研开源 FPS 网页项目',
    }),
  ])
  const text = renderDriftHardBlock(g2.nodes['a'], {
    score: 0,
    streak: 3,
    action: 'hard',
    signals: { file: null, symbol: null, semantic: 0 },
    detail: '',
    semanticProxy: true,
  })
  assert.match(text, /（目的：阶段 1：调研开源 FPS 网页项目）/, '目的行应渲染干净的原文')
  assert.doesNotMatch(text, /迁移自/, '渲染文本不得再出现机器前缀')
  // 断流源头：migrate.ts 的 intent 不再加前缀
  const MIGRATE_SRC = readFileSync(fileURLToPath(new URL('../migrate.ts', import.meta.url)), 'utf-8')
  assert.match(MIGRATE_SRC, /intent: item\.text/, '迁移 intent 应直接用原清单项文本')
  assert.doesNotMatch(MIGRATE_SRC, /迁移自 v0\.29 清单项：\$\{item\.text\}/, '不得再拼接机器前缀')
  // 语义取词源同净化（describeFocus 走 cleanIntent）
  const DRIFT_SRC = readFileSync(fileURLToPath(new URL('../drift.ts', import.meta.url)), 'utf-8')
  assert.match(DRIFT_SRC, /function describeFocus\(node: TaskNode\): string \{[\s\S]{0,120}?cleanIntent/, 'describeFocus 应经 cleanIntent 净化')
})
