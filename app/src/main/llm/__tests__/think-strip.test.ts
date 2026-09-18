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
