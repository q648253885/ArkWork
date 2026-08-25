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
