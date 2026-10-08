/* ============================================================
 * ArkWork — task_plan 形状非法回执的「出路」用例（v0.48.0 · TC-PEM，对应 D223）
 *
 * 真机根因（公司部署 qwen3.8 27b）：模型提交 task_plan({items: []}) 后，引擎回执
 * 只有「items 必须是非空数组。请重新提交完整清单」—— 没说 task_plan 可选、没附
 * 快照、「请重新提交」驱动原样重试 → 同参数签名预算 5/5 耗尽 → task_complete
 * 被完成门禁拦 → 空转 stall，任务无法完成。
 *
 * 修复：回执按账本现状分场给出路（文案唯一事实源 hint.ts invalidShapeSuffixOf），
 * act.ts 形状非法分支 loadLedger 求现状 + renderOverview 同源快照。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plan-shape-escape
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PLAN_TOOL_NAME, invalidShapeSuffixOf } from '../../ledger/hint.js'
/** 注释剥离器唯一真源（纪律㉒） */
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const ACT = stripComments(read('../act.ts'))
const HINT = stripComments(read('../../ledger/hint.ts'))

/* ---------------- 一、纯函数真值表（真执行） ---------------- */

test('TC-PEM-001 ★ invalidShapeSuffixOf 真值表：空清单给「直接开干」出路 / 有清单给快照+收尾指引', () => {
  // —— 空清单场（itemCount <= 0，真机 qwen3.8 items[] 为空的现场）——
  for (const n of [0, -3]) {
    const empty = invalidShapeSuffixOf(n, '')
    assert.match(empty, /items 非空/, '必须点明 items 非空（纠正形状本身）')
    assert.match(empty, /直接开始执行任务/, '必须给出「直接开干」出路（引擎自动建清单）——否则模型只会原样重试')
    assert.match(empty, /可选的快路径/, '必须说明 task_plan 是可选快路径（D202 降级语义）')
  }
  // —— 有清单场：清空不被允许 + 完成给收尾 + 快照可见 ——
  const snap = '- [x] 完成调研\n- [ ] 实现修复'
  const filled = invalidShapeSuffixOf(2, snap)
  assert.match(filled, /清空清单是不被允许的操作/, '必须明说清空被拒（而非含糊的参数非法）')
  assert.match(filled, /task_complete/, '必须给出收尾出路（任务已完成时不至于空转）')
  assert.match(filled, /重新提交修正后的完整清单/, '修正路径：提交完整清单（引擎 diff，已完成项不回退）')
  assert.match(filled, /当前清单（2 项）/, '必须报当前项数')
  assert.match(filled, /完成调研/, '快照必须真实附上（模型才知道「完整清单」长什么样）')
  assert.match(filled, /实现修复/, '快照内容完整')
  // 快照为空白串 → 走「（空）」兜底，不得裸拼空行
  assert.match(invalidShapeSuffixOf(3, '   \n '), /（空）/, '空白快照回落「（空）」')
})

test('TC-PEM-002 ★ 纪律⑩反向核验：出路文案不得复述被拦调用形态 task_plan( ；两场都必须有出路', () => {
  // v0.34.4 D63 死循环教训：指引不得复述被拦的那条调用形态
  assert.doesNotMatch(invalidShapeSuffixOf(0, ''), /task_plan\s*\(/, '空清单场不得复述 task_plan( 形态')
  assert.doesNotMatch(invalidShapeSuffixOf(2, '- [x] a'), /task_plan\s*\(/, '有清单场不得复述 task_plan( 形态')
  // 两场都必须「给出路」而不是只给错误
  assert.match(invalidShapeSuffixOf(0, ''), /直接开始执行任务/)
  assert.match(invalidShapeSuffixOf(2, '- [x] a'), /task_complete/)
  // 工具名必须来自唯一事实源 PLAN_TOOL_NAME（纪律⑧），不得就地写死
  assert.match(invalidShapeSuffixOf(0, ''), new RegExp(PLAN_TOOL_NAME), '空清单场引用 PLAN_TOOL_NAME 的值')
})

/* ---------------- 二、接线契约（纪律⑭：有写必须有读） ---------------- */

test('TC-PEM-003 ★ act.ts 接线：形状非法分支 loadLedger 求现状 + renderOverview 同源快照 + 前缀保留', () => {
  assert.match(
    ACT,
    /import \{ PLAN_TOOL_HINT, endgameSuffixOf, invalidShapeSuffixOf \} from '\.\.\/ledger\/hint\.js'/,
    'hint 导入存在（与 TC-ENDG-003 同一断言口径）',
  )
  assert.match(ACT, /await import\('\.\.\/ledger\/engine\.js'\)/, '动态 import ledger/engine（主进程既有模式）')
  assert.match(ACT, /await led\.loadLedger\(placeholder\.taskId\)/, '按账本现状分场（而非臆测）')
  assert.match(
    ACT,
    /renderOverview\(curItems\.map\(\(it\) => \(\{ status: it\.status, text: it\.text \}\)\)\)/,
    '快照与成功路径同源 renderOverview（同一事实源，不另写渲染器）',
  )
  assert.match(ACT, /invalidShapeSuffixOf\(0, ''\)/, '账本读不到时按无清单场兜底（出路文案仍成立）')
  assert.match(
    ACT,
    /`task_plan 参数非法：\$\{shapeErrors\.slice\(0, 3\)\.join\('；'\)\}。status 用 todo\/doing\/done\/skipped\/blocked。\$\{wayOut\}`/,
    '既有契约前缀「task_plan 参数非法」+ 5 态枚举保留（TC-TODO 断言依赖），后接出路文案',
  )
})

test('TC-PEM-004 消费者数量下限（纪律㊳：有文案必须有读者，防整段删除）', () => {
  const consumers = (ACT.match(/invalidShapeSuffixOf/g) ?? []).length
  assert.ok(consumers >= 3, `act.ts 至少 3 处消费（导入 1 + 主路径 1 + catch 兜底 1，实际 ${consumers}）`)
  assert.match(HINT, /export function invalidShapeSuffixOf/, 'hint.ts 定义存在')
  assert.match(HINT, /\$\{PLAN_TOOL_NAME\} 是可选的快路径/, '文案引用 PLAN_TOOL_NAME 常量（单一事实源）')
})
