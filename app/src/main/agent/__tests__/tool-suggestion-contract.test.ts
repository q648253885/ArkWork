/* ============================================================
 * ArkWork — 失败回执的「替代建议」契约（v0.34.4 · TC-SUGG-001..012）
 * 规格来源：docs/versions/v0.34.4/00-release-goal.md §3.1（D63）/ 纪律⑩
 *
 * 立组原因（真机 t1 · T-20260919-6c3v48，51 轮空转 / 零产物）：
 *   `act.ts` 的 `suggestionFor('file-reader')` 第 ② 条写着
 *   「用 file-reader({ path: "." }) 列出工作区根目录」—— **正是刚刚被
 *   「同参数调用已达上限（5/5）」拦掉的那条调用**。模型照做 → 再被拦 → 再读到同一条
 *   建议 → 确定性死循环（I15/18/24/39/45/49 六次重试同一被拦调用）。
 *
 * 纪律⑩：**错误回执不得指向本轮已被拒绝的那条调用。**
 * 建议必须满足「换参数 / 换工具 / 换层次」至少其一。
 *
 * 本组刻意**直接调用生产函数** `buildObservationSummary`（而非只 grep 源码）——
 * 纪律⑨/D38-a 的教训：断言"仓库里有这句话"不等于断言"模型真的看到这句话"。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs tool-suggestion
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildObservationSummary } from '../engine/act.js'

const actSrc = readFileSync(fileURLToPath(new URL('../engine/act.ts', import.meta.url)), 'utf-8')

/** 复刻 loop.ts 预算守卫在拦截时合成的失败摘要形态 */
function blockedSummary(tool: string, limit = 5): string {
  const msg = `${tool} 同参数调用已达上限（${limit}/${limit}），请改用替代方法`
  return buildObservationSummary(tool, { error: msg }, msg, false)
}

/* ============================================================
 * ① 真机反例：建议里不得再出现被拦的那条调用
 * ============================================================ */

test('TC-SUGG-001 ★ [D63] file-reader 被拦后的回执不得再建议 file-reader', () => {
  const out = blockedSummary('file-reader')
  assert.match(out, /已达上限/, '前提：回执应包含拦截原因')
  assert.doesNotMatch(
    out,
    /file-reader\s*\(\s*\{\s*path:\s*["']\.["']\s*\}\)/,
    '★ 真机死循环原文：不得建议 file-reader({ path: "." }) —— 那正是被拦的调用',
  )
  assert.doesNotMatch(
    out,
    /用\s*file-reader\s*\(/,
    '★ 同一工具的同一形态不得作为建议出现（纪律⑩）',
  )
})

test('TC-SUGG-002 ★ [D63] file-reader 建议必须给出「换参数」的明确指引', () => {
  const out = blockedSummary('file-reader')
  assert.match(out, /换\*\*不同\*\*的\s*path|不同的 path|换一个\*\*不同\*\*/, '必须点明"换不同的 path"')
  assert.match(out, /glob-search/, '必须给出跨工具的替代路径')
})

test('TC-SUGG-003 ★ [D63] glob-search / grep-search 必须有自己的建议分支（不得落 default 空话）', () => {
  for (const tool of ['glob-search', 'grep-search']) {
    const out = blockedSummary(tool)
    assert.doesNotMatch(
      out,
      /^\[[^\]]+\] failed: .*尝试换一种方法或基于已有信息推理。\s*$/,
      `★ ${tool} 不应落到无信息量的 default 建议（真机里模型据此弹回 file-reader 乒乓）`,
    )
    assert.match(out, /pattern|更精确/, `${tool} 的建议应指向"换更精确的 pattern"`)
  }
})

/* ============================================================
 * ② 反面：不得把「同族别的工具」也算成可恢复建议的前提说反
 * ============================================================ */

test('TC-SUGG-004 [D63/D154] 已下架清单工具（todo-update）被拦 → 建议必须指向 task_plan 单入口', () => {
  // v0.38.1（D166 测试侧改写随新语义）：D154 下架 todo-update 后，建议契约从
  // 「讲清 item_index 0-based」变为「指向 task_plan 单入口 + 禁止新造工具名」。
  const out = blockedSummary('todo-update')
  assert.match(out, /已废弃/, '必须明确告知工具已废弃')
  assert.match(out, /task_plan/, '必须指向唯一入口 task_plan')
  assert.match(out, /完整清单/, '必须讲清 task_plan 的完整清单契约')
  assert.match(out, /不要新造工具名/, '必须明确禁止自造工具名')
})

test('TC-SUGG-005 [D63] default 分支不得是"换一种方法"这类空话', () => {
  const out = blockedSummary('some-unknown-tool')
  assert.doesNotMatch(out, /^\[[^\]]+\] failed: .*尝试换一种方法或基于已有信息推理。\s*$/, 'default 建议必须可执行')
  assert.match(out, /产出|结论|换个参数|同类工具/, 'default 必须给出具体的下一步动作')
})

/* ============================================================
 * ③ 不得误伤：成功回执 / 静默工具的既有契约
 * ============================================================ */

test('TC-SUGG-006 [D63 反向] 成功回执不含"失败/替代建议"字样', () => {
  const ok = buildObservationSummary(
    'file-reader',
    { path: 'a.md', content: 'hello', lines: 1, size: 5, truncated: false },
    '[file-reader] a.md (1 lines, 5 bytes)',
    true,
  )
  assert.doesNotMatch(ok, /替代建议/, '成功回执不得附建议')
  assert.doesNotMatch(ok, /failed/, '成功回执不得写 failed')
})

test('TC-SUGG-007 [D63 反向] task_complete / ask_user 失败时保持静默（不附建议）', () => {
  for (const t of ['task_complete', 'ask_user']) {
    const out = buildObservationSummary(t, { error: 'x' }, 'x', false)
    assert.doesNotMatch(out, /替代建议/, `${t} 属终止语义，不应附替代建议`)
  }
})

/* ============================================================
 * ④ 接线与纪律：建议表本身的形状
 * ============================================================ */

test('TC-SUGG-008 ★ 建议表显式声明纪律⑩，且 file-reader 分支保留历史注释', () => {
  assert.match(actSrc, /纪律⑩/, '★ 建议表必须显式标注纪律⑩（防后来者再犯）')
  assert.match(actSrc, /不得建议本轮刚被拒绝的那条调用/, '★ 必须写明判据')
  // v0.17.x 的 shell ls 死循环注释仍应保留（历史教训不删）
  assert.match(actSrc, /不得再建议 shell ls/, 'v0.17.x 的历史教训注释应保留')
})

test('TC-SUGG-009 [D63/D154] 建议表覆盖清单：file-reader / glob / grep / task_plan + 下架守卫各有分支', () => {
  // v0.38.1（D166 测试侧改写随新语义）：D154 后下架工具不再逐个 case（内联清单会随
  // 下架名单扩容静默漏项），统一走 isRetiredPlanTool 守卫；task_plan 自己有专属分支。
  const body = actSrc.slice(
    actSrc.indexOf('const suggestionFor = (t: string)'),
    actSrc.indexOf('if (!ok) {'),
  )
  assert.ok(body.length > 0, '应能切出 suggestionFor 函数体')
  assert.match(body, /isRetiredPlanTool\(t\)/, '下架清单工具应走唯一守卫（纪律⑧，不逐个 case）')
  for (const key of ["case 'file-reader':", "case 'glob-search':", "case 'grep-search':", "case 'task_plan':"]) {
    assert.ok(body.includes(key), `建议表应含 ${key}`)
  }
})

test('TC-SUGG-010 ★ [D63 结构化] 任何分支都不得建议"同一工具的同一无参/点路径调用"', () => {
  const body = actSrc.slice(
    actSrc.indexOf('const suggestionFor = (t: string)'),
    actSrc.indexOf('if (!ok) {'),
  )
  // 抓所有 `xxx(` 形态的工具调用建议，断言没有 `path: "."` 这类"原样重试"写法
  assert.doesNotMatch(body, /path:\s*["']\.["']/, '★ 建议表内不得残留 path:"." 的自指标识')
  assert.doesNotMatch(body, /<dir>\/\*\*\/\*/, '★ 不得再建议与 file-reader 等价的宽 glob 兜底写法')
})
