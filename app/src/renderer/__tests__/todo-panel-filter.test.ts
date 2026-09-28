/* ============================================================
 * ArkWork — 任务清单筛选口径与子任务层级（v0.41.0 / D209）
 * TC-TDP-001…005（矩阵 §二 模块 R）
 *
 * 缺陷本体（用户实机 + 追加需求③）：replan/task_plan 后已完成项由 I8
 * 保护保留在清单尾部，但 TodoPanel「全部」不过滤终态 → 完成项挤占主视线；
 * parentId 已随投影送达渲染层（v0.39.0 D185），UI 却按下标平铺、不缩进。
 *
 * 本组把守三件事：
 *   ① 层级判定是**纯函数**且真值表钉死（孤儿 / 环 / 越级兜底顶级）；
 *   ② 筛选口径：all = 仅未终态、ended = 全部终态，计数与列表同源；
 *   ③ 接线链存在（run-setup → derive-conversation → PlanBlock / TodoPanel）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs todo-panel-filter
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'
import {
  planItemDepths,
  planItemNumbering,
  filterPlanItemIndices,
  isTerminalPlanStatus,
} from '../utils/plan-status.js'

const RENDERER = fileURLToPath(new URL('..', import.meta.url)) // app/src/renderer/
const SRC = fileURLToPath(new URL('../..', import.meta.url)) // app/src/
const codeOf = (p: string): string => stripComments(readFileSync(join(SRC, p), 'utf-8'))

test('TC-TDP-001 planItemDepths 真值表：两层 / 孤儿 / 自引用环 / 越级 clamp', () => {
  // 正常两层
  const ok = [
    { id: 'a', parentId: null },
    { id: 'a1', parentId: 'a' },
    { id: 'a2', parentId: 'a' },
    { id: 'b', parentId: null },
  ]
  assert.deepEqual(planItemDepths(ok), [0, 1, 1, 0])
  // 孤儿父引用（父不存在）→ 顶级
  const orphan = [{ id: 'x', parentId: 'ghost' }]
  assert.deepEqual(planItemDepths(orphan), [0])
  // 自引用环 → 顶级
  const cycle = [{ id: 'x', parentId: 'x' }]
  assert.deepEqual(planItemDepths(cycle), [0])
  // 越级（父已是子）→ clamp ≤1
  const deep = [
    { id: 'p', parentId: null },
    { id: 'c', parentId: 'p' },
    { id: 'g', parentId: 'c' },
  ]
  assert.deepEqual(planItemDepths(deep), [0, 1, 1], '第三层 clamp 到 1（账本层级 ≤2 的镜像）')
  // parentId 缺省字段（旧数据）
  assert.deepEqual(planItemDepths([{ id: 'p' }]), [0])
})

test('TC-TDP-002 planItemNumbering 复合编号：1 / 1.1 / 1.2 / 2；父项在子项之后声明也能对上', () => {
  const normal = [
    { id: 'a', parentId: null },
    { id: 'a1', parentId: 'a' },
    { id: 'a2', parentId: 'a' },
    { id: 'b', parentId: null },
  ]
  assert.deepEqual(planItemNumbering(normal), ['1', '1.1', '1.2', '2'])
  // 父项在子项之后声明（弱模型常见输出顺序）
  const reversed = [
    { id: 'a1', parentId: 'a' },
    { id: 'a', parentId: null },
  ]
  assert.deepEqual(planItemNumbering(reversed), ['1.1', '1'], '先子后父必须仍能配对')
  // 孤儿 → 顶级编号
  const orphan = [
    { id: 'x', parentId: 'ghost' },
    { id: 'y', parentId: null },
  ]
  assert.deepEqual(planItemNumbering(orphan), ['1', '2'])
})

test('TC-TDP-003 filterPlanItemIndices 口径：all=仅未终态 / ended=全部终态 / 单态精确 / 计数一致', () => {
  const states = ['done', 'running', 'pending', 'cancelled', 'skipped', 'paused', 'failed'] as const
  const all = filterPlanItemIndices(states as unknown as never[], 'all')
  const ended = filterPlanItemIndices(states as unknown as never[], 'ended')
  assert.deepEqual(all, [1, 2, 5], '「全部」只显示未终态（running/pending/paused）')
  assert.deepEqual(ended, [0, 3, 4, 6], '「已结束」汇集全部终态（done/cancelled/skipped/failed）')
  assert.equal(all.length + ended.length, states.length, '两口径互补，计数必须与列表一致')
  assert.deepEqual(filterPlanItemIndices(states as unknown as never[], 'done'), [0])
  assert.deepEqual(filterPlanItemIndices([], 'all'), [], '空清单恒空')
  for (const s of ['done', 'failed', 'cancelled', 'skipped'] as const) {
    assert.equal(isTerminalPlanStatus(s), true)
  }
  for (const s of ['pending', 'running', 'paused'] as const) {
    assert.equal(isTerminalPlanStatus(s), false)
  }
})

test('TC-TDP-004 接线契约：TodoPanel 复用唯一终态判据 + 「已结束」chip + 全部计数=未终态', () => {
  const panel = codeOf('renderer/components/dock/TodoPanel.tsx')
  // 终态判据单一事实源（纪律⑦）：不得再自留一份 TERMINAL 集合
  assert.doesNotMatch(panel, /const TERMINAL: ReadonlySet/, '本地 TERMINAL 集合必须删除（唯一事实源在 plan-status）')
  assert.match(panel, /isTerminalPlanStatus/)
  assert.match(panel, /filterPlanItemIndices\(states, filter\)/, '筛选必须走纯函数（口径唯一）')
  assert.match(panel, /setFilter\('ended'\)/, '必须存在「已结束」chip')
  assert.match(panel, /dock\.todo\.filter_ended/, '「已结束」chip 必须走 i18n 键')
  assert.match(panel, /\{openCount\}/, '「全部」chip 计数必须是未终态数（与列表口径一致）')
  // 层级渲染接线
  assert.match(panel, /planItemDepths/, '行深度必须来自纯函数')
  assert.match(panel, /planItemNumbering/, '序号圈必须用复合编号')
  assert.match(panel, /paddingLeft: 16 \* depth/, '子任务必须缩进（16px × depth）')
})

test('TC-TDP-005 parentIds 透传链：run-setup → PlanContent → project.ts → PlanBlock', () => {
  const planContent = codeOf('shared/types/react.ts')
  const flowType = codeOf('shared/types/flow.ts')
  const runSetup = codeOf('main/agent/engine/run-setup.ts')
  const project = codeOf('renderer/flow/project.ts')
  const planBlock = codeOf('renderer/components/flow/blocks/PlanBlock.tsx')
  assert.match(planContent, /parentIds\?: Array<string \| null>/, 'PlanContent 必须声明可选 parentIds')
  assert.match(flowType, /parentIds\?: Array<string \| null>/, 'flow PlanBlock 必须声明可选 parentIds')
  assert.match(runSetup, /plan\.parentIds = plan\.items\.map/, 'run-setup 必须按 plan.items 下标对齐透传（唯一写入点）')
  assert.match(project, /parentIds: item\.plan\?\.parentIds/, 'project.ts 必须把 parentIds 透传给 flow PlanBlock')
  assert.match(planBlock, /planItemNumbering/, 'PlanBlock 必须用复合编号渲染层级')
  assert.match(planBlock, /paddingLeft: 16 \* depth/, 'PlanBlock 子任务必须缩进')
})
