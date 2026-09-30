/* ============================================================
 * ArkWork — Git Manager 面板升级用例（v0.42.0 · TC-GITP2）
 * v0.42.0 面板对齐 VSCode 源代码管理形态：暂存分组 / 单文件操作 /
 * 内联 diff / 分支操作 / 提交详情。新映射函数全部落在面板**纯函数区**
 * （@@ARKWORK-PURE@@，与 TC-PGM-016 同一可测性接缝）：本仓没有 jsdom，
 * 面板脚本没法整体装载，用例抽出该区源码 new Function 真跑 ——
 * 断言返回值，不是源码 grep（纪律⑫）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plugin-git-manager-v042
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { filesOf } from '../sample-plugins.js'
import { GIT_ALL_OPS } from '../../git/service.js'
import { stripComments } from '@shared/utils/source-guard'

const GIT_ID = 'ark.plugin.git-manager'
const PURE_START = '/* @@ARKWORK-PURE:START@@ */'
const PURE_END = '/* @@ARKWORK-PURE:END@@ */'

/** 抽出纯函数区并真跑（区必须自包含：NL 等依赖要在区内声明） */
function panelPure(): {
  groupChanges: (entries: Array<{ x: string; y: string; path: string }>) => {
    staged: Array<{ path: string }>
    unstaged: Array<{ path: string }>
  }
  parseDiffLines: (text: string | null) => { lines: Array<{ cls: string; text: string }>; truncated: boolean }
  branchLabel: (entries: Array<{ name: string; current: boolean }>) => string
} {
  const html = filesOf(GIT_ID)!['panel.html']!
  const a = html.indexOf(PURE_START)
  const b = html.indexOf(PURE_END)
  assert.ok(a >= 0 && b > a, '纯函数区标记必须在（可测性接缝，删掉 = 用例退化为源码 grep）')
  return new Function(
    `${html.slice(a + PURE_START.length, b)}\nreturn { groupChanges: groupChanges, parseDiffLines: parseDiffLines, branchLabel: branchLabel }`,
  )()
}

test('TC-GITP2-001 ★ groupChanges 真值表：已暂存/未暂存/两区都有/未跟踪 各归其组', () => {
  const { groupChanges } = panelPure()
  const g = groupChanges([
    { x: 'M', y: ' ', path: 'a.ts' }, // 只已暂存
    { x: ' ', y: 'M', path: 'b.ts' }, // 只未暂存
    { x: 'M', y: 'M', path: 'c.ts' }, // 两区都有 → 两组各一次（VSCode 口径）
    { x: '?', y: '?', path: 'd.ts' }, // 未跟踪 → 只进未暂存
    { x: 'A', y: ' ', path: 'e.ts' }, // 新增已暂存
  ])
  assert.deepEqual(g.staged.map((e: { path: string }) => e.path), ['a.ts', 'c.ts', 'e.ts'])
  assert.deepEqual(g.unstaged.map((e: { path: string }) => e.path), ['b.ts', 'c.ts', 'd.ts'])
})

test('TC-GITP2-002 ★ groupChanges 边界：空输入 / 缺字段兜底', () => {
  const { groupChanges } = panelPure()
  assert.deepEqual(groupChanges([]), { staged: [], unstaged: [] })
  assert.deepEqual(groupChanges(undefined as unknown as []), { staged: [], unstaged: [] })
  // 缺 x/y 字段按「两区都空」处理（不进任何组、不抛错）
  const g = groupChanges([{ path: 'x.ts' } as { x: string; y: string; path: string }])
  assert.deepEqual(g, { staged: [], unstaged: [] })
})

test('TC-GITP2-003 ★ parseDiffLines 真值表：文件头/hunk/增/删/上下文 分类正确', () => {
  const { parseDiffLines } = panelPure()
  const nl = String.fromCharCode(10)
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1234567..89abcde 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,4 @@',
    '  context line',
    '+added line',
    '-removed line',
  ].join(nl)
  const parsed = parseDiffLines(diff)
  assert.deepEqual(
    parsed.lines.map((l) => l.cls),
    ['d-file', 'd-file', 'd-file', 'd-file', 'd-hunk', 'd-ctx', 'd-add', 'd-del'],
  )
  assert.equal(parsed.truncated, false)
})

test('TC-GITP2-004 ★ parseDiffLines 边界：空 / null / 截断（上限 400 行）', () => {
  const { parseDiffLines } = panelPure()
  assert.deepEqual(parseDiffLines(''), { lines: [], truncated: false })
  assert.deepEqual(parseDiffLines(null as unknown as string), { lines: [], truncated: false })
  const nl = String.fromCharCode(10)
  const big = Array.from({ length: 401 }, (_, i) => `+line ${i}`).join(nl)
  const parsed = parseDiffLines(big)
  assert.equal(parsed.lines.length, 400, '大 diff 必须截断到 400 行（防卡死 iframe）')
  assert.equal(parsed.truncated, true)
})

test('TC-GITP2-005 ★ branchLabel：当前分支命中 / 空列表 / 无当前位', () => {
  const { branchLabel } = panelPure()
  assert.equal(branchLabel([{ name: 'main', current: false }, { name: 'dev', current: true }]), 'dev')
  assert.equal(branchLabel([]), '')
  assert.equal(branchLabel(undefined as unknown as []), '')
  assert.equal(branchLabel([{ name: 'main', current: false }]), '')
})

test('TC-GITP2-006 面板新用到的 op 全在白名单内（diff/show/checkout/branch-create/branch-delete）', () => {
  const html = filesOf(GIT_ID)!['panel.html']!
  const used = new Set<string>()
  // 两条调用形态都要扫：git('op', …) 直调与 runWrite('op', …) 包装（busy+refresh 收敛路径）
  for (const m of html.matchAll(/\b(?:git|runWrite)\(\s*'([a-z-]+)'/g)) used.add(m[1]!)
  for (const op of used) {
    assert.ok(
      (GIT_ALL_OPS as readonly string[]).includes(op),
      `面板调用了白名单外的 op「${op}」—— 点了必然报未知操作`,
    )
  }
  // v0.42.0 新能力的最低集：逐文件操作 + 内联 diff + 分支管理
  for (const op of ['diff', 'show', 'add', 'reset', 'checkout', 'branch-create', 'branch-delete']) {
    assert.ok(used.has(op), `面板缺少 ${op} 调用（对应升级能力缺失）`)
  }
})

test('TC-GITP2-007 提交流程两步化：「暂存全部并提交」二合一按钮退役（防误提交）', () => {
  const code = stripComments(filesOf(GIT_ID)!['panel.html']!)
  assert.doesNotMatch(code, /暂存全部并提交/, '二合一按钮已退役（v0.42.0：暂存与提交分开，逐文件可控）')
  assert.match(code, /提交已暂存/, '提交按钮语义 = 只提交已暂存')
  // 空暂存区禁止提交：commit 由 updateCommitButton 守卫（stagedCount === 0 → disabled）
  assert.match(code, /stagedCount === 0/, '提交按钮必须有空暂存区守卫')
})
