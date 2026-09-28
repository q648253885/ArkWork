/**
 * v0.38.0 详测 — 续聊零写树强约束的**返工后**契约（TC-ENFORCE-001…008）
 *
 * 依据：docs/versions/v0.38.0/04-system-design.md §4.5 / §6.3
 *       docs/versions/v0.38.0/01-research.md §2.1 / §2.2
 *
 * ★ 本文件是**改写**而非新增：
 *   v0.36.6 的 D127/D128 通道（`pendingTreeSync` → `treeSyncDebt` →
 *   `refuseCompletionForTreeSync`/`emitTreeSyncRefusal`）在 v0.38.0 被整体删除，
 *   原用例断言的对象已不存在。存量的 TC-ENFORCE-001…008 若只删不改，就会留下
 *   「门禁无守卫」的空档 —— 而 D150/D151/D152 三条缺陷恰恰全出在这条链上。
 *   故这里按旧编号逐条重写为**新契约**，并额外补上"旧结构不得复活"的反向断言。
 *
 *   同时保留原文件中**仍然有效**的两条：D127 的纯轮数提醒判定（TC-ENFORCE-001）、
 *   D129 的每图写锁（TC-ENFORCE-006）—— 它们与本次返工无关，属回归护栏。
 *
 * 手法：源码契约（readFileSync + 剥注释 + 正则）—— run-setup / turn-end / loop
 * 依赖 LLM/存储/Electron，node:test 无渲染/网络环境，锁结构性不变量
 * （与 continuation-regen / plan-tree-sync 同手法）。
 *
 * ⚠️ 纪律⑫：断言前**必须**剥注释。turn-end.ts 里恰好留着一段解释性注释，
 *    逐字写着被删掉的 `refuseCompletionForTreeSync` / `emitTreeSyncRefusal`
 *    （那是删除说明，不是代码）—— 不剥注释就会把说明当违规。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs tree-sync-enforce
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

const RUN_SETUP = read('../run-setup.ts')
const TURN_END = read('../turn-end.ts')
const LOOP = read('../loop.ts')
const TREE_SYNC = read('../plan-tree-sync.ts')
const PLAN_SYNC = read('../../graph/plan-sync.ts')
const LEDGER_GUARD = read('../ledger-guard.ts')
const GATE_CHANNEL = read('../gate-channel.ts')
const LEDGER_TYPES = read('../../ledger/types.ts')
const WORK_CLASS = read('../work-class.ts')

/* ============================================================
 * TC-ENFORCE-001 D127（保留）：陈旧提醒是**纯轮数**判定
 * ============================================================ */

test('TC-ENFORCE-001 D127 shouldRemindTreeSync 纯轮数：不依赖「清单有未收口项」前置', () => {
  assert.doesNotMatch(
    TREE_SYNC,
    /hasUnfinishedItems/,
    'D127：全终态但已过时的树同样必须提醒（对齐 ZCode runtime-reminders）',
  )
  assert.match(TREE_SYNC, /return state\.itersSinceTreeTouch >= state\.threshold/, '判定退化为纯轮数比较')
})

test('TC-ENFORCE-001b D154：写树判定只有一个事实源（调唯一写入口守卫，不另立白名单）', () => {
  assert.match(
    TREE_SYNC,
    /import \{ isPlanWriteTool \} from '\.\/work-class\.js'/,
    '纪律⑧：白名单只许一个事实源 —— 控制面收敛后不得再维护第二份工具名清单',
  )
  assert.match(TREE_SYNC, /isPlanWriteTool\(t\)/, '全仓只调守卫，连集合字面量都不留')
  assert.doesNotMatch(
    TREE_SYNC,
    /new Set<string>\(PLAN_TOOLS\)/,
    '不得用「清单族」（含已下架名）当「写账本」—— 旧名调用不写账本，算作写过会在门禁处静默放行',
  )
})

/* ============================================================
 * TC-ENFORCE-002 D150 run-setup：代理变量退场，改为「让模型先判断」
 * ============================================================ */

test('TC-ENFORCE-002 ★ D150 run-setup 不再挂「树同步欠账」欠账（旧结构不得复活）', () => {
  assert.doesNotMatch(
    RUN_SETUP,
    /pendingTreeSync/,
    'D150：`pendingTreeSync = startIter > 0 && !isReplyContinuation && graphId` 三个条件全是代理变量，',
  )
  assert.doesNotMatch(RUN_SETUP, /startIter > 0 && !isReplyContinuation/, '判定式整体移除，不只是改名')
})

test('TC-ENFORCE-002b D155 run-setup 注入「新输入判断」指令（原输入 + 清单快照交给模型）', () => {
  // v0.39.0（W4）：该 import 合法地多了 `emitTurnNote`（规划通道提交后通知用户），
  // 故判据放宽为「包含 injectInputJudgement 即可」，不再钉死花括号内只有它一个。
  assert.match(
    RUN_SETUP,
    /import \{[^}]*\binjectInputJudgement\b[^}]*\} from '\.\/gate-channel\.js'/,
    'run-setup 必须从 gate-channel 导入 injectInputJudgement',
  )
  assert.match(RUN_SETUP, /await injectInputJudgement\(\{/, '新输入必须**立即**注入判断请求，不等收尾')
  const idx = RUN_SETUP.indexOf('await injectInputJudgement(')
  const body = RUN_SETUP.slice(idx, idx + 500)
  assert.match(body, /inputText:/, '必须把用户原输入一并给出（模型要读的是内容，不是"有没有说话"）')
  assert.match(body, /items: ledger\.items/, '必须给出当前清单快照')
})

/* ============================================================
 * TC-ENFORCE-003 D150 loop：客观事实收集器
 * ============================================================ */

test('TC-ENFORCE-003 loop 维护「本 run 实际调用过哪些工具」与「是否写过清单」两项客观事实', () => {
  assert.match(LOOP, /const toolsThisRun: string\[\] = \[\]/, 'run 级工具调用收集器')
  assert.match(LOOP, /for \(const a of actions\) toolsThisRun\.push\(a\.tool\)/, 'Act 执行前逐条登记')
  assert.match(LOOP, /let treeTouchedThisRun = false/)
  assert.match(LOOP, /treeTouchedThisRun = true/, 'touchesPlanTree 命中即置位（欠账已偿的事实来源）')

  // v0.38.0：计数**统一从 0 起算**（续聊与首轮同待遇），不再由欠账满额启动
  assert.match(LOOP, /let itersSinceTreeTouch = 0/, '首轮与续聊同待遇 —— 不再有"续聊首轮即满额"的特权通道')
  assert.doesNotMatch(
    LOOP,
    /itersSinceTreeTouch = pendingTreeSync \? TREE_SYNC_REMIND_INTERVAL/,
    '旧欠账满额启动表达式必须消失',
  )
})

/* ============================================================
 * TC-ENFORCE-004 D150/D152 统一门禁：判定客观 + 拒绝必投递
 * ============================================================ */

test('TC-ENFORCE-004 ★ 答复型收尾走统一门禁：判据是 workClass + touchedTree，不是计数器', () => {
  const idx = LOOP.indexOf('const verdict = await guardFinish(')
  assert.ok(idx > 0, '答复型收尾必须先过 guardFinish')
  const body = LOOP.slice(idx, idx + 220)
  assert.match(body, /workClass: classifyRunWork\(toolsThisRun\)/, '判据 = 本 run 实际工具调用（客观事实）')
  assert.match(body, /touchedTree: treeTouchedThisRun/, '判据 = 是否写过清单（客观事实）')
  assert.doesNotMatch(body, /completeRefusals/, 'run 局部计数**不得**再参与判定（D151）')
})

test('TC-ENFORCE-004b ★ D152 被拒时必须投递：recordRefusal → refuseViaGate → emitTurnNote → continue', () => {
  const idx = LOOP.indexOf('if (!verdict.allow) {')
  assert.ok(idx > 0)
  const body = LOOP.slice(idx, LOOP.indexOf('await emitEvent(task.id, {\n          type: \'task_complete\'', idx))
  // ① 主线顺序：拒绝计数 → 投递拒绝卡 → 保底结论 → continue
  const order = [/await recordRefusal\(task\.id\)/, /await refuseViaGate\(/]
  let cursor = -1
  for (const re of order) {
    const at = body.search(re)
    assert.ok(at > cursor, `被拒路径必须按序出现：${re}`)
    cursor = at
  }
  // ② 投递点必须**在 refuseViaGate 之后**（v0.39.0 D180 在它之前合法地加了第二个投递点，
  //    用于「拒绝计数写失败 → 有界放行」分支；用全局 first-match 会误判顺序）
  const afterRefuse = body.slice(body.search(/await refuseViaGate\(/))
  const noteAt = afterRefuse.search(/await emitTurnNote\(/)
  assert.ok(
    noteAt > 0,
    '被拒路径必须按序出现：/await emitTurnNote\\(/ —— 尤其 emitTurnNote 不可漏（漏了用户看不到任何答复）',
  )
  assert.ok(
    afterRefuse.slice(noteAt).includes('continue'),
    '被拒后必须 continue（保底结论投递完即进入下一轮）',
  )
  // ③ D180 有界放行分支同样必须投递（否则"计数失能 + 静默放行"用户什么都看不到）
  const bounded = body.indexOf('refusalWriteFailures >= MAX_REFUSAL_WRITE_FAILURES')
  assert.ok(bounded > 0, '应存在 D180 有界放行分支')
  const boundedBody = body.slice(bounded, body.indexOf('await refuseViaGate(', bounded))
  assert.match(boundedBody, /await emitTurnNote\(/, 'D180 有界放行前必须投递人话说明（纪律⑨：不得静默放行）')
  assert.match(body, /via: 'gate-refusal'/, '保底结论必须标明来源，便于 UI 区分"模型主动汇报"与"被拦后保底"')
})

test('TC-ENFORCE-004c 拒绝必须发生在封口之前（否则"任务 done 而清单未同步"落到界面）', () => {
  const guardIdx = LOOP.indexOf('if (!verdict.allow) {')
  const sealIdx = LOOP.indexOf("await sealGraphForTaskOutcome(task, 'completed', '任务完成')")
  assert.ok(guardIdx > 0 && sealIdx > guardIdx, '门禁必须先于 sealGraphForTaskOutcome')
  const noteIdx = LOOP.indexOf("await sealLedger(task.id, 'completed', '任务完成（最终答复）')")
  assert.ok(noteIdx > guardIdx, '门禁必须先于 sealLedger')
})

/* ============================================================
 * TC-ENFORCE-005 回归护栏：既有完成语义未被绕过
 * ============================================================ */

test('TC-ENFORCE-005 回归护栏：v0.39.0（D183）完成收尾只剩**一条判据 + 一个计数**', () => {
  // D39 的第二套守卫与账本门禁**串联**（最多 2+3 次拒绝、且第二套不写账本），
  // 本版整体删除；在途项改为门禁放行后由 forceCloseOpenItems 一次性收口。
  assert.doesNotMatch(TURN_END, /MAX_COMPLETE_REFUSALS/, 'D183：第二套拒绝上限已删除')
  assert.doesNotMatch(TURN_END, /refuseCompletionForLeftovers/, 'D183：第二套未收口守卫已删除')
  assert.doesNotMatch(TURN_END, /discardIncompletePlanItems/, 'D183：超限收 cancelled 兜底已删除（与门禁"放行+收口"结论相反）')
  assert.doesNotMatch(LOOP, /completeRefusals/, 'D183：run 局部计数彻底消失（唯一落点 = 账本 resume.refusals）')
  assert.match(TURN_END, /await syncModelClaim\(/, 'v0.30.0 验证门禁保留')
})

test('TC-ENFORCE-005b ★ D151 单一计数：run 局部计数不得再作为放行/拒绝条件', () => {
  assert.doesNotMatch(
    LOOP,
    /completeRefusals === 0/,
    'D151：`completeRefusals === 0` 与账本 `resume.refusals` 叠加正是"莫名其妙被拒 3 次"的来源',
  )
  assert.doesNotMatch(TURN_END, /priorRefusals === 0/, 'turn-end 侧同样不得再有"仅首次拒绝"的判定')
  assert.doesNotMatch(LOOP, /treeSyncDebt/, 'D128 专用欠账传参必须彻底消失')
  assert.doesNotMatch(TURN_END, /treeSyncDebt/, '同上')
})

/* ============================================================
 * TC-ENFORCE-006 D129（保留）：每图写锁
 * ============================================================ */

test('TC-ENFORCE-006 D129 plan-sync 每图写锁：事务串行化 + 锁内加载 base + 空闲自清理', () => {
  assert.match(PLAN_SYNC, /const graphWriteLocks = new Map<string, Promise<unknown>>\(\)/, '按 graphId 键控的写锁表')
  assert.match(PLAN_SYNC, /function withGraphWriteLock<T>/, '通用写锁原语')
  assert.match(
    PLAN_SYNC,
    /return withGraphWriteLock\(ctx\.graphId, \(\) => commitStatusesLocked\(ctx, updates, reason, force\)\)/,
    'commitStatuses 应整体进入写锁（读图→改状态→落盘 为同一临界区）',
  )
  const lockedIdx = PLAN_SYNC.indexOf('async function commitStatusesLocked(')
  const baseIdx = PLAN_SYNC.indexOf('const base = await getGraphById(ctx.graphId)')
  assert.ok(lockedIdx > 0 && baseIdx > lockedIdx, 'base 加载必须在锁内 —— 后到者拿最新图，先到写者的变更不丢')
  assert.match(PLAN_SYNC, /graphWriteLocks\.delete\(graphId\)/, '锁表空闲后自清理（防长进程 Map 膨胀）')
})

/* ============================================================
 * TC-ENFORCE-007 D153 通道隔离
 * ============================================================ */

test('TC-ENFORCE-007 ★ D153 通道隔离：loop 不内联内部标记，两类输出各走一条通道', () => {
  assert.doesNotMatch(
    LOOP,
    /tree-sync-required/,
    'D153：内部标记只许出现在"给模型的指令"里，loop 内联会把引擎话术泄进用户视野',
  )
  assert.match(LOOP, /import \{ refuseViaGate, emitTurnNote \} from '\.\/gate-channel\.js'/, '投递统一走 gate-channel')
  // 给模型的指令 → L1 system；给用户的通告 → gate_blocked 事件；结论 → turn_note 事件
  assert.match(GATE_CHANNEL, /kind: 'gate_hint'/, '门禁指令走 system 通道（不是 user_message —— 那是 D153 的根因）')
  assert.match(GATE_CHANNEL, /type: 'gate_blocked'/, '用户通告走独立事件通道')
  assert.match(GATE_CHANNEL, /type: 'turn_note'/, '阶段结论走独立事件通道（且不写 L1）')
})

test('TC-ENFORCE-007b ★ D183 完成收口唯一路径：guardFinish 放行后 forceCloseOpenItems 收口在途项', () => {
  const guardIdx = TURN_END.indexOf('const verdict = await guardFinish(')
  assert.ok(guardIdx > 0, 'task_complete 分支必须先过 guardFinish')
  const closeIdx = TURN_END.indexOf('await forceCloseOpenItems(')
  assert.ok(closeIdx > guardIdx, '收口必须在 guardFinish 判定之后（不得先收口再判）')
  const body = TURN_END.slice(guardIdx, closeIdx + 120)
  assert.match(body, /if \(verdict\.leftovers\.length > 0\)/, '仅在途项非空才收口（空清单不得产生写操作）')
  assert.match(
    TURN_END,
    /import \{ guardFinish, recordRefusal, forceCloseOpenItems \} from '\.\/ledger-guard\.js'/,
    '收口函数必须真实引入（函数全对、接线缺失是 D78/D79 同型缺陷）',
  )
  // D153 同族：门禁指令仍不得伪装成用户消息
  assert.match(GATE_CHANNEL, /kind: 'gate_hint'/, '控制指令走 system 通道（不得写成 user_message）')
})

/* ============================================================
 * TC-ENFORCE-008 D151 唯一计数落点
 * ============================================================ */

test('TC-ENFORCE-008 ★ 旧通道彻底退场：refuseCompletionForTreeSync / emitTreeSyncRefusal 不在代码里', () => {
  assert.doesNotMatch(TURN_END, /refuseCompletionForTreeSync/, '删除说明写在注释里（已剥离），代码里不得残留')
  assert.doesNotMatch(TURN_END, /emitTreeSyncRefusal/, '同上')
  assert.doesNotMatch(
    LOOP,
    /emitTreeSyncRefusal/,
    'loop 不得再导入该函数 —— 它绕过了账本计数，是 D151 的第二个计数器',
  )
})

test('TC-ENFORCE-008b 拒绝计数唯一落点：recordRefusal 是唯一 bump-refusal 调用方，上限 3', () => {
  assert.match(LEDGER_TYPES, /export const MAX_LEDGER_REFUSALS = 3/, 'D151：上限合一后定为 3')
  assert.match(LEDGER_GUARD, /export async function recordRefusal\(/)
  assert.match(LEDGER_GUARD, /kind: 'bump-refusal'/, '账本 bump-refusal 是唯一计数动作')
  // 全仓仅一处 bump-refusal 调用（guard 自己）；清零点仅一处（ops.ts 的 touch-sync）
  assert.doesNotMatch(LOOP, /bump-refusal/, 'loop 不得直接写账本计数')
  assert.doesNotMatch(TURN_END, /bump-refusal/, 'turn-end 不得直接写账本计数')
})

test('TC-ENFORCE-008b2 D151 残留清理：pendingSync 字段已删除（只写不读的字段会被误读成门禁条件）', () => {
  assert.doesNotMatch(LEDGER_TYPES, /pendingSync/, 'LedgerResume 不得再保留这个 v0.37.0 的遗留字段')
  assert.doesNotMatch(LEDGER_GUARD, /pendingSync/)
  assert.doesNotMatch(LOOP, /pendingSync/)
  assert.doesNotMatch(TURN_END, /pendingSync/)
  assert.doesNotMatch(RUN_SETUP, /pendingSync/)
})

test('TC-ENFORCE-008c 工作分类只有一个事实源（readonly / control / plan 三族 + 守卫函数）', () => {
  assert.match(WORK_CLASS, /export const READONLY_TOOLS = \[/)
  assert.match(WORK_CLASS, /export const CONTROL_TOOLS = \[/)
  assert.match(WORK_CLASS, /export const PLAN_TOOLS = \[/, '清单族（含历史名）—— 用于"算不算实质工作"')
  assert.match(WORK_CLASS, /export const PLAN_WRITE_TOOLS = \[/, '唯一写入口 —— 用于"是否真写过账本"')
  assert.match(WORK_CLASS, /export const RETIRED_PLAN_TOOLS = \[/, '下架名单唯一事实源 —— act.ts 兜底只许引用它')
  assert.match(WORK_CLASS, /export function isReadonlyTool\(/, '调用方只许走守卫（纪律⑧）')
  assert.match(WORK_CLASS, /export function isPlanWriteTool\(/, '调用方只许走守卫（纪律⑧）')
  assert.match(WORK_CLASS, /export function isRetiredPlanTool\(/, '调用方只许走守卫（纪律⑧）')
  assert.match(WORK_CLASS, /export function classifyRunWork\(/)
  // loop 此前有一份本地 READONLY_TOOLS Set —— 已删除，全仓只留一份
  assert.doesNotMatch(LOOP, /const READONLY_TOOLS = new Set/, '第二份只读清单必须消失')
  assert.match(LOOP, /isReadonlyTool\(/, '改为调用守卫')
})
