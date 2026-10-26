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

test('TC-PTL-002 回灌条件三要素：通道激活 + 无原生 action + 无 pendingActions', () => {
  // v0.48.2（D229）：激活判据 = proseTrigger.active（谓词启动命中 或 运行中触发翻转）
  const m = loopCode.match(/if \(proseTrigger\.active && !response\.action && \(response\.actions\?\.length \?\? 0\) === 0\)/)
  assert.ok(m, '回灌条件必须三要素齐备（缺一即可能双执行或漏执行）：实测源码 ' +
    JSON.stringify(loopCode.match(/if \(proseTrigger[^)]*\)/)?.[0] ?? null))
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
  // loop 侧：两条 hint 注入点都必须按激活状态分流（v0.48.2 D229：proseTrigger.active）
  assert.match(loopCode, /proseTrigger\.active\s*\n?\s*\?\s*proseToolContractHint\(\)/, '伪调用命中处与未完成提示处都要分流')
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

test('TC-PTL-006 影响面守卫：未激活时提取器只许探测计数、不许执行（D229 后的双调用点）', () => {
  // v0.48.2（D229）后 loop 里提取器恰好两个调用点：
  //   ① 回灌门（proseTrigger.active 包裹 —— 激活才代为执行）；
  //   ② 健康度探测（!proseTrigger.active 包裹 —— 未激活只计数，绝无副作用）。
  const occurrences = loopCode.split('extractProseToolCalls(').length - 1
  assert.equal(occurrences, 2, `提取器调用点应为 2（回灌门 + 探测；实测 ${occurrences}）`)
  const idxGate = loopCode.indexOf('if (proseTrigger.active && !response.action')
  const idxProbe = loopCode.indexOf('} else if ((response.content ?? \'\').includes(\'{\'))')
  const firstCall = loopCode.indexOf('extractProseToolCalls(response.content)')
  const secondCall = loopCode.indexOf('extractProseToolCalls(response.content)', firstCall + 1)
  assert.ok(idxGate > 0 && firstCall > idxGate, '调用点①必须被激活条件包裹（激活才执行）')
  assert.ok(idxProbe > 0 && secondCall > idxProbe, '调用点②必须落在未激活探测分支（只计数不执行）')
})

test('TC-PTL-007 ★ 触发式降级接线（v0.48.2 D229）：观测块 + 翻转注入契约 + 请求体仍按启动谓词', () => {
  // ① 健康度观测块存在且未激活才观测（激活后信号冻结）
  assert.match(loopCode, /if \(!proseTrigger\.active\) \{[\s\S]*?noteNativeMalformedRound\(\)/, '观测块存在')
  // ② 翻转事件 → 契约提示注入下一轮请求
  assert.match(loopCode, /consumeActivation\(\)[\s\S]{0,500}proseToolContractHint\(\)/, '翻转 → 契约提示')
  // ③ 请求体语义不变：runReasonPhase 仍收启动谓词 proseToolFallback（think 不随触发翻转）
  assert.match(loopCode, /const proseToolFallback = isProseToolFallbackModel\(await getModel\(opts\.modelId\)\)/, '启动谓词保留')
  assert.match(loopCode, /proseTrigger = createProseFallbackTrigger\(proseToolFallback\)/, '解析层状态与请求体语义分离')
  // ④ 阈值常量 N=3 已在 TC-PTC-017 钉死（本文件为纯源码断言，不引运行时符号）
})
