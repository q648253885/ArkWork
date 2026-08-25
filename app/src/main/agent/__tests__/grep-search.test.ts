/* ============================================================
 * v0.24.2 / v0.28.0 grep-search 关键词归一化 + 预算测试
 * 场景：Run4 模型以 25 次 grep + 不同 pattern 探测（同一组关键词换序/换转义反复用）
 * v0.28.0（F9）：阈值放宽 —— 单签 warn@3/block@5，全局 warn@12/block@16
 * ============================================================ */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkRepeatRead,
  recordRepeatResult,
  invalidateReadsOf,
  clearRepeatReadMap,
} from '../skills/read-repeat-guard.js'
import { grepSearch } from '../skills/grep-search.js'

// 自包含临时工作区（此前硬编码 /Users/gongzheng/ai/t2，工作区内容变更后测试随之失效）
const workspaceDir = await mkdtemp(join(tmpdir(), 'arkwork-grep-test-'))
await mkdir(join(workspaceDir, 'src'), { recursive: true })
await writeFile(
  join(workspaceDir, 'src', 'scenes-ui.js'),
  [
    'function levelSelect(scene) {',
    '  // 选择关卡入口',
    '  return scene.jumpTo("level")',
    '}',
    'const mkButton = (label) => ({ tag: "button", label })',
    '',
  ].join('\n'),
  'utf8',
)
test.after(() => rm(workspaceDir, { recursive: true, force: true }))

const ctx = { taskId: 'g', workspaceDir } as never

test('grep-search 关键词归一化：换序/换转义同一 signature', async () => {
  clearRepeatReadMap(ctx)
  // 五次搜索共用同一 normalized signature：['levelselect.', '选择关卡']
  // （\\. ↔ . 转义归一、大小写归一、alternation 换序归一）
  const r1 = await grepSearch({ pattern: 'levelSelect\\.|选择关卡', path: 'src/scenes-ui.js' }, ctx)
  assert.equal((r1 as { hint?: string }).hint, undefined, '第 1 次应 pass')
  const r2 = await grepSearch({ pattern: '选择关卡|LEVELSELECT\\.', path: 'src/scenes-ui.js' }, ctx)
  assert.ok((r2 as { hint?: string }).hint === undefined, '第 2 次应 pass（换序+大小写同签）')
  // warn@3、block@5
  const r3 = await grepSearch({ pattern: 'LEVELSELECT.|选择关卡', path: 'src/scenes-ui.js' }, ctx)
  assert.ok((r3 as { hint?: string }).hint?.includes('重复读'), '第 3 次应 warn（去转义同签）')
  const r4 = await grepSearch({ pattern: '选择关卡|levelSelect.', path: 'src/scenes-ui.js' }, ctx)
  assert.ok((r4 as { hint?: string }).hint?.includes('重复读'), '第 4 次应 warn')
  const r5 = await grepSearch({ pattern: 'LEVELSELECT\\.|选择关卡', path: 'src/scenes-ui.js' }, ctx)
  assert.ok((r5 as { hint?: string }).hint?.includes('已拦截'), '第 5 次相同 signature 应被拦截')
})

test('grep-search 全局预算：累计第 12 次起 warn、第 16 次起 block', async () => {
  clearRepeatReadMap(ctx)
  // 用每次都不同的 pattern 让单签名判定全部 pass，仅触发全局预算
  let warnHit = 0
  let blockHit = 0
  for (let i = 1; i <= 16; i++) {
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
  for (let i = 1; i <= 13; i++) {
    await grepSearch({ pattern: `__tok_${i}__`, path: 'src/scenes-ui.js' }, ctx)
  }
  invalidateReadsOf(ctx, 'src/scenes-ui.js')
  // 编辑后再搜应恢复 pass（全局预算被重置）
  const r = await grepSearch({ pattern: 'mkButton', path: 'src/scenes-ui.js' }, ctx)
  assert.equal((r as { hint?: string }).hint, undefined, '编辑后全局预算应被重置')
})
