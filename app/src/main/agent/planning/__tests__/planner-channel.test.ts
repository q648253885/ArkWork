/**
 * v0.39.0 详测 — 规划通道（TC-PLANCH-001…013）
 *
 * 依据：docs/versions/v0.39.0/04-system-design.md §5（W1/W3/W4）、§6.1、§6.5、§7（D195）
 *       docs/versions/v0.39.0/testcases/00-cumulative-matrix.md TC-PLANCH 组
 *
 * 这一组的核心命题只有一句：**规划是一次独立的、不带工具的调用，且它失败时
 * 主链路行为与 v0.38.1 完全一致**。因此用例分三部分：
 *   A. 真执行 —— runner 跑一个注入的假 adapter（不联网），把失败/超时/中止/重试全跑一遍；
 *   B. 接线守卫 —— 断言三个触发点在源码里的**相对顺序**（函数全对而没接线 = D78/D79 同型）；
 *   C. 失败诊断 —— 不可解析时必须留原文摘要（D195：既有计划链留了 200 字，新通道当初没留）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs planner-channel
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'
import { runPlannerPass } from '../runner.js'
import {
  initPlannerState,
  shouldRunPlanner,
  notePlannerRun,
  draftFingerprint,
  shouldCommitRegexDraft,
} from '../policy.js'
import { MAX_PLANNER_PASSES_PER_RUN, MAX_REGEX_COMMITS_PER_RUN } from '../types.js'
import { buildPlannerSystem, renderPlannerUserMessage, OUTPUT_CONTRACT } from '../prompt.js'
import { clipRawForLog, RAW_LOG_LIMIT } from '../digest.js'

const readCode = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

const PLAN_SRC = readCode('../../../agent/engine/plan.ts')
const LOOP_SRC = readCode('../../../agent/engine/loop.ts')
const RUN_SETUP_SRC = readCode('../../../agent/engine/run-setup.ts')
const ACT_SRC = readCode('../../../agent/engine/act.ts')
const RUNNER_SRC = readCode('../runner.ts')

const SIG = (): AbortSignal => new AbortController().signal
const REQ = {
  taskId: 'T-PLANCH',
  trigger: 'run-start' as const,
  goal: '把调研文档写成 HTML',
  items: [],
  failures: [],
}

/* ---------------- A. runner 真执行（假 adapter 注入） ---------------- */

test('TC-PLANCH-001 runner 真执行：合法 JSON → ok:true + draft + via；**不带工具**', async () => {
  const seen: Array<{ tools: unknown; temperature: number }> = []
  const res = await runPlannerPass({
    req: REQ,
    modelId: 'fake',
    signal: SIG(),
    completeFn: async (input) => {
      seen.push({ tools: (input as { tools?: unknown }).tools, temperature: input.temperature })
      return { content: '[{"text":"读现有调研稿","status":"todo"},{"text":"写 HTML","status":"todo"}]' }
    },
  })
  assert.equal(res.ok, true)
  assert.equal(res.draft.length, 2)
  assert.equal(res.via, 'json-strict')
  assert.equal(res.attempts, 1)
  assert.equal(seen[0]!.temperature, 0.2, '规划回合用低温（推演要稳定，不要创作性）')
})

test('TC-PLANCH-002 ★ 两次都不可解析 → ok:false 且**不抛**（调用方回落既有链）', async () => {
  let calls = 0
  const res = await runPlannerPass({
    req: REQ,
    modelId: 'fake',
    signal: SIG(),
    completeFn: async () => {
      calls += 1
      return { content: '我觉得应该先调研，然后写文档。' }
    },
  })
  assert.equal(res.ok, false)
  assert.ok(res.skipped, '必须给出跳过原因（诊断通道留人话，纪律⑨）')
  assert.equal(calls, 2, '最多两次尝试（一次正常 + 一次 tighten）')
  assert.equal(res.draft.length, 0, '失败不得产出半成品草案')
})

test('TC-PLANCH-003 首次坏 → tighten 后好：attempts=2，第二次提示带收紧条款', async () => {
  const systems: string[] = []
  const res = await runPlannerPass({
    req: REQ,
    modelId: 'fake',
    signal: SIG(),
    completeFn: async (input) => {
      systems.push(input.system)
      return systems.length === 1
        ? { content: '没有清单' }
        : { content: '[{"text":"A","status":"todo"},{"text":"B","status":"todo"}]' }
    },
  })
  assert.equal(res.ok, true)
  assert.equal(res.attempts, 2)
  assert.notEqual(systems[1], systems[0], '第二次必须加收紧提示，不是原样重试')
})

test('TC-PLANCH-004 ★ 用户中止原样抛出（否则 Esc 停不下来）', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () =>
      runPlannerPass({
        req: REQ,
        modelId: 'fake',
        signal: ac.signal,
        completeFn: async () => {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        },
      }),
    /aborted/,
  )
})

/* ---------------- B. 接线守卫（W1 / W3 / W4 / W5） ---------------- */

test('TC-PLANCH-005 ★ W1 接线：planner 在既有三级链**之前**，且失败 return null 回落', () => {
  const iPlanner = PLAN_SRC.indexOf('await tryPlannerFirstPass(')
  const iChain = PLAN_SRC.indexOf('const plan = await tryGeneratePlan(')
  assert.ok(iPlanner > 0, 'generatePlan 内必须有 planner 优先调用')
  assert.ok(iChain > iPlanner, '★ planner 必须在既有三级降级链之前（顺序反了 = 功能没生效）')
  assert.match(
    PLAN_SRC,
    /if \(plannerPlan\) return plannerPlan/,
    '★ 只有 planner 成功才短路；否则必须继续走既有链（这就是"不影响正常 LLM"）',
  )
  // 回落的三个前提：不可解析 / 抛错 / 中止分流
  assert.match(PLAN_SRC, /if \(!res\.ok \|\| res\.draft\.length === 0\)/, 'planner 未产出 → return null 回落')
  const helper = PLAN_SRC.slice(PLAN_SRC.indexOf('async function tryPlannerFirstPass'), iChain)
  assert.match(helper, /\} catch \(err\) \{[\s\S]{0,400}?return null/, 'planner 抛错 → 捕获后回落（不得把异常冒到开局链）')
  assert.match(helper, /signal\.aborted\) throw err/, '★ 中止必须继续上抛（不得被回落吞掉）')
  assert.doesNotMatch(helper, /appendL1|mutate\(|emitEvent/, 'planner 不得写 L1 / 账本 / 事件（落库只走 plan-commit 管线）')
})

test('TC-PLANCH-006 ★ W3 接线：陈旧清单先重排、再回落原提醒，且顺序固定', () => {
  const iReplan = LOOP_SRC.indexOf('runPlannerPass({')
  assert.ok(iReplan > 0, 'loop 内应调规划通道')
  assert.match(LOOP_SRC, /trigger: 'stale'/, '陈旧路径的触发源必须是 stale')
  const iRemind = LOOP_SRC.indexOf('tree-sync reminder injected')
  assert.ok(iRemind > iReplan, '★ 原提醒必须留在重排之后（重排成功就不走原提醒）')
  assert.match(LOOP_SRC, /if \(!replanHandled\) \{/, '★ 必须显式回落分支，不能"重排失败就什么都不做"')
  assert.match(LOOP_SRC, /treeHint/, '回落分支仍注入原提示（行为零变更）')
})

test('TC-PLANCH-007 ★ W4 接线：新指令重排在「请先判断」指令之后，判据是 changed 不是"用户说话"', () => {
  const iJudge = RUN_SETUP_SRC.indexOf('await injectInputJudgement(')
  const iReplan = RUN_SETUP_SRC.indexOf("trigger: 'new-instruction'")
  assert.ok(iJudge > 0 && iReplan > iJudge, '★ 重排必须在既有判定指令之后（顺序即语义）')
  assert.match(RUN_SETUP_SRC, /if \(committed\.ok && committed\.changed > 0\)/, '只有真的变了才告知用户')
  assert.match(RUN_SETUP_SRC, /via: 'plan-revision'/, '清单被引擎改过必须走 plan-revision 告知通道')
  assert.doesNotMatch(
    RUN_SETUP_SRC.slice(iJudge, iReplan),
    /isReplyContinuation\s*&&/,
    '★ 不得再引入"用户是否说话"这类代理变量做判据（D150 的根因形态）',
  )
})

test('TC-PLANCH-008 回归：task_plan 主路径零变更（模型仍是清单的主人）', () => {
  assert.match(ACT_SRC, /action\.tool === 'task_plan'/, '★ task_plan 拦截分支必须仍在')
  assert.match(ACT_SRC, /commitPlanDraft\(/, 'task_plan 仍走共享落库管线')
  assert.doesNotMatch(ACT_SRC, /updateTask\([\s\S]{0,120}planItems/, 'act.ts 不得直写 planItems（第二写入者）')
})

test('TC-PLANCH-009 预算与冷却真值表（policy 纯函数）', () => {
  const base = { ...initPlannerState(), passes: MAX_PLANNER_PASSES_PER_RUN }
  assert.deepEqual(shouldRunPlanner({ state: base, trigger: 'stale', now: 1, fingerprint: 'f' }), {
    run: false,
    reason: 'budget',
  }, '超预算一律不放行（含 failure）')

  let s = initPlannerState()
  s = notePlannerRun(s, 'stale', 1000, 'f1')
  assert.equal(shouldRunPlanner({ state: s, trigger: 'stale', now: 1000 + 1, fingerprint: 'f2' }).reason, 'cooldown')
  assert.equal(
    shouldRunPlanner({ state: s, trigger: 'failure', now: 1000 + 1, fingerprint: 'f2' }).run,
    true,
    '★ failure 豁免冷却 —— 失败是最需要立刻重想的时刻，让它等 15 秒等于把任务拖死',
  )
  assert.equal(shouldRunPlanner({ state: s, trigger: 'stale', now: 999_999, fingerprint: 'f1' }).reason, 'duplicate')
  assert.equal(shouldRunPlanner({ state: s, trigger: 'stale', now: 999_999, fingerprint: 'f2' }).run, true)
  assert.equal(draftFingerprint([{ text: '  A ', status: 'todo' }]), draftFingerprint([{ text: 'A', status: 'todo' }]), '指纹不看空白')
})

test('TC-PLANCH-010 shouldCommitRegexDraft 真值表：chatMode / 伪调用 / 停滞 / 每 run 上限', () => {
  const c = (o: Partial<Parameters<typeof shouldCommitRegexDraft>[0]>) =>
    shouldCommitRegexDraft({ chatMode: false, pseudoHit: false, noToolStallHit: false, regexCommits: 0, ...o })
  assert.equal(c({}), true)
  assert.equal(c({ chatMode: true }), false, 'D182：对话级任务解释性答复里的 1…2… 不是清单')
  assert.equal(c({ pseudoHit: true }), false, 'D179：伪调用必须先当伪调用处理')
  assert.equal(c({ noToolStallHit: true }), false, '停滞达阈值 → 让有界暂停先生效')
  assert.equal(c({ regexCommits: MAX_REGEX_COMMITS_PER_RUN }), false, '每 run 上限')
  assert.equal(c({ regexCommits: MAX_REGEX_COMMITS_PER_RUN - 1 }), true)
})

test('TC-PLANCH-011 规划 prompt 必须避开 ReAct 模板且禁止自报完成', () => {
  const sys = buildPlannerSystem(REQ)
  assert.ok(sys.includes(OUTPUT_CONTRACT), '输出契约必须进 system')
  assert.doesNotMatch(sys, /Thought:|Action:|Observation:/i, '★ 不得用 ReAct 模板（假设 H1：与 Qwen 思考的 stopword 冲突）')
  assert.match(sys, /不执行|不要执行/, '必须写明"只规划、不执行"')
  // 当前清单进 **system**（修订变体），不进 user —— user 只有目标 + 约束（刻意不含对话历史/工具结果）
  const reviseReq = { ...REQ, trigger: 'stale' as const, items: [{ id: 'i1', text: '写 PRD', status: 'todo' }] }
  assert.match(buildPlannerSystem(reviseReq), /写 PRD/, '修订变体必须先摆出当前清单（模型据此算差异）')
  const userMsg = renderPlannerUserMessage(reviseReq)
  assert.match(userMsg, /目标：/, 'user 消息含目标')
  assert.doesNotMatch(userMsg, /写 PRD/, 'user 消息不得重复摆清单（同一状态两种措辞 = 模型可能按其中一份行事）')
  const failureReq = {
    ...REQ,
    trigger: 'failure' as const,
    items: [{ id: 'i1', text: '写 PRD', status: 'todo' }],
    failures: [{ tool: 'shell', code: 'exit', message: '命令退出码 1', attempts: 2 }],
  }
  const failSys = buildPlannerSystem(failureReq)
  assert.match(failSys, /命令退出码 1/, '失败变体必须把失败摘要摆进 system（最需要重想的时刻）')
  assert.match(failSys, /不得\*\*原样重试|不得原样重试/, '必须硬性禁止原样重试')
})

/* ---------------- C. 失败诊断（D195） ---------------- */

test('TC-PLANCH-012 ★ clipRawForLog：区分「空回复」与「不成形」，且不劈代理对（D195）', () => {
  assert.equal(RAW_LOG_LIMIT, 200, '与既有计划链 engine/plan.ts 的 safeSlice(raw, 200) 同口径')
  assert.equal(clipRawForLog(''), '(空回复)')
  assert.equal(clipRawForLog('   \n\t '), '(空回复)')
  assert.equal(clipRawForLog(null), '(空回复)')
  assert.equal(clipRawForLog(undefined), '(空回复)')
  assert.equal(clipRawForLog('第一行\n第二行'), '第一行⏎第二行', '换行折叠成一行（logs.jsonl 一条一条）')
  assert.equal(clipRawForLog('  a \n\n  b  '), 'a⏎b')
  assert.equal(clipRawForLog('短文本'), '短文本', '未超限不截断、不加标记')
  const long = 'x'.repeat(RAW_LOG_LIMIT + 10)
  const out = clipRawForLog(long)
  assert.match(out, /原文共 210 字符/, '超限必须标出原文长度 —— 让「模型话太多」可量化')
  assert.equal(Array.from(out).length, RAW_LOG_LIMIT + Array.from('…(原文共 210 字符)').length)
  // 代理对边界：200 个 emoji（每个 2 码元）恰好卡在截断点上
  const emoji = '🚀'.repeat(RAW_LOG_LIMIT) + 'tail'
  const eo = clipRawForLog(emoji)
  assert.doesNotMatch(eo, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, '不得以孤立高代理结尾（劈开的 emoji 会污染日志）')
  assert.ok(!eo.includes('\uFFFD'), '不得出现替换字符')
})

test('TC-PLANCH-013 ★ 接线：不可解析必须把原文摘要落诊断通道，且**不进**用户面（D195）', async () => {
  // 真跑一遍：模型回散文（不可解析，但非空）
  const prose = '好的，我先帮你梳理一下思路。\n第一步是读文档，第二步再写代码。'
  const res = await runPlannerPass({
    req: REQ,
    modelId: 'fake',
    signal: SIG(),
    completeFn: async () => ({ content: prose }),
  })
  assert.equal(res.ok, false, '散文不可解析 → ok:false，由调用方回落既有链')
  assert.equal(res.skipped, 'unparsable', 'D195：原因必须说真话（不是 aborted —— 模型确实回了）')
  // 人话提示保持原样：**原文不得进用户面**（噪音控制，C4）
  assert.doesNotMatch(res.summary, /第一步是读文档/, '★ 原文只许进日志，不许进 UI 提示')
  assert.match(res.summary, /不是可识别的清单形态/, '分类词（人话）仍要留')

  // 接线守卫：不可解析分支必须同时含 logger.warn 与 clipRawForLog(raw)，且仍在同一分支内
  const branch = /if \(!parsed\) \{([\s\S]*?)\n    \}/.exec(RUNNER_SRC)
  assert.ok(branch, '前提：runner.ts 存在 if (!parsed) { … } 分支')
  const body = branch![1]!
  assert.match(body, /logger\.warn\(/, '★ 解析失败必须落诊断通道（纪律⑨）')
  assert.match(body, /clipRawForLog\(raw\)/, '★ 且必须带原文摘要 —— 否则实机调 prompt 无从下手（D195）')
  assert.match(body, /parsedWarnReason\(raw\)/, '分类词仍保留（用户看到的还是人话）')
  assert.match(body, /continue/, '仍然 continue 到下一次尝试（C7）')
})
