/* ============================================================
 * ArkWork — 协议归一化层单测（v0.36.0 F1.5 · TC-LN-001..024）
 *
 * 覆盖 llm/normalize.ts 四块能力：
 *   ① normalizeFinishReason：openai / anthropic 精确词表 + ollama/vllm 宽松
 *      词表 + 缺省 interrupted（D35 语义锁定）；
 *   ② normalizeToolCalls：malformed 标记 + _raw 保留 + 缺失 id 合成；
 *   ③ normalizeResponse：聚合 + empty 判定（reason-phase 补试链路接管口径）；
 *   ④ greeting-loop 守卫（同前缀 × 连续 N 轮）+ endpoint unhealthy 计数。
 * 另锁 adapter 薄包装（openai/anthropic mapFinishReason）与单源 error-classify。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs llm-normalize
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFinishReason,
  normalizeToolCalls,
  normalizeResponse,
  createGreetingLoopGuard,
  markEndpointUnhealthy,
  getEndpointUnhealthyCount,
  resetEndpointUnhealthy,
  __resetUnhealthyForTest,
} from '../normalize.js'
import { mapFinishReason as openaiMapFinishReason } from '../openai.js'
import { mapFinishReason as anthropicMapFinishReason } from '../anthropic.js'
import { retryableError, isContextOverflowError, LlmTimeoutError } from '../error-classify.js'

/** RawProtocolResponse.toolCalls 的元素类型（测试别名） */
type RawToolCall = Parameters<typeof normalizeToolCalls>[0][number]

/* ---------------- ① finish_reason 映射表 ---------------- */

test('TC-LN-001 openai 词表：stop/tool_calls/length/content_filter 精确映射', () => {
  assert.equal(normalizeFinishReason('openai', 'stop'), 'stop')
  assert.equal(normalizeFinishReason('openai', 'tool_calls'), 'tool_calls')
  assert.equal(normalizeFinishReason('openai', 'function_call'), 'tool_calls') // legacy 形态
  assert.equal(normalizeFinishReason('openai', 'length'), 'length')
  assert.equal(normalizeFinishReason('openai', 'content_filter'), 'content_filter')
})

test('TC-LN-002 anthropic 词表：end_turn/stop_sequence→stop、tool_use→tool_calls、max_tokens→length', () => {
  assert.equal(normalizeFinishReason('anthropic', 'end_turn'), 'stop')
  assert.equal(normalizeFinishReason('anthropic', 'stop_sequence'), 'stop')
  assert.equal(normalizeFinishReason('anthropic', 'tool_use'), 'tool_calls')
  assert.equal(normalizeFinishReason('anthropic', 'max_tokens'), 'length')
})

test('TC-LN-003 缺终止帧/未知值 → interrupted（D35：缺终止帧 ≠ 正常说完）', () => {
  for (const kind of ['openai', 'anthropic', 'ollama', 'vllm'] as const) {
    assert.equal(normalizeFinishReason(kind, null), 'interrupted')
    assert.equal(normalizeFinishReason(kind, undefined), 'interrupted')
    assert.equal(normalizeFinishReason(kind, ''), 'interrupted')
    assert.equal(normalizeFinishReason(kind, 'abort'), 'interrupted') // vLLM 实测形态
    assert.equal(normalizeFinishReason(kind, 'weird_value'), 'interrupted')
  }
})

test('TC-LN-004 ollama/vllm 宽松：同时接受 openai 与 anthropic 词表', () => {
  assert.equal(normalizeFinishReason('ollama', 'stop'), 'stop')
  assert.equal(normalizeFinishReason('ollama', 'end_turn'), 'stop')
  assert.equal(normalizeFinishReason('vllm', 'tool_use'), 'tool_calls')
  assert.equal(normalizeFinishReason('vllm', 'max_tokens'), 'length')
})

test('TC-LN-005 adapter 薄包装与单源映射等价（openai / anthropic）', () => {
  assert.equal(openaiMapFinishReason('stop'), 'stop')
  assert.equal(openaiMapFinishReason(undefined), 'interrupted')
  assert.equal(anthropicMapFinishReason('end_turn'), 'stop')
  assert.equal(anthropicMapFinishReason('tool_use'), 'tool_calls')
  assert.equal(anthropicMapFinishReason(null), 'interrupted')
})

/* ---------------- ② tool_calls 容错 ---------------- */

test('TC-LN-010 合法调用原样解析（id/name/args 保留）', () => {
  const [call] = normalizeToolCalls([
    { id: 'call_abc', name: 'shell', arguments: '{"command":"ls"}' },
  ])
  assert.equal(call.id, 'call_abc')
  assert.equal(call.name, 'shell')
  assert.deepEqual(call.args, { command: 'ls' })
  assert.equal(call.malformed, false)
})

test('TC-LN-011 arguments 非法 JSON → malformed=true + args 降级 {_raw: 原文}', () => {
  const [call] = normalizeToolCalls([
    { id: 'x', name: 'write_file', arguments: '{"path": "a.txt", ' },
  ])
  assert.equal(call.malformed, true)
  assert.deepEqual(call.args, { _raw: '{"path": "a.txt", ' })
  assert.equal(call.rawArguments, '{"path": "a.txt", ')
})

test('TC-LN-012 arguments 空串 → 按 {} 解析（端点省略 arguments 的形态）', () => {
  const [call] = normalizeToolCalls([{ id: 'x', name: 'shell', arguments: '' }])
  assert.equal(call.malformed, false)
  assert.deepEqual(call.args, {})
})

test('TC-LN-013 arguments 为非对象 JSON（数组/标量）→ malformed + _raw', () => {
  const [arr] = normalizeToolCalls([{ id: 'x', name: 't', arguments: '[1,2]' }])
  assert.equal(arr.malformed, true)
  assert.deepEqual(arr.args, { _raw: '[1,2]' })
  const [num] = normalizeToolCalls([{ id: 'y', name: 't', arguments: '42' }])
  assert.equal(num.malformed, true)
})

test('TC-LN-014 缺失/空串 id → 合成稳定 id（call_{index}_{hash8}）', () => {
  const calls = normalizeToolCalls([
    { name: 'a', arguments: '{"x":1}' },
    { id: '', name: 'b', arguments: '{"y":2}' },
    { id: 'real', name: 'c', arguments: '{}' },
  ])
  assert.match(calls[0].id, /^call_0_[0-9a-f]{8}$/)
  assert.match(calls[1].id, /^call_1_[0-9a-f]{8}$/)
  assert.equal(calls[2].id, 'real')
  // 同输入 → 同合成 id（对 name+arguments 稳定）
  const again = normalizeToolCalls([{ name: 'a', arguments: '{"x":1}' }])
  assert.equal(again[0].id, calls[0].id)
  // 不同输入 → 不同合成 id
  const other = normalizeToolCalls([{ name: 'a', arguments: '{"x":2}' }])
  assert.notEqual(other[0].id, calls[0].id)
})

test('TC-LN-015 name 缺失 → 空串（不抛错，容错优先）', () => {
  const [call] = normalizeToolCalls([{ id: 'x', arguments: '{}' }])
  assert.equal(call.name, '')
  assert.equal(call.malformed, false)
})

test('TC-LN-016 ★ arguments 为对象形态 → 直接采用（v0.48.1 D224 真机 qwen3.8 网关形态）', () => {
  // 真机根因：兼容网关返回 arguments 为对象（OpenAI 规范是字符串），此前静默
  // 降级 {} → items 在到达 act.ts 前消失 →「items 必须是非空数组」与事实不符。
  const [call] = normalizeToolCalls([
    {
      id: 'call_x',
      name: 'task_plan',
      arguments: { items: [{ text: '调研', status: 'todo' }], reason: '开局' },
    } as unknown as RawToolCall,
  ])
  assert.equal(call.id, 'call_x')
  assert.equal(call.name, 'task_plan')
  assert.equal(call.malformed, false, '对象形态是合法参数载体，不得标 malformed')
  assert.deepEqual(call.args, { items: [{ text: '调研', status: 'todo' }], reason: '开局' })
  assert.equal(
    call.rawArguments,
    JSON.stringify({ items: [{ text: '调研', status: 'todo' }], reason: '开局' }),
    'rawArguments 保留对象序列化原文（诊断可回放）',
  )
})

test('TC-LN-017 对象形态边界回归：数组 / null / 缺省不受新分支影响', () => {
  // 数组：不是参数对象 → 不走对象直采分支，维持旧行为（arguments 视为缺失 → {}）
  const [arr] = normalizeToolCalls([{ id: 'x', name: 't', arguments: [1, 2] } as unknown as RawToolCall])
  assert.equal(arr.malformed, false)
  assert.deepEqual(arr.args, {})
  // null / 缺省：无参数语义，维持既有行为（空对象解析）
  const [nil] = normalizeToolCalls([{ id: 'x', name: 't', arguments: null }])
  assert.equal(nil.malformed, false)
  assert.deepEqual(nil.args, {})
  const [absent] = normalizeToolCalls([{ id: 'x', name: 't' }])
  assert.equal(absent.malformed, false)
  assert.deepEqual(absent.args, {})
})

test('TC-LN-018 ★ 字符串 arguments 夹带不可见字符 → 剥离重试一次（v0.48.1 D227 打包联测补遗）', () => {
  // 真机表象：「arguments 不是合法 JSON（原始文本：{}）」而 JSON.parse("{}") 不可能
  // 失败 → 原文夹带 BOM/零宽等不可见格式字符（恰被回显链路 trim/\s 折叠成干净的 {}）。
  // 腿①：BOM 前缀 + 完整参数 → 剥离重试成功，args 完整采用（malformed=false）
  const bomArgs = '\uFEFF{"items":[{"text":"调研","status":"todo"}],"reason":"开局"}'
  const [bom] = normalizeToolCalls([{ id: 'x', name: 'task_plan', arguments: bomArgs }])
  assert.equal(bom.malformed, false, 'BOM 毒化但剥离后可解析 → 不标 malformed')
  assert.deepEqual(bom.args, { items: [{ text: '调研', status: 'todo' }], reason: '开局' })
  assert.equal(bom.rawArguments, bomArgs, 'rawArguments 保留原始原文（诊断可回放）')
  // 腿②：零宽字符夹在结构里 → 同样重试成功
  const zwspArgs = '{\u200b"command":"ls"\u200d}'
  const [zwsp] = normalizeToolCalls([{ id: 'y', name: 'shell', arguments: zwspArgs }])
  assert.equal(zwsp.malformed, false)
  assert.deepEqual(zwsp.args, { command: 'ls' })
  // 腿③：真正常非法 JSON（无不可见字符）→ 重试仍失败，维持 _raw 降级且保留原文
  const [broken] = normalizeToolCalls([{ id: 'z', name: 'write_file', arguments: '{"path": "a.txt", ' }])
  assert.equal(broken.malformed, true)
  assert.deepEqual(broken.args, { _raw: '{"path": "a.txt", ' })
  assert.equal(broken.rawArguments, '{"path": "a.txt", ')
  // 腿④：重试成功也不碰字符串值内容——值内的不可见字符原样保留
  const inValue = '{"note":"a\uFEFFb"}'
  const [val] = normalizeToolCalls([{ id: 'w', name: 't', arguments: inValue }])
  assert.equal(val.malformed, false, '原样可解析 → 零干预，不剥离字符串值内容')
  assert.deepEqual(val.args, { note: 'a\uFEFFb' })
})

test('TC-LN-041 ★ 整体双重编码剥离：arguments 是被二次 stringify 的参数对象（v0.48.2 D228①）', () => {
  // 业界口径（vLLM tool parser 归一化层）：网关剥码。字段级双重编码由 act.ts items
  // 抢救兜底（D225），本层收口「arguments 整体被二次序列化」形态：
  // parse 出字符串、其内容再 parse 出对象 → 二次采用。
  const inner = { items: [{ text: '调研', status: 'todo' }], reason: '开局' }
  const twice = JSON.stringify(JSON.stringify(inner))
  const [dbl] = normalizeToolCalls([{ id: 'x', name: 'task_plan', arguments: twice }])
  assert.equal(dbl.malformed, false, '双层编码剥开后是合法参数对象 → 不标 malformed')
  assert.deepEqual(dbl.args, inner)
  assert.equal(dbl.rawArguments, twice, 'rawArguments 保留原始原文（诊断可回放）')
  // 反例①：parse 出字符串但内容不是 JSON 对象 → 维持 _raw 降级（不误收）
  const [plain] = normalizeToolCalls([{ id: 'y', name: 't', arguments: JSON.stringify('hello') }])
  assert.equal(plain.malformed, true)
  assert.deepEqual(plain.args, { _raw: JSON.stringify('hello') })
  // 反例②：内层剥出来是数组 → 仍拒收（asRecord 不做隐式转换，与数组形态口径一致）
  const [arr] = normalizeToolCalls([{ id: 'z', name: 't', arguments: JSON.stringify(JSON.stringify([1, 2])) }])
  assert.equal(arr.malformed, true)
})

test('TC-LN-042 ★ 截断 JSON 闭合补全（v0.48.2 D228②；仅 allowTruncationRepair 开启时）', () => {
  const truncated = '{"items": [{"text": "a"'
  // 腿①：补全开启 → 闭合重验成功采用
  const [fixed] = normalizeToolCalls([{ id: 'x', name: 'task_plan', arguments: truncated }], {
    allowTruncationRepair: true,
  })
  assert.equal(fixed.malformed, false, '截断形态补全后可解析 → 采用')
  assert.deepEqual(fixed.args, { items: [{ text: 'a' }] })
  // 腿②：尾部悬空逗号也一并剥掉
  const [comma] = normalizeToolCalls([{ id: 'y', name: 't', arguments: '{"command":"ls",' }], {
    allowTruncationRepair: true,
  })
  assert.equal(comma.malformed, false)
  assert.deepEqual(comma.args, { command: 'ls' })
  // 腿③：默认（不传 opts）不补全 → 维持 _raw 降级（既有路径逐字节不变）
  const [off] = normalizeToolCalls([{ id: 'w', name: 't', arguments: truncated }])
  assert.equal(off.malformed, true, '未开启补全 → 旧行为')
  assert.deepEqual(off.args, { _raw: truncated })
  // 腿④：截断停在键名中间 → 补全产物不合法，parse 验证失败回落 _raw（宁缺毋滥）
  const [midKey] = normalizeToolCalls([{ id: 'm', name: 't', arguments: '{"te' }], {
    allowTruncationRepair: true,
  })
  assert.equal(midKey.malformed, true)
  // 腿⑤：结构完整但语法非法（非截断形态）→ 不画蛇添足
  const [broken] = normalizeToolCalls([{ id: 'b', name: 't', arguments: '{"bad' }], {
    allowTruncationRepair: true,
  })
  assert.equal(broken.malformed, true)
})

/* ---------------- ③ normalizeResponse 聚合 ---------------- */

test('TC-LN-043 ★ 截断补全安全阀：finish_reason=length 不补全（v0.48.2 D228② Pi agent loop 原则）', () => {
  // 被输出长度截断的调用即使可补全也不执行 —— 半截参数比失败更危险。
  // 腿①：length → 不补全，malformed + _raw 保留原文
  const truncated = '{"items": [{"text": "a"'
  const len = normalizeResponse(
    { toolCalls: [{ id: 'x', name: 'task_plan', arguments: truncated }], finishReason: 'length' },
    'openai',
  )
  assert.equal(len.finishReason, 'length')
  assert.equal(len.toolCalls[0]!.malformed, true, 'length 截断 → 不补全')
  assert.deepEqual(len.toolCalls[0]!.args, { _raw: truncated })
  // 腿②：max_tokens（ollama 词表）同归 length → 同样不补全
  const mt = normalizeResponse(
    { toolCalls: [{ id: 'y', name: 't', arguments: truncated }], finishReason: 'max_tokens' },
    'ollama',
  )
  assert.equal(mt.finishReason, 'length')
  assert.equal(mt.toolCalls[0]!.malformed, true)
  // 腿③：stop → 允许补全（同形态采用）
  const ok = normalizeResponse(
    { toolCalls: [{ id: 'z', name: 'task_plan', arguments: truncated }], finishReason: 'stop' },
    'openai',
  )
  assert.equal(ok.toolCalls[0]!.malformed, false, '正常终止帧 → 补全开启')
  assert.deepEqual(ok.toolCalls[0]!.args, { items: [{ text: 'a' }] })
})

test('TC-LN-020 聚合：text/reasoning/toolCalls/finishReason/usage 齐全', () => {
  const r = normalizeResponse(
    {
      content: '你好',
      reasoningContent: '想一想',
      toolCalls: [{ id: 't1', name: 'shell', arguments: '{}' }],
      finishReason: 'tool_calls',
      usage: { tokensIn: 10, tokensOut: 5 },
    },
    'openai',
  )
  assert.equal(r.text, '你好')
  assert.equal(r.reasoning, '想一想')
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.finishReason, 'tool_calls')
  assert.equal(r.tokensIn, 10)
  assert.equal(r.tokensOut, 5)
  assert.equal(r.empty, false)
  assert.equal(r.malformedToolCallCount, 0)
})

test('TC-LN-021 空文本 + 空 toolCalls → empty=true（reason-phase 补试链路接管口径）', () => {
  assert.equal(normalizeResponse({ content: '', finishReason: 'stop' }, 'openai').empty, true)
  assert.equal(normalizeResponse({ content: '   \n\t' }, 'anthropic').empty, true)
  assert.equal(normalizeResponse({}, 'ollama').empty, true)
})

test('TC-LN-022 有 toolCalls 即不 empty（即便文本为空）', () => {
  const r = normalizeResponse(
    { content: '', toolCalls: [{ id: 't', name: 'shell', arguments: '{}' }] },
    'openai',
  )
  assert.equal(r.empty, false)
})

test('TC-LN-023 toolCalls 非数组 / 字段类型异常 → 容错为空集，不抛错', () => {
  const r = normalizeResponse({ content: 'ok', toolCalls: 'garbage' as unknown as RawToolCall[] }, 'openai')
  assert.deepEqual(r.toolCalls, [])
  assert.equal(r.text, 'ok')
})

test('TC-LN-024 usage 缺失 → tokensIn/Out 为 0；malformed 计数正确', () => {
  const r = normalizeResponse(
    {
      content: '',
      toolCalls: [
        { id: 'a', name: 'x', arguments: 'bad json' },
        { id: 'b', name: 'y', arguments: '{}' },
      ],
    },
    'vllm',
  )
  assert.equal(r.tokensIn, 0)
  assert.equal(r.tokensOut, 0)
  assert.equal(r.malformedToolCallCount, 1)
})

/* ---------------- ④ greeting-loop 守卫 + unhealthy 计数 ---------------- */

test('TC-LN-030 守卫真值表：连续 3 轮同前缀才触发（maxRepeat=3）', () => {
  const guard = createGreetingLoopGuard({ reference: '帮我分析一下整个工作区的结构' })
  assert.deepEqual(guard.observe('帮我分析一下整个工作区的结构！很高兴见到你。'), { repeated: false, streak: 1 })
  assert.deepEqual(guard.observe('帮我分析一下整个工作区的结构！！'), { repeated: false, streak: 2 })
  const v = guard.observe('帮我分析一下整个工作区的结构。你好。')
  assert.equal(v.repeated, true)
  assert.equal(v.streak, 3)
  // 触发后 streak 归零重新累计
  assert.deepEqual(guard.observe('帮我分析一下整个工作区的结构。'), { repeated: false, streak: 1 })
})

test('TC-LN-031 中途正常回复 → streak 归零', () => {
  const guard = createGreetingLoopGuard({ reference: '修复登录页的 bug' })
  guard.observe('修复登录页的 bug 是我的专长。')
  guard.observe('修复登录页的 bug 需要两步。')
  assert.deepEqual(guard.observe('已完成修复。'), { repeated: false, streak: 0 })
})

test('TC-LN-032 空白差异不影响同前缀判定（whitespace 归一）', () => {
  const guard = createGreetingLoopGuard({ reference: '你好\n 世界\t 今天' })
  assert.deepEqual(guard.observe('你好 世界 今天 大家好'), { repeated: false, streak: 1 })
})

test('TC-LN-033 空响应不参与重复判定（prefix 为空 → 不累计）', () => {
  const guard = createGreetingLoopGuard({ reference: '你好世界' })
  assert.deepEqual(guard.observe(''), { repeated: false, streak: 0 })
  assert.deepEqual(guard.observe('   '), { repeated: false, streak: 0 })
})

test('TC-LN-034 基准为空 → 守卫不激活', () => {
  const guard = createGreetingLoopGuard({ reference: '' })
  assert.deepEqual(guard.observe('任何内容'), { repeated: false, streak: 0 })
})

test('TC-LN-035 prefixChars 截断比较（长文本按前缀判定）', () => {
  const long = 'A'.repeat(100)
  const guard = createGreetingLoopGuard({ reference: long, prefixChars: 80 })
  // 前 80 字符一致、后缀不同 → 仍判重复
  assert.deepEqual(guard.observe(long + 'B'), { repeated: false, streak: 1 })
})

test('TC-LN-036 unhealthy 计数：mark/get/reset 按 endpoint|modelId 维度聚合', () => {
  __resetUnhealthyForTest()
  assert.equal(markEndpointUnhealthy('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 1)
  assert.equal(markEndpointUnhealthy('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 2)
  assert.equal(getEndpointUnhealthyCount('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 2)
  // 不同 endpoint / 不同 modelId 互不干扰
  assert.equal(getEndpointUnhealthyCount('http://other:11434/v1', 'qwen3.5:9b'), 0)
  assert.equal(getEndpointUnhealthyCount('http://192.168.31.57:11434/v1', 'other:8b'), 0)
  resetEndpointUnhealthy('http://192.168.31.57:11434/v1', 'qwen3.5:9b')
  assert.equal(getEndpointUnhealthyCount('http://192.168.31.57:11434/v1', 'qwen3.5:9b'), 0)
  // endpoint 缺省退化为 modelId 维度
  assert.equal(markEndpointUnhealthy(undefined, 'qwen3.5:9b'), 1)
  assert.equal(getEndpointUnhealthyCount('', 'qwen3.5:9b'), 1)
  __resetUnhealthyForTest()
})

/* ---------------- 单源 error-classify（F1.4 回归锁定） ---------------- */

test('TC-LN-040 retryableError / isContextOverflowError / LlmTimeoutError 单源可用', () => {
  assert.equal(retryableError(new Error('429 Too Many Requests')), true)
  assert.equal(retryableError(new Error('fetch failed')), true)
  assert.equal(retryableError(new Error('The user aborted a request.')), false) // 用户中止不重试
  assert.equal(isContextOverflowError(new Error('maximum context length exceeded')), true)
  const t = new LlmTimeoutError('LLM 调用超时 (timeout 120s)')
  assert.equal(isContextOverflowError(t), true) // 超时按窗口膨胀处理
  assert.equal(t.name, 'LlmTimeoutError')
})
