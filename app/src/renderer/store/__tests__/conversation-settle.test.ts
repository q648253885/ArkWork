/* ============================================================
 * v0.31.0 B1 — 流式缓冲与落定交接（TC-SETTLE-001…007）
 *
 * 依据：docs/versions/v0.31.0/04-system-design.md §6.2
 *      docs/versions/v0.31.0/testcases/00-cumulative-matrix.md §3.3
 *      agent_learn/docs/interaction-display-v1.0/04 §六（G8–G10）
 * 防的是 RC-3：「`reason` 步骤到达时无条件 `delete` 缓冲 → 文本缩短的视觉跳变」。
 *
 * 载体说明（对矩阵 §3.3 的一处收敛，已在矩阵 §四登记）：
 *   矩阵原写「store 单测，直接构造 slice 调 `appendStep`」。实测 `conversationSlice`
 *   的依赖链（`store/meta.ts` → `i18n/index.ts`）在模块顶层读取 `import.meta.env`
 *   与 `document`，Node ESM 下**无法实例化**。故 B1 把「缓冲 key 规则 + 落定交接」
 *   抽为纯模块 `store/settle.ts`，用例直接对其断言 —— 这比源码正则断言**更强**
 *   （能跑行为），且 slice 侧另加接线契约用例防止逻辑分叉。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/renderer/store/__tests__/conversation-settle.test.ts
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { appendDelta, clearBuffers, settleReasonStep, streamBufferKey } from '../settle.js'
import { MIN_VISIBLE_MS, resolveReasoningOpen } from '@shared/utils/reasoning'
import type { ReActStep } from '@shared/types/react'
import type { TaskTextDeltaPayload } from '@shared/types/ipc'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const SLICE = read('../slices/conversationSlice.ts')

function reasonStep(over: Partial<ReActStep> = {}): ReActStep {
  return {
    id: 'step-1',
    taskId: 't1',
    iteration: 0,
    type: 'reason',
    startedAt: 1_000,
    durationMs: 100,
    status: 'success',
    ...over,
  }
}

function delta(over: Partial<TaskTextDeltaPayload> = {}): TaskTextDeltaPayload {
  return { taskId: 't1', scope: 'turn', kind: 'text', seq: 1, text: '', ...over }
}

describe('settle · TC-SETTLE', () => {
  /* ---------- 001 落定取较长者 ---------- */
  it('TC-SETTLE-001 落定取较长者：settled 短于 streamed → 用 streamed 文本', () => {
    const streamed = '流式累计的完整思考文本，比落定文本长得多'
    const r = settleReasonStep(reasonStep({ reasoning: '短' }), {
      't1:turn:reasoning': { seq: 3, text: streamed },
    })
    assert.equal(r.tookLonger, true)
    assert.equal(r.step.reasoning, streamed, '必须保留较长的流式文本（RC-3 根因修复）')
  })

  /* ---------- 002 truncated 与取较长者同时置位 ---------- */
  it('TC-SETTLE-002 `truncated` 与「取较长者」同时置位（不变量②）', () => {
    const before = '权威文本'
    const streamed = '权威文本 + 流式期间多出来的尾巴'
    const r = settleReasonStep(reasonStep({ reasoning: before }), {
      't1:turn:reasoning': { seq: 2, text: streamed },
    })
    assert.equal(r.step.truncated, true, '取较长者时必须同时置位 truncated（不静默缩短）')
    const after = r.step.reasoning ?? ''
    assert.ok(
      after.length >= before.length || r.step.truncated === true,
      '不变量②：落定后文本长度不减少，或显式标记 truncated',
    )

    // 反向：权威更长/相等时不得误置 truncated
    const r2 = settleReasonStep(reasonStep({ reasoning: streamed }), {
      't1:turn:reasoning': { seq: 2, text: before },
    })
    assert.equal(r2.tookLonger, false)
    assert.notEqual(r2.step.truncated, true, '权威文本不短时不得置 truncated')
    assert.equal(r2.step.reasoning, streamed)
  })

  /* ---------- 003 块 id 落定前后不变 ---------- */
  it('TC-SETTLE-003 块 id 落定前后不变（不变量①）', () => {
    const step = reasonStep({ id: 'stable-id' })
    const r1 = settleReasonStep(step, { 't1:turn:reasoning': { seq: 1, text: 'x'.repeat(50) } })
    assert.equal(r1.step.id, 'stable-id', '改写了内容也不得换 id（换 id = React 卸载重建 = 视觉跳变）')
    const r2 = settleReasonStep(step, {})
    assert.equal(r2.step.id, 'stable-id')
    assert.equal(r2.step, step, '无流式残留时应原样返回同一引用（零行为变化）')
  })

  /* ---------- 004 短思考不自动折叠 ---------- */
  it('TC-SETTLE-004 短思考不自动折叠：elapsedMs < minVisibleMs 时保持展开（不变量③ / C-8）', () => {
    const base = { userOpen: null, streaming: false, failed: false, autoOpenWhenSettled: false }
    assert.equal(
      resolveReasoningOpen({ ...base, elapsedMs: MIN_VISIBLE_MS - 1 }),
      true,
      '未达最短可见时长必须保持展开（防「闪一下就没」）',
    )
    assert.equal(
      resolveReasoningOpen({ ...base, elapsedMs: MIN_VISIBLE_MS }),
      false,
      '达到阈值后按策略（此处 autoOpenWhenSettled=false → 折叠）',
    )
    assert.equal(MIN_VISIBLE_MS, 1200, '最短可见时长默认 1200ms（C-8）')
    // 流式中恒展开（不受时长影响）
    assert.equal(resolveReasoningOpen({ ...base, streaming: true, elapsedMs: 5_000 }), true)
    // 失败恒展开（失败不静默）
    assert.equal(resolveReasoningOpen({ ...base, failed: true, elapsedMs: 5_000 }), true)
  })

  /* ---------- 005 用户态优先 ---------- */
  it('TC-SETTLE-005 用户态优先：`userOpen !== null` 时模式与保护都不覆盖（不变量④ / R4）', () => {
    const crowded = { streaming: true, elapsedMs: 0, failed: true, autoOpenWhenSettled: true }
    assert.equal(
      resolveReasoningOpen({ ...crowded, userOpen: false }),
      false,
      '用户手动折叠后，即便「流式中 + 失败 + 策略展开」也不得覆盖',
    )
    assert.equal(
      resolveReasoningOpen({ ...crowded, userOpen: true, streaming: false, failed: false, elapsedMs: 9_999, autoOpenWhenSettled: false }),
      true,
      '用户手动展开后，即便已落定也要保持展开',
    )
  })

  /* ---------- 006 缓冲 key 三维不互撞 ---------- */
  it('TC-SETTLE-006 缓冲 key 三维 `${taskId}:${scope}:${kind}`：同 task 的 text 与 reasoning 不互撞', () => {
    assert.notEqual(
      streamBufferKey('t1', 'turn', 'text'),
      streamBufferKey('t1', 'turn', 'reasoning'),
      '同任务同管线的两条通道必须是不同缓冲',
    )

    let bufs = appendDelta({}, delta({ kind: 'text', seq: 1, text: '叙述一' }))
    bufs = appendDelta(bufs, delta({ kind: 'reasoning', seq: 1, text: '思考一' }))
    assert.equal(bufs['t1:turn:text'].text, '叙述一')
    assert.equal(bufs['t1:turn:reasoning'].text, '思考一')

    // 续写与乱序判定各自独立
    bufs = appendDelta(bufs, delta({ kind: 'text', seq: 2, text: '叙述二' }))
    assert.equal(bufs['t1:turn:text'].text, '叙述一叙述二')
    assert.equal(bufs['t1:turn:reasoning'].text, '思考一', '续写 text 不得影响 reasoning 缓冲')
    // text 收到 seq=9（乱序）→ 整体丢弃，返回同一引用
    const before = bufs
    assert.equal(appendDelta(bufs, delta({ kind: 'text', seq: 9, text: '乱序' })), before)
    // 但 reasoning 通道的 seq=9 是它自己的顺序续写（两条通道各自计 seq）
    assert.equal(appendDelta(bufs, delta({ kind: 'reasoning', seq: 2, text: '思考二' }))['t1:turn:reasoning'].text, '思考一思考二')
  })

  /* ---------- 007 reason 落定：清 text 通道、保留 reasoning 通道 ---------- */
  it('TC-SETTLE-007 `reason` 到达：清 `:turn:text` 缓冲；`:turn:reasoning` 不删', () => {
    const r = settleReasonStep(reasonStep({ reasoning: '权威' }), {
      't1:turn:text': { seq: 1, text: '叙述' },
      't1:turn:reasoning': { seq: 1, text: '思考' },
      't1:chat:text': { seq: 1, text: '快速回复' },
    })
    assert.ok(!('t1:turn:text' in r.streamBuffers), '叙述通道的权威内容在 answer / say 块里，缓冲必须清')
    assert.equal(r.streamBuffers['t1:turn:reasoning']?.text, '思考', '思考缓冲留给展示块读完后清（此处不删）')
    assert.equal(r.streamBuffers['t1:chat:text']?.text, '快速回复', '不得误伤 chat 管线')

    // 非 reason 步骤：缓冲一字不动（既有调用点零行为变化）
    const act = reasonStep({ type: 'act', toolName: 'file-reader' })
    const r2 = settleReasonStep(act, r.streamBuffers)
    assert.equal(r2.streamBuffers, r.streamBuffers)
  })

  /* ---------- 接线契约（防 slice 与纯模块分叉） ---------- */
  it('接线契约：conversationSlice 三个方法均委托纯模块（无第二份实现）', () => {
    assert.match(SLICE, /settleReasonStep\(stepIn, s\.streamBuffers\)/, 'appendStep 必须委托 settleReasonStep')
    assert.match(SLICE, /appendDelta\(s\.streamBuffers, payload\)/, 'applyTextDelta 必须委托 appendDelta')
    assert.match(SLICE, /clearBuffers\(s\.streamBuffers, taskId, scope, kind\)/, 'clearStreamBuffer 必须委托 clearBuffers')
    assert.doesNotMatch(
      SLICE,
      /streamBuffers\[\`\$\{step\.taskId\}:turn\`\]/,
      '不得残留旧二维 key 的直写形态（R-stream-3 的旧实现）',
    )
  })

  /* ---------- clearBuffers 逐维收窄（TC-SETTLE-007 的补强） ---------- */
  it('clearBuffers 逐维收窄：省略 scope 清全作用域，指定 kind 只清该通道', () => {
    const all = {
      't1:turn:text': { seq: 1, text: 'a' },
      't1:turn:reasoning': { seq: 1, text: 'b' },
      't1:chat:text': { seq: 1, text: 'c' },
      't2:turn:text': { seq: 1, text: 'd' },
    }
    const onlyTurnText = clearBuffers(all, 't1', 'turn', 'text')
    assert.deepEqual(Object.keys(onlyTurnText).sort(), ['t1:chat:text', 't1:turn:reasoning', 't2:turn:text'])
    const wholeTask = clearBuffers(all, 't1')
    assert.deepEqual(Object.keys(wholeTask).sort(), ['t2:turn:text'])
    assert.equal(clearBuffers(all, 'nope'), all, '无命中时返回同一引用')
  })
})
