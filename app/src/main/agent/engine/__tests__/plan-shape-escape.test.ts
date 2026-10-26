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
const NORM = stripComments(read('../../../llm/normalize.ts'))

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

/* ---------------- 三、参数丢失自诊断（v0.48.1 · D225） ---------------- */

test('TC-PEM-005 ★ 形状校验分场自诊断：_raw 回显原文 / items 缺失报实收键名 / 非数组报实际类型', () => {
  // —— 场①：arguments 解析失败（args 只剩 {_raw}）→ 回显原文，模型能对着改 ——
  assert.match(
    ACT,
    /const rawArgsJson = typeof args\._raw === 'string' \? args\._raw\.trim\(\) : ''/,
    '_raw 存在性检查必须先于 items 判定（参数丢失 ≠ items 为空，两回事）',
  )
  assert.match(
    ACT,
    /arguments 不是合法 JSON，引擎没有收到任何字段（原始文本：/, // eslint-disable-line
    '_raw 场必须点明「没收到任何字段」并回显原始文本（诚实诊断，不冒充 items 为空）',
  )
  // —— 场②：items 缺失 → 报实收参数键（模型才知道参数丢在哪一跳）——
  assert.match(ACT, /items 缺失（实收参数键：/, '缺失场必须回显实收参数键')
  assert.match(ACT, /Object\.keys\(args\)\.filter\(\(k\) => k !== '_raw'\)/, '实收键统计必须排除 _raw 本身')
  assert.match(ACT, /items 缺失（未收到任何参数）/, '连键都没有 → 明说没收到任何参数')
  // —— 场③：items 类型不对 → 报实际类型（空数组 / 字符串 / 其他），不再千篇一律 ——
  assert.match(ACT, /items 必须是非空数组（实收 \$\{Array\.isArray\(rawItems\) \? '空数组' : typeof rawItems\}）/)
})

test('TC-PEM-006 ★ 双重编码自动抢救：字符串 items 一次解析 + 成功后回告模型（防原样重发）', () => {
  // —— 抢救函数存在且只试一次、直解失败诚实放弃（不自建第二条 repair 管线，纪律⑧）——
  assert.match(ACT, /const rescueItemsFromString = \(s: string\): unknown\[\] \| null =>/, '抢救函数定义存在')
  assert.match(ACT, /JSON\.parse\(t\)/, '抢救 = 一次 JSON 直解')
  assert.match(ACT, /Array\.isArray\(v\)\) return v/, '裸数组形态直接采用')
  assert.match(ACT, /Array\.isArray\(\(v as Record<string, unknown>\)\.items\)\)/, '包裹形态 {items:[…]} 也抢救')
  assert.match(ACT, /if \(!rawArgsJson && typeof rawItems === 'string'\)/, '抢救只在 arguments 合法且 items 为字符串时触发（互斥不越场）')
  assert.match(ACT, /itemsRescued = true/, '抢救成功必须置位（有写必须有读，见下）')
  // —— 抢救成功回告：两个 summary 分支都必须拼 rescueNote（否则下轮原样重发撞同参数预算）——
  assert.match(
    ACT,
    /items 以字符串形态提交，引擎已自动解析为清单数组/, // eslint-disable-line
    '回告文案存在：点明引擎已代为解析 + 要求直接输出 JSON 数组',
  )
  assert.match(ACT, /const rescueNote = itemsRescued/, 'rescueNote 由 itemsRescued 驱动（接线契约）')
  assert.match(ACT, /\\n当前清单：\\n\$\{overview\}\$\{rescueNote\}/, 'changed===0 分支拼接 rescueNote')
  assert.match(ACT, /\$\{endgame\}\$\{rescueNote\}/, 'changed>0 分支拼接 rescueNote')
})

test('TC-PEM-007 ★ 回显不可见字符转义 \\uXXXX（v0.48.1 D227 打包联测补遗）', () => {
  // 真机表象：「原始文本：{}」却解析失败——BOM/零宽被空白折叠与渲染吞掉，无法定罪。
  // clipRawArgs 必须把不可见字符转成 \uXXXX 字面（含 \ufeff），让下一次报错自带字节证据。
  assert.match(
    ACT,
    /const invisibleChars = \/\[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u00AD\\u200B-\\u200D\\u2060-\\u2064\\u200E\\u200F\\uFEFF\]\/g/,
    '不可见字符集合与 normalize.ts 剥离集同源（BOM/零宽/变体选择符/双向标记/软连字符/C0 控制符）',
  )
  assert.match(
    ACT,
    /\\u\$\{ch\.charCodeAt\(0\)\.toString\(16\)\.padStart\(4, '0'\)\}/,
    '逐字符转义为 \\uXXXX 四位十六进制字面（渲染不再吞字符）',
  )
  assert.match(ACT, /const escaped = s\.replace\(invisibleChars/, '转义发生在空白折叠与截断之前')
  // —— 同源契约：normalize.ts 的 parse 剥离集与 act.ts 回显转义集保持一致（单一毒源清单）——
  assert.match(
    NORM,
    /\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u00AD\\u200B-\\u200D\\u2060-\\u2064\\u200E\\u200F\\uFEFF/,
    'normalize.ts 剥离集存在（F4a parse 重试）',
  )
})
