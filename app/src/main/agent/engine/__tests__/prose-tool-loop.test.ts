/* ============================================================
 * ArkWork — 正文工具降级通道主循环接线契约（v0.41.0 / D208）
 * TC-PTL-001…005（矩阵 §二 模块 P）
 *
 * 纪律⑭/㉘：接线类代码必须断言「调用点存在 + 顺序正确」；判据取源码
 * 物理顺序（stripComments 后），顺序即防线（TC-OPS-024 同族）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs prose-tool-loop
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { getRepoScan } from '@shared/utils/repo-scan'

const SRC = fileURLToPath(new URL('../../../..', import.meta.url)) // → app/src（engine/__tests__ 比顶层多一层）
const scan = getRepoScan(SRC)
const rel = (abs: string): string => relative(SRC, abs).split('\\').join('/')
const code = (abs: string): string => scan.stripped(abs)

const loopCode = code(scan.all.find((a) => rel(a) === 'main/agent/engine/loop.ts')!)
const reasonCode = code(scan.all.find((a) => rel(a) === 'main/agent/engine/reason-phase.ts')!)
const extractorCode = code(scan.all.find((a) => rel(a) === 'main/agent/engine/prose-tool-call.ts')!)

test('TC-PTL-001 ★ 回灌点顺序：normalizeToolNames 之后、action/pendingActions 判定之前（流经原生 Act 链零旁路）', () => {
  const idxNormalize = loopCode.indexOf('normalizeResponseToolNames(response)')
  const idxInject = loopCode.indexOf('extractProseToolCalls(response.content)')
  const idxAction = loopCode.indexOf('const action = response.action')
  const idxNoTool = loopCode.indexOf('if (!action && pendingActions.length === 0)')
  for (const [name, idx] of [['normalize', idxNormalize], ['inject', idxInject], ['action', idxAction], ['notool', idxNoTool]] as const) {
    assert.ok(idx > 0, `${name} 锚点必须存在（实测 ${idx}）`)
  }
  assert.ok(idxInject > idxNormalize, '回灌必须在名字归一之后（合成的名字已归一）')
  assert.ok(idxInject < idxAction, '回灌必须在 action 判定之前 —— 写回 response 后由原生链路统一消费')
  assert.ok(idxInject < idxNoTool, '回灌必须在无工具分支之前（有合成动作时根本不进无工具分支）')
})

test('TC-PTL-002 回灌条件三要素：谓词命中 + 无原生 action + 无 pendingActions', () => {
  const m = loopCode.match(/if \(proseToolFallback && !response\.action && \(response\.actions\?\.length \?\? 0\) === 0\)/)
  assert.ok(m, '回灌条件必须三要素齐备（缺一即可能双执行或漏执行）：实测源码 ' +
    JSON.stringify(loopCode.match(/if \(proseToolFallback[^)]*\)/)?.[0] ?? null))
})

test('TC-PTL-003 合成动作带 prose_ 前缀 toolCallIds + 日志留人话（纪律⑨）', () => {
  assert.match(loopCode, /prose_\$\{iteration\}_\$\{i\}/, 'observation 配对 id 必须可归因')
  assert.match(loopCode, /prose tool fallback:/, '代为执行必须留人话日志')
  assert.match(loopCode, /个无效调用已跳过|白名单\/参数不合法被拒/, 'invalid 跳过也必须留痕')
})

test('TC-PTL-004 谓词命中时提示替换为协议契约；通用"发起真实工具调用"措辞在命中分支不出现', () => {
  // 契约提示产出方：含格式样例 + 白名单，不含对弱模型无效的"发起真实调用"要求
  const hint = extractorCode.slice(extractorCode.indexOf('export function proseToolContractHint'))
  assert.match(hint, /无法使用原生工具调用/)
  assert.match(hint, /"tool"/)
  assert.ok(!hint.includes('请改为发起真实工具调用'), '契约提示不得要求弱模型发起原生调用（无效指令）')
  // loop 侧：两条 hint 注入点都必须按谓词分流
  assert.match(loopCode, /proseToolFallback\s*\n?\s*\?\s*proseToolContractHint\(\)/, '伪调用命中处与未完成提示处都要分流')
  // 否定腿：未命中谓词时旧措辞保留（既有守卫语义不回退）
  assert.match(loopCode, /请改为发起真实工具调用/, '谓词不命中时保留旧提示（否定腿）')
})

test('TC-PTL-005 reason-phase 接线：proseToolFallback → req.think=true；缺省不传（两腿）', () => {
  assert.match(reasonCode, /proseToolFallback\?: boolean/, 'ReasonPhaseArgs 必须声明可选字段')
  assert.match(reasonCode, /think: args\.proseToolFallback === true \? true : undefined/,
    '激活 → req.think=true；未激活 → undefined（请求与 v0.40.0 逐字节一致）')
  assert.match(loopCode, /proseToolFallback,\s*\n\s*\}\)/, 'loop 调 runReasonPhase 必须透传该字段')
  // run 级一次判定 + 默认关闭
  assert.match(loopCode, /const proseToolFallback = isProseToolFallbackModel\(await getModel\(opts\.modelId\)\)/)
})

test('TC-PTL-006 影响面守卫：谓词不命中时提取器零调用（默认关闭的唯一开关）', () => {
  // extractProseToolCalls 在 loop 里只允许出现一次，且在 proseToolFallback 条件内
  const occurrences = loopCode.split('extractProseToolCalls(').length - 1
  assert.equal(occurrences, 1, `提取器在 loop 中只许一个调用点（实测 ${occurrences}）`)
  const idxCond = loopCode.indexOf('if (proseToolFallback && !response.action')
  const idxCall = loopCode.indexOf('extractProseToolCalls(response.content)')
  assert.ok(idxCond < idxCall, '调用点必须被谓词条件包裹（默认零影响面）')
})
