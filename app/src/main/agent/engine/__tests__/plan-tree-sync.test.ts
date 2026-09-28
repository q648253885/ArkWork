/* ============================================================
 * ArkWork — v0.36.5 任务树同步单测（D125/D126）
 *
 * 规格来源：docs/versions/v0.36.0/17-v0365-plan-tree-sync-design.md §四/§五
 *   - D125：renderPlanTreeSnapshot 纯函数（续聊 hint 内联整棵树快照）
 *   - D126：shouldRemindTreeSync / touchesPlanTree 真值表（段末完成检查，
 *           对齐 ZCode todo_reminder，阈值 10）+ loop.ts 接线契约
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plan-tree-sync
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderPlanTreeSnapshot } from '../../../../shared/utils/plan-parse.js'
import { stripComments } from '@shared/utils/source-guard'
import {
  shouldRemindTreeSync,
  touchesPlanTree,
  TREE_SYNC_REMIND_INTERVAL,
} from '../plan-tree-sync.js'

import type { PlanItem, PlanItemStatus } from '../../../../shared/types/task.js'

/** 造一个最小 PlanItem */
const item = (text: string, status: PlanItemStatus = 'pending'): PlanItem => ({
  id: `plan_${text}`,
  text,
  status,
  createdAt: 0,
  updatedAt: 0,
})

/* ============================================================
 * 1. renderPlanTreeSnapshot（D125）
 * ============================================================ */

test('renderPlanTreeSnapshot: 空清单 → 空串（调用方自行决定拼接）', () => {
  assert.equal(renderPlanTreeSnapshot([]), '')
})

test('renderPlanTreeSnapshot: 六态状态标记逐态钉死', () => {
  const out = renderPlanTreeSnapshot([
    item('待开始步骤', 'pending'),
    item('进行中步骤', 'running'),
    item('已完成步骤', 'done'),
    item('失败步骤', 'failed'),
    item('已取消步骤', 'cancelled'),
    item('已跳过步骤', 'skipped'),
  ])
  const lines = out.split('\n')
  assert.equal(lines.length, 6)
  assert.match(lines[0], /^1\. \[ \] 待开始步骤$/)
  assert.match(lines[1], /^2\. \[▶\] 进行中步骤$/)
  assert.match(lines[2], /^3\. \[x\] 已完成步骤$/)
  assert.match(lines[3], /^4\. \[✗失败\] 失败步骤$/)
  assert.match(lines[4], /^5\. \[✗已取消\] 已取消步骤$/, '取消必须带可见标记（设计：编号+状态+取消标记）')
  assert.match(lines[5], /^6\. \[✗跳过\] 已跳过步骤$/)
})

test('renderPlanTreeSnapshot: 编号从 1 连续递增、未知状态回退 [ ]', () => {
  const odd = item('未知状态项', 'unknown' as PlanItemStatus)
  const out = renderPlanTreeSnapshot([odd, item('第二项')])
  assert.match(out, /^1\. \[ \] 未知状态项\n2\. \[ \] 第二项$/)
})

test('renderPlanTreeSnapshot: 单行超 60 字截断加省略号；多行折叠为空格', () => {
  const long = '这是一条特别长的清单项'.repeat(12) + '\n第二行内容'
  const out = renderPlanTreeSnapshot([item(long)])
  const line = out.split('\n')[0]!
  assert.ok(line.length <= 70, `单行应被截断，实际长度 ${line.length}`)
  assert.ok(line.endsWith('…'), '截断应以省略号结尾')
  assert.doesNotMatch(out, /\n.*第二行内容/, '换行必须折叠，快照必须单行一项')
})

test('renderPlanTreeSnapshot: 超 30 项截断并注明剩余数量', () => {
  const many = Array.from({ length: 35 }, (_, i) => item(`步骤${i + 1}`))
  const out = renderPlanTreeSnapshot(many)
  const lines = out.split('\n')
  assert.equal(lines.length, 31, '30 项 + 1 行剩余说明')
  assert.match(lines[30]!, /^…（其余 5 项略）$/)
  assert.match(lines[29]!, /^30\. /, '第 30 项仍带编号')
})

/* ============================================================
 * 2. shouldRemindTreeSync 真值表（D126 + v0.36.6 D127 纯轮数 · 设计 §二）
 * ============================================================ */

test('shouldRemindTreeSync: 真值表逐行钉死（阈值 10，D127 纯轮数无未收口前置）', () => {
  const row = (iters: number) =>
    shouldRemindTreeSync({ itersSinceTreeTouch: iters, threshold: TREE_SYNC_REMIND_INTERVAL })
  // iters < threshold → false
  assert.equal(row(0), false)
  assert.equal(row(9), false)
  // iters >= threshold → true —— 无「有未收口项」前置（D127）：
  // 「全终态但已过时」的树同样提醒，对齐 ZCode runtime-reminders 纯轮数判定
  assert.equal(row(10), true)
  assert.equal(row(23), true)
})

test('shouldRemindTreeSync: 自定义阈值（测试注入小值）边界相等命中', () => {
  assert.equal(shouldRemindTreeSync({ itersSinceTreeTouch: 3, threshold: 3 }), true)
  assert.equal(shouldRemindTreeSync({ itersSinceTreeTouch: 2, threshold: 3 }), false)
})

test('TREE_SYNC_REMIND_INTERVAL: 对齐 ZCode runtime-reminders 阈值 10', () => {
  assert.equal(TREE_SYNC_REMIND_INTERVAL, 10)
})

/* ============================================================
 * 3. touchesPlanTree 真值表（D126 计数器归零条件）
 * ============================================================ */

test('touchesPlanTree: 唯一写入口 task_plan 命中；只读工具与已下架旧名一律不命中', () => {
  assert.equal(touchesPlanTree([]), false)
  assert.equal(touchesPlanTree(['file-reader']), false)
  assert.equal(touchesPlanTree(['web-search', 'shell']), false)
  assert.equal(touchesPlanTree(['task_plan']), true)
  assert.equal(touchesPlanTree(['file-reader', 'task_plan']), true, '混合轮次只要触碰即归零')

  // ★ v0.38.0（D154）：已下架的旧名**不写账本** —— `act.ts` 的兜底分支在 `invokeSkill`
  // 之前就 return，清单一个字节都没变。因此绝不能算作"触碰过树"：
  // 一旦算作触碰，`treeTouchedThisRun` 会被置真 → 完成门禁在"有实质工作 + 清单陈旧"
  // 时**静默放行** → 续聊重做第一个任务（本版要消灭的症状族）。
  assert.equal(touchesPlanTree(['todo_update']), false, '下架旧名不得算作写树（门禁静默放行的种子）')
  assert.equal(touchesPlanTree(['todo-update']), false)
  assert.equal(touchesPlanTree(['replan']), false)
  assert.equal(touchesPlanTree(['task_create']), false)
  assert.equal(touchesPlanTree(['task_update']), false, 'v0.38.0 实现时曾漏掉的三个名字之一')
  assert.equal(touchesPlanTree(['task_get']), false)
  assert.equal(touchesPlanTree(['task_list']), false)
})

/* ============================================================
 * 4. loop.ts 接线契约（源码断言，与 continuation-regen 同手法）
 * ============================================================ */

const LOOP = readFileSync(new URL('../loop.ts', import.meta.url), 'utf-8')
/** 反向断言必须剥离注释 —— loop.ts 的删除说明注释里逐字写着已删结构名（纪律⑫/D89） */
const LOOP_SRC = stripComments(LOOP)

test('v0.36.5 D126 + v0.38.0 D150/D154: loop 每轮计数 + 唯一写入口归零 + 达阈值注入树快照提醒', () => {
  // v0.38.0（D150）：D128 的「续聊欠账满额启动」随三个代理变量一并退场 → 统一从 0 起算
  assert.match(LOOP, /let itersSinceTreeTouch = 0/, '计数器统一从 0 起算（续聊与首轮同待遇）')
  assert.match(LOOP, /let treeTouchedThisRun = false/)
  assert.doesNotMatch(LOOP_SRC, /pendingTreeSync/, 'D128 的续聊欠账标志不得复活（D150 已由客观事实取代）')
  assert.match(LOOP, /itersSinceTreeTouch \+= 1/, '每轮迭代应 +1')
  assert.match(
    LOOP,
    /if \(touchesPlanTree\(actions\.map\(\(a\) => a\.tool\)\)\) \{\s*itersSinceTreeTouch = 0\s*treeTouchedThisRun = true/,
    '本轮含写树动作（唯一入口 task_plan）应归零并记录 treeTouchedThisRun',
  )
  assert.match(
    LOOP,
    /shouldRemindTreeSync\(\{\s*itersSinceTreeTouch,\s*threshold: TREE_SYNC_REMIND_INTERVAL\s*\}\)/,
    '达阈值判定应走纯函数（真值表可单测，D127 后无 hasUnfinishedItems 实参）',
  )
  assert.match(
    LOOP,
    /任务清单已 \$\{TREE_SYNC_REMIND_INTERVAL\} 轮未更新/,
    '提醒文案应说明距上次更新的轮数阈值',
  )
  assert.match(
    LOOP,
    /renderPlanTreeSnapshot\(task\.planItems \?\? \[\]\)/,
    '提醒必须内联当前树快照（ZCode todo_reminder 同款）',
  )
  // v0.38.0（D154）：提醒文案不得再指向已下架的旧工具（否则等于教模型调废名）
  assert.match(LOOP, /用 task_plan 提交更新后的清单/, '提醒应引导用唯一入口补标已完成段落')
  assert.doesNotMatch(LOOP, /todo_update 标记（done）/, '下架旧名不得出现在注入给模型的提醒文案里')
  assert.match(LOOP, /全部完成后调用 task_complete/, '提醒应包含段末完成检查（设计 §〇 用户诉求 2）')
  // 触发后归零（防刷屏，ZCode 双阈值等价实现）：提醒块内再次置 0
  const remindIdx = LOOP.indexOf('tree-sync reminder injected')
  const blockStart = LOOP.lastIndexOf('itersSinceTreeTouch += 1', remindIdx)
  const block = LOOP.slice(blockStart, remindIdx)
  assert.match(block, /itersSinceTreeTouch = 0/, '注入提醒后计数必须归零（防下一轮重复注入）')
  // v0.38.0（D150）：D128 的 `treeSyncDebt` 欠账标志随代理变量退场
  assert.doesNotMatch(LOOP_SRC, /treeSyncDebt/, 'D128 欠账标志不得复活（已由 treeTouchedThisRun 客观事实取代）')
})
