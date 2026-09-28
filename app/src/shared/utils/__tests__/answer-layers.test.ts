/**
 * v0.37.0 详测 — 最终答复的输出层次解析（TC-LAYER-001…006）
 *
 * 对应文档：docs/versions/v0.37.0/04-system-design.md §6.1（交互区输出层次）
 *          docs/versions/v0.37.0/testcases/00-cumulative-matrix.md §二 模块 D
 *
 * 为什么要有这一组：
 *   分层渲染的价值全在**切得准**。切错的两种失败都很难被发现 ——
 *   ① 该分层没分层（用户仍要自己从十行里挑结论）→ 静默退化；
 *   ② 不该分层却分层（正常行文被切碎成四块）→ 观感损坏但没人报错。
 *   故正反例都要钉住（纪律⑩：反向核验）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs answer-layers
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ANSWER_LAYER_ORDER,
  ANSWER_LAYER_SPECS,
  parseAnswerLayers,
  shouldRenderLayered,
} from '../answer-layers'

/* ---------------- 正例：标准四段 ---------------- */

const FULL = [
  '## 结论先行',
  '已把清单收敛到文件，中断续聊不再重做第一项。',
  '',
  '## 变更清单',
  '- `src/main/agent/ledger/engine.ts`（新增唯一写入口）',
  '- `src/main/agent/engine/act.ts`（todo-update 改走账本）',
  '',
  '## 验证结果',
  '```',
  'node scripts/run-tests.mjs ledger  →  22 pass / 0 fail',
  '```',
  '',
  '## 下一步',
  '等你确认后打 tag v0.37.0。',
].join('\n')

test('TC-LAYER-001 标准四段：全部识别，顺序规范，正文不串段', () => {
  const r = parseAnswerLayers(FULL)
  assert.equal(r.recognized, 4)
  assert.deepEqual(
    r.layers.map((l) => l.id),
    [...ANSWER_LAYER_ORDER],
    '段的顺序必须是规范顺序（结论 → 变更 → 验证 → 下一步）',
  )
  const changes = r.layers.find((l) => l.id === 'changes')!
  assert.match(changes.body, /ledger\/engine\.ts/, '变更清单正文应落在 changes 段')
  assert.doesNotMatch(changes.body, /下一步/, '正文不得串到相邻段')
  const next = r.layers.find((l) => l.id === 'next')!
  assert.match(next.body, /打 tag v0\.37\.0/)
  assert.equal(r.prefix, '', '首个标题前没有内容时 prefix 应为空')
})

/* ---------------- 变体：加粗标题 / 「标签：」独占一行 / 英文 ---------------- */

test('TC-LAYER-002 标题形态变体：**加粗**、「标签：」、英文标题都能识别', () => {
  const bold = parseAnswerLayers(['**结论**', '做完了。', '', '**变更清单**', '- a.ts', '', '**验证**', '未跑。'].join('\n'))
  assert.deepEqual(bold.layers.map((l) => l.id), ['conclusion', 'changes', 'verification'])

  const colon = parseAnswerLayers(['结论：', '做完了。', '变更清单：', '- a.ts', '下一步：', '等你确认。'].join('\n'))
  assert.deepEqual(colon.layers.map((l) => l.id), ['conclusion', 'changes', 'next'])

  const en = parseAnswerLayers(['## Conclusion', 'Done.', '## Changes', '- a.ts', '## Verification', '22 pass'].join('\n'))
  assert.deepEqual(en.layers.map((l) => l.id), ['conclusion', 'changes', 'verification'])
})

test('TC-LAYER-003 导语保留：标题之前的内容进 prefix（不被丢掉）', () => {
  const r = parseAnswerLayers(['一句话先说结果。', '', '## 结论', 'A', '## 变更清单', 'B'].join('\n'))
  assert.equal(r.prefix, '一句话先说结果。', '标题前的导语必须保留（静默丢内容是缺陷）')
  assert.equal(r.recognized, 2)
})

/* ---------------- 反例：不该分层的不能分层 ---------------- */

test('TC-LAYER-004 反例：普通行文（含"结论"二字但不是标题）不触发分层', () => {
  const plain = parseAnswerLayers(
    ['我读完了这两个文件，得出的结论是这个方案可行，但需要先补一个守卫用例。', '接下来我会按上面的方案改。'].join('\n'),
  )
  assert.equal(plain.recognized, 0, '正文里出现"结论"二字不应被当成标题行')
  assert.equal(shouldRenderLayered(plain), false, '未成形 → 调用方回退整段 Markdown')

  // 长句 + 冒号结尾（>24 字）：不接受为标题，避免把正文切成段
  const longLabel = parseAnswerLayers('关于这个结论我们有如下几点需要补充说明：\n- 一\n- 二')
  assert.equal(longLabel.recognized, 0, '长句标签不视为标题')
})

test('TC-LAYER-005 单段不成形：只有 1 段时仍回退 Markdown（不切碎）', () => {
  const one = parseAnswerLayers('## 结论\n只有结论这一段的答复。')
  assert.equal(one.recognized, 1)
  assert.equal(shouldRenderLayered(one), false, '识别 < 2 段一律回退（避免把普通回答切碎）')
})

/* ---------------- 渲染策略表 ---------------- */

test('TC-LAYER-006 默认可见性：结论/变更/下一步展开，验证折叠；缺段有占位文案', () => {
  assert.deepEqual(
    ANSWER_LAYER_SPECS.map((s) => s.id),
    [...ANSWER_LAYER_ORDER],
    '渲染策略表必须覆盖四段且顺序一致',
  )
  const open = (id: string) => ANSWER_LAYER_SPECS.find((s) => s.id === id)!.defaultOpen
  assert.equal(open('conclusion'), true, '结论必须默认可见（用户做判断的前提）')
  assert.equal(open('changes'), true, '变更清单必须默认可见')
  assert.equal(open('verification'), false, '验证细节默认折叠（长输出会挤掉结论）')
  assert.equal(open('next'), true, '下一步必须默认可见')
  for (const s of ANSWER_LAYER_SPECS) {
    assert.ok(s.missingHint.length > 0, `${s.id} 缺段时必须有占位文案（不静默）`)
  }
  // 缺段占位的措辞要点：验证缺段不能读成"已验证"
  const v = ANSWER_LAYER_SPECS.find((s) => s.id === 'verification')!
  assert.match(v.missingHint, /不等于已验证|不等于|谨慎/, '验证缺段必须说明"没验证 ≠ 已验证"')
})

test('TC-LAYER-007 重复段合并而非覆盖（内容不静默丢失）', () => {
  const r = parseAnswerLayers(['## 结论', '第一句。', '## 结论', '补充一句。'].join('\n'))
  assert.equal(r.layers.length, 1)
  assert.match(r.layers[0]!.body, /第一句/)
  assert.match(r.layers[0]!.body, /补充一句/, '重复出现的同段应合并，后者不得覆盖前者')
})
