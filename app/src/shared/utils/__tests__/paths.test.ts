/* ============================================================
 * v0.31.0 B2 修复 — shared/utils/paths.ts 单测（TC-PATH-001..004）
 *
 * 载体纪律：**纯函数、零 IO、零 electron** —— 直接 import 被测模块，
 * 不读源码正则（除 TC-PATH-004 那条**常量单源**契约，它按定义就是源码契约用例）。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs shared/utils/__tests__
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ARKWORK_DIRNAME, isArkworkInternal } from '../paths.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

/* ============================================================
 * TC-PATH-001 · `.arkwork` 段命中（Unix 形态）
 * ============================================================ */
test('TC-PATH-001 含 .arkwork 段的 Unix 路径一律命中', () => {
  assert.equal(isArkworkInternal('/ws/.arkwork/artifacts/a.md'), true)
  assert.equal(isArkworkInternal('/ws/.arkwork'), true, '尾段无后续也命中')
  assert.equal(isArkworkInternal('/ws/src/.arkwork/x'), true, '嵌套 .arkwork 保守命中（无 root 时的取向）')
  assert.equal(isArkworkInternal('/.arkwork'), true)
  assert.equal(isArkworkInternal('.arkwork/a'), true, '相对路径同样命中')
  assert.equal(isArkworkInternal('.arkwork'), true)
})

/* ============================================================
 * TC-PATH-002 · 跨平台对等：反斜杠路径同样命中
 * ============================================================ */
test('TC-PATH-002 Windows 反斜杠路径与 Unix 路径判定一致（三平台对等）', () => {
  const cases: Array<[string, string]> = [
    ['C:\\ws\\.arkwork\\a.md', '/ws/.arkwork/a.md'],
    ['C:\\ws\\.arkwork', '/ws/.arkwork'],
    ['\\ws\\a\\.arkwork\\b', '/ws/a/.arkwork/b'],
  ]
  for (const [win, nix] of cases) {
    assert.equal(isArkworkInternal(win), true, `Windows 形态应命中: ${win}`)
    assert.equal(isArkworkInternal(win), isArkworkInternal(nix), `两平台判定必须一致: ${win} / ${nix}`)
  }
})

/* ============================================================
 * TC-PATH-003 · 不误伤：近似名与空串
 * ============================================================ */
test('TC-PATH-003 近似名不得误判（否则会挡住正常可编辑文件）', () => {
  // 少一个点 / 多后缀 / 只像一部分 —— 都不是 agent 内容区
  assert.equal(isArkworkInternal('/ws/arkwork/a.md'), false)
  assert.equal(isArkworkInternal('/ws/.arkworkx/a.md'), false, '前缀相同但不是同一个目录名')
  assert.equal(isArkworkInternal('/ws/my.arkwork/a.md'), false, '含 .arkwork 但非独立路径段')
  assert.equal(isArkworkInternal('/ws/x.arkwork.md'), false)
  assert.equal(isArkworkInternal(''), false, '空串不得命中（⌘E 占位入口会传空路径）')
  assert.equal(isArkworkInternal('/ws/src/a.ts'), false)
})

/* ============================================================
 * TC-PATH-004 · 常量单源契约：全仓库仅一处 `.arkwork` 字面量定义
 * ============================================================ */
test('TC-PATH-004 ARKWORK_DIRNAME 单源：main/fs/guard 从共享层引用而非自带字面量', () => {
  assert.equal(ARKWORK_DIRNAME, '.arkwork', '目录名是正本既有事实，不得改')

  const guard = read('../../../main/fs/guard.ts')
  assert.match(
    guard,
    /import\s*\{\s*ARKWORK_DIRNAME\s*\}\s*from\s*'@shared\/utils\/paths'/,
    'guard.ts 必须从 @shared/utils/paths 引入常量',
  )
  assert.ok(
    !/const\s+ARKWORK_DIRNAME\s*=/.test(guard),
    'guard.ts 不得再自带 `const ARKWORK_DIRNAME = …` 字面量（否则两处定义会漂移）',
  )
  assert.match(guard, /export\s*\{\s*ARKWORK_DIRNAME\s*\}/, '需转出以维持既有导入点（guard.test.ts）')
})
