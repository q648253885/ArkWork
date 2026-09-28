/* ============================================================
 * ArkWork — 空响应防御的**接线 + 终局**契约（v0.39.0 · TC-EMPTYG-001..006）
 *
 * 背景（用户实测 qwen3.5:9b @ Ollama 局域网端点，多协议复测）：端点偶发返回
 * 「全空回合」—— content/thought/actions 全空（只吐一对空 `<think></think>`、
 * 网关毛刺、流被无声掐断等）。此前原样放行 → 烧一个迭代 → 无工具守卫
 * 提示注入 → 继续空转，实测连烧 100+ 轮直到 maxIterations。
 *
 * ★ v0.39.0（D197）补上的是**第二半**：补试（TC-EMPTYG-001..004）只解决了
 * 「瞬时毛刺就地消化」，但**补试用尽之后没有任何出路** —— 非 finish=length
 * 的分支没有 else，空响应顺着「未调工具 + 清单无未完成项 + 未截断」三条判定
 * 一路走到成功分支，用空 summary 把任务封成 completed。
 * 实机证据（`logs.jsonl` / task T-20260927-152m5e）：
 *   empty-retry 1/2 → 2/2 → 第三次 POST ← 4096+57 tokens（仍空）
 *   → `ledger r15 by=seal:completed` ⇒ 用户看到一条**空白的「答复」**。
 *
 * 因此本组用两条互补的断言把守（纪律 D38-a：判定与接线都要测；纪律⑫：能真执行
 * 的真执行）：
 *   · 接线类（001–004）：补试在位、次数有上限、位置正确、判定单一真源；
 *   · 终局类（005）：用尽后**必须就地暂停**，且拦截点在完成门禁之前；
 *   · 真执行类（006）：summary 兜底链抽纯函数区 `new Function` 真跑真值表。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs empty-response-guard
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// 纪律⑫/⑲：源码守卫断言前必须剥注释（唯一真源），否则说明注释里的反例字样会假红
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const phaseSrc = read('../engine/reason-phase.ts')
const loopSrc = read('../engine/loop.ts')
const turnEndSrc = read('../engine/turn-end.ts')
const broadcastSrc = read('../engine/broadcast.ts')

test('TC-EMPTYG-001 空响应补试在位：判定条件 + 上限单一真源 + 同一调用管道', () => {
  // 判定条件：非 length（length 走下方专用提额重试）、未中止、且判定为不完整
  assert.match(
    phaseSrc,
    /response\.finishReason !== 'length' && !signal\.aborted && isIncompleteLlmResponse\(response\)/,
    '补试触发条件必须排除 finish=length、用户中止、非空回合',
  )
  // 补试上限：D197 起改为引用单一事实源常量（纪律⑧：计数不许两处各写一份）
  assert.match(
    phaseSrc,
    /for\s*\(let emptyRetry = 1; emptyRetry <= EMPTY_RETRY_LIMIT; emptyRetry\+\+\)/,
    '补试循环的上限必须引用 EMPTY_RETRY_LIMIT',
  )
  assert.match(phaseSrc, /export const EMPTY_RETRY_LIMIT = 2/, '补试上限常量必须为 2')
  assert.match(
    phaseSrc,
    /export const EMPTY_RESPONSE_ATTEMPTS = EMPTY_RETRY_LIMIT \+ 1/,
    '总调用次数必须由补试上限推导（首轮 1 + 补试 N），不得另写一个字面量',
  )
  // 必须复用 callTurnLlm（流式双通道泵 + say 剥离 + 超时包装都在里面）
  const block = phaseSrc.slice(phaseSrc.indexOf('多协议空响应防御'))
  assert.match(block, /response = await callLlmWithRetry\(\(\) => callTurnLlm\(\), signal\)/, '补试必须复用 callTurnLlm 管道')
})

test('TC-EMPTYG-002 位置正确：首轮 callLlmWithRetry 之后、length 专用重试之前', () => {
  const firstCall = phaseSrc.indexOf('response = await callLlmWithRetry(() => callTurnLlm(), signal)')
  const emptyGuard = phaseSrc.indexOf("response.finishReason !== 'length'")
  const lengthRetry = phaseSrc.indexOf('reasoning exhausted output budget')
  assert.notEqual(firstCall, -1, '首轮调用必须在位')
  assert.notEqual(lengthRetry, -1, 'length 专用重试必须在位')
  assert.ok(emptyGuard > firstCall, '空响应补试必须在首轮调用之后（否则首轮结果还没拿到）')
  assert.ok(emptyGuard < lengthRetry, '空响应补试必须在 length 专用重试之前（length 场景不消耗补试次数）')
})

test('TC-EMPTYG-003 补试循环内的短路条件齐全（中止 / length / 已非空都立即停）', () => {
  const block = phaseSrc.slice(
    phaseSrc.indexOf('for (let emptyRetry = 1'),
    phaseSrc.indexOf('reasoning exhausted output budget'),
  )
  assert.match(
    block,
    /if \(signal\.aborted \|\| response\.finishReason === 'length' \|\| !isIncompleteLlmResponse\(response\)\) break/,
    '短路条件必须齐全',
  )
  // 每次补试必须留 warn（复盘靠它，不能静默重试）
  assert.match(block, /logger\.warn\(/, '补试必须留 warn 日志')
  assert.match(block, /empty-retry \$\{emptyRetry\}\/\$\{EMPTY_RETRY_LIMIT\}/, '日志应含进度 N/上限')
})

test('TC-EMPTYG-004 判定单一真源：reason-phase 不许自写第二份「空响应」判定', () => {
  assert.match(
    phaseSrc,
    /import\s*\{[^}]*isIncompleteLlmResponse[^}]*\}\s*from\s*'\.\.\/llm-call\.js'/,
    '必须复用 llm-call 的单一真源判定，不得内联重写',
  )
})

/* ============================================================
 * ★ D197 终局：补试用尽必须「停」，不许「完成」
 * ============================================================ */

test('TC-EMPTYG-005 ★ D197：补试用尽 → 就地优雅暂停；拦截点必须在完成门禁之前', () => {
  const loopCode = stripComments(loopSrc)

  // ① reason-phase 必须把「用尽」这个事实显式回报（不是靠 loop 侧再猜一遍）
  assert.match(
    phaseSrc,
    /let emptyExhausted = false/,
    'reason-phase 必须有 emptyExhausted 标志（唯一出口）',
  )
  assert.match(
    phaseSrc,
    /if \(!signal\.aborted && response\.finishReason !== 'length' && isIncompleteLlmResponse\(response\)\) \{\s*\n\s*emptyExhausted = true/,
    '置位条件必须是「未中止 + 非 length + 仍判定为不完整」—— 三者缺一都会误伤 length 占位路径',
  )
  assert.match(phaseSrc, /return \{ response, emptyExhausted \}/, '标志必须随返回值交回 loop')

  // ② loop 必须解构并**就地终止**（不是 continue、不是放过）
  assert.match(
    loopCode,
    /const \{ response, emptyExhausted \} = await runReasonPhase\(/,
    'loop 必须消费 emptyExhausted（禁 `await x()` 丢弃结果，纪律 D123 ①）',
  )
  const iBranch = loopCode.indexOf('if (emptyExhausted)')
  assert.ok(iBranch > 0, 'loop 必须有 emptyExhausted 拦截分支')
  // v0.40.0（O7 / D201）：空回合块里**先**给清单一次推进机会（PlanOps），清单动了就
  // `continue`；只有清单也推不动才走暂停。因此分支体从 ~150 字符膨胀到 ~2.2k，
  // 原 400 字符窗口不再够 —— 窗口必须覆盖**整个分支**，否则会误判成"没接暂停"。
  // 同时补一条顺序断言（与 TC-OPS-019 互为印证）：兜底必须排在暂停**之前**。
  const branch = loopCode.slice(iBranch, iBranch + 2600)
  assert.match(branch, /await pauseForEmptyResponses\(task, iteration, EMPTY_RESPONSE_ATTEMPTS\)/, '必须走空响应专用暂停')
  const iAdvance = loopCode.indexOf('emptyRound: true', iBranch)
  const iPause = loopCode.indexOf('await pauseForEmptyResponses(', iBranch)
  assert.ok(iAdvance > 0, '空回合块应有 PlanOps 兜底（emptyRound: true）')
  assert.ok(iAdvance < iPause, 'PlanOps 兜底必须排在暂停**之前** —— 顺序反了等于没接（D201）')
  assert.match(branch, /if \(advancedByOps\) continue/, '清单动了必须继续跑，而不是照样暂停')
  assert.match(branch, /return/, '拦截后必须立即结束本 run（任何 continue 都等于放过空响应）')

  // ③ ★ 位置判据：拦截必须在完成门禁**之前**。
  //    否则空响应会先过 guardFinish，再落进成功分支 —— D197 的原始病灶。
  const iGuard = loopCode.indexOf('guardFinish(')
  assert.ok(iGuard > 0, '完成门禁必须在位')
  assert.ok(
    iBranch < iGuard,
    '空响应拦截必须早于 guardFinish —— 门禁的判据（未调工具 / 未触树）对空回合天然放行，拦不住',
  )
  assert.ok(
    iBranch < loopCode.indexOf("type: 'task_complete'"),
    '拦截必须早于任何 task_complete 投递',
  )

  // ④ 暂停必须**只**暂停：不得顺手封任何终态（暂停可恢复，见 D36）
  const fn = stripComments(
    loopSrc.slice(
      loopSrc.indexOf('async function pauseForEmptyResponses('),
      loopSrc.indexOf('async function pauseForNoToolAnswerStall'),
    ),
  )
  assert.match(fn, /status: 'paused'/, '必须是 paused（进度保留、可继续）')
  assert.match(fn, /type: 'ask_user'/, '必须给出 ask_user 让用户决策')
  assert.match(fn, /emitTurnNote\(/, '人话正文必须额外走 turn_note（ask_user 卡片只渲染按钮，同 D160）')
  assert.match(fn, /broadcastTaskStatus\(/, '状态必须广播给渲染层')
  assert.doesNotMatch(
    fn,
    /sealLedger|sealGraphForTaskOutcome|status: 'done'|status: 'failed'/,
    '暂停路径**绝不能**封任务终态 —— 静默假成功的病灶正在于「空响应也能封 completed」',
  )
  // 人话必须说清「不是任务出错、任务未完成」（纪律⑨：容错路径要在诊断通道留人话）
  assert.match(fn, /已停止：模型连续 \$\{attempts\} 次返回空响应/)
  assert.match(fn, /任务不会被标记完成/)
  // 纯文本：交互区原样渲染，混入 Markdown 会显示成噪音
  assert.doesNotMatch(fn, /\*\*/, '暂停文案不得含 Markdown 标记（交互区会原样显示）')

  // ⑤ 诊断必须能指认来源（纪律㉖）：空回合唯一的可分辨特征是 finishReason 与 token 数
  const diag = phaseSrc.slice(phaseSrc.indexOf('empty LLM response exhausted after'))
  assert.match(diag, /finish=\$\{response\.finishReason\}/, '诊断必须记 finishReason')
  assert.match(diag, /outTokens=\$\{response\.tokensOut\}/, '诊断必须记 token 数（57 tokens 的空回合与 0 tokens 的根因不同）')
})

/* ============================================================
 * ★ D197 终局：summary 兜底链不许再出现「两级全空」
 * ============================================================ */

const PURE_START = '/* @@ARKWORK-PURE:START@@ */'
const PURE_END = '/* @@ARKWORK-PURE:END@@ */'

/**
 * 按**精确签名**从 TS 源码里抽函数体 —— 体内部无类型标注，可直接 `new Function` 真跑。
 * `.ts` 带标注的签名本身喂不进 `new Function`（"Unexpected token ':'"），故只取 `{`
 * 与行首 `}` 之间那一段；签名一旦被改，`indexOf` 落空 → 本用例**响亮失败**，
 * 不会静默退化成「看不见被测对象」（与 `redirect-light-write.test.ts` 同法）。
 */
function extractBody(src: string, signature: string): string {
  const i = src.indexOf(signature)
  assert.ok(i >= 0, `源码里找不到签名，抽不出函数体：${signature.split('(')[0]}`)
  const end = src.indexOf('\n}', i)
  assert.ok(end > i, `找不到函数结束位置：${signature.split('(')[0]}`)
  return src.slice(i + signature.length, end)
}

type SummaryFn = (args: Record<string, unknown> | undefined, thought: string | undefined) => string

/**
 * 抽出 `resolveCompleteSummary` 的**真实函数体**真跑（纪律⑫：断言返回值，不是正则命中）。
 * 依赖的 `safeSlice` 同样从 `broadcast.ts` 抽真源码 —— 用替身测出来的结论不作数。
 */
function pureSummary(): SummaryFn {
  assert.ok(
    turnEndSrc.includes(PURE_START) && turnEndSrc.includes(PURE_END),
    'turn-end.ts 必须保留 resolveCompleteSummary 的纯函数区标记（@@ARKWORK-PURE:START/END@@）——' +
      '标记不在了，本用例就退化成「看不见被测对象」，故按失败处理',
  )
  const body = extractBody(
    turnEndSrc,
    'function resolveCompleteSummary(\n  args: Record<string, unknown> | undefined,\n  thought: string | undefined,\n): string {',
  )
  const safeBody = extractBody(broadcastSrc, 'function safeSlice(content: string, max: number): string {')
  const safeSlice = new Function(`function safeSlice(content, max) {${safeBody}}\n;return safeSlice;`)()
  return new Function(
    'safeSlice',
    `function resolveCompleteSummary(args, thought) {${body}}\n;return resolveCompleteSummary;`,
  )(safeSlice) as SummaryFn
}

test('TC-EMPTYG-006 ★ D197：task_complete 的 summary 兜底永不空（真执行真值表）', () => {
  const f = pureSummary()

  // ① 模型显式给的 summary 优先（含首尾空白裁剪）
  assert.equal(f({ summary: '已完成三项改造' }, '思考正文'), '已完成三项改造')
  assert.equal(f({ summary: '  已完成  ' }, '思考正文'), '已完成')

  // ② summary 缺省 / 空白 / 类型不对 → 回落本轮正文
  assert.equal(f(undefined, '正文答复'), '正文答复')
  assert.equal(f({}, '正文答复'), '正文答复')
  assert.equal(f({ summary: '   ' }, '正文答复'), '正文答复')
  assert.equal(f({ summary: 42 }, '正文答复'), '正文答复')

  // ③ ★ 两级全空（D197 的现场形状）→ 仍必须给出一句人话，绝不再吐空串。
  //    空串正是渲染层直出「空白答复」的唯一来源（subscriptions.ts 直接插值）。
  for (const empty of [undefined, '', '   ', '\n']) {
    const got = f({ summary: empty }, empty)
    assert.notEqual(got.trim(), '', 'summary 绝不允许为空 —— 渲染层会直出一条空白「答复」')
    assert.match(got, /[\u4e00-\u9fa5]/, '兜底必须是中文人话')
    assert.doesNotMatch(got, /^(undefined|null|NaN)$/, '不得把 JS 的空值字符串化漏给用户')
  }

  // ④ 超长正文走真 safeSlice 截断（且不切碎代理对）
  assert.equal(f(undefined, 'x'.repeat(600)).length, 500)
  // 600 个 U+20000 = 1200 个 UTF-16 单元；截到 500 落在偶数位（代理对边界），
  // 故应得 250 个完整字符 —— 若截出奇数长度就说明切碎了半个字符
  assert.equal(f(undefined, '𠀀'.repeat(600)), '𠀀'.repeat(250), '代理对应整对保留')

  // ⑤ 唯一事实源（纪律⑧）：两处收尾都必须经它，不得再内联「?? safeSlice(...)」
  const turnCode = stripComments(turnEndSrc)
  const loopCode = stripComments(loopSrc)
  assert.match(turnCode, /summary: resolveCompleteSummary\(action\.args, response\.thought\)/)
  assert.match(loopCode, /summary: resolveCompleteSummary\(undefined, response\.thought\)/)
  const iTail = turnCode.indexOf("type: 'task_complete'")
  assert.ok(iTail > 0, 'task_complete 投递必须在位')
  assert.doesNotMatch(
    turnCode.slice(iTail, iTail + 400),
    /safeSlice/,
    'task_complete 分支不得再内联兜底链（两级全空 = D197 的病灶）',
  )
})
