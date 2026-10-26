/* ============================================================
 * v0.33.1 W1 — think-strip.ts 单测
 *
 * 覆盖：流式分流（跨 delta 切分 / 大小写 / 未闭合收尾）
 *      + 落定剥离（多块 / 未闭合 / 无标签）。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/llm/__tests__/think-strip.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createThinkStripper, stripThinkBlocks } from '../think-strip.js'

/** 辅助：把整串按给定块切分流式 push 后 finish，聚合两通道 */
function streamAll(chunks: string[]): { think: string; text: string } {
  const s = createThinkStripper()
  let think = ''
  let text = ''
  for (const c of chunks) {
    const r = s.push(c)
    think += r.think
    text += r.text
  }
  const f = s.finish()
  return { think: think + f.think, text: text + f.text }
}

test('流式：无标签 → 全部归正文', () => {
  const r = streamAll(['你好', '，世界'])
  assert.equal(r.text, '你好，世界')
  assert.equal(r.think, '')
})

test('流式：完整 <think> 块 → 思考/正文分流', () => {
  const r = streamAll(['<think>内部推理', '</think>最终回答'])
  assert.equal(r.think, '内部推理')
  assert.equal(r.text, '最终回答')
})

test('流式：跨 delta 切分 `<thi|nk>` 必须识别', () => {
  const r = streamAll(['abc<thi', 'nk>思考中</th', 'ink>正文'])
  assert.equal(r.text, 'abc正文')
  assert.equal(r.think, '思考中')
})

test('流式：大小写不敏感 `<Think>` 也认', () => {
  const r = streamAll(['<Think>t1</THINK>rest'])
  assert.equal(r.think, 't1')
  assert.equal(r.text, 'rest')
})

test('流式：think 内多段 + 标签前后正文拼接', () => {
  const r = streamAll(['A<think>B</think>C<think>D</think>E'])
  assert.equal(r.text, 'ACE')
  assert.equal(r.think, 'BD')
})

test('流式：未闭合（流截断）→ finish 残余归思考', () => {
  const r = streamAll(['<think>被截断的思考…'])
  assert.equal(r.think, '被截断的思考…')
  assert.equal(r.text, '')
})

test('流式：一字不丢 —— 随机切分聚合等于原文重组', () => {
  const src = 'x<think>yyy</think>z<think>ww</think>v'
  const r = streamAll(src.split('')) // 逐字符最苛刻
  assert.equal(r.text + '|' + r.think, 'xzv|yyyww')
})

test('落定：无标签 → think 为 null、rest 原样', () => {
  const r = stripThinkBlocks('plain answer')
  assert.equal(r.think, null)
  assert.equal(r.rest, 'plain answer')
})

test('落定：单块剥离 + 前后正文拼接', () => {
  const r = stripThinkBlocks('前置<think>推理</think>后置')
  assert.equal(r.think, '推理')
  assert.equal(r.rest, '前置后置')
})

test('落定：多块依次剥离拼接', () => {
  const r = stripThinkBlocks('<think>a</think>X<think>b</think>Y')
  assert.equal(r.think, 'a\nb')
  assert.equal(r.rest, 'XY')
})

test('落定：未闭合 → 从 <think> 起全部算思考', () => {
  const r = stripThinkBlocks('answer<think>残缺')
  assert.equal(r.think, '残缺')
  assert.equal(r.rest, 'answer')
})

test('落定：空串安全', () => {
  const r = stripThinkBlocks('')
  assert.equal(r.think, null)
  assert.equal(r.rest, '')
})

// ============================================================
// v0.48.2（D233 / TC-SWALLOW-001）：未闭合截断语义锁定（F7a 标记的前提）。
// 实机（qwen3.8 27b）：代码写在思考流内、`<think>` 未闭合（截断发生在闭合前）
// → 全部算思考、正文 rest 必须为空。openai.ts 的 contentSwallowedByTruncation
// 判据（finish=length && think!==null && rest===''）依赖这条语义，语义漂移即标记失真。
// ============================================================
test('落定：未闭合截断（代码在 think 内）→ think 吞全部、rest 空（D233 F7a 前提语义）', () => {
  const r = stripThinkBlocks('<think>先分析……然后给出代码：\nconst x = 1\nconsole.log(x)')
  assert.equal(r.rest, '', '未闭合截断时正文必须为空（F7a 标记判据依赖）')
  assert.ok(r.think && r.think.includes('const x = 1'), '代码必须被识别为思考（吞没事实）')
  // 对照：正常闭合 → 闭合后的正文可见（不被吞）
  const ok = stripThinkBlocks('<think>推理</think>\nconst x = 1')
  assert.equal(ok.rest, 'const x = 1')
  assert.equal(ok.think, '推理')
})
