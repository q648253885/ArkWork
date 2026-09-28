/* ============================================================
 * v0.39.0 · D198 — 暂停提问的**持久化消费者**契约（TC-ASKP-001..005）
 *
 * 缺陷本体（实机验收抓到，D197 修完之后才暴露）：
 *   引擎有 9 处暂停点把提问写进 `Task.pendingAskUser`，既有守卫
 *   `loop-stall-guard.test.ts:138` 早就断言「必须写 pendingAskUser，
 *   **否则重开任务时问题丢失**」—— 持久化的**目的**就是给「事后重开」看。
 *   但渲染层只认活体 `ask_user` 事件（`store.askUserQuestion`，初值 null、
 *   切任务时显式清空），**全仓没有任何一处读 `pendingAskUser`**。
 *
 *   实机复现（打包后的 0.39.0 + 确定性空响应端点）：
 *     · 新任务空响应 3 次 → 引擎正确 `paused` + `ask_user` + `turn_note`；
 *     · 刷新窗口 / 重开该任务 → 界面只剩「已暂停 · 等待你的指令…」，
 *       我写的那段「模型连续 3 次返回空响应……任务不会被标记完成」**不可见**；
 *     · DOM 直查：`连续` / `空响应` / `不会被标记完成` / `保留已有进度` 全部 false。
 *
 * 本组把守三件事：
 *   ① 判定是**纯函数**且被**真执行**（真值表，纪律⑫：真执行 > grep）；
 *   ② 渲染层**真的有消费者**（D198 的核心：字段有写无读 = 静默丢失）；
 *   ③ 旧形态**不得回潮**（`const askUserQuestion = useStore((s) => s.askUserQuestion)`
 *      这种「只取活体」的写法正是缺陷本源），并带检测器自检（纪律⑮）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs ask-user-persisted-question
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'

const RENDERER = fileURLToPath(new URL('../..', import.meta.url)) // app/src/renderer/
const RESOLVER = join(RENDERER, 'components/ask-user-question.ts')
const COMPOSER = join(RENDERER, 'components/Composer.tsx')

const resolverSrc = readFileSync(RESOLVER, 'utf-8')
const resolverCode = stripComments(resolverSrc)
const composerCode = stripComments(readFileSync(COMPOSER, 'utf-8'))

/* ============================================================
 * 0. 工装：从 TS 源码抽函数**体**后用真签名执行
 *
 * 为什么不能直接 `new Function(带注解的源码)`：TS 参数注解（`liveQuestion:
 * string | null | undefined`）对 JS 是语法错误（`Unexpected token ':'`）。
 * 抽「体」再配「无注解签名」是仓库既有做法（empty-response-guard /
 * redirect-light-write 同款）。签名用**精确串** indexOf —— 签名一漂移就报红，
 * 不会静默退化成"测了个别的函数"。
 * ============================================================ */
function extractBody(src: string, signature: string): string {
  const i = src.indexOf(signature)
  assert.notEqual(i, -1, `未找到签名（签名漂移会让本用例静默失效）：${signature.slice(0, 60)}…`)
  const bodyStart = i + signature.length
  const j = src.indexOf('\n}', bodyStart)
  assert.notEqual(j, -1, '未找到函数体结尾')
  return src.slice(bodyStart, j)
}

type ResolveFn = (
  live: unknown,
  task: unknown,
) => string | null

function pureResolver(): ResolveFn {
  const body = extractBody(
    resolverSrc,
    // 精确签名：必须含 TS 注解原文，避免"抽到别的函数"还能过
    'export function resolveAskUserQuestion(\n' +
      '  liveQuestion: string | null | undefined,\n' +
      '  task: PausableTaskLike | null | undefined,\n' +
      '): string | null {',
  )
  return new Function(
    `function resolveAskUserQuestion(liveQuestion, task) {${body}\n}\n;return resolveAskUserQuestion;`,
  )() as ResolveFn
}

/* ============================================================
 * 1. TC-ASKP-001：resolveAskUserQuestion 真执行真值表
 * ============================================================ */
test('TC-ASKP-001 ★ resolveAskUserQuestion 真值表：活体优先 → 回落持久化 → 皆空为 null', () => {
  const f = pureResolver()
  const P = (q: unknown) => ({ pendingAskUser: { question: q } })

  const cases: Array<[string, unknown, unknown, string | null]> = [
    // ① 活体事件最权威
    ['活体提问直接采用', '本轮提问', P('持久化提问'), '本轮提问'],
    ['活体首尾空白裁掉', '  本轮提问  ', P('持久化提问'), '本轮提问'],
    ['活体优先于持久化', 'live', P('persisted'), 'live'],
    // ② 活体缺席 → 回落持久化（D198 补齐的那一格）
    ['活体 null → 回落持久化', null, P('持久化提问'), '持久化提问'],
    ['活体 undefined → 回落持久化', undefined, P('持久化提问'), '持久化提问'],
    ['活体全空白 → 回落持久化', '   ', P('持久化提问'), '持久化提问'],
    ['持久化首尾空白裁掉', null, P('  持久化提问  '), '持久化提问'],
    // ③ 皆空 → null（手动暂停不得被误升格为待答门禁）
    ['两者皆空 → null', null, { pendingAskUser: { question: '   ' } }, null],
    ['无 pendingAskUser → null', null, {}, null],
    ['task 为 null → null', null, null, null],
    ['task 为 undefined → null', null, undefined, null],
    ['pendingAskUser 为 null → null', null, { pendingAskUser: null }, null],
    // ④ 非字符串不得当提问渲染（防「把 42 显示成提问」）
    ['活体为数字 → 回落持久化', 42, P('持久化提问'), '持久化提问'],
    ['活体为对象 → 回落持久化', { q: 'x' }, P('持久化提问'), '持久化提问'],
    ['持久化为数字 → null', null, P(42), null],
    ['持久化为对象 → null', null, P({ q: 'x' }), null],
    ['持久化为空串 → null', null, P(''), null],
  ]

  for (const [name, live, task, want] of cases) {
    assert.equal(f(live, task), want, `${name}（live=${JSON.stringify(live)}）`)
  }
  assert.equal(cases.length, 17, '真值表条数应稳定（防误删）')
})

/* ============================================================
 * 2. TC-ASKP-002：唯一事实源必须真的读 pendingAskUser
 * ============================================================ */
test('TC-ASKP-002 ★ 唯一事实源读 pendingAskUser（字段有写无读 = 静默丢失）', () => {
  assert.match(
    resolverCode,
    /task\?\.pendingAskUser\?\.question/,
    'resolveAskUserQuestion 必须读 task.pendingAskUser.question —— 引擎 9 处暂停点写的正是它',
  )
  // 纯函数区的存在性：本用例靠它抽体真执行，缝没了就等于没测
  assert.match(resolverSrc, /@@ARKWORK-PURE:START@@/, '必须保留纯函数缝（真执行依赖它）')
  assert.match(resolverSrc, /@@ARKWORK-PURE:END@@/, '必须保留纯函数缝（真执行依赖它）')
})

/* ============================================================
 * 3. TC-ASKP-003：Composer 接线 + 旧形态禁止回潮（含检测器自检）
 * ============================================================ */
const STALE_FORM = /const\s+askUserQuestion\s*=\s*useStore\(\(s\)\s*=>\s*s\.askUserQuestion\)/

test('TC-ASKP-003 ★ Composer 消费唯一事实源，且「只取活体」的旧写法不得回潮', () => {
  assert.match(
    composerCode,
    /import\s*\{\s*resolveAskUserQuestion\s*\}\s*from\s*'\.\/ask-user-question'/,
    'Composer 必须从唯一事实源导入 resolveAskUserQuestion',
  )
  assert.match(
    composerCode,
    /const\s+askUserQuestion\s*=\s*resolveAskUserQuestion\(\s*liveAskUserQuestion\s*,\s*task\s*\)/,
    'askUserQuestion 必须是「活体 ∪ 持久化」的合并结果（D198 的修复本体）',
  )
  assert.match(
    composerCode,
    /const\s+liveAskUserQuestion\s*=\s*useStore\(\(s\)\s*=>\s*s\.askUserQuestion\)/,
    '活体事件应改名 liveAskUserQuestion，明示它只是**来源之一**',
  )
  assert.doesNotMatch(
    composerCode,
    STALE_FORM,
    'D198 回潮：不得再写「askUserQuestion 只取活体事件」——那样重开任务后提问必然丢失',
  )
  // AskUserGate 的渲染条件不变（仍以合并后的 askUserQuestion 为准）
  assert.match(composerCode, /if\s*\(task\s*&&\s*isPaused\s*&&\s*askUserQuestion\)/, '门禁渲染条件应保持')
})

test('TC-ASKP-004 ★ 检测器自检：旧写法能被抓到，新写法不被误伤', () => {
  const stale = 'const askUserQuestion = useStore((s) => s.askUserQuestion)'
  const fresh = 'const askUserQuestion = resolveAskUserQuestion(liveAskUserQuestion, task)'
  assert.match(stale, STALE_FORM, '检测器必须能抓到旧写法（否则本组是假绿）')
  assert.doesNotMatch(fresh, STALE_FORM, '检测器不得误伤新写法')
})

/* ============================================================
 * 4. TC-ASKP-004：消费者数量下限 —— 防再次被整段删除
 * ============================================================ */
test('TC-ASKP-005 ★ 渲染层必须存在 pendingAskUser 的消费者（防再次被删）', () => {
  const hits = [resolverCode, composerCode].filter((s) => /pendingAskUser/.test(s))
  assert.ok(
    hits.length >= 1,
    '渲染层至少要有一处读 pendingAskUser —— 否则引擎的暂停理由永远到不了用户眼前（D198）',
  )
})
