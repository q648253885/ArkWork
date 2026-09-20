/* ============================================================
 * v0.24.0 read-repeat-guard 三级判决测试
 * 场景来源：T-20260817-106u4s（同文件读 6 次 / 同关键词 grep 4 次打转 105 轮）
 * ============================================================ */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkRepeatRead,
  recordRepeatResult,
  invalidateReadsOf,
  clearRepeatReadMap,
  repeatGuardBucketCount,
} from '../skills/read-repeat-guard.js'

const ctx = { taskId: 'test' } as never

test('三级判决：pass(1-2) → warn(3) → block(4+)', () => {
  clearRepeatReadMap(ctx)
  const sig = { path: 'src/game.js' }

  assert.equal(checkRepeatRead(ctx, 'file-reader', sig).action, 'pass')
  assert.equal(checkRepeatRead(ctx, 'file-reader', sig).action, 'pass')

  const warn = checkRepeatRead(ctx, 'file-reader', sig)
  assert.equal(warn.action, 'warn')
  if (warn.action === 'warn') {
    assert.ok(warn.hint.includes('第 3 次'))
    assert.ok(warn.hint.includes('直接行动'))
  }

  const block = checkRepeatRead(ctx, 'file-reader', sig)
  assert.equal(block.action, 'block')
  if (block.action === 'block') {
    assert.ok(block.observation.includes('已拦截'))
    assert.ok(block.observation.includes('禁止继续读取'))
  }

  const block2 = checkRepeatRead(ctx, 'file-reader', sig)
  assert.equal(block2.action, 'block')
})

test('recordRepeatResult：block 观察回带上次内容头', () => {
  clearRepeatReadMap(ctx)
  const sig = { pattern: 'setInteractive' }
  for (let i = 0; i < 3; i++) checkRepeatRead(ctx, 'grep-search', sig)
  recordRepeatResult(ctx, 'grep-search', sig, '3 处命中，如 scenes/ui.js:42')

  const block = checkRepeatRead(ctx, 'grep-search', sig)
  assert.equal(block.action, 'block')
  if (block.action === 'block') {
    assert.ok(block.observation.includes('scenes/ui.js:42'))
  }
})

test('invalidateReadsOf：编辑后同文件可重读（计数清零）', () => {
  clearRepeatReadMap(ctx)
  const sig = { path: 'src/main.js' }
  for (let i = 0; i < 4; i++) checkRepeatRead(ctx, 'file-reader', sig)
  assert.equal(checkRepeatRead(ctx, 'file-reader', sig).action, 'block')

  invalidateReadsOf(ctx, 'src/main.js')
  assert.equal(checkRepeatRead(ctx, 'file-reader', sig).action, 'pass')
})

test('不同 signature 互不干扰', () => {
  clearRepeatReadMap(ctx)
  const sigA = { path: 'a.js' }
  const sigB = { path: 'b.js' }
  for (let i = 0; i < 4; i++) checkRepeatRead(ctx, 'file-reader', sigA)
  assert.equal(checkRepeatRead(ctx, 'file-reader', sigA).action, 'block')
  assert.equal(checkRepeatRead(ctx, 'file-reader', sigB).action, 'pass')
})

test('v0.24.2 文件级预算：换分页反复读同一文件仍拦截（warn@4 / block@6）', () => {
  clearRepeatReadMap(ctx)
  const fileSig = { path: 'src/scenes-ui.js' }
  const fileOpts = { warnThreshold: 4, blockThreshold: 6 }
  // 模拟 file-reader 双判定：页级签名随 startLine 变化，文件级签名恒定
  for (let i = 0; i < 3; i++) {
    checkRepeatRead(ctx, 'file-reader', fileSig, fileOpts)
    checkRepeatRead(ctx, 'file-reader', { path: fileSig.path, page: i }) // 每次换一页
  }
  // 第 4 次文件级读取 → warn
  const warn = checkRepeatRead(ctx, 'file-reader', fileSig, fileOpts)
  assert.equal(warn.action, 'warn')
  // 第 5 次仍 warn
  assert.equal(checkRepeatRead(ctx, 'file-reader', fileSig, fileOpts).action, 'warn')
  // 第 6 次起 block（尽管每次都是不同 page）
  const block = checkRepeatRead(ctx, 'file-reader', fileSig, fileOpts)
  assert.equal(block.action, 'block')
  if (block.action === 'block') assert.ok(block.observation.includes('已拦截'))
  // 编辑后重置
  invalidateReadsOf(ctx, 'src/scenes-ui.js')
  assert.equal(checkRepeatRead(ctx, 'file-reader', fileSig, fileOpts).action, 'pass')
})

/* ============================================================
 * v0.34.4（D70）：**接线**契约 —— 状态必须按 taskId 存，不得按 ctx 对象身份存
 *
 * 病（本守卫自 v0.24.0 起在生产上完全失效）：
 *   `SkillContext` 由 `act.ts` 在 `executeAct()` 内部**每次工具调用新建**
 *   （对象里含 iteration 等逐次变化字段，无法复用）；而守卫此前用
 *   `WeakMap<object, …>` 按 **ctx 对象身份**取值 ⇒ 每次调用都命中不到上次的桶，
 *   计数恒为 1 ⇒ 永远停在 `pass`。
 *
 * 真机证据（t1 · T-20260919-6c3v48，51 轮空转 / 零产物）：
 *   · 同一文件 `docs/v1.0/00-release-goal.md` 被**成功读取 9 次**（两种路径写法各 5/4 次）；
 *   · 出题人本意第 4 次起 block —— 实际 warn 0 次、block 0 次；
 *   · session.jsonl 383 条事件里 `重复读警告` / `已拦截` 出现次数 = 0 / 0。
 *
 * 为什么既有用例没拦住：上面所有用例共用**模块级单例** `const ctx = {taskId:'test'}`
 * —— 测的是"意图"，不是"接线"（与 v0.32.1 D38-a 同型）。本组因此**每次新建对象**，
 * 复刻生产真实形态（纪律③：挂点类用例必须覆盖真实会走的那条路径）。
 * ============================================================ */

/** 生产形态：每次工具调用新建 ctx 对象，只有 taskId 稳定 */
const freshCtx = (taskId = 'T-shape-real'): never =>
  ({ taskId, signal: new AbortController().signal, workspaceDir: '/ws' }) as never

test('TC-RRG-020 ★ [D70] 每次新建 ctx 对象也必须累计（复刻 act.ts 的 per-call 构造）', () => {
  const sig = { path: '/ws/docs/v1.0/00-release-goal.md', page: 0 }
  // 第 1、2 次 pass
  assert.equal(checkRepeatRead(freshCtx(), 'file-reader', sig).action, 'pass')
  assert.equal(checkRepeatRead(freshCtx(), 'file-reader', sig).action, 'pass')
  // 第 3 次 warn
  assert.equal(checkRepeatRead(freshCtx(), 'file-reader', sig).action, 'warn')
  // 第 4 次起 block —— 这正是真机上缺失的那一步
  const block = checkRepeatRead(freshCtx(), 'file-reader', sig)
  assert.equal(
    block.action,
    'block',
    '★ 状态必须按 taskId 存：每次新建 ctx 是生产实际，按对象身份存会让守卫永远 pass',
  )
  if (block.action === 'block') assert.ok(block.observation.includes('已拦截'))
})

test('TC-RRG-021 ★ [D70] 9 次同文件读取（真机次数）必须被拦下至少 5 次', () => {
  const sig = { path: '/ws/docs/v1.0/00-release-goal.md' }
  const verdicts = Array.from({ length: 9 }, () => checkRepeatRead(freshCtx('T-9reads'), 'file-reader', sig).action)
  const blocked = verdicts.filter((v) => v === 'block').length
  assert.ok(
    blocked >= 5,
    `★ 真机该文件被成功读 9 次；守卫应拦下第 4 次起的 6 次，实际拦下 ${blocked} 次（verdicts=${verdicts.join(',')}）`,
  )
})

test('TC-RRG-022 [D70] 不同 taskId 相互隔离（不得跨任务串味）', () => {
  const sig = { path: '/ws/a.md' }
  for (let i = 0; i < 4; i++) checkRepeatRead(freshCtx('T-A'), 'file-reader', sig)
  assert.equal(checkRepeatRead(freshCtx('T-A'), 'file-reader', sig).action, 'block', 'T-A 应已拦截')
  assert.equal(
    checkRepeatRead(freshCtx('T-B'), 'file-reader', sig).action,
    'pass',
    '★ 换任务必须重新计数 —— 否则跨任务误拦',
  )
})

test('TC-RRG-023 [D70] 桶数有界：不得随任务数无界增长（WeakMap→Map 的配套）', () => {
  const before = repeatGuardBucketCount()
  for (let i = 0; i < 200; i++) {
    checkRepeatRead(freshCtx(`T-bulk-${i}`), 'file-reader', { path: `/ws/f${i}.md` })
  }
  const after = repeatGuardBucketCount()
  assert.ok(after < before + 200, '★ 必须有过期/上限淘汰，不能每次新 taskId 就永久占一个桶')
  assert.ok(after <= 64 + 1, `桶数应有上限（含兜底桶），实际 ${after}`)
})

test('TC-RRG-024 [D70] clearRepeatReadMap 按 taskId 清除，且不影响其它任务', () => {
  const sig = { path: '/ws/b.md' }
  const c = freshCtx('T-C')
  for (let i = 0; i < 4; i++) checkRepeatRead(c, 'file-reader', sig)
  assert.equal(checkRepeatRead(c, 'file-reader', sig).action, 'block')
  clearRepeatReadMap(freshCtx('T-C')) // 换一个新的对象、同 taskId
  assert.equal(
    checkRepeatRead(freshCtx('T-C'), 'file-reader', sig).action,
    'pass',
    '★ 按 taskId 清除必须对"另一对象同 taskId"同样生效（这正是接线契约）',
  )
})

