/* ============================================================
 * ArkWork — 空响应防御的**接线**契约（v0.34.x · TC-EMPTYG-001..004）
 *
 * 背景（用户实测 qwen3.5:9b @ Ollama，多协议复测）：端点偶发返回
 * 「全空回合」—— content/thought/actions 全空（只吐一对空 `<think></think>`、
 * 网关毛刺、流被无声掐断等）。此前原样放行 → 烧一个迭代 → 无工具守卫
 * 提示注入 → 继续空转，实测连烧 100+ 轮直到 maxIterations。
 *
 * 判定函数 isIncompleteLlmResponse 的真值表在 llm-robustness.test.ts；
 * 本组按项目纪律（D38-a：判定与接线都要测）只钉 **reason-phase.ts 真的
 * 在正确位置接了线**：首轮调用之后、length 专用重试之前、补试上限、
 * 中止短路。
 * 运行（cwd=app）：node scripts/run-tests.mjs empty-response-guard
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const phaseSrc = readFileSync(
  fileURLToPath(new URL('../engine/reason-phase.ts', import.meta.url)),
  'utf-8',
)

test('TC-EMPTYG-001 空响应补试在位：判定条件 + 上限 2 次 + 同一调用管道', () => {
  // 判定条件：非 length（length 走下方专用提额重试）、未中止、且判定为不完整
  assert.match(
    phaseSrc,
    /response\.finishReason !== 'length' && !signal\.aborted && isIncompleteLlmResponse\(response\)/,
    '补试触发条件必须排除 finish=length、用户中止、非空回合',
  )
  // 补试上限：最多 2 次（瞬时毛刺就地消化，不无限重试）
  assert.match(phaseSrc, /for\s*\(let emptyRetry = 1; emptyRetry <= 2; emptyRetry\+\+\)/, '补试上限必须是 2 次')
  // 必须复用 callTurnLlm（流式双通道泵 + say 剥离 + 超时包装都在里面）
  const block = phaseSrc.slice(phaseSrc.indexOf('多协议空响应防御'))
  assert.match(block, /response = await callLlmWithRetry\(\(\) => callTurnLlm\(\), signal\)/, '补试必须复用 callTurnLlm 管道')
})

test('TC-EMPTYG-002 位置正确：首轮 callLlmWithRetry 之后、length 专用重试之前', () => {
  const firstCall = phaseSrc.indexOf('response = await callLlmWithRetry(() => callTurnLlm(), signal)')
  const emptyGuard = phaseSrc.indexOf("response.finishReason !== 'length'")
  const lengthRetry = phaseSrc.indexOf('reasoning exhausted output budget')
  assert.notEqual(firstCall, -1, '首轮调用必须在位')
  assert.notEqual(lengthRetry, -1, 'length 专用重试必须在位')
  assert.ok(emptyGuard > firstCall, '空响应补试必须在首轮调用之后（否则首轮结果还没拿到）')
  assert.ok(emptyGuard < lengthRetry, '空响应补试必须在 length 专用重试之前（length 场景不消耗补试次数）')
})

test('TC-EMPTYG-031 补试循环内的短路条件齐全（中止 / length / 已非空都立即停）', () => {
  const block = phaseSrc.slice(
    phaseSrc.indexOf('for (let emptyRetry = 1'),
    phaseSrc.indexOf('reasoning exhausted output budget'),
  )
  assert.match(block, /if \(signal\.aborted \|\| response\.finishReason === 'length' \|\| !isIncompleteLlmResponse\(response\)\) break/, '短路条件必须齐全')
  // 每次补试必须留 warn（复盘靠它，不能静默重试）
  assert.match(block, /logger\.warn\(/, '补试必须留 warn 日志')
  assert.match(block, /empty-retry \$\{emptyRetry\}\/2/, '日志应含进度 N/2')
})

test('TC-EMPTYG-004 判定单一真源：reason-phase 不许自写第二份「空响应」判定', () => {
  // isIncompleteLlmResponse 必须从 llm-call.js 引入（与 withLlmTimeout 同源）
  assert.match(
    phaseSrc,
    /import\s*\{[^}]*isIncompleteLlmResponse[^}]*\}\s*from\s*'\.\.\/llm-call\.js'/,
    '必须复用 llm-call 的单一真源判定，不得内联重写',
  )
})
