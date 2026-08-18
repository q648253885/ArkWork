/* ============================================================
 * v0.24.2 grep-search 关键词归一化 + 全局预算测试
 * 场景：Run4 模型以 25 次 grep + 不同 pattern 探测（同一组关键词换序/换转义反复用）
 * ============================================================ */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkRepeatRead,
  recordRepeatResult,
  invalidateReadsOf,
  clearRepeatReadMap,
} from '../skills/read-repeat-guard.js'
import { grepSearch } from '../skills/grep-search.js'

const ctx = { taskId: 'g', workspaceDir: '/Users/gongzheng/ai/t2' } as never

test('grep-search 关键词归一化：换序/换转义同一 signature', async () => {
  clearRepeatReadMap(ctx)
  const r1 = await grepSearch({ pattern: '选择关卡|levelSelect|selectLevel|关卡', path: 'src/scenes-ui.js' }, ctx)
  assert.equal((r1 as { hint?: string }).hint, undefined)
  // 换顺序的同一组关键词 → 应被拦
  const r2 = await grepSearch({ pattern: 'levelSelect|selectLevel|关卡|选择关卡', path: 'src/scenes-ui.js' }, ctx)
  const r3 = await grepSearch({ pattern: '关卡|levelSelect|selectLevel|选择关卡', path: 'src/scenes-ui.js' }, ctx)
  // 第 3 次相同 signature → block
  assert.ok((r3 as { hint?: string }).hint?.includes('已拦截'), '第 3 次应被拦截')
})

test('grep-search 全局预算：累计第 6 次起 warn、第 8 次起 block', async () => {
  clearRepeatReadMap(ctx)
  // 用每次都不同的 pattern 让单签名判定全部 pass，仅触发全局预算
  let warnHit = 0
  let blockHit = 0
  for (let i = 1; i <= 12; i++) {
    const r = await grepSearch({ pattern: `__unique_token_${i}__`, path: 'src/scenes-ui.js' }, ctx)
    const hint = (r as { hint?: string }).hint ?? ''
    if (hint.includes('重复读警告')) warnHit++
    if (hint.includes('已拦截')) blockHit++
  }
  assert.ok(warnHit >= 1, `应至少有 1 次 warn，实得 ${warnHit}`)
  assert.ok(blockHit >= 1, `应至少有 1 次 block，实得 ${blockHit}`)
})

test('grep-search 编辑后重置（invalidateReadsOf 对全局签名也生效）', async () => {
  clearRepeatReadMap(ctx)
  for (let i = 1; i <= 10; i++) {
    await grepSearch({ pattern: `__tok_${i}__`, path: 'src/scenes-ui.js' }, ctx)
  }
  invalidateReadsOf(ctx, 'src/scenes-ui.js')
  // 编辑后再搜应恢复 pass
  const r = await grepSearch({ pattern: 'mkButton', path: 'src/scenes-ui.js' }, ctx)
  assert.equal((r as { hint?: string }).hint, undefined, '编辑后全局预算应被重置')
})