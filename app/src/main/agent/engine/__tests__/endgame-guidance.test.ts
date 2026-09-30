/* ============================================================
 * ArkWork — 终局引导用例（v0.42.1 · TC-ENDG，对应 D212/D213）
 *
 * 真机根因（qwen3.8 27b，用户澄清「是因为一直无法结束，才导致到达上限的」）：
 * 弱模型干完活后反复用 task_plan 提交同一份清单当「确认完成」——
 * ① 引擎对零变化提交只回「清单已检视，无需变化」（无终局指引）；
 * ② 同参数 5/5 拦截只说「请改用替代方法」（同样无出路）；
 * ③ 模型不知道该调 task_complete / 直接给最终答复 → 死循环到 stall。
 *
 * 修复：终局指引唯一文案源 PLAN_TOOL_HINT.endgame（hint.ts），三处消费：
 *  ① task_plan 零变化 observation（act.ts，经 endgameSuffixOf 纯函数分场）
 *  ② 清单收口后的更新 observation（act.ts）
 *  ③ 预算拦截回执 + system hint（loop.ts，仅清单族）
 * 外加 seed §6 层级规划引导（D213）+ 内置 agent version 0.42.1。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs endgame-guidance
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PLAN_TOOL_HINT, endgameSuffixOf } from '../../ledger/hint.js'
/** 注释剥离器唯一真源（纪律㉒） */
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const ACT = stripComments(read('../act.ts'))
const LOOP = stripComments(read('../loop.ts'))
const HINT = stripComments(read('../../ledger/hint.ts'))
const SEED = stripComments(read('../../../store/seed.ts'))

/* ---------------- 一、纯函数真值表（真执行） ---------------- */

test('TC-ENDG-001 ★ endgameSuffixOf 真值表：无清单不引导 / 全收口给 endgame / 有在途只催推进（防误导提前收尾）', () => {
  // 无清单 → 空（没有清单就谈不上收口）
  assert.equal(endgameSuffixOf(0, 0), '')
  assert.equal(endgameSuffixOf(2, 0), '')
  // 全部终态 → 「全部收口」+ endgame 指引（task_complete / 最终答复）
  const done = endgameSuffixOf(0, 9)
  assert.match(done, /全部收口（9 项全部完成）/, '必须点明清单已收口')
  assert.match(done, /task_complete/, '必须给出收尾工具')
  assert.match(done, /最终答复/, '必须给出直接答复的替代出路')
  assert.match(done, /不要重复提交相同的清单/, '必须明说禁止重交相同清单（真机死循环的直接形态）')
  // 有在途项 → 只催推进，**不得**引导立即收尾
  const open = endgameSuffixOf(2, 9)
  assert.match(open, /仍有 2 项在途/, '必须报在途计数')
  assert.match(open, /继续推进在途项/, '必须指向继续推进')
  assert.doesNotMatch(open, /全部收口/, '有在途项时不得声称已收口')
  assert.doesNotMatch(open, /不要重复提交相同的清单/, 'endgame 强指引不得出现在有在途项的分场（防误导）')
})

test('TC-ENDG-002 ★ 纪律⑩反向核验：endgame 指引不得包含被拦调用的形态（task_plan(）', () => {
  // 指引指向换层次的动作（task_complete / 最终答复），
  // 不得复述被拦的那条调用形态（v0.34.4 D63 死循环教训）
  assert.doesNotMatch(PLAN_TOOL_HINT.endgame, /task_plan\s*\(/, 'endgame 不得复述被拦的 task_plan(...) 调用形态')
})

/* ---------------- 二、接线契约（纪律⑭：有写必须有读） ---------------- */

test('TC-ENDG-003 ★ act.ts 消费接线：零变化分支 + 更新分支都接 endgameSuffixOf（openItems 判在途）', () => {
  assert.match(ACT, /import \{ PLAN_TOOL_HINT, endgameSuffixOf \} from '\.\.\/ledger\/hint\.js'/, 'hint 导入存在')
  assert.match(ACT, /import \{ openItems \} from '\.\.\/ledger\/project\.js'/, 'openItems 导入存在（在途判据唯一事实源）')
  assert.match(ACT, /const openCount = fresh \? openItems\(fresh\)\.length : 0/, '在途计数真实计算')
  // 零变化分支：open>0 → 在途推进文案；open=0 → endgame
  assert.match(
    ACT,
    /openCount > 0 \? `\\n\$\{endgameSuffixOf\(openCount, freshItems\.length\)\}` : ''/,
    '零变化分支必须按在途数分场',
  )
  // 更新分支（模型刚把最后一项标 done 的那一刻最需要指引）：open=0 → endgame
  assert.match(ACT, /const endgame =\n?\s*openCount === 0 && freshItems\.length > 0/, '更新分支的收口 endgame 存在')
  // v0.42.2（D214c，纪律㉔ 改写）：更新分支 observation 拼接顺序
  // warnText + engineWarnText（I2 等引擎纠正）+ degradeText + endgame —— 四段都必须在
  assert.match(ACT, /\$\{warnText\}\$\{engineWarnText\}\$\{degradeText\}\$\{endgame\}/, '更新分支 observation 必须拼接引擎纠正与 endgame')
})

test('TC-ENDG-004 ★ loop.ts 消费接线：清单族被拦（回执 + 两个 system hint）都带 endgame', () => {
  assert.match(LOOP, /import \{ PLAN_TOOL_HINT \} from '\.\.\/ledger\/hint\.js'/, 'hint 导入存在')
  // 单条被拦回执：task_plan 同参数 5/5 → 回执含终局指引（真机死循环现场）
  assert.match(LOOP, /const planEndgame = isPlanWriteTool\(toolName\) \? `。\$\{PLAN_TOOL_HINT\.endgame\}` : ''/, '被拦回执按清单族特化')
  assert.match(LOOP, /请改用替代方法\$\{planEndgame\}/, '拦截 msg 必须拼接 planEndgame')
  // 两个 system hint（全部达上限 / 部分达上限）都接入
  assert.match(LOOP, /actions\.some\(\(a\) => isPlanWriteTool\(a\.tool\)\) \? PLAN_TOOL_HINT\.endgame : ''/, '全部达上限分支接入')
  assert.match(LOOP, /blocked\.some\(\(t\) => isPlanWriteTool\(t\)\) \? PLAN_TOOL_HINT\.endgame : ''/, '部分达上限分支接入')
})

test('TC-ENDG-005 消费者数量下限（纪律㊳：有文案必须有读者，防整段删除）', () => {
  const consumers = (LOOP.match(/PLAN_TOOL_HINT\.endgame/g) ?? []).length
  assert.ok(consumers >= 3, `loop.ts 至少 3 处消费（实际 ${consumers}）`)
  const actEndgame = (ACT.match(/endgameSuffixOf/g) ?? []).length
  assert.ok(actEndgame >= 3, `act.ts 至少 3 处消费 endgameSuffixOf（导入 1 + 两分支，实际 ${actEndgame}）`)
})

/* ---------------- 三、seed 层级规划引导（D213） ---------------- */

test('TC-ENDG-006 ★ seed §6 层级规划引导：三份 agent prompt 全部含「层级规划 + 立即收尾」两条', () => {
  for (const kw of ['层级规划（层次感）', '两级结构', '最多两层', '清单全部完成后立即收尾', '不要继续提交相同的清单']) {
    const n = (SEED.match(new RegExp(kw, 'g')) ?? []).length
    assert.ok(n >= 3, `提示词关键词「${kw}」应出现在 ≥3 份 agent prompt（实际 ${n}）`)
  }
})

test('TC-ENDG-007 ★ task_plan schema：parent 描述含两级结构建议；内置 agent version 同步 0.43.0', () => {
  assert.match(SEED, /多阶段任务建议建两级结构（主任务 → 子任务），简单任务平铺即可/, 'parent 字段描述必须引导层级')
  // v0.43.0（R5，纪律㉔ 改写）：§6/§7 增「改状态 / 新增项必须填 reason」→ 版本升 0.43.0
  const versions = (SEED.match(/version: '([\d.]+)'/g) ?? []).map((s) => s.replace(/\D+/g, ''))
  const target = '0430'
  assert.ok(versions.includes(target), `内置 agent version 必须升到 0.43.0（R5 reason 规则触发存量同步）`)
  assert.equal((SEED.match(/version: '0\.43\.0'/g) ?? []).length, 3, '三份内置 agent 全部同步')
})
