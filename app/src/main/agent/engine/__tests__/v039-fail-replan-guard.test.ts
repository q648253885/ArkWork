/**
 * v0.39.0 详测 — 失败重排（W2 / F7）与五条判据缺陷的接线契约
 *   TC-FAIL-001…005  ｜ TC-GUARD-001…011
 *
 * 依据：docs/versions/v0.39.0/04-system-design.md §5（W2）、§7（D178/D180/D182/D183/D184/D188）
 *       docs/versions/v0.39.0/testcases/00-cumulative-matrix.md
 *
 * 手法分工（纪律⑫）：
 *   · 纯函数（digest / policy / openItems）→ 穷举真值表，不看源码；
 *   · 接线（谁在什么位置调谁）→ 源码契约 + **剥注释**（`@shared/utils/source-guard` 唯一真源）；
 *   · 「放行分支带没带 leftovers」→ 真账本跑一遍（字符串断言测不出语义）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs v039-fail-replan-guard
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

const LOOP = read('../loop.ts')
const TURN_END = read('../turn-end.ts')
const ABORT = read('../abort.ts')
const RUNNER = read('../../runner.ts')
const LEDGER_GUARD = read('../ledger-guard.ts')
const OPS = read('../../ledger/ops.ts')
const WORK_CLASS = read('../work-class.ts')

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-v039-guard-'))
const db = await import('../../../store/db.js')
db.setWorkspaceDir(WORKSPACE)
const { resetTaskCollection, createTask } = await import('../../../store/tasks.js')
resetTaskCollection()

const { ensureLedger, loadLedger, mutate } = await import('../../ledger/index.js')
const { diffPlan } = await import('../../ledger/plan-diff.js')
const { openItems } = await import('../../ledger/project.js')
const { MAX_LEDGER_REFUSALS } = await import('../../ledger/types.js')
const { guardFinish, recordRefusal } = await import('../ledger-guard.js')
const { pushFailureDigest, renderFailureDigest } = await import('../../planning/digest.js')
const { shouldCommitRegexDraft, shouldRunPlanner, initPlannerState } = await import('../../planning/policy.js')
const { RETIRED_PLAN_TOOLS } = await import('../work-class.js')
const { PLANNER_FAILURE_THRESHOLD, MAX_REGEX_COMMITS_PER_RUN, PLANNER_COOLDOWN_MS } = await import(
  '../../planning/types.js'
)

/* ============================================================
 * TC-FAIL：失败摘要 → 阈值重排（W2 · F7）
 * ============================================================ */

test('TC-FAIL-001 同一 tool 的连续失败累加 attempts，而不是堆成 N 条', () => {
  let buf = pushFailureDigest([], { itemId: 'i1', tool: 'shell', message: 'exit 1', attempts: 1 })
  assert.equal(buf.length, 1)
  assert.equal(buf[0]!.attempts, 1)
  buf = pushFailureDigest(buf, { itemId: 'i1', tool: 'shell', message: 'exit 1 又', attempts: 1 })
  assert.equal(buf.length, 1, '★ 同一 tool 必须合并 —— 否则阈值永远数不到「连续失败」')
  assert.equal(buf[0]!.attempts, 2, '★ attempts 是模型判断「别原样重试」的唯一依据')
  assert.equal(buf[0]!.message, 'exit 1 又', 'message 取最新一次（旧报错无诊断价值）')
})

test('TC-FAIL-002 不同 tool 各自成条；同一 tool 换 item 也各自成条', () => {
  let buf = pushFailureDigest([], { itemId: 'i1', tool: 'shell', message: 'a', attempts: 1 })
  buf = pushFailureDigest(buf, { itemId: 'i1', tool: 'file-writer', message: 'b', attempts: 1 })
  assert.equal(buf.length, 2, '换工具就是换了一条路径，不该合并')
  buf = pushFailureDigest(buf, { itemId: 'i2', tool: 'shell', message: 'c', attempts: 1 })
  assert.equal(buf.length, 3, '★ 合并键是 itemId + tool —— 只按 tool 合并会把别的任务项吞掉')
})

test('TC-FAIL-003 摘要上限：只保留最近 N 条（防上下文被失败刷屏）', () => {
  let buf: ReturnType<typeof pushFailureDigest> = []
  for (let i = 0; i < 10; i++) {
    buf = pushFailureDigest(buf, { itemId: `i${i}`, tool: 'shell', message: `m${i}`, attempts: 1 }, 3)
  }
  assert.equal(buf.length, 3, '超上限截断')
  assert.deepEqual(
    buf.map((f) => f.itemId),
    ['i7', 'i8', 'i9'],
    '保留**最近**三条（旧失败已被后续失败取代，留着只会误导）',
  )
})

test('TC-FAIL-004 renderFailureDigest 三要素齐全 + 建议按错因命中 + 空数组不产出', () => {
  assert.equal(renderFailureDigest([]), '', '无失败 → 空串（不得产出空标题）')
  const d = renderFailureDigest([
    { itemId: 'li_1', tool: 'shell', message: 'command failed with exit code 127', attempts: 2 },
    { itemId: 'li_2', tool: 'file-reader', message: '超时：读取 30s 未返回', attempts: 1 },
  ])
  assert.match(d, /li_1 shell 失败 2 次/, '★ 三要素：哪一项 + 哪个工具 + 失败几次')
  assert.match(d, /exit code 127/, '必须带原始报错片段（否则建议只能靠猜）')
  assert.match(d, /先读完整报错定位第一行根因/, 'exit code → 命中「别盲目重跑」建议')
  assert.match(d, /考虑把这一步拆小/, '超时 → 命中「粒度太粗」建议')
  assert.equal((d.match(/建议：/g) ?? []).length, 2, '每条失败都要有建议 —— 没有建议 = 鼓励原样重试')
})

test('TC-FAIL-005 ★ 接线：采集点清空 + 阈值块位置 + 触发后清空 + failure 豁免冷却', () => {
  // ① 工具**成功**即清掉同 tool 记录（只有连续失败才值得换回合）
  assert.match(
    LOOP,
    /failureDigest = failureDigest\.filter\(\(f\) => f\.tool !== a\.tool\)/,
    '★ 成功不清零 → "连续失败"会退化成"累计失败"，一次偶然失败加两次别的失败就触发重排',
  )
  // ② 阈值块必须在 per-action 循环**之后**（否则同轮多动作只看到第一条）
  const iLoopEnd = LOOP.indexOf('lastObservationSummary = observationSummary')
  const iThreshold = LOOP.indexOf('failureDigest.some((f) => f.attempts >= PLANNER_FAILURE_THRESHOLD)')
  assert.ok(iLoopEnd > 0 && iThreshold > iLoopEnd, '阈值判定必须在整组 act 收集完之后')
  // ③ 阈值块必须在 observation 事件之前（先改清单、再让模型看 observation）
  const iObs = LOOP.indexOf("type: 'observation'")
  assert.ok(iObs > iThreshold, '重排要在 observation 之前落地，模型下一轮直接看到新清单')
  // ④ 触发后清空 —— 否则同一批失败会在后续每一轮反复触发
  assert.match(LOOP, /const digest = failureDigest\n\s*failureDigest = \[\]/, '★ 触发即清空（自限条件①）')
  // ⑤ 必须走 trigger='failure' 通道（豁免冷却）
  assert.match(LOOP, /trigger: 'failure'/, '失败重排必须用 failure trigger')
  assert.equal(
    shouldRunPlanner({
      state: { ...initPlannerState(), lastAt: { failure: Date.now() - 1 } },
      trigger: 'failure',
      now: Date.now(),
      fingerprint: 'x',
    }).run,
    true,
    '★ failure 不受冷却约束（刚失败的那一刻最需要重新想，等 15 秒等于拖死任务）',
  )
  assert.equal(
    shouldRunPlanner({
      state: { ...initPlannerState(), lastAt: { 'new-instruction': Date.now() } },
      trigger: 'new-instruction',
      now: Date.now(),
      fingerprint: 'x',
    }).run,
    false,
    '对照：非 failure 通道仍在冷却窗口内被拦',
  )
  assert.ok(PLANNER_COOLDOWN_MS > 0 && PLANNER_FAILURE_THRESHOLD >= 2, '阈值常量同源且有意义')
})

/* ============================================================
 * TC-GUARD：五条判据缺陷 + 层级唯一执法点
 * ============================================================ */

test('TC-GUARD-001 D178 放行分支也携带 leftovers（否则调用方无从判断要不要收口）', () => {
  assert.match(
    LEDGER_GUARD,
    /\{ allow: true; reason: GuardAllowReason; leftovers: LedgerItem\[\] \}/,
    '★ 放行分支必须带 leftovers —— 此前只有拒绝分支带，超限放行后 loop 看不见清单状态',
  )
  assert.match(LEDGER_GUARD, /return \{ allow: true, reason: 'readonly', leftovers: openItems\(ledger\) \}/)
  // 两个消费点都必须真的用上它
  for (const [name, src] of [
    ['loop.ts', LOOP],
    ['turn-end.ts', TURN_END],
  ] as const) {
    assert.match(
      src,
      /verdict\.leftovers\.length > 0[\s\S]{0,200}?forceCloseOpenItems\(/,
      `★ ${name} 必须在放行且 leftovers>0 时收口 —— 带上了字段却不消费 = D78/D79 同型`,
    )
  }
})

test('TC-GUARD-002 D178 行为：UNFINISHED 拒绝带 leftovers；超限放行同样带', async () => {
  const t = await createTask({ title: 'g', text: 'g', agentId: 'default', modelId: 'm1' })
  await ensureLedger(t as never, { seedFromPlanItems: false })
  const l0 = (await loadLedger(t.id))!
  const { layout } = diffPlan({
    current: l0.items,
    draft: [
      { text: '在途一', status: 'doing' },
      { text: '在途二', status: 'todo' },
    ] as never,
  })
  await mutate(t.id, { kind: 'plan-commit', layout, reason: 't', source: 'task-plan' }, { actor: 't' })

  const r1 = await guardFinish({ taskId: t.id, iteration: 1, workClass: 'mutating', touchedTree: true })
  assert.equal(r1.allow, false)
  assert.equal(r1.allow === false ? r1.code : '', 'UNFINISHED')
  assert.equal(r1.leftovers.length, 2, '★ 拒绝时必须点名在途项')

  // 烧满拒绝上限 → 有界放行，且**仍然**带着在途项（供收口）
  for (let i = 0; i < MAX_LEDGER_REFUSALS; i++) {
    assert.equal(await recordRefusal(t.id), true, '拒绝计数必须写成功（D180 的返回值就是为这里准备的）')
  }
  const r2 = await guardFinish({ taskId: t.id, iteration: 2, workClass: 'mutating', touchedTree: true })
  assert.equal(r2.allow, true, '到上限必须放行（fail-closed 才是真缺陷）')
  assert.equal(r2.allow === true ? r2.reason : '', 'over-limit')
  assert.equal(r2.leftovers.length, 2, '★ 放行分支的 leftovers 就是"收口清单"，缺了它就永远收不了口')
})

test('TC-GUARD-003 D180 recordRefusal 返回写入结果，不得吞掉失败', () => {
  assert.match(
    LEDGER_GUARD,
    /export async function recordRefusal\(taskId: string\): Promise<boolean>/,
    '★ 必须把成功与否交给调用方 —— 此前 `.catch(() => {})` 让计数永远停在旧值',
  )
  // 两个失败出口都必须返回 false（catch 与 res.ok===false）
  const body = LEDGER_GUARD.slice(LEDGER_GUARD.indexOf('export async function recordRefusal'))
  assert.match(body, /return false[\s\S]{0,120}?return true/, '失败路径返回 false、成功返回 true')
  assert.doesNotMatch(body.slice(0, body.indexOf('return true')), /catch \(.*\) \{\s*\}/, '不得有空 catch')
})

test('TC-GUARD-004 D180 有界放行：连续写失败达上限 → 封账本完成（不再无限拒绝）', () => {
  assert.match(LOOP, /const MAX_REFUSAL_WRITE_FAILURES = 2/, '上限必须是有名常量（可测、可解释）')
  assert.match(LOOP, /const wrote = await recordRefusal\(task\.id\)/, '★ 必须消费返回值')
  const iBump = LOOP.indexOf('refusalWriteFailures += 1')
  const iGuard = LOOP.indexOf('refusalWriteFailures >= MAX_REFUSAL_WRITE_FAILURES')
  const iSeal = LOOP.indexOf("sealLedger(task.id, 'completed', '任务完成（门禁计数异常，有界放行）')")
  assert.ok(iBump > 0 && iGuard > iBump && iSeal > iGuard, '递增 → 判上限 → 封账本，顺序不可倒')
  assert.match(LOOP, /refusalWriteFailures = 0/, '写成功必须清零（计的是「连续」失败）')
})

test('TC-GUARD-005 D182 shouldCommitRegexDraft 真值表（对话级 / 伪调用 / 停滞 / 每 run 上限）', () => {
  const c = (o: Partial<Parameters<typeof shouldCommitRegexDraft>[0]>) =>
    shouldCommitRegexDraft({ chatMode: false, pseudoHit: false, noToolStallHit: false, regexCommits: 0, ...o })
  assert.equal(c({}), true, '四条全过 → 允许解析（这是唯一能救弱模型的一条路）')
  assert.equal(c({ chatMode: true }), false, '★ 对话级任务：解释性答复里的「1… 2…」不是清单')
  assert.equal(c({ pseudoHit: true }), false, '★ 伪调用要先按伪调用处置，不许被解析救场（D179 根因）')
  assert.equal(c({ noToolStallHit: true }), false, '★ 停滞已达阈值 → 让有界暂停先生效')
  assert.equal(c({ regexCommits: MAX_REGEX_COMMITS_PER_RUN }), false, '每 run 上限')
  assert.equal(c({ regexCommits: MAX_REGEX_COMMITS_PER_RUN - 1 }), true, '上限之下一律放行')
})

test('TC-GUARD-006 D182 顺序：解析回退排在伪调用与纯答复停滞**之后**', () => {
  const iPseudo = LOOP.indexOf('if (consecutivePseudoNoTool >= PSEUDO_CALL_STOP_ROUNDS)')
  const iStall = LOOP.indexOf('if (consecutiveNoToolFinal >= NO_TOOL_STOP_ROUNDS)')
  const iRegex = LOOP.indexOf('shouldCommitRegexDraft({')
  assert.ok(iPseudo > 0 && iStall > iPseudo && iRegex > iStall, '★ 顺序：伪调用 → 纯答复停滞 →（最后）文本解析')
  // 代为落库后必须**仍然**计入无工具轮次（此前 continue 跳过了递增 = 无限通行证）
  const tail = LOOP.slice(iRegex, iRegex + 3000)
  assert.match(
    tail,
    /regexCommits \+= 1[\s\S]{0,1200}?consecutiveNoToolFinal \+= 1/,
    '★ 解析成功也不能白送一轮 —— 否则措辞每次微变就能一路烧到 maxIterations',
  )
})

test('TC-GUARD-007 D183 第二套守卫已删除（收口唯一路径是 guardFinish 放行 + forceCloseOpenItems）', () => {
  for (const dead of ['MAX_COMPLETE_REFUSALS', 'refuseCompletionForLeftovers', 'completeRefusals']) {
    assert.doesNotMatch(TURN_END, new RegExp(`\\b${dead}\\b`), `★ ${dead} 必须已删除（两套守卫 = 单 run 稳定产出 3 次无法解释的拒绝）`)
  }
  assert.match(TURN_END, /import \{ guardFinish, recordRefusal, forceCloseOpenItems \} from '\.\/ledger-guard\.js'/)
  // guardFinish 放行 → 收口；拒绝 → 不改写清单
  const iGuard = TURN_END.indexOf('await guardFinish(')
  const iClose = TURN_END.indexOf('await forceCloseOpenItems(')
  assert.ok(iGuard > 0 && iClose > iGuard, '收口必须发生在门禁放行之后')
})

test('TC-GUARD-008 D184 五条终态路径全部封账本（含 failed / cancelled / 孤儿）', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['loop 运行失败', LOOP, /sealLedger\(task\.id, 'failed'/],
    ['runner run 异常终止', RUNNER, /sealLedger\(taskId, 'failed'/],
    ['runner 取消', RUNNER, /sealLedger\(taskId, 'cancelled'/],
    ['runner 孤儿修正', RUNNER, /sealLedger\(task\.id, 'failed', '进程异常退出/],
    ['abort 用户中止', ABORT, /sealLedger\([\s\S]{0,60}?'cancelled'/],
    ['turn-end 完成', TURN_END, /sealLedger\(task\.id, 'completed'/],
  ]
  for (const [name, src, re] of cases) {
    assert.match(src, re, `★ ${name} 路径必须封账本 —— 漏一条就是"任务结束了、清单还挂着"`)
  }
})

test('TC-GUARD-009 ★ D188 引擎判定路径不得依赖退役工具名（判据恒假的假守卫）', () => {
  // 事实源：work-class.RETIRED_PLAN_TOOLS（唯一一份下架名清单）
  assert.ok(RETIRED_PLAN_TOOLS.includes('submit_plan'), '夹具前提：submit_plan 确在退役表内')
  for (const [name, src] of [
    ['loop.ts', LOOP],
    ['turn-end.ts', TURN_END],
    ['abort.ts', ABORT],
    ['ledger-guard.ts', LEDGER_GUARD],
  ] as const) {
    for (const t of RETIRED_PLAN_TOOLS) {
      assert.doesNotMatch(
        src,
        new RegExp(`['"\`]${t.replace(/-/g, '\\-')}['"\`]`),
        `★ ${name} 里出现退役工具名字面量「${t}」：判据永远不成立（模型拿不到该名字），` +
          `读代码的人却以为守卫在工作 —— 请改读活状态或剥离该判定`,
      )
    }
  }
  // 反向：正例必须仍存在（避免"把整个判定一起删掉"也算通过）
  assert.match(LOOP, /isPlanWriteTool\(/, '写树判定仍走唯一守卫')
})

test('TC-GUARD-010 D188 shouldCommitRegexDraft 的守卫参数必须是推导值，不是字面量', () => {
  assert.doesNotMatch(
    LOOP,
    /pseudoHit:\s*false/,
    '★ 字面量 false = 假守卫：顺序一被改动，条件不会自己成立，而是静默继续放行',
  )
  assert.doesNotMatch(LOOP, /noToolStallHit:\s*false/, '同上')
  assert.match(LOOP, /pseudoHit:\s*pseudoTool !== null/, '必须是推导值')
  assert.match(
    LOOP,
    /noToolStallHit:\s*consecutiveNoToolFinal >= NO_TOOL_STOP_ROUNDS/,
    '必须是推导值，且与早退用**同一个**阈值常量（两处各写一个数必然漂移）',
  )
})

test('TC-GUARD-011 层级上限：唯一执法点在 ops.ts，且与 PLAN_PARENT_HINT 同源', () => {
  // 判据只许出现一处（plan-diff 只解析引用，不判层级）
  const PLAN_DIFF = read('../../ledger/plan-diff.ts')
  assert.doesNotMatch(PLAN_DIFF, /层级最多两层/, '★ plan-diff 不得自己判层级（draft 期父项 parentId 未落定，判不准）')
  assert.match(OPS, /任务层级最多两层/, '执法点在 ops.ts plan-commit')
  assert.match(OPS, /PLAN_PARENT_HINT/, '拒绝理由必须引用提示常量（不得两处各写一份文案）')
  // 判据必须在**所有** parentId 落定之后 —— 顺序敏感 = 概率性漏洞
  const iResolve = OPS.indexOf('finalParent.set(child.id, parentId)')
  const iDepth = OPS.indexOf('const grandparent = finalParent.get(parent.id)')
  const iApply = OPS.indexOf('child.parentId = parentId\n        child.updatedAt = now')
  assert.ok(iResolve > 0 && iDepth > iResolve && iApply > iDepth, '★ 解析 → 判层级 → 落盘，三步不可合并')
  assert.match(
    OPS,
    /const grandparent = finalParent\.get\(parent\.id\) \?\? parent\.parentId \?\? null/,
    '★ 终态父关系 = 本次新挂的 ∪ 既有的；只看既有值会漏「同批内新建的链」',
  )
  assert.match(WORK_CLASS, /export const RETIRED_PLAN_TOOLS/, '退役表仍在唯一事实源里')
  // openItems 是在途项的唯一定义（放行分支收口靠它）
  const l = { items: [{ status: 'pending' }, { status: 'running' }, { status: 'done' }, { status: 'cancelled' }] }
  assert.equal(openItems(l as never).length, 2, '★ 在途 = pending/running（终态不算），收口范围靠它界定')
})
