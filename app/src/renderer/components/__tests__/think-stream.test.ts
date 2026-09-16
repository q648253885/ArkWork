/**
 * v0.30.2 详测 — 思考内容运行时展开 + 完成后折叠（问题③）
 *
 * 依据：docs/versions/v0.30.2/04-system-design.md §三 + testcases/00-cumulative-matrix.md §3.3
 * 用例：TC-THINK-001…005
 *
 * 背景（用户实测）：交互区吞掉思考内容 —— 流式文本落地后消失、思考块默认折叠看不见。
 * 根因：
 *   (a) ThoughtStream ThinkBlock `useState(false)` 恒默认折叠 → reason 步骤落地后不可见；
 *   (b) ConversationFlow 流式预览为裸文本、无「思考中」语义，落地瞬间缓冲被清（R-stream-3）
 *       → 流式文本消失 + 权威思考块折叠 = 内容被吞。
 *
 * 修复（traework 对齐：运行时展开 + 完成后折叠）：
 *   - ThinkBlock：`userOpen ?? isRunning` 展开态语义，手动切换优先；
 *   - ConversationFlow：新增 StreamingThinkBlock（.react-reason 外观，默认展开、可折叠）。
 *
 * 手法：源码契约（readFileSync + 正则）—— 组件依赖 DOM，node:test 无渲染环境，
 * 与 interactive-copy.test.ts 同源。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/renderer/components/__tests__/think-stream.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const THOUGHT = read('../ThoughtStream.tsx')
const FLOW = read('../ConversationFlow.tsx')

/** 截取指定函数组件的完整源码块（跳过参数列表，从函数体 `{` 开始括号配平） */
function fnBlock(src: string, name: string): string {
  const anchor = src.indexOf(`function ${name}(`)
  assert.ok(anchor >= 0, `未找到组件 ${name}`)
  // 参数列表结尾：第一个 `) {`（解构参数对象内的 `}` 不干扰 —— search 找 `)` 后跟 `{`）
  const rel = src.slice(anchor).search(/\)\s*\{/)
  assert.ok(rel >= 0, `组件 ${name} 签名未找到参数列表结尾`)
  const bodyStart = anchor + rel + src.slice(anchor + rel).indexOf('{')
  let depth = 0
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(anchor, i + 1)
    }
  }
  assert.fail(`组件 ${name} 未闭合`)
}

const THINK = fnBlock(THOUGHT, 'ThinkBlock')
const STREAMING = fnBlock(FLOW, 'StreamingThinkBlock')

/* ============================================================
 * TC-THINK-001 ThinkBlock 展开态 = userOpen ?? isRunning
 * ============================================================ */

test('TC-THINK-001 ThinkBlock 展开态 = userOpen ?? isRunning（运行时展开、完成后折叠）', () => {
  assert.match(
    THINK,
    /const \[userOpen, setUserOpen\] = useState<boolean \| null>\(null\)/,
    'userOpen 应为 boolean | null（null = 未手动干预）',
  )
  assert.match(
    THINK,
    /const showFull = userOpen \?\? isRunning/,
    '展开态应为 userOpen ?? isRunning —— 运行中默认展开，完成后默认折叠',
  )
  assert.match(
    THINK,
    /const isRunning = step\.status === 'running' && isActive/,
    'isRunning 语义（running + 当前激活单元）保持',
  )
})

/* ============================================================
 * TC-THINK-002 用户手动切换写入 userOpen（手动优先于自动态）
 * ============================================================ */

test('TC-THINK-002 用户手动切换写入 userOpen（手动优先于自动态）', () => {
  assert.match(
    THINK,
    /onClick=\{\(\) => setUserOpen\(!showFull\)\}/,
    '头部点击应 setUserOpen(!showFull)（手动切换后不再随 isRunning 自动切换）',
  )
  assert.doesNotMatch(
    THINK,
    /setShowFull/,
    '不应残留旧的 setShowFull 直改形态',
  )
})

/* ============================================================
 * TC-THINK-003 旧「恒默认折叠」形态根除
 * ============================================================ */

test('TC-THINK-003 ThinkBlock 不再存在恒默认 useState(false) 的 showFull（旧缺陷根除）', () => {
  assert.doesNotMatch(
    THINK,
    /useState\(false\)/,
    'ThinkBlock 不应有 useState(false)（旧缺陷：reason 落地后思考内容默认不可见）',
  )
  assert.match(
    THINK,
    /aria-expanded=\{showFull\}/,
    'aria-expanded 绑定 showFull（无障碍语义保持）',
  )
})

/* ============================================================
 * TC-THINK-004 ConversationFlow 存在 StreamingThinkBlock（默认展开、可折叠）
 * ============================================================ */

test('TC-THINK-004 StreamingThinkBlock：react-reason 外观 + 默认展开 + 可折叠 + 接管流式预览', () => {
  // 组件存在且默认展开（userOpen ?? true）
  assert.match(
    STREAMING,
    /const showFull = userOpen \?\? true/,
    'StreamingThinkBlock 应默认展开（userOpen ?? true）',
  )
  // react-reason 外观：Brain 图标 + running 态 + 闪烁点 + chevron
  assert.match(STREAMING, /className="react-reason" data-state="running"/, '应复用 .react-reason 外观')
  assert.match(STREAMING, /Icon\.Brain/, '应带 Brain 图标')
  assert.match(STREAMING, /pulse-dot/, '应带闪烁点（思考中）')
  assert.match(STREAMING, /Icon\.ChevronDown/, '应带 chevron（可折叠）')
  // 流式预览渲染点：裸文本已被 StreamingThinkBlock 取代
  assert.match(
    FLOW,
    /<StreamingThinkBlock text=\{streamText\} \/>/,
    '流式预览应渲染 StreamingThinkBlock',
  )
  assert.doesNotMatch(
    FLOW,
    /className="text-sm leading-6 text-text-secondary whitespace-pre-wrap break-words">\s*\{streamText\}/,
    '裸 streamText 直渲形态应移除（旧「被吞」观感来源）',
  )
})

/* ============================================================
 * TC-THINK-005 R-stream-3 保持：reason step 落地清 turn 缓冲
 * ============================================================ */

test('TC-THINK-005 R-stream-3 保持：appendStep 内 reason 落地清 turn 缓冲（双份展示防护不回退）', () => {
  const SLICE = read('../../store/slices/conversationSlice.ts')
  assert.match(
    SLICE,
    /step\.type === 'reason' && s\.streamBuffers\[\`\$\{step\.taskId\}:turn\`\]/,
    'appendStep 应在 reason step 到达时清 taskId:turn 流式缓冲（流式 → 权威渲染平滑交接）',
  )
})
