/* ============================================================
 * ArkWork — Ollama qwen3.5 正文工具调用提取器（v0.41.0 / D208；v0.48.1 D226 证伪关闭：真机 qwen3.8 走 OpenAI 协议，谓词不扩）
 * TC-PTC-001…015（矩阵 §二 模块 O）
 *
 * ★ 用例价值声明：TC-PTC-003 / 008 / 009 的 mock 数据取自用户提供的
 *   qwen3.5:9b 实机会话**原文形态** —— 单测构造不出来的真实输入
 * （纪律㊱/㊱：引擎↔模型接口的边界形态必须被真实模型跑过或以真实样本钉住）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs prose-tool-call
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractProseToolCalls,
  isProseToolFallbackModel,
  proseToolContractHint,
  createProseFallbackTrigger,
  PROSE_FALLBACK_TRIGGER_THRESHOLD,
  PROSE_TOOL_CALL_LIMIT,
} from '../prose-tool-call.js'

test('TC-PTC-001 fenced json 对象命中', () => {
  const raw = '我来读取文件。\n```json\n{"tool": "shell", "arguments": {"command": "ls"}}\n```'
  const { calls, invalid } = extractProseToolCalls(raw)
  assert.equal(invalid, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.tool, 'shell')
  assert.deepEqual(calls[0]!.args, { command: 'ls' })
})

test('TC-PTC-002 裸 JSON 对象（无 fence）命中', () => {
  const { calls } = extractProseToolCalls('直接输出：{"tool":"grep-search","arguments":{"pattern":"foo"}}')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.tool, 'grep-search')
})

test('TC-PTC-003 ★ 实机主形态：扁平键 {"tool":"file-reader","path":"."}（用户日志原文）', () => {
  // 原文语境：模型先说一段话，再跟一个扁平 JSON
  const raw = '正在执行计划第 1 步：分析项目结构与技术栈（读取根目录文件列表）。\n{"tool": "file-reader", "path": "."}'
  const { calls, invalid } = extractProseToolCalls(raw)
  assert.equal(invalid, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.tool, 'file-reader')
  assert.deepEqual(calls[0]!.args, { path: '.' }, '保留键以外的键必须全部视作参数')
})

test('TC-PTC-004 键别名 name/parameters/args/input；arguments 优先于扁平键', () => {
  const a = extractProseToolCalls('{"name":"shell","parameters":{"cmd":"pwd"}}')
  assert.equal(a.calls[0]!.tool, 'shell')
  assert.deepEqual(a.calls[0]!.args, { cmd: 'pwd' })
  const b = extractProseToolCalls('{"tool":"shell","args":{"x":1}}')
  assert.deepEqual(b.calls[0]!.args, { x: 1 })
  // arguments 与扁平键同时存在 → arguments 优先，扁平键不混入
  const c = extractProseToolCalls('{"tool":"shell","arguments":{"a":1},"path":"."}')
  assert.deepEqual(c.calls[0]!.args, { a: 1 })
  assert.equal('path' in c.calls[0]!.args, false)
})

test('TC-PTC-005 数组多调用按序产出，上限 4/轮', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ tool: 'file-reader', path: `f${i}` }))
  const { calls } = extractProseToolCalls(JSON.stringify(items))
  assert.equal(calls.length, PROSE_TOOL_CALL_LIMIT)
  assert.equal(calls[0]!.args.path, 'f0')
  assert.equal(calls[3]!.args.path, 'f3')
})

test('TC-PTC-006 ★ 白名单外名称（幻觉工具名）不执行、计 invalid', () => {
  const { calls, invalid } = extractProseToolCalls('{"tool": "file-system-probe", "path": "."}')
  assert.equal(calls.length, 0, '防幻觉执行的最后闸：不在白名单一律不执行')
  assert.equal(invalid, 1)
})

test('TC-PTC-007 参数 JSON 损坏 → repairJson 容错；不可修复 → invalid', () => {
  const ok = extractProseToolCalls('```json\n{"tool":"shell","arguments":{"cmd":"ls",}}\n```')
  assert.equal(ok.calls[0]!.tool, 'shell', '尾逗号可修复')
  const bad = extractProseToolCalls('{"tool":"shell","arguments":"{{{完全不是JSON"}')
  assert.equal(bad.calls.length, 0)
  assert.equal(bad.invalid, 1)
})

test('TC-PTC-008 ★ 大模型形态：同一段 JSON 说两遍仍能提取（D205 同族）', () => {
  const one = JSON.stringify([{ tool: 'file-reader', path: '.' }])
  const raw = `${one}\n${one}`
  const { calls, invalid } = extractProseToolCalls(raw)
  assert.equal(invalid, 0)
  assert.ok(calls.length >= 1, '至少提取出一份')
  assert.equal(calls.length, 1, '去重后只执行一次（重复执行 = 双倍副作用）')
})

test('TC-PTC-009 ★ 大模型形态：[running] 叙述 + JSON 混排，只取 JSON', () => {
  const raw = '[running] 读取 CSV 文件并解析数据\n{"tool": "file-reader", "path": "data.csv"}\n[pending] 生成图表'
  const { calls, invalid } = extractProseToolCalls(raw)
  assert.equal(invalid, 0)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, { path: 'data.csv' })
})

test('TC-PTC-010 fence 语言标注有/无都吃；多 fence 取最后一个合法块', () => {
  const withLang = extractProseToolCalls('```json\n{"tool":"shell","arguments":{}}\n```')
  assert.equal(withLang.calls.length, 1)
  const noLang = extractProseToolCalls('```\n{"tool":"shell","arguments":{}}\n```')
  assert.equal(noLang.calls.length, 1)
  const two = extractProseToolCalls(
    '```json\n{"tool":"bad-hallucinated-name"}\n```\n```json\n{"tool":"shell","arguments":{}}\n```',
  )
  assert.equal(two.calls.length, 1, '首个 fence 是幻觉名 → 只取后一个合法块')
  assert.equal(two.calls[0]!.tool, 'shell')
})

test('TC-PTC-011 ★ 宁缺毋滥：散文 / 代码 / 清单数组一律不产出', () => {
  assert.deepEqual(extractProseToolCalls('我会先读取根目录，然后分析 pom.xml 和 src 结构，请稍等。'), { calls: [], invalid: 0 })
  assert.equal(extractProseToolCalls('```js\nconst x = useState(0)\n```').calls.length, 0, '代码里的调用形态不算')
  // 清单数组（元素无 tool/name 键）→ 静默跳过、不产 calls 也不产 invalid（D177 管辖）
  const plan = extractProseToolCalls('[{"text":"读取配置","status":"todo"},{"text":"写代码","status":"todo"}]')
  assert.deepEqual(plan, { calls: [], invalid: 0 })
})

test('TC-PTC-012 task_plan 正文调用命中（走真实工具路径，引擎照常落账）', () => {
  const raw = '{"tool":"task_plan","arguments":{"items":[{"text":"步1","status":"todo"}]}}'
  const { calls } = extractProseToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.tool, 'task_plan')
  assert.deepEqual(calls[0]!.args, { items: [{ text: '步1', status: 'todo' }] })
})

test('TC-PTC-013 谓词 isProseToolFallbackModel 真值表（默认关闭、只对 ollama qwen3.5 放行）', () => {
  const m = (id: string, kind: string, baseURL?: string) => ({ id, kind, baseURL } as never)
  assert.equal(isProseToolFallbackModel(m('qwen3.5:9b', 'ollama')), true)
  assert.equal(isProseToolFallbackModel(m('Qwen3.5-9B', 'ollama')), true, '大小写不敏感')
  // v0.48.1（D226 证伪关闭）：qwen3.8 真机走 OpenAI 协议且原生 tool_calls 通达，
  // 正文降级通道不适用 —— 谓词维持 3.5，qwen3.8 任何端点形态都不放行。
  assert.equal(isProseToolFallbackModel(m('qwen3.8:27b', 'ollama')), false, 'qwen3.8 不扩（D226 关闭）')
  assert.equal(isProseToolFallbackModel(m('qwen3.8:27b', 'openai', 'https://api.x.com/v1')), false, 'qwen3.8 OpenAI 协议（真机形态）→ false')
  assert.equal(isProseToolFallbackModel(m('qwen3.5:9b', 'openai', 'http://lan:11434')), true, '端点形态也算 ollama（:11434）')
  assert.equal(isProseToolFallbackModel(m('my-model', 'openai', 'http://lan:11434')), false, '端点形态但模型不是 qwen3.5 → false')
  assert.equal(isProseToolFallbackModel(m('qwen3:8b', 'ollama')), false, 'qwen3（无 .5）不放行')
  assert.equal(isProseToolFallbackModel(m('qwen3.5:9b', 'openai', 'https://api.x.com/v1')), false)
  assert.equal(isProseToolFallbackModel(m('qwen3.5:9b', 'vllm')), true, 'vllm 同属 ollama 形态（isOllamaLikeEndpoint 口径）')
  assert.equal(isProseToolFallbackModel(m('gpt-oss:20b', 'ollama')), false, '非 qwen3.5 不放行')
  assert.equal(isProseToolFallbackModel(undefined), false)
  assert.equal(isProseToolFallbackModel(null), false)
})

test('TC-PTC-014 叙述性键不混入 args', () => {
  const { calls } = extractProseToolCalls('{"tool":"shell","path":".","thought":"我想想","explanation":"因为","note":"注"}')
  assert.deepEqual(calls[0]!.args, { path: '.' })
})

test('TC-PTC-015 混合：合法 + 幻觉 + 损坏互不污染，计数各归各', () => {
  const raw = [
    '{"tool":"file-reader","path":"a"}',
    '{"tool":"hallucinated-probe"}',
    '{"tool":"shell","arguments":"{{{坏"}',
    '{"tool":"file-reader","path":"b"}',
  ].join('\n')
  const { calls, invalid } = extractProseToolCalls(raw)
  assert.equal(calls.length, 2)
  assert.equal(invalid, 2)
  assert.deepEqual(calls.map((c) => (c.args as { path: string }).path), ['a', 'b'])
})

test('TC-PTC-016 契约提示含格式样例与白名单工具名（模型侧唯一信息源）', () => {
  const hint = proseToolContractHint()
  assert.match(hint, /"tool"/)
  assert.match(hint, /"arguments"/)
  assert.match(hint, /task_plan/)
  assert.match(hint, /file-writer/)
  assert.match(hint, /无法使用原生工具调用/)
})

/* ============================================================
 * v0.48.2（D229）：触发式降级激活器 —— 协议无关（TC-PTC-017/018）
 * 业界依据：Cline consecutiveMistakeCount（错误 +1 / 成功清零，达限 3 介入）、
 * OpenHands StuckDetector（连续 N 组同形态失败判死循环）。
 * ============================================================ */

test('TC-PTC-017 ★ 触发器真值表：失败 +1 / 健康清零 / 中性不动 / 连续 3 翻转且单向', () => {
  assert.equal(PROSE_FALLBACK_TRIGGER_THRESHOLD, 3, '业界典型 N=3，钉死防漂移')
  // 腿①：未达阈值不激活
  const t1 = createProseFallbackTrigger(false)
  assert.equal(t1.active, false, '默认关闭')
  t1.noteNativeMalformedRound()
  t1.noteNativeMalformedRound()
  assert.equal(t1.active, false)
  assert.equal(t1.streak, 2)
  // 腿②：健康原生轮清零（Cline 范式）
  t1.noteNativeHealthyRound()
  assert.equal(t1.streak, 0)
  assert.equal(t1.active, false)
  // 腿③：连续 3 次失败 → 翻转激活，consumeActivation 消费型（一次）
  t1.noteNativeMalformedRound()
  t1.noteNativeMalformedRound()
  t1.noteNativeMalformedRound()
  assert.equal(t1.active, true, '连续 3 → 激活')
  assert.equal(t1.consumeActivation(), true, '翻转事件只报一次')
  assert.equal(t1.consumeActivation(), false, '消费后不再报')
  // 腿④：激活后单向不回切，健康轮不再清零、失败不再累计
  t1.noteNativeHealthyRound()
  assert.equal(t1.active, true, 'run 内单向不回切')
  assert.equal(t1.streak, 3, '激活后计数冻结')
  // 腿⑤：正文命中信号同样累计（模型在用正文发调用 = 原生通道异常）
  const t2 = createProseFallbackTrigger(false)
  t2.noteProseCallAttempt()
  t2.noteProseCallAttempt()
  t2.noteProseCallAttempt()
  assert.equal(t2.active, true)
  // 腿⑥：中性轮（普通正文答复）不动计数
  const t3 = createProseFallbackTrigger(false)
  t3.noteNativeMalformedRound()
  // 中性轮不提供任何 note —— streak 不变即语义
  t3.noteNativeMalformedRound()
  assert.equal(t3.streak, 2, '中性轮既不清零也不累计')
})

test('TC-PTC-018 谓词启动激活路径：初始即 active、不产生触发翻转事件', () => {
  // qwen3.5@ollama 启动即激活（D208 既有路径）—— 不得被当成「运行中翻转」上报
  const t = createProseFallbackTrigger(true)
  assert.equal(t.active, true)
  assert.equal(t.consumeActivation(), false, '谓词启动激活 ≠ 触发翻转（不发重复契约提示）')
  // 激活态下失败/健康信号都是 no-op
  t.noteNativeMalformedRound()
  t.noteNativeHealthyRound()
  assert.equal(t.streak, 0)
  assert.equal(t.active, true)
})
