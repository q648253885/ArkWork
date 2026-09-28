/* ============================================================
 * ArkWork — v0.36.0 B11/P4-c：渲染层 SAY 兜底剥离 单测
 * 载体：renderer/utils/say-strip.ts 纯函数（node:test 密闭）
 * 规格来源：docs/versions/v0.36.0/12-b11-fix-batch-design.md §五（P4-c）
 * 运行（cwd=app）：node scripts/run-tests.mjs say-strip
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripSayMarkers } from '../say-strip'

test('TC-EXEC-003a 无标记文本恒等（快速路径零破坏）', () => {
  const s = '# 报告\n\n正文内容，含 <<< 字符与 SAY 单词但不构成标记。'
  assert.equal(stripSayMarkers(s), s)
  assert.equal(stripSayMarkers(''), '')
})

test('TC-EXEC-003b 配对标记段整体删除（协议原形 <<<SAY>>>…<<<END>>>）', () => {
  const s = '## 结论\n\n<<<SAY>>>\n项目分析已完成。\n<<<END>>>\n'
  const out = stripSayMarkers(s)
  assert.ok(!out.includes('SAY'))
  assert.ok(!out.includes('END>>'))
  assert.ok(out.includes('## 结论'), 'SAY 段之外的正文必须保留')
})

test('TC-EXEC-003c 实机截图变体（«<SAY>>> / <<END>>>）剥离', () => {
  const s = '前言\n\n<<SAY>>>\n项目分析已完成，TravelSky Code 是一个功能完整的 Web 版 Code Agent。\n<<END>>>'
  const out = stripSayMarkers(s)
  assert.ok(!out.includes('SAY'))
  assert.ok(!out.includes('END'))
  assert.ok(out.startsWith('前言'))
})

test('TC-EXEC-003d 未闭合标记：剥标记、保内容', () => {
  const s = '总结如下\n<<<SAY>>>\n这是还没闭合的叙述'
  const out = stripSayMarkers(s)
  assert.ok(!out.includes('SAY'))
  assert.ok(out.includes('总结如下'))
  assert.ok(out.includes('这是还没闭合的叙述'), '未闭合时内容不得被误删')
})

test('TC-EXEC-003e 裸 <<<END>>> 残留同样剥除', () => {
  const out = stripSayMarkers('正文\n<<<END>>>\n后续')
  assert.ok(!out.includes('END'))
  assert.ok(out.includes('正文') && out.includes('后续'))
})

test('TC-EXEC-003f 剥除后空行收敛（不留 3 连以上空洞）', () => {
  const out = stripSayMarkers('A\n\n\n<<<SAY>>>x<<<END>>>\n\n\nB')
  assert.ok(!/\n{3,}/.test(out))
  assert.ok(out.includes('A') && out.includes('B'))
})
