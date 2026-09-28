/**
 * v0.36.4 详测 — D121 交互区执行锚点（LLM 规划产物，非机械造词）
 *
 * 依据：docs/versions/v0.36.4/16-v0364-windows-compat-design.md §二 D121
 * 用户实测：交互区只有 Agent 内部思考/动作/状态流转，看不到核心任务 / 用户意图 / 正在做。
 *
 * 设计取向（用户裁决后的重设计，对照 Claude Code subject/activeForm 与 ZCode Goal）：
 *   锚点字段全部来自 **LLM 规划产物的结构化字段**（graph.goal / 焦点节点 title+intent /
 *   首条用户消息），UI 只渲染不造词 —— **拒绝**零 LLM 依赖的机械锚点块。
 *
 * 手法：纯函数真执行（task-anchor.ts 零依赖）+ 渲染树契约（纪律⑥：不能只 grep import，
 * 必须断言组件真正出现在 TurnList 的 JSX 里）+ i18n 四语言 key 齐备。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/renderer/components/flow/__tests__/task-anchor.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { pickFocusNode, planRunningText, focusNodeLabel, userIntentText } from '../../../flow/task-anchor'
import type { TaskGraph, TaskNode } from '@shared/types/graph'

/* ---------------- 纯函数真执行 ---------------- */

function node(over: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.id}`,
    intent: 'D121 回归用意图',
    status: 'ready',
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

// 局部 defaultVerification 引用（避免整包 graph helpers 拖入）
import { defaultVerification } from '@shared/types/graph'

function graph(nodes: TaskNode[], over: Partial<TaskGraph> = {}): TaskGraph {
  const map: Record<string, TaskNode> = {}
  for (const n of nodes) map[n.id] = n
  return {
    schemaVersion: '0',
    id: 'tg_20260923_d121xx',
    title: 'D121 详测图',
    goal: '验证执行锚点取自 LLM 规划产物',
    status: 'in_progress',
    graphRevision: 1,
    spec: {
      state: 'draft', scopeIn: [], scopeOut: [], assumptions: [], constraints: [], acceptance: [], contextRefs: [],
    },
    nodes: map,
    rootIds: nodes.filter((n) => n.parentId === null).map((n) => n.id),
    policy: { tier: 2, parallelism: 1 },
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as unknown as TaskGraph
}

test('TC-D121-001 pickFocusNode 与 sync.ts pickFocusId 同口径：needs_human → verifying → in_progress', () => {
  const g = graph([
    node({ id: 'a', status: 'in_progress' }),
    node({ id: 'b', status: 'verifying' }),
    node({ id: 'c', status: 'needs_human' }),
  ])
  assert.equal(pickFocusNode(g)?.id, 'c', 'needs_human 优先（等待用户输入的节点最抢眼）')
  assert.equal(pickFocusNode(graph([node({ id: 'a', status: 'in_progress' }), node({ id: 'b', status: 'verifying' })]))?.id, 'b')
  assert.equal(pickFocusNode(graph([node({ id: 'a', status: 'in_progress' })]))?.id, 'a')
  assert.equal(pickFocusNode(graph([node({ id: 'a', status: 'completed' })])), null, '无非在途节点 → null')
  assert.equal(pickFocusNode(null), null, '无图 → null')
  assert.equal(pickFocusNode(undefined), null, '图未加载 → null')
})

test('TC-D121-002 无图回落：planItems 第一个 running 项文本（同为模型规划产物）', () => {
  assert.equal(
    planRunningText([
      { id: '1', text: '先完成的', status: 'done', createdAt: 1, updatedAt: 1 },
      { id: '2', text: '  正在做的项  ', status: 'running', createdAt: 1, updatedAt: 1 },
    ]),
    '正在做的项',
    '取第一个 running 并 trim',
  )
  assert.equal(planRunningText([{ id: '1', text: '全完成', status: 'done', createdAt: 1, updatedAt: 1 }]), null)
  assert.equal(planRunningText(undefined), null)
  assert.equal(planRunningText([{ id: '1', text: '   ', status: 'running', createdAt: 1, updatedAt: 1 }]), null, '空白文本不算')
})

test('TC-D121-003 focusNodeLabel：T-01 标题 — 意图 组合与截断（锚点保持一行语义）', () => {
  assert.equal(focusNodeLabel(null), null)
  assert.equal(
    focusNodeLabel(node({ id: 'a', key: 'T-01', title: '梳理项目结构', intent: '阅读 README 与目录' })),
    'T-01 梳理项目结构 — 阅读 README 与目录',
  )
  assert.equal(
    focusNodeLabel(node({ id: 'a', key: 'T-01', title: '只有标题', intent: '  ' })),
    'T-01 只有标题',
    '空白意图不拼分隔符',
  )
  assert.equal(
    focusNodeLabel(node({ id: 'a', key: 'T-02', title: '', intent: '只有意图' })),
    'T-02 — 只有意图',
    '标题空但 key 非空时保留 key（定位信息有用）',
  )
  assert.equal(focusNodeLabel(node({ id: 'a', key: '', title: '', intent: '只有意图' })), '只有意图', 'key/标题全空时只出意图')
  const long = focusNodeLabel(node({ id: 'a', key: 'T-03', title: 'x', intent: '意'.repeat(80) }))
  assert.ok(long?.endsWith('…'), '超长意图应截断加省略号')
  assert.ok((long?.length ?? 0) <= 70, '截断后长度受控')
})

test('TC-D121-004 userIntentText：首条非空行 + 200 字截断 + 空输入 null', () => {
  assert.equal(userIntentText('第一行意图\n\n第二行'), '第一行意图', '取首个非空行')
  assert.equal(userIntentText('\n  \n真正的意图'), '真正的意图', '跳过空行与空白行')
  assert.equal(userIntentText(undefined), null)
  assert.equal(userIntentText('   \n'), null)
  const long = userIntentText('长'.repeat(300))
  assert.ok(long?.startsWith('长'.repeat(200)) && long?.endsWith('…'), '超 200 字截断加省略号')
})

/* ---------------- 渲染树 + i18n 契约 ---------------- */

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const TURN_LIST = read('../TurnList.tsx')
const TASK_ANCHOR_TSX = read('../TaskAnchor.tsx')

test('TC-D121-005 TaskAnchor 真实出现在 TurnList 渲染树中（纪律⑥：不能只查 import）', () => {
  assert.match(TURN_LIST, /import \{ TaskAnchor \} from '\.\/TaskAnchor'/, '导入存在')
  assert.match(
    TURN_LIST,
    /\{taskId && <TaskAnchor taskId=\{taskId\} \/>\}/,
    'TaskAnchor 应以 JSX 形式挂载（taskId 存在时渲染）',
  )
})

test('TC-D121-006 TaskAnchor 渲染三段 LLM 产物锚点：goal / 正在做 / 用户意图（可折叠）', () => {
  assert.match(TASK_ANCHOR_TSX, /useGraph\(taskId\)/, '应从图缓存取 graph（goal/焦点节点来源）')
  assert.match(TASK_ANCHOR_TSX, /pickFocusNode\(/, '焦点节点经纯函数挑选（与 S1 投影同口径）')
  assert.match(TASK_ANCHOR_TSX, /planRunningText\(/, '无图任务回落 planItems running 项')
  assert.match(TASK_ANCHOR_TSX, /userIntentText\(/, '用户意图取首条消息')
  assert.match(TASK_ANCHOR_TSX, /taskAnchor\.title/, '标题走 i18n')
  assert.match(TASK_ANCHOR_TSX, /taskAnchor\.goal/, '核心任务区走 i18n')
  assert.match(TASK_ANCHOR_TSX, /taskAnchor\.doing/, '正在做区走 i18n')
  assert.match(TASK_ANCHOR_TSX, /taskAnchor\.intent/, '用户意图区走 i18n')
  // 可折叠（默认展开态与切换）
  assert.match(TASK_ANCHOR_TSX, /useState/, '折叠态应可切换')
  assert.match(TASK_ANCHOR_TSX, /Icon\.ChevronDown|Icon\.ChevronRight/, '折叠指示图标')
})

test('TC-D121-007 i18n 四语言 taskAnchor key 齐备（zh/en/ja/ko）', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const raw = read(`../../../i18n/locales/${locale}.json`)
    const table = JSON.parse(raw) as Record<string, unknown>
    for (const key of ['taskAnchor.title', 'taskAnchor.goal', 'taskAnchor.doing', 'taskAnchor.intent']) {
      const v = key.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], table)
      assert.ok(typeof v === 'string' && v.length > 0, `${locale}.json 缺少 ${key}`)
    }
  }
})
