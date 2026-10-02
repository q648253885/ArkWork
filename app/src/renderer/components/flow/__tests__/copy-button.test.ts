/* ============================================================
 * ArkWork — 段落复制按钮（v0.45.0 · R-F · TC-COPYBTN）
 *
 * 用户实机反馈：交互区每一段只能手动框选复制。本套件钉住：
 *  ① CopyButton 组件契约（clipboard 写入 / stopPropagation / 四语言键复用 /
 *     hover 浮出交互）；
 *  ② 挂点契约：AnswerBlock（分层每段 + 未分层整块）/ SayBlock（两态）/
 *     NoteBlock / UserBlock / ReasoningBlock 全部接入；
 *  ③ TC-COPY-001 不被破坏：AnswerBlock 整文件不得出现 `select-none`；
 *  ④ i18n 四语言 `markdown.copy` / `markdown.copied` 键在位（复用不新增）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs copy-button
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
const blocks = (rel: string): string => stripComments(read(rel))

test('TC-COPYBTN-001 CopyButton 组件契约：clipboard 写入 + 防冒泡 + 复用既有 i18n 键 + hover 浮出', () => {
  const src = blocks('../CopyButton.tsx')
  assert.match(src, /navigator\.clipboard\.writeText\(text\)/, '必须走 clipboard API 写入')
  assert.match(src, /e\.stopPropagation\(\)/, '宿主可能是可点击容器，复制不得触发宿主行为')
  assert.match(src, /markdown\.copy/, '复用 markdown.copy 键（不新增键集）')
  assert.match(src, /markdown\.copied/, '复制成功态复用 markdown.copied 键')
  assert.match(src, /group-hover:opacity-100/, 'hover 浮出交互（宿主块 group 上下文）')
  assert.match(src, /setTimeout\([^,]+,\s*1500\)/, 'copied 反馈 1500ms 复位（与代码块复制同口径）')
})

test('TC-COPYBTN-002 挂点契约：五个正文块全部接入 CopyButton', () => {
  // AnswerBlock：分层每段 + 未分层整块两处
  const answer = blocks('../blocks/AnswerBlock.tsx')
  const answerHits = answer.match(/<CopyButton/g) ?? []
  assert.ok(answerHits.length >= 2, `AnswerBlock 至少两处挂点（未分层整块 + 分层每段），实测 ${answerHits.length}`)
  assert.match(answer, /import \{ CopyButton \} from '\.\.\/CopyButton'/)
  // Say / Note / User / Reasoning 各一处起
  for (const [file, min] of [['SayBlock.tsx', 2], ['NoteBlock.tsx', 1], ['UserBlock.tsx', 1], ['ReasoningBlock.tsx', 1]] as const) {
    const src = blocks(`../blocks/${file}`)
    const hits = src.match(/<CopyButton/g) ?? []
    assert.ok(hits.length >= min, `${file} 应有 ≥${min} 处挂点，实测 ${hits.length}`)
    assert.match(src, /CopyButton/, `${file} 缺 CopyButton import/使用`)
  }
})

test('TC-COPYBTN-003 TC-COPY-001 不回退：AnswerBlock 整文件不得出现 select-none', () => {
  const src = blocks('../blocks/AnswerBlock.tsx')
  assert.doesNotMatch(src, /select-none/, '段标题/正文属于可复制内容，禁选禁令不得回退（F1-4）')
})

test('TC-COPYBTN-004 i18n 四语言 markdown.copy / markdown.copied 键在位（复用前提）', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const raw = read(`../../../i18n/locales/${lang}.json`)
    assert.match(raw, /"copy"\s*:/, `${lang}.markdown.copy 缺失`)
    assert.match(raw, /"copied"\s*:/, `${lang}.markdown.copied 缺失`)
  }
})
