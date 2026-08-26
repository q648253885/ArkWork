/* ============================================================
 * v0.28.1 — 无工具调用回合的「提前完成」守卫（模型自愈，不打扰用户）
 *
 * 背景（用户反馈：任务突然结束）：
 *   ReAct 循环在「模型未调用工具」时直接判为最终答复并把任务标 done
 *   （loop.ts 原逻辑）。当任务清单仍有未完成项（running/pending）、
 *   或模型输出被 finish=length 截断（工具调用被截掉）时，这种静默 done
 *   会提前结束任务，剩余代码/清单项未被执行。
 *
 * 策略（v0.28.1 二次修订：不打扰用户）：
 *   无工具调用 + 清单未完成 / 输出截断 → 一律由引擎注入 user 提示让模型
 *   自愈（首次温和提示，连续达阈值后升级为强指令：继续调工具 / task_complete
 *   二选一）。绝不弹 ask_user——用户无从判断引擎内部状态；失控由
 *   maxIterations 迭代上限兜底（超限走既有 paused + ask_user 路径）。
 *
 * 覆盖方式：与项目惯例一致 —— 源码契约断言 + 逐行对齐的纯函数复刻。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const loopSrc = readFileSync(
  fileURLToPath(new URL('../engine/loop.ts', import.meta.url)),
  'utf-8',
)

/* ---------- 纯函数复刻（与 loop.ts 逐行对齐） ---------- */

type NoToolDecision = 'done' | 'hint-gentle' | 'hint-strong'

interface NoToolInput {
  outputTruncated: boolean
  unfinishedCount: number
  consecutive: number
  threshold: number
}

/** 无工具调用回合的判定：done / 温和提示 / 强指令提示 */
function evaluateNoToolTurn(input: NoToolInput): NoToolDecision {
  if (!input.outputTruncated && input.unfinishedCount === 0) return 'done'
  return input.consecutive + 1 >= input.threshold ? 'hint-strong' : 'hint-gentle'
}

/* ---------- 1. 纯函数行为 ---------- */

test('守卫: 无未完成项且未截断 → 正常收尾 done（不破坏原逻辑）', () => {
  assert.equal(evaluateNoToolTurn({ outputTruncated: false, unfinishedCount: 0, consecutive: 0, threshold: 2 }), 'done')
  assert.equal(evaluateNoToolTurn({ outputTruncated: false, unfinishedCount: 0, consecutive: 5, threshold: 2 }), 'done')
})

test('守卫: 清单有未完成项 → 首次注入温和提示（不静默 done、不打扰用户）', () => {
  assert.equal(evaluateNoToolTurn({ outputTruncated: false, unfinishedCount: 3, consecutive: 0, threshold: 2 }), 'hint-gentle')
  assert.equal(evaluateNoToolTurn({ outputTruncated: false, unfinishedCount: 1, consecutive: 0, threshold: 2 }), 'hint-gentle')
})

test('守卫: 连续达阈值仍无工具调用 → 升级为强指令提示（仍面向模型，不 ask_user）', () => {
  assert.equal(evaluateNoToolTurn({ outputTruncated: false, unfinishedCount: 3, consecutive: 1, threshold: 2 }), 'hint-strong')
  assert.equal(evaluateNoToolTurn({ outputTruncated: false, unfinishedCount: 2, consecutive: 1, threshold: 2 }), 'hint-strong')
})

test('守卫: 输出被截断（finish=length）→ 即使无清单项也注入提示，不静默 done', () => {
  assert.equal(evaluateNoToolTurn({ outputTruncated: true, unfinishedCount: 0, consecutive: 0, threshold: 2 }), 'hint-gentle')
  assert.equal(evaluateNoToolTurn({ outputTruncated: true, unfinishedCount: 0, consecutive: 1, threshold: 2 }), 'hint-strong')
})

/* ---------- 2. 源码契约（loop.ts 确已接入守卫） ---------- */

test('loop.ts: 定义 MAX_CONSECUTIVE_NO_TOOL 阈值常量', () => {
  assert.match(loopSrc, /const\s+MAX_CONSECUTIVE_NO_TOOL\s*=\s*2/, '应定义阈值常量（默认 2）')
})

test('loop.ts: 无工具调用分支同时检查「截断」与「未完成清单项」', () => {
  assert.match(loopSrc, /const\s+outputTruncated\s*=\s*response\.finishReason\s*===\s*['"]length['"]/, '应识别 finish=length 截断')
  assert.match(
    loopSrc,
    /const\s+unfinishedCount\s*=\s*\(task\.planItems\s*\?\?\s*\[\]\)\.filter\(\s*\(?\s*p\s*\)?\s*=>\s*p\.status\s*===\s*['"]running['"]\s*\|\|\s*p\.status\s*===\s*['"]pending['"]/,
    '应统计 running/pending 未完成项',
  )
  assert.match(loopSrc, /if\s*\(\s*outputTruncated\s*\|\|\s*unfinishedCount\s*>\s*0\s*\)\s*\{/, '应基于截断/未完成项进入守卫')
})

test('loop.ts: 守卫路径只注入 user 提示并 continue，不标 done 也不暂停', () => {
  assert.match(loopSrc, /consecutiveNoToolFinal\s*\+=\s*1/, '每次无工具调用递增连续计数')
  assert.match(loopSrc, /kind:\s*['"]user_message['"]/, '应注入 user 消息作为提示')
  // 守卫块内不得出现 paused / ask_user / task_complete 终止语义
  const guardStart = loopSrc.indexOf('if (outputTruncated || unfinishedCount > 0)')
  const guardEnd = loopSrc.indexOf('// 模型未调用工具，且清单无未完成项、输出未被截断')
  assert.ok(guardStart >= 0 && guardEnd > guardStart, '守卫块应存在且位于 done 分支之前')
  const guardBlock = loopSrc.slice(guardStart, guardEnd)
  assert.ok(!/status:\s*['"]paused['"]/.test(guardBlock), '守卫块不应置 paused（不打扰用户）')
  assert.ok(!/type:\s*['"]ask_user['"]/.test(guardBlock), '守卫块不应弹 ask_user（不打扰用户）')
  assert.ok(!/type:\s*['"]task_complete['"]/.test(guardBlock), '守卫块不应标 task_complete')
  assert.match(guardBlock, /\bcontinue\b/, '守卫块应以 continue 继续循环')
})

test('loop.ts: 连续达阈值 → 提示升级为强指令（继续调工具 / task_complete 二选一）', () => {
  assert.match(loopSrc, /consecutiveNoToolFinal\s*>=\s*MAX_CONSECUTIVE_NO_TOOL/, '应基于阈值切换提示强度')
  assert.match(loopSrc, /【重要】/, '强指令提示应有明显标记')
  assert.match(loopSrc, /禁止只输出文字说明/, '强指令应明确禁止纯文字回复')
})

test('loop.ts: 有工具调用时重置连续计数（不误伤正常多轮执行）', () => {
  assert.match(loopSrc, /consecutiveNoToolFinal\s*=\s*0/, '工具调用路径应重置计数')
})

test('loop.ts: 原「无工具调用=最终答复」仅在无未完成项且未截断时触发', () => {
  const doneIdx = loopSrc.indexOf("type: 'task_complete'")
  const guardIdx = loopSrc.indexOf('unfinishedCount > 0')
  assert.ok(guardIdx >= 0 && doneIdx > guardIdx, 'done 分支应位于守卫之后')
})
