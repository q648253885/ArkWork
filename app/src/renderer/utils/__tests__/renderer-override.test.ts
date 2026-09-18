/* ============================================================
 * v0.33.0 — 渲染器覆盖契约（TC-RDR-001..007）
 * 规格见 testcases/00-cumulative-matrix.md §11；
 * 被测：shared/utils/renderer-ext.ts（覆盖流纯函数层）
 *
 * 为什么测 shared 而不是 renderer/store/meta.ts：meta 顶层经
 * ipc/client 读 window，node:test 无法导入；v0.33.0 已把内置表搬进
 * shared（单一真源），meta.detectRenderer 只是一行委托。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs renderer-override
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_EXT_RENDERER,
  detectRendererKind,
  extOf,
  sanitizeRendererOverrides,
} from '@shared/utils/renderer-ext'

test('TC-RDR-001 无覆盖表 → 与 v0.32.1 逐位一致（核心样本）', () => {
  assert.equal(detectRendererKind('a.md'), 'markdown')
  assert.equal(detectRendererKind('a.csv'), 'table')
  assert.equal(detectRendererKind('a.png'), 'image')
  assert.equal(detectRendererKind('a.svg'), 'svg')
  assert.equal(detectRendererKind('a.html'), 'browser')
  assert.equal(detectRendererKind('a.ts'), 'code')
  assert.equal(detectRendererKind('a.unknownext'), 'fallback')
})

test('TC-RDR-002 无覆盖表 → 内置表逐条回归（表驱动穷尽）', () => {
  for (const [ext, kind] of Object.entries(BUILTIN_EXT_RENDERER)) {
    assert.equal(detectRendererKind(`x.${ext}`), kind, `.${ext} 不得漂移`)
    // 与 v0.32.1 同口径：无点文件名整串当扩展名（Makefile → makefile → code）
    assert.equal(extOf(`x.${ext}`), ext)
  }
  assert.equal(detectRendererKind('Makefile'), 'code', '历史口径：Makefile 命中 code')
})

test('TC-RDR-003 插件覆盖 kchart→table 生效', () => {
  assert.equal(detectRendererKind('a.kchart', { kchart: 'table' }), 'table')
  // 无覆盖时 kchart 落 fallback
  assert.equal(detectRendererKind('a.kchart'), 'fallback')
})

test('TC-RDR-004 覆盖既有扩展名（md→code）→ 以覆盖为准', () => {
  assert.equal(detectRendererKind('a.md', { md: 'code' }), 'code')
})

test('TC-RDR-005 覆盖值为非法 RendererKind → 回落内置映射（绝不返回非法值）', () => {
  assert.equal(detectRendererKind('a.md', { md: 'bogus' }), 'markdown')
  assert.equal(detectRendererKind('a.kchart', { kchart: '3d' }), 'fallback')
  // 净化器：非字符串值 / 非法键被剔除
  assert.deepEqual(sanitizeRendererOverrides({ kchart: 1, 'BAD_KEY': 'table', ok: 'table' }), { ok: 'table' })
  assert.deepEqual(sanitizeRendererOverrides('nope'), {})
})

test('TC-RDR-006 覆盖表键大小写不敏感（KCHART 也能命中 a.kchart）', () => {
  assert.equal(detectRendererKind('a.kchart', { KCHART: 'table' }), 'table')
})

test('TC-RDR-007 覆盖表不影响无扩展名/未知扩展名文件的内置回落', () => {
  assert.equal(detectRendererKind('README', { readme: 'markdown' }), 'markdown', '键命中覆盖仍生效（覆盖语义）')
  assert.equal(detectRendererKind('README'), 'fallback', '无覆盖 → fallback')
  // 覆盖表只按扩展名命中，不改变其它文件的判定
  assert.equal(detectRendererKind('b.md', { kchart: 'table' }), 'markdown')
})
