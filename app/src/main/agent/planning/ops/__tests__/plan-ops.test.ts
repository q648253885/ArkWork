/* ============================================================
 * v0.40.0 · 清单操作通道（PlanOps）用例
 * 设计文档：docs/versions/v0.40.0/04-system-design.md
 * 缺陷：D199（默认通道会空）/ D200（清单夹缝）/ D201（空回合停摆）/ D202（必须调用 task_plan）
 *
 * 载体原则（纪律⑫）：**真执行** —— `runPlanOps` 经注入点 `completeFn` 跑完
 * 一次完整调用（构建 prompt → 解析 → 返回），不靠 grep 源码假装验证。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  PLAN_OPS_KINDS,
  isPlanOpsKind,
  MAX_PLAN_OPS_PER_RUN,
  PLAN_OPS_MIN_ROUND_GAP,
  PLAN_OPS_STALE_ROUNDS,
  PLAN_OPS_FAILURE_THRESHOLD,
  type PlanOpsKind,
} from '../types.js'
import {
  initPlanOpsState,
  shouldRunPlanOps,
  notePlanOpsRun,
  pickPlanOpsKind,
  keepOnlyPreviouslyDone,
} from '../policy.js'
import { runPlanOps, type PlanOpsLlmInput, type PlanOpsLlmOutput } from '../runner.js'
import { buildPlanOpsSystem, renderPlanOpsUserMessage, PLANOPS_OUTPUT_CONTRACT } from '../prompt.js'
import { parsePlannerOutput } from '../../parse.js'

const HERE = dirname(fileURLToPath(import.meta.url))      // .../src/main/agent/planning/ops/__tests__
const AGENT = join(HERE, '..', '..', '..')                // src/main/agent
const MAIN = join(AGENT, '..')                            // src/main
const REPO = join(MAIN, '..', '..')                       // app

function src(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

const SIGNAL_BASE = {
  failedCount: 0,
  staleRounds: 0,
  justSucceeded: false,
  hadProse: false,
  cancelRequested: false,
  emptyRound: false,
}

/* ============================================================
 * 一、五类操作的唯一事实源（TC-OPS-001 / 002）
 * ============================================================ */

test('TC-OPS-001 PLAN_OPS_KINDS 是唯一事实源：5 类，守卫与之一致', () => {
  assert.deepEqual([...PLAN_OPS_KINDS], ['create', 'update', 'complete', 'cancel', 'replan'])
  for (const k of PLAN_OPS_KINDS) assert.equal(isPlanOpsKind(k), true)
  // 守卫必须拒绝：大小写变形 / 未登记词 / 非字符串
  for (const bad of ['Create', 'UPDATE', 'replan2', 'task_plan', '', 'done', null, undefined, 0, {}]) {
    assert.equal(isPlanOpsKind(bad), false, `守卫应拒绝 ${String(bad)}`)
  }
})

test('TC-OPS-002 pickPlanOpsKind 真值表：优先级先命中先返回', () => {
  const p = (o: Partial<Parameters<typeof pickPlanOpsKind>[0]>) =>
    pickPlanOpsKind({ round: 1, hasPlan: true, ...SIGNAL_BASE, ...o })

  // 取消 > 无清单 > 连续失败 > 陈旧 > 空回合 > 有进展
  assert.equal(p({ cancelRequested: true }), 'cancel')
  assert.equal(p({ cancelRequested: true, hasPlan: false }), 'cancel')
  assert.equal(p({ hasPlan: false }), 'create')
  assert.equal(p({ failedCount: PLAN_OPS_FAILURE_THRESHOLD }), 'replan')
  assert.equal(p({ failedCount: PLAN_OPS_FAILURE_THRESHOLD - 1 }), null, '未达阈值不该重排')
  assert.equal(p({ staleRounds: PLAN_OPS_STALE_ROUNDS }), 'replan')
  assert.equal(p({ staleRounds: PLAN_OPS_STALE_ROUNDS - 1 }), null)
  assert.equal(p({ emptyRound: true }), 'update', '空回合必须兜底推进（D201）')
  // 有实质进展（工具执行成功）：偶数轮确认完成、奇数轮同步
  assert.equal(p({ justSucceeded: true, round: 2 }), 'complete')
  assert.equal(p({ justSucceeded: true, round: 3 }), 'update')
  // -------------------------------------------------------------------------
  // v0.40.0（真机修正）：**只有正文**（弱模型常态）→ 一律 update，**不走 complete**。
  //
  // 真机反例（`T-20260928-4t5z6k` + 本地 0.8b）：8b/0.8b 从不发起工具调用，
  // 于是 `justSucceeded` 恒 false、`emptyRound` 也 false（它有正文）→ 本函数
  // 恒返回 null → `plan-ops` 日志**零命中**，清单停在初始 4 项直到 6 轮暂停。
  // 而「模型在用正文干活」正是其他 agent 能正常交互的原因（Cline 范式）。
  // -------------------------------------------------------------------------
  assert.equal(p({ hadProse: true }), 'update', '只有正文也必须推进清单（否则弱模型永不触发）')
  assert.equal(p({ hadProse: true, round: 2 }), 'update', '没有可核对产物时不走 complete')
  assert.equal(p({ hadProse: true, round: 9 }), 'update')
  // 工具成功优先于只有正文
  assert.equal(p({ hadProse: true, justSucceeded: true, round: 2 }), 'complete')
  // 无进展、无信号 → 不调用（不空烧）
  assert.equal(p({}), null)
  assert.equal(p({ justSucceeded: false, hadProse: false, emptyRound: false }), null)
})

/* ============================================================
 * 二、预算与冷却（TC-OPS-003 / 004）
 * ============================================================ */

test('TC-OPS-003 shouldRunPlanOps 真值表：预算优先于一切豁免', () => {
  const g = (o: Partial<Parameters<typeof shouldRunPlanOps>[0]>) =>
    shouldRunPlanOps({ state: initPlanOpsState(), kind: 'update', round: 10, fingerprint: 'A', ...o })

  assert.equal(g({}).run, true)
  // 预算：优先于 force（O7 的 force 只豁免轮间隔，**不豁免预算**）
  assert.equal(
    g({ state: { passes: MAX_PLAN_OPS_PER_RUN, lastRound: {}, lastFingerprint: 'A' }, force: true }).reason,
    'budget',
    '预算耗尽后 force 也必须被拦 —— 否则空回合会变成无限调用',
  )
  // 轮间隔
  assert.equal(
    g({ state: { passes: 1, lastRound: { update: 10 }, lastFingerprint: 'X' }, round: 11 }).reason,
    'cooldown',
  )
  assert.equal(
    g({ state: { passes: 1, lastRound: { update: 10 }, lastFingerprint: 'X' }, round: 10 + PLAN_OPS_MIN_ROUND_GAP }).run,
    true,
  )
  // force 豁免轮间隔（create / cancel / 空回合）
  assert.equal(
    g({ state: { passes: 1, lastRound: { update: 10 }, lastFingerprint: 'X' }, round: 11, force: true }).run,
    true,
  )
  // 幂等只对 update 生效
  assert.equal(g({ state: { passes: 1, lastRound: {}, lastFingerprint: 'A' }, fingerprint: 'A' }).reason, 'duplicate')
  assert.equal(
    g({ kind: 'complete', state: { passes: 1, lastRound: {}, lastFingerprint: 'A' }, fingerprint: 'A' }).run,
    true,
    'complete 要的是判定，不是新文本 —— 不受幂等限制',
  )
  assert.equal(
    g({ kind: 'replan', state: { passes: 1, lastRound: {}, lastFingerprint: 'A' }, fingerprint: 'A' }).run,
    true,
  )
})

test('TC-OPS-004 notePlanOpsRun 推进状态且为纯函数（不改入参）', () => {
  const s0 = initPlanOpsState()
  assert.deepEqual(s0, { passes: 0, lastRound: {}, lastFingerprint: undefined })
  const s1 = notePlanOpsRun(s0, 'update', 5, 'A')
  assert.equal(s1.passes, 1)
  assert.equal(s1.lastRound.update, 5)
  assert.equal(s1.lastFingerprint, 'A')
  // 纯函数：入参未被就地修改
  assert.equal(s0.passes, 0)
  assert.deepEqual(s0.lastRound, {})
})

/* ============================================================
 * 三、提示词契约（TC-OPS-005 / 006）
 * ============================================================ */

test('TC-OPS-005 五类 prompt 各自可构建，且都含**同一份**输出契约（I-O7）', () => {
  const kinds: PlanOpsKind[] = [...PLAN_OPS_KINDS]
  for (const kind of kinds) {
    const sys = buildPlanOpsSystem({
      kind,
      taskId: 'T-1',
      goal: '写一个 CSV 折线图脚本',
      snapshot: '  1. [todo] 读取 CSV',
      event: '已读取 data.csv（3 列）',
    })
    assert.ok(sys.includes(PLANOPS_OUTPUT_CONTRACT), `${kind} 必须含共享输出契约`)
    assert.ok(sys.includes('清单维护器'), `${kind} 必须声明角色`)
    assert.ok(sys.length > 200, `${kind} 的 system 不应过短`)
  }
  // 不同 kind 的正文必须真的不同（否则等于只有一套 prompt）
  const sysOf = (kind: PlanOpsKind) =>
    buildPlanOpsSystem({ kind, taskId: 'T-1', goal: 'g', snapshot: 's', event: 'e' })
  const uniq = new Set(kinds.map(sysOf))
  assert.equal(uniq.size, kinds.length, '五类操作的 system 必须两两不同')
  // 用户消息只给项数约束，不含对话历史
  assert.ok(renderPlanOpsUserMessage({ kind: 'update', taskId: 'T', goal: 'g', snapshot: 's', event: 'e' }).includes('12'))
})

test('TC-OPS-006 清单操作 prompt **不提任何工具名**（约束②）', () => {
  // 这是 v0.39.0 的三条设计约束之一：这是一次没有工具的调用，
  // 提工具名等于诱导弱模型写伪调用（D160 的病根）。
  const sys = buildPlanOpsSystem({ kind: 'update', taskId: 'T', goal: 'g', snapshot: 's', event: 'e' })
  for (const name of ['task_plan', 'turn_note', 'file-reader', 'shell', 'task_complete', 'ask_user']) {
    assert.equal(sys.includes(name), false, `prompt 不该出现工具名 ${name}`)
  }
})

/* ============================================================
 * 四、执行器：真执行（TC-OPS-007 ~ 013）
 * ============================================================ */

function okOut(text: string): (i: PlanOpsLlmInput) => Promise<PlanOpsLlmOutput> {
  return async () => ({ content: text, thought: null })
}

const REQ = { taskId: 'T-1', goal: '写一个 CSV 折线图脚本', snapshot: '  1. [todo] 读取 CSV', event: '已读取 data.csv' }

test('TC-OPS-007 runPlanOps：标准 JSON 形态（注入点真执行）', async () => {
  const res = await runPlanOps({
    req: { ...REQ, kind: 'create' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: okOut('[{"text":"读取 CSV","status":"todo"},{"text":"画折线图","status":"todo"}]'),
  })
  assert.equal(res.ok, true)
  assert.equal(res.draft.length, 2)
  assert.equal(res.via, 'json-strict')
  assert.equal(res.kind, 'create')
})

test('TC-OPS-008 runPlanOps：勾选清单形态（弱模型最常输出，evidence/04 §3.1 用例 B）', async () => {
  const res = await runPlanOps({
    req: { ...REQ, kind: 'update' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: okOut('- [x] 读取 CSV\n- [ ] 画折线图\n- [ ] 保存图片'),
  })
  assert.equal(res.ok, true)
  assert.equal(res.draft.length, 3)
  assert.equal(res.via, 'checklist')
})

test('TC-OPS-009 runPlanOps：编号列表形态（提纲，需计划类标题）', async () => {
  // outline 是全解析器最脆的一层，刻意要求「计划类标题 + ≥2 条」防误伤散文；
  // 用例必须如实带上标题，否则等于在测一个不存在的行为。
  const res = await runPlanOps({
    req: { ...REQ, kind: 'replan' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: okOut('任务清单：\n1. 读取 CSV（已完成）\n2. 画折线图（进行中）'),
  })
  assert.equal(res.ok, true)
  assert.equal(res.draft.length, 2)
  assert.equal(res.via, 'outline')
})

test('TC-OPS-010 runPlanOps：两次都不可解析 → skipped=unparsable 且 attempts=2（C5/C7）', async () => {
  const res = await runPlanOps({
    req: { ...REQ, kind: 'update' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: okOut('我想了一下，这个任务比较复杂，需要分步骤来做。'),
  })
  assert.equal(res.ok, false)
  assert.equal(res.skipped, 'unparsable', '不可解析不得借用 aborted（D195 教训）')
  assert.equal(res.attempts, 2)
  assert.equal(res.draft.length, 0)
})

test('TC-OPS-011 runPlanOps：update/complete 放行 done，create/replan 降级（allowDone 语义）', async () => {
  const json = '[{"text":"读取 CSV","status":"done"},{"text":"画折线图","status":"todo"}]'
  const run = (kind: PlanOpsKind) =>
    runPlanOps({ req: { ...REQ, kind }, modelId: 'm', signal: new AbortController().signal, completeFn: okOut(json) })

  // update 要求「输出完整清单并保留已完成项」—— 不放行会让已完成项回退成 todo（清单倒退）
  const up = await run('update')
  assert.equal(up.draft[0]?.status, 'done', 'update 必须放行 done')
  const cp = await run('complete')
  assert.equal(cp.draft[0]?.status, 'done', 'complete 必须放行 done')
  // create 是「工作还没开始」；replan 的新 done 必须由执行事实产生
  const cr = await run('create')
  assert.equal(cr.draft[0]?.status, 'todo', 'create 不放行 done')
  const rp = await run('replan')
  assert.equal(rp.draft[0]?.status, 'todo', 'replan 不放行 done')
  const cn = await run('cancel')
  assert.equal(cn.draft[0]?.status, 'todo', 'cancel 不放行 done')
})

test('TC-OPS-012 runPlanOps：用户中止**原样抛出**（C6）', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(
    () =>
      runPlanOps({
        req: { ...REQ, kind: 'update' },
        modelId: 'm',
        signal: ctrl.signal,
        completeFn: okOut('[]'),
      }),
    /aborted/,
    '吞掉中止会让「停止」按钮失灵',
  )
})

test('TC-OPS-013 runPlanOps：调用失败 → ok:false 且**不抛**（C3）', async () => {
  const res = await runPlanOps({
    req: { ...REQ, kind: 'update' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: async () => {
      throw new Error('Ollama /api/chat HTTP 500: {"error":"EOF"}')
    },
  })
  assert.equal(res.ok, false)
  assert.equal(res.skipped, 'aborted')
  assert.ok(res.summary.includes('EOF'), '失败原因必须进 summary（纪律⑨：容错路径留人话）')
})

test('TC-OPS-014 runPlanOps：思考型模型把答案放进 thought 也要能解析（C4）', async () => {
  const res = await runPlanOps({
    req: { ...REQ, kind: 'update' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: async () => ({ content: '', thought: '- [ ] 读取 CSV\n- [ ] 画折线图' }),
  })
  assert.equal(res.ok, true)
  assert.equal(res.draft.length, 2)
})

/* ============================================================
 * 五、解析器的 allowDone 放行：默认零变化（TC-OPS-015）
 * ============================================================ */

test('TC-OPS-015 parsePlannerOutput 的 allowDone 默认 false（既有两条路径行为零变化）', () => {
  const raw = '[{"text":"读取 CSV","status":"done"},{"text":"画折线图","status":"todo"}]'
  const d = parsePlannerOutput(raw)
  assert.ok(d)
  assert.equal(d!.draft[0]?.status, 'todo', '默认必须降级（D181 不变量不变）')

  const a = parsePlannerOutput(raw, { allowDone: true })
  assert.ok(a)
  assert.equal(a!.draft[0]?.status, 'done', 'allowDone=true 时放行')
  // 显式 false 与缺省同义
  const f = parsePlannerOutput(raw, { allowDone: false })
  assert.equal(f!.draft[0]?.status, 'todo')
})

/* ============================================================
 * 六、接线契约（TC-OPS-018 ~ 022）
 *
 * 注：通道修复（D199）的两条用例 TC-OPS-016 / TC-OPS-017 放在
 * `src/main/llm/__tests__/ollama-native.test.ts` —— 那里已静态引入
 * `openai.ts`（electron 桩覆盖得到）；本文件用动态绝对路径 import 会绕过桩。
 * ============================================================ */

test('TC-OPS-018 loop.ts 接线：轮首 tick + 空回合 tick 两处调用点都存在', () => {
  const loop = src('src/main/agent/engine/loop.ts')
  const hits = loop.match(/await planOpsTick\(/g) ?? []
  assert.ok(hits.length >= 2, `planOpsTick 调用点应 ≥2，实测 ${hits.length}`)
  assert.ok(loop.includes("import { planOpsTick } from './plan-ops-tick.js'"), '应有 import')
  assert.ok(loop.includes('let planOpsState = initPlanOpsState()'), 'run 级预算状态应在循环外声明')
})

test('TC-OPS-019 空回合块里 planOpsTick 必须排在 pauseForEmptyResponses **之前**（O7）', () => {
  const loop = src('src/main/agent/engine/loop.ts')
  const iTick = loop.indexOf('emptyRound: true')
  const iPause = loop.indexOf('await pauseForEmptyResponses(')
  assert.ok(iTick > 0, '应有 emptyRound: true 的调用')
  assert.ok(iPause > 0, '应有 pauseForEmptyResponses 调用')
  assert.ok(iTick < iPause, '先给清单一次机会，再决定暂停（顺序反了等于没接）')
  // 且「清单动了就继续」必须是 continue，而不是照样暂停
  const between = loop.slice(iTick, iPause)
  assert.ok(between.includes('if (advancedByOps) continue'), '清单动了必须继续跑')
})

test('TC-OPS-020 模型可见文案不得再要求「必须通过 task_plan」（D202，反回潮）', () => {
  const sections = src('src/main/agent/prompt/sections.ts')
  assert.equal(
    sections.includes('必须通过 task_plan'),
    false,
    '「必须通过 task_plan」是 D202 的病灶：弱模型做不到 → 空转/伪调用/空响应',
  )
  // 新文案必须把「不调用也不会停滞」讲明白（否则模型会以为不做就错了）
  assert.ok(sections.includes('不调用也不会停滞'), '应明确告知引擎会独立维护清单')
})

test('TC-OPS-021 task_plan 工具描述应声明「不调用也不会停滞」', () => {
  const seed = src('src/main/store/seed.ts')
  const i = seed.indexOf("name: 'task_plan'")
  assert.ok(i > 0, 'task_plan 应仍注册（S1：保留为强模型的快路径）')
  const block = seed.slice(i, i + 1400)
  assert.ok(block.includes('不会让任务停滞'), 'task_plan 描述应说明它是可选快路径')
})

test('TC-OPS-022 清单操作通道**不带工具**：runner 源码不含工具定义注入（C1）', () => {
  const runner = src('src/main/agent/planning/ops/runner.ts')
  const i = runner.indexOf('adapter.complete(')
  assert.ok(i > 0)
  const block = runner.slice(i, i + 500)
  assert.ok(block.includes('tools: undefined'), 'C1：清单回合必须不带工具')
})

/* ============================================================
 * 八、检测器自检（TC-OPS-023）
 * ============================================================ */

test('TC-OPS-024 ★ 真机修正：hadProse 采集点必须在无工具分支**之前**', () => {
  // 真机实测（打包 0.40.0 + 本地 0.8b，任务 T-20260928-4t5z6k）：清单停在初始 4 项、
  // 6 轮后暂停、`plan-ops` 日志零命中。根因是**信号采集点位置**：原实现放在 Act 之后，
  // 而弱模型的每一轮都走无工具分支（十几处 `continue`）→ 永远采不到信号。
  const loop = src('src/main/agent/engine/loop.ts')
  const iReason = loop.indexOf('const { response, emptyExhausted } = await runReasonPhase(')
  const iCollect = loop.indexOf('planOpsHadProse = Boolean(')
  const iNoTool = loop.indexOf('if (!action && pendingActions.length === 0) {')
  assert.ok(iReason > 0 && iCollect > 0 && iNoTool > 0, '三处锚点都应存在')
  assert.ok(iReason < iCollect, '采集点必须在 Reason 之后（要用本轮的 response）')
  assert.ok(
    iCollect < iNoTool,
    '采集点必须在无工具分支**之前** —— 放后面会被十几处 continue 跳过（真机病态的根因）',
  )
  const forwarded = loop.match(/hadProse: planOpsHadProse/g) ?? []
  assert.ok(forwarded.length >= 2, `两处 tick 调用都要传 hadProse，实测 ${forwarded.length}`)
})

test('TC-OPS-025 ★ 真机形态：同一段 JSON 数组被模型说两遍也要能解析（D205）', async () => {
  // 实测原文（打包 0.40.0 + qwen3.5:0.8b，任务 T-20260928-1b2p4e，attempt 1/2）：
  //   [{"text":"读取 CSV","status":"done"},…]⏎[{"text":"读取 CSV","status":"done"},…]
  // 原 parseJsonRepair 取 lastIndexOf(']') → 切出「两段拼接」→ 永远非法 JSON → 整层失效。
  const one = '[{"text":"读取 CSV","status":"done"},{"text":"画折线图","status":"todo"}]'
  const res = await runPlanOps({
    req: { ...REQ, kind: 'update' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: okOut(one + '\n' + one),
  })
  assert.equal(res.ok, true, '两段拼接不该让整层静默失效')
  assert.equal(res.via, 'json-repair')
  assert.equal(res.draft.length, 2)
  assert.equal(res.draft[0]?.status, 'done', 'update 放行 done')
})

test('TC-OPS-026 ★ 真机形态：`[status] 文本` 逐行清单也要能解析（D205）', async () => {
  // 实测原文（同一任务，attempt 2/2）：
  //   [running] 读取 CSV 文件并解析数据⏎[pending] 处理列结构并提取数值字段⏎…
  const raw = '[running] 读取 CSV 文件并解析数据\n[pending] 处理列结构并提取数值字段\n[todo] 绘制折线图的 Python 代码'
  const res = await runPlanOps({
    req: { ...REQ, kind: 'update' },
    modelId: 'm',
    signal: new AbortController().signal,
    completeFn: okOut(raw),
  })
  assert.equal(res.ok, true, '[status] 形态是真机实测输出，必须收')
  assert.equal(res.via, 'checklist')
  assert.equal(res.draft.length, 3)
  assert.equal(res.draft[0]?.status, 'doing', '内部 running 归一为对外 doing')
  assert.equal(res.draft[1]?.status, 'todo', '内部 pending 归一为对外 todo')
})

test('TC-OPS-027 ★ 真机修正（D206）：update 不得「新标 done」，只许保留既有 done', () => {
  // 真机实测（打包 0.40.0 + 0.8b，第三轮）：模型把**五项全部标成 done**，
  // 而任务实际什么都没产出、summary 为空 —— 又一次「静默假成功」（D197 同族）。
  const cur = [
    { text: '读取 CSV', status: 'done' },
    { text: '画折线图', status: 'running' },
  ]
  const a = keepOnlyPreviouslyDone(
    [
      { text: '读取 CSV', status: 'done' },   // 既有 done → 保留
      { text: '画折线图', status: 'done' },   // 新标 → 降级
      { text: '保存图片', status: 'done' },   // 新标 → 降级
    ],
    cur,
    'update',
  )
  assert.equal(a.draft[0]?.status, 'done', '既有 done 必须保留（否则清单倒退）')
  assert.equal(a.draft[1]?.status, 'todo', '新标 done 必须降级')
  assert.equal(a.draft[2]?.status, 'todo')
  assert.equal(a.downgraded, 2)
  assert.ok(a.draft[1]?.note?.includes('降级为待做'), '降级要留原因（纪律⑨：不留静默）')

  // complete 不过滤：它的职责就是确认完成
  const b = keepOnlyPreviouslyDone([{ text: '画折线图', status: 'done' }], cur, 'complete')
  assert.equal(b.draft[0]?.status, 'done')
  assert.equal(b.downgraded, 0)
  // cancel 不过滤：要保留既有 done
  const c = keepOnlyPreviouslyDone([{ text: '画折线图', status: 'done' }], cur, 'cancel')
  assert.equal(c.draft[0]?.status, 'done')

  // 文本归一化：标点/空白差异不该被当作「新项」
  const d = keepOnlyPreviouslyDone([{ text: '读取  CSV！', status: 'done' }], cur, 'update')
  assert.equal(d.draft[0]?.status, 'done', '归一化后应认作同一项')

  // 没有 done 时零开销直通，且不改动入参
  const src0 = [{ text: 'X', status: 'todo' as const }]
  const e = keepOnlyPreviouslyDone(src0, cur, 'update')
  assert.equal(e.downgraded, 0)
  assert.equal(src0[0]?.status, 'todo')
})

test('TC-OPS-023 契约用例的检测器自检：能报红、不误报', () => {
  const loop = src('src/main/agent/engine/loop.ts')
  // 检测器 1：删掉所有 planOpsTick 调用 → 应命中 0（报红）
  assert.equal((loop.replace(/await planOpsTick\(/g, '').match(/await planOpsTick\(/g) ?? []).length, 0)
  // 检测器 2：注入反模式文案 → 「必须通过 task_plan」判据应命中
  assert.equal('你必须通过 task_plan 提交清单'.includes('必须通过 task_plan'), true)
  // 检测器 3：顺序判据对「顺序颠倒」确实报红
  const bad = 'await pauseForEmptyResponses(); emptyRound: true'
  assert.ok(bad.indexOf('emptyRound: true') > bad.indexOf('await pauseForEmptyResponses('), '颠倒时应被判为红')
  // 检测器 4：不误报 —— 正常源码不该命中「必须通过 task_plan」
  assert.equal(loop.includes('必须通过 task_plan'), false)
})
