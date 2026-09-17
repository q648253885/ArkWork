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
 * v0.31.0 B1 变更（矩阵 testcases/00-cumulative-matrix.md §4.1 已逐条登记）：
 *   - TC-THINK-001 展开态 `userOpen ?? isRunning` → `resolveReasoningOpen({...})` 解析链（+最短可见/失败保护）；
 *   - TC-THINK-004 流式预览源 `streamText` → `streamReasoning`（读 `:turn:reasoning` 通道）；
 *   - TC-THINK-005 清缓冲的那句 `delete` 由 slice 下沉到纯模块 `store/settle.ts`。
 *   **三条断言方向均不变**，仅形态随 B1 契约更新。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/renderer/components/__tests__/think-stream.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

// v0.31.0 B4 载体收敛（§4.1 登记表）：ThoughtStream.tsx / ConversationFlow.tsx 下线，
// 思考块契约转写到 flow/blocks/ReasoningBlock.tsx，流式预览契约转写到 flow/TurnList.tsx。
// **断言方向均不变**：用户意志最高 → 流式展开 → 最短可见 → 失败必展开 → 完成后折叠。
const THOUGHT = read('../flow/blocks/ReasoningBlock.tsx')
const FLOW = read('../flow/TurnList.tsx')

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

const THINK = fnBlock(THOUGHT, 'ReasoningBlock')

/* ============================================================
 * TC-THINK-001 ThinkBlock 展开态 = userOpen ?? isRunning
 * ============================================================ */

test('TC-THINK-001 ThinkBlock 展开态经解析链（用户意志最高 → 流式中展开 → 完成后折叠）', () => {
  assert.match(
    THINK,
    /const \[userOpen, setUserOpen\] = useState<boolean \| null>\(null\)/,
    'userOpen 应为 boolean | null（null = 未手动干预）',
  )
  // v0.31.0 B1（C-8）：展开态由 `userOpen ?? isRunning` 升级为 resolveReasoningOpen 解析链
  // （用户意志 → 流式 → 最短可见 1200ms → 失败 → 视图策略）。**断言方向不变**：
  // 仍是「runtimeing 展开、完成后折叠」，只是补上了「最短可见」与「失败必展开」两条保护。
  assert.match(
    THINK,
    /const showFull = resolveReasoningOpen\(\{[\s\S]*?userOpen,[\s\S]*?\}\)/,
    '展开态应经 resolveReasoningOpen 解析链（不得退回裸 userOpen ?? isRunning）',
  )
  assert.match(THINK, /streaming: isRunning === true/, '流式中默认展开（运行时展开方向保持）')
  assert.match(THINK, /autoOpenWhenSettled: false/, '完成后默认折叠（完成后折叠方向保持）')
  assert.match(
    THINK,
    /const isRunning = block\.status === 'streaming' \|\| block\.status === 'pending'/,
    'isRunning 语义（流式/挂起中的思考块）保持',
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
 * TC-THINK-004 TurnList 接管流式思考预览（B4 转写：StreamingThinkBlock →
 * reasoning 通道缓冲直入投影层，运行中的思考以 streaming ReasoningBlock 呈现）
 * ============================================================ */

test('TC-THINK-004 TurnList：reasoning 通道缓冲直入投影层（流式默认展开由 ReasoningBlock 承担）', () => {
  // TurnList 订阅 `:turn:reasoning` 通道并传入 projectConversation（B1 管道语义保持）
  assert.match(
    FLOW,
    /:turn:reasoning/,
    'TurnList 应订阅 `${taskId}:turn:reasoning` 通道',
  )
  assert.match(
    FLOW,
    /streamBuffers:\s*streamBuffer\s*\?\s*\{/,
    '流式缓冲应注入投影层（不再有独立 StreamingThinkBlock 裸渲形态）',
  )
  assert.match(FLOW, /projectConversation\(/, '交互区唯一真相 = 投影层')
  // 裸流式文本直渲形态不得回归（旧「被吞」观感来源）
  assert.doesNotMatch(
    FLOW,
    /className="text-sm leading-6 text-text-secondary whitespace-pre-wrap break-words">\s*\{stream/,
    '裸流式文本直渲形态应移除（流式预览必须经 ReasoningBlock 的解析链）',
  )
})

/* ============================================================
 * TC-THINK-005 R-stream-3 保持：reason step 落地清 turn 缓冲
 * ============================================================ */

test('TC-THINK-005 R-stream-3 保持：reason 落地清 turn 文本缓冲（双份展示防护不回退）', () => {
  const SLICE = read('../../store/slices/conversationSlice.ts')
  // v0.31.0 B1：落定交接逻辑抽为纯模块 `store/settle.ts`（node:test 可密闭断言），
  // slice 退化为薄接线。断言方向不变 —— 仍锁「reason 落地必须清 turn 文本缓冲，
  // 流式 → 权威渲染平滑交接」，只是不再要求那句 `delete` 出现在 slice 里。
  assert.match(
    SLICE,
    /const settled = settleReasonStep\(stepIn, s\.streamBuffers\)/,
    'appendStep 应把流式缓冲交接给 settleReasonStep（reason 落地清缓冲）',
  )
  const SETTLE = read('../../store/settle.ts')
  assert.match(SETTLE, /if \(step\.type !== 'reason'\)/, 'settle 必须按 step.type === reason 分流')
  assert.match(SETTLE, /delete nextBuffers\[kText\]/, 'reason 落地必须清 :turn:text 缓冲（双份展示防护）')
})
