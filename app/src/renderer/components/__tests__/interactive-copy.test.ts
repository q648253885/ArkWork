/**
 * v0.30.1 详测 — 交互区可复制契约（问题①）
 *
 * 依据：docs/versions/v0.30.1/04-system-design.md §3.3（放开选中）+ §7.1（TC-COPY）
 * 用例：TC-COPY-001…004
 *
 * 背景（用户实测）：「读取文件:{value}」这一行**无法复制**。根因是
 *   (a) `ThoughtStream.tsx` 完成/失败分支文本容器整块 `select-none`；
 *   (b) `globals.css` 的 `html,body,#root{user-select:none}` 为全站禁选继承源，
 *       仅去掉 `select-none` 不够，必须在交互区容器显式 `user-select:text` 覆盖继承值。
 *
 * 不可误选边界（F1-4）：按钮 / 图标 / 行内菜单**继续** `select-none`，避免拖选产生伪文本。
 *
 * 源码契约（readFileSync + 正则）：node:test 无 DOM 渲染环境，锁结构性不变量，
 * 与 task-panel-fix2.test.ts 同手法。
 *
 * 运行（cwd=app）：
 *   npx tsx --test src/renderer/components/__tests__/interactive-copy.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

// v0.31.0 B4 载体收敛：ThoughtStream.tsx 下线，交互区文本容器契约转写到
// components/flow/blocks/*（SayBlock / AnswerBlock / ReasoningBlock / ToolBlock，
// §4.1 登记表）。断言方向不变：文本可选、控件不可选。
const SAY = read('../flow/blocks/SayBlock.tsx')
const ANSWER = read('../flow/blocks/AnswerBlock.tsx')
const REASON = read('../flow/blocks/ReasoningBlock.tsx')
const TOOL = read('../flow/blocks/ToolBlock.tsx')
const CSS = read('../../styles/globals.css')

/** 取出以 selector 起始的 CSS 规则块（到首个 `}` 为止） */
function cssBlock(css: string, selector: string): string {
  const idx = css.indexOf(selector)
  assert.ok(idx >= 0, `未找到 CSS 规则 ${selector}`)
  const end = css.indexOf('}', idx)
  assert.ok(end > idx, `CSS 规则 ${selector} 未闭合`)
  return css.slice(idx, end + 1)
}

/* ============================================================
 * 一、TC-COPY-001 交互区文本块容器不再整块 select-none
 * ============================================================ */

test('TC-COPY-001 交互区各文本块容器可选中（select-text；Say/Answer 整文件无 select-none）', () => {
  // SayBlock：叙述文本容器 select-text，整文件不得回退 select-none
  assert.match(SAY, /select-text/, 'SayBlock 文本容器应为 select-text')
  assert.doesNotMatch(SAY, /select-none/, 'SayBlock 不应含 select-none')
  // AnswerBlock：streaming <pre> 与落定 Markdown 共用外层容器
  assert.match(ANSWER, /select-text/, 'AnswerBlock 外层容器应为 select-text')
  assert.doesNotMatch(ANSWER, /select-none/, 'AnswerBlock 不应含 select-none')
  // ReasoningBlock：思考正文 select-text（头部行/来源徽标控件允许 select-none，F1-4）
  assert.match(REASON, /react-reason__body[^"]*select-text/, '思考正文应为 select-text')
  // ToolBlock：外层容器 select-text（「读取文件:{value}」意图行随容器可选中）
  assert.match(TOOL, /px-3 py-2 select-text/, 'ToolBlock 外层容器应为 select-text')
})

/* ============================================================
 * 二、TC-COPY-002 工具卡头部/正文放开选中
 * ============================================================ */

test('TC-COPY-002 .tool-card__head 为 user-select:text（命令/文件名可复制），正文同类放开', () => {
  const head = cssBlock(CSS, '.tool-card__head {')
  assert.match(head, /user-select:\s*text/, '.tool-card__head 应为 user-select:text')
  assert.doesNotMatch(head, /user-select:\s*none\s*;/, '.tool-card__head 不应保留 user-select:none 声明')

  // 交互区内其余可复制容器（正文 / 思考正文 / 意图行）
  for (const sel of ['.tool-card__body {', '.react-reason__body {', '.intent-hint {']) {
    assert.match(cssBlock(CSS, sel), /user-select:\s*text/, `${sel} 应为 user-select:text`)
  }
})

/* ============================================================
 * 三、TC-COPY-003 全局禁选默认保持（Scope Out S3）
 * ============================================================ */

test('TC-COPY-003 body 仍保持 user-select:none（不放大到全局）', () => {
  const root = cssBlock(CSS, '\nbody {')
  assert.match(root, /user-select:\s*none/, 'body 应保持 user-select:none（S3：交互区靠更具体规则覆盖）')
})

/* ============================================================
 * 四、TC-COPY-004 控件保持不可选（F1-4）
 * ============================================================ */

test('TC-COPY-004 操作按钮 .tool-card__btn 保持 user-select:none（不误选伪文本）', () => {
  const btn = cssBlock(CSS, '.tool-card__btn {')
  assert.match(btn, /user-select:\s*none/, '.tool-card__btn 应保持 user-select:none')
  // 源码侧锚点（B4 载体转写）：ToolBlock 控件继续 select-none（头部行 + 结果开关按钮）
  assert.match(TOOL, /tool-card__btn[^"]*select-none/, '结果开关按钮应保留 select-none（F1-4）')
})
