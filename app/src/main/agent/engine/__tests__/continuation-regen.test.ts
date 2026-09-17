/**
 * v0.30.2 详测 — 续聊清单语义（问题② · D12 v2 终版：清单是活树）
 *
 * 依据：docs/versions/v0.30.2/04-system-design.md §2.4（v2 终版）+ testcases/00-cumulative-matrix.md §3.2
 * 用例：TC-REGEN-001…007
 *
 * 背景（用户两轮实测）：
 *   ① v0.30.1 及以前：续聊新指令不更新清单（问题②原始缺陷）；
 *   ② v0.30.2 首版「引擎侧清空重建」：门禁答复被当成新指令，10 项阶段清单被清成 2 项退化清单（D12）；
 *   ③ 用户澄清取向：清单是活树 —— 同任务追加指令应作为**子任务挂树**；
 *      **真正切换任务才清空**，且清空须经 replan 第 2 级**用户批准**。
 *
 * 终版契约（D12 v2）：
 *   - 引擎续聊分支**禁止清空重建**（无 generatePlan / _regen / graphId 置空 / planItems 直写）；
 *   - 5 处 ask_user 暂停点打 pendingAskUser 标记；run-setup 先捕获 isReplyContinuation 再消费；
 *   - replanHint 分叉：答复型（清单不变）vs 新指令型（task_create 挂树 / replan 待批准）。
 *
 * 手法：源码契约（readFileSync + 正则）—— prepareRun 依赖 LLM/存储/Electron，
 * node:test 无渲染/网络环境，锁结构性不变量（与 interactive-copy.test.ts 同源）。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/engine/__tests__/continuation-regen.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const RUN_SETUP = read('../run-setup.ts')
const TURN_END = read('../turn-end.ts')
const LOOP = read('../loop.ts')
const ABORT = read('../abort.ts')
const TASK_TYPES = read('../../../../shared/types/task.ts')
// v0.31.0 B3：deriveConversation 迁至纯模块 store/derive-conversation.ts（meta.ts 转出口），
// 本用例载体随之收敛到新文件（B1「载体收敛」先例，矩阵 §4.1 已登记）
const META = read('../../../../renderer/store/derive-conversation.ts')
const GRAPH_TOOLS = read('../../graph/tools.ts')

/** 截取 startIter > 0 续聊分支的源码（从 `if (startIter > 0)` 到闭合） */
function continuationBlock(src: string): string {
  const anchor = src.indexOf('if (startIter > 0) {')
  assert.ok(anchor >= 0, '未找到续聊分支 if (startIter > 0)')
  // 括号配平截取
  let depth = 0
  for (let i = anchor; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(anchor, i + 1)
    }
  }
  assert.fail('续聊分支未闭合')
}

const CONT = continuationBlock(RUN_SETUP)

/* ============================================================
 * TC-REGEN-001 续聊分支禁止引擎侧清空重建（D12 v2 核心契约）
 * ============================================================ */

test('TC-REGEN-001 续聊分支禁止引擎侧清空重建（写入权回归受审计 Replan 通道）', () => {
  assert.doesNotMatch(
    CONT,
    /generatePlan/,
    '续聊分支不得调用 generatePlan（引擎侧重建在 UAT 中误伤门禁答复 → D12 根因）',
  )
  assert.doesNotMatch(CONT, /_regen/, '续聊分支不得出现 _regen 清理')
  assert.doesNotMatch(
    CONT,
    /graphId = undefined/,
    '续聊分支不得置空 graphId（旧图指针保留，子任务挂现有树）',
  )
  assert.doesNotMatch(
    CONT,
    /updateTask\(/,
    '续聊分支不得直写任务（planItems/graphId 写入权回归 task_create / replan 受审计通道）',
  )
  assert.doesNotMatch(
    CONT,
    /broadcastPlanListSnapshot|broadcastStep|emitEvent\(/,
    '续聊分支不得广播 plan-regen 快照 / 新 plan step（无重建即无新卡）',
  )
  assert.doesNotMatch(
    RUN_SETUP,
    /dropGraphPending/,
    'run-setup 不再解除旧图指针（dropGraphPending 随引擎重建一并移除）',
  )
  // 首轮建图通道不变量保留（planItemId === nodeId 恢复依赖它）
  assert.match(RUN_SETUP, /needsGraphMigration\(/, '尾部建图块 needsGraphMigration 应保留')
  assert.match(RUN_SETUP, /migrateToGraph\(/, '尾部建图块 migrateToGraph 应保留')
})

/* ============================================================
 * TC-REGEN-002 答复型续聊判定：先捕获 isReplyContinuation，再消费标记
 * ============================================================ */

test('TC-REGEN-002 isReplyContinuation 判定存在且先于标记消费（消费顺序不变量）', () => {
  assert.match(
    RUN_SETUP,
    /const isReplyContinuation = Boolean\(task\.pendingGateBlock \|\| task\.pendingAskUser\)/,
    '答复型判定应覆盖两类标记：门禁答复（pendingGateBlock）+ ask_user 答复（pendingAskUser）',
  )
  // 顺序：判定必须先于两个标记的消费（消费即置 undefined，晚于判定才不丢）
  const judgeIdx = RUN_SETUP.indexOf('const isReplyContinuation')
  const gateConsumeIdx = RUN_SETUP.indexOf('task.pendingGateBlock = undefined')
  const askConsumeIdx = RUN_SETUP.indexOf('task.pendingAskUser = undefined')
  assert.ok(judgeIdx >= 0 && gateConsumeIdx >= 0 && askConsumeIdx >= 0, '三处锚点均应存在')
  assert.ok(judgeIdx < gateConsumeIdx, 'isReplyContinuation 判定必须先于 pendingGateBlock 消费')
  assert.ok(judgeIdx < askConsumeIdx, 'isReplyContinuation 判定必须先于 pendingAskUser 消费')
  // 消费：置空 + 持久化清除（与 pendingGateBlock 同模式）
  assert.match(
    RUN_SETUP,
    /if \(task\.pendingAskUser\) \{\s*task\.pendingAskUser = undefined\s*await updateTask\(task\.id, \{ pendingAskUser: undefined \}\)\s*\}/,
    'pendingAskUser 应在 run 开始时消费（内存置空 + tasks.json 清除）',
  )
})

/* ============================================================
 * TC-REGEN-003 五处 ask_user 暂停点打标；手动暂停不打标
 * ============================================================ */

test('TC-REGEN-003 五处 ask_user 暂停点写 pendingAskUser；abort.ts（手动暂停）不写', () => {
  // 1) turn-end.pauseViaAskUser（LLM 主动提问）
  assert.match(
    TURN_END,
    /pendingAskUser: \{ question, askedAt: Date\.now\(\) \}/,
    'pauseViaAskUser 暂停时应写 pendingAskUser（仅在 continueTurnIfInjected 未续跑时）',
  )
  // 2-5) loop.ts 四处：预算中断 / P8 计划闸门 / 阶段门禁直推 / 迭代上限
  const loopMarks = LOOP.match(/pendingAskUser:/g) ?? []
  assert.ok(loopMarks.length >= 4, `loop.ts 应有 ≥4 处打标，实测 ${loopMarks.length}`)
  assert.match(LOOP, /预算中断也属 ask_user 暂停/, '预算中断暂停点应打标')
  assert.match(LOOP, /pendingAskUser: \{ question: '计划已提交，等待批准'/, 'P8 计划闸门暂停点应打标')
  assert.match(LOOP, /pendingAskUser: \{ question: gate\.question/, '阶段门禁直推暂停点应打标')
  assert.match(LOOP, /askUser\.maxIterQuestion/, '迭代上限暂停点应打标（答复=继续/结束）')
  // 用户手动暂停（Esc/停止）不打标 —— 那之后的首条输入就是新指令，应触发清单重评
  assert.doesNotMatch(
    ABORT,
    /pendingAskUser/,
    'abort.ts 手动暂停不得打标（手动暂停后的输入是新指令，非答复）',
  )
})

/* ============================================================
 * TC-REGEN-004 replanHint 分叉：答复型（清单不变）vs 新指令型（三选一）
 * ============================================================ */

test('TC-REGEN-004 replanHint 按 isReplyContinuation 分叉（答复型 / 新指令型）', () => {
  // 答复型分支：清单保持不变 + 禁止整体作废
  assert.match(CONT, /isReplyContinuation\s*\n?\s*\?/, 'replanHint 应以 isReplyContinuation 三元分叉')
  assert.match(CONT, /## 答复型续聊/, '应存在答复型 hint（门禁/ask_user 答复）')
  assert.match(CONT, /任务清单保持不变/, '答复型 hint 应明确清单不变')
  // 新指令型分支：三选一 —— 子任务挂树 / add-only / 真切换待批准
  assert.match(CONT, /## 续聊指令与清单/, '应存在新指令型 hint')
  assert.match(
    CONT,
    /task_create 新建节点（parent_id 挂到相关节点下/,
    '新指令型 hint 应引导子任务用 task_create 挂树（parent_id，第 1 级自动应用）',
  )
  assert.match(CONT, /add-only 补丁（第 1 级自动应用）/, '独立追加应引导 replan add-only（第 1 级）')
  assert.match(
    CONT,
    /remove\+add 重构补丁[\s\S]{0,80}第 2 级[\s\S]{0,40}等待用户批准/,
    '真正切换任务应引导 replan 重构补丁 → 第 2 级待用户批准（清空必须经批准）',
  )
  assert.match(CONT, /禁止未经批准擅自整体作废/, '新指令型 hint 应禁止模型擅自清空清单')
})

/* ============================================================
 * TC-REGEN-005 图通道原语齐备（task_create 挂树 + replan 分级）+ 多计划卡渲染保留
 * ============================================================ */

test('TC-REGEN-005 task_create 支持 parent_id 挂树；replan 第 1 级自动应用 / 第 2 级待决登记', () => {
  // task_create：parent_id 原语（子任务挂树的唯一通道）+ 建图走受审计 Replan 通道
  assert.match(GRAPH_TOOLS, /parent_id: \{ type: 'string', description: '父节点 id/, 'task_create 应声明 parent_id 参数')
  assert.match(GRAPH_TOOLS, /建图工具走 Replan 通道/, 'task_create 应走受审计通道（add-only → 第 1 级自动应用）')
  // replan：第 1 级自动应用 + 第 2/3 级登记待决（用户批准卡）
  assert.match(GRAPH_TOOLS, /第 1 级：自动应用/, 'replan 第 1 级（add-only）应自动应用')
  assert.match(GRAPH_TOOLS, /registerPendingPatch\(graph\.id, patch\)/, 'replan 第 2/3 级应登记待决表（面板批准卡）')
  assert.match(GRAPH_TOOLS, /graph_replan_proposed/, '登记后应广播待批准卡')
  // 渲染端：deriveConversation 多计划卡能力保留（历史计划卡不丢）
  assert.match(
    META,
    /steps\.filter\(\(s\) => s\.type === 'plan' && s\.plan\)/,
    'deriveConversation 应按 plan step 逐个派生计划卡',
  )
})

/* ============================================================
 * TC-REGEN-006 startIter === 0（全新任务）路径不受影响
 * ============================================================ */

test('TC-REGEN-006 全新任务（startIter === 0）首轮 plan 生成语义不变', () => {
  // 首轮分支仍存在且含 plan_start / plan-fallback 兜底（v0.17.x 语义）
  assert.match(RUN_SETUP, /if \(startIter === 0\) \{/, '首轮分支应保留')
  assert.match(RUN_SETUP, /emitEvent\(task\.id, \{ type: 'plan_start'/, '首轮 plan_start 事件保留')
  assert.match(RUN_SETUP, /'plan-fallback'/, '首轮兜底清单 source=plan-fallback 保留')
  // 引擎重建已整体移除：首轮分支自然无 _regen（全文件亦无 —— D12 v2 终版）
  const firstRunAnchor = RUN_SETUP.indexOf('if (startIter === 0) {')
  const nextAnchor = RUN_SETUP.indexOf('if (startIter > 0) {')
  const firstRunBlock = RUN_SETUP.slice(firstRunAnchor, nextAnchor)
  assert.doesNotMatch(firstRunBlock, /_regen/, '首轮分支不应出现 _regen 清理')
})

/* ============================================================
 * TC-REGEN-007 Task 类型声明 pendingAskUser（持久标记契约）
 * ============================================================ */

test('TC-REGEN-007 task.ts 声明 pendingAskUser 持久标记（与 pendingGateBlock 同模式）', () => {
  assert.match(
    TASK_TYPES,
    /pendingAskUser\?: \{ question: string; askedAt: number \}/,
    'Task 应声明 pendingAskUser?: { question: string; askedAt: number }',
  )
  assert.match(
    TASK_TYPES,
    /答复[\s\S]{0,400}?pendingAskUser\?:/,
    'pendingAskUser 注释应说明「答复型续聊」语义（答复而非新指令）',
  )
})
