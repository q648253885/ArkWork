/* ============================================================
 * v0.25.0 F4 — say-marker.ts 单测
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/main/llm/__tests__/say-marker.test.ts
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractSayMarker } from '../say-marker.js'

test('extractSayMarker 无 SAY 块 → 返回原文 + undefined', () => {
  const result = extractSayMarker('这是普通 thought，无 SAY 块。')
  assert.equal(result.say, undefined)
  assert.equal(result.thought, '这是普通 thought，无 SAY 块。')
})

test('extractSayMarker 标准 SAY 块 → 抽取并剥离', () => {
  const result = extractSayMarker('内部思考\n\n<<<SAY>>>\n已完成 PRD 阶段，进入编码\n<<<END>>>\n剩余思考')
  assert.equal(result.say, '已完成 PRD 阶段，进入编码')
  // thought 保留 SAY 块前后的内容（前置 + 后置）
  assert.ok(result.thought.includes('内部思考'))
  assert.ok(result.thought.includes('剩余思考'))
  assert.ok(!result.thought.includes('已完成 PRD 阶段，进入编码'))
})

test('extractSayMarker 大小写不敏感', () => {
  const result = extractSayMarker('<<<say>>>\n结论：开始编码\n<<<end>>>')
  assert.equal(result.say, '结论：开始编码')
})

test('extractSayMarker 缺 <<<END>>> → 容错，原文保持', () => {
  const result = extractSayMarker('<<<SAY>>>\n未闭合的块\n更多内容')
  assert.equal(result.say, undefined)
  assert.equal(result.thought, '<<<SAY>>>\n未闭合的块\n更多内容')
})

test('extractSayMarker 空 SAY 块 → undefined', () => {
  const result = extractSayMarker('前置\n<<<SAY>>>\n<<<END>>>\n后置')
  assert.equal(result.say, undefined)
  // 空 SAY 块不影响 thought（前后都还在）
  assert.ok(result.thought.includes('前置'))
  assert.ok(result.thought.includes('后置'))
})

test('extractSayMarker 超过 600 字截断', () => {
  const longSay = 'x'.repeat(800)
  const result = extractSayMarker(`<<<SAY>>>\n${longSay}\n<<<END>>>`)
  assert.ok(result.say)
  assert.ok(result.say!.length <= 601) // 600 字 + '…'
  assert.ok(result.say!.endsWith('…'))
})

test('extractSayMarker 多个 SAY 块只取第一段', () => {
  const result = extractSayMarker('<<<SAY>>>\n第一段\n<<<END>>>\n中间\n<<<SAY>>>\n第二段\n<<<END>>>')
  assert.equal(result.say, '第一段')
})

test('extractSayMarker 空输入', () => {
  const result = extractSayMarker('')
  assert.equal(result.say, undefined)
  assert.equal(result.thought, '')
})

test('extractSayMarker 仅 SAY 开放标签 → 视为无 SAY', () => {
  const result = extractSayMarker('<<<SAY>>> 整段都是 SAY 但是没关闭')
  assert.equal(result.say, undefined)
  assert.equal(result.thought, '<<<SAY>>> 整段都是 SAY 但是没关闭')
})

test('extractSayMarker SAY 后跟空白 → 自动 trim', () => {
  const result = extractSayMarker('<<<SAY>>>\n\n   关键结论   \n   \n<<<END>>>')
  assert.equal(result.say, '关键结论')
})