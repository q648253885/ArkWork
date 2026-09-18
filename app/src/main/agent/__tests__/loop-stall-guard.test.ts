/* ============================================================
 * ArkWork — 零产出轮终局守卫的**接线**契约（v0.34.0 · TC-STALLG-001..015）
 * 规格来源：docs/versions/v0.34.0/04-system-design.md §2.2
 *
 * 为什么判定逻辑在 stall.test.ts、接线还要单独一组：
 *   v0.32.1 D38-a 的教训 —— `turn-end.finishViaTaskComplete` 函数本身
 *   **全对**，错的是「没人调用它」。于是那一版离线全绿、真跑不过。
 *   本组因此只问一个问题：**loop.ts 真的把这个判定用上了吗，用对了地方吗？**
 *   凡「挂点类」断言，必须钉住**真实会走的那条路径**，而不是「仓库里有这个符号」。
 *
 * v0.34.x 补口（本组新增 TC-STALLG-013..015）：**无工具分支**此前完全不推进
 * 零产出计数 —— 空响应/纯文字回合在「提示注入 → 继续空转」里无限循环
 * （qwen3.5:9b @ Ollama 实测连烧 100+ 轮直到 maxIterations）。
 * 暂停收尾同步抽为 pauseForStalledRounds（两条终局路径共用，断言其函数体）。
 *
 * 覆盖方式（与项目惯例一致）：源码契约 + 真实生产函数（计数器已抽到 stall.ts）。
 * 运行（cwd=app）：node scripts/run-tests.mjs loop-stall-guard
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAX_STALLED_ROUNDS } from '../engine/stall.js'

const loopSrc = readFileSync(fileURLToPath(new URL('../engine/loop.ts', import.meta.url)), 'utf-8')
const stallSrc = readFileSync(fileURLToPath(new URL('../engine/stall.ts', import.meta.url)), 'utf-8')
const messagesSrc = readFileSync(
  fileURLToPath(new URL('../../i18n/messages.ts', import.meta.url)),
  'utf-8',
)

/** 取某段源码：从 `from` 到 `to`（都按首次出现定位） */
function slice(from: string, to: string, src: string = loopSrc): string {
  const i = src.indexOf(from)
  assert.notEqual(i, -1, `未找到定位锚点：${from}`)
  const j = src.indexOf(to, i)
  assert.notEqual(j, -1, `未找到结束锚点：${to}`)
  return src.slice(i, j)
}

/** 共用暂停收尾函数体（两条终局路径的语义载体） */
function pauseHelperSrc(): string {
  return slice('async function pauseForStalledRounds', 'export async function runReActLoop')
}

/* ============================================================
 * 1. 判定函数确实被引入并调用（不是「仓库里恰好有这个文件」）
 * ============================================================ */

test('TC-STALLG-001 loop.ts 从 stall.ts 引入判定与计数器（缺任一即失效）', () => {
  assert.match(
    loopSrc,
    /import\s*\{[^}]*isStalledRound[^}]*\}\s*from\s*'\.\/stall\.js'/,
    '必须引入 isStalledRound（只 import 常量不算接线）',
  )
  assert.match(loopSrc, /import\s*\{[^}]*planSignature[^}]*\}\s*from\s*'\.\/stall\.js'/, '必须引入 planSignature')
  assert.match(loopSrc, /import\s*\{[^}]*advanceStallCounter[^}]*\}\s*from\s*'\.\/stall\.js'/, '必须引入计数器推进函数')
  assert.match(loopSrc, /import\s*\{[^}]*isStallTerminal[^}]*\}\s*from\s*'\.\/stall\.js'/, '必须引入终局判定')
  assert.match(loopSrc, /import\s*\{[^}]*MAX_STALLED_ROUNDS[^}]*\}\s*from\s*'\.\/stall\.js'/, '必须引入阈值常量')
  assert.match(stallSrc, /export\s+const\s+MAX_STALLED_ROUNDS\s*=\s*6/, 'stall.ts 应导出 6 轮阈值')
})

test('TC-STALLG-002 计数器在循环作用域内声明并初始化为 0（每任务独立，不跨任务串味）', () => {
  assert.equal(MAX_STALLED_ROUNDS, 6)
  assert.match(loopSrc, /let\s+consecutiveStalledRounds\s*=\s*0/, '必须有从 0 起的任务级计数器')
  // 不能写成模块级（否则多个任务共享计数 → 一个任务的空转会暂停另一个任务）
  const moduleLevel = /^(?:const|let|var)\s+consecutiveStalledRounds/m.test(loopSrc)
  assert.equal(moduleLevel, false, '计数器必须是任务级局部变量，不得提到模块级')
})

test('TC-STALLG-003 判定函数被真实调用（Act 路径 + 无工具分支两处，不是引入后闲置）', () => {
  assert.match(loopSrc, /const\s+stalledRound\s*=\s*isStalledRound\(\{/, 'Act 路径必须以本轮事实调用 isStalledRound')
  assert.match(loopSrc, /const\s+stalledNoTool\s*=\s*isStalledRound\(\{/, '无工具分支必须调用 isStalledRound（D52 补口）')
  assert.match(loopSrc, /advanceStallCounter\(consecutiveStalledRounds,\s*true\)/, '零产出分支必须推进计数')
  assert.match(loopSrc, /advanceStallCounter\(consecutiveStalledRounds,\s*false\)/, '有产出分支必须归零计数')
  assert.match(loopSrc, /advanceStallCounter\(consecutiveStalledRounds,\s*stalledNoTool\)/, '无工具分支必须以判定结果推进计数')
  assert.match(loopSrc, /if\s*\(isStallTerminal\(consecutiveStalledRounds\)\)/, '必须用同一阈值函数判终局')
})

/* ============================================================
 * 2. 四个输入字段的来源正确（「判定对了」的前提是「喂对了」）
 * ============================================================ */

test('TC-STALLG-004 hasToolCall 取自真实动作数（不是 response 的原始 tool_calls）', () => {
  const call = slice('const stalledRound = isStalledRound({', 'if (stalledRound)')
  assert.match(
    call,
    /hasToolCall:\s*actions\.length\s*>\s*0/,
    '必须用 collectActionsForIteration 的结果 —— 预算耗尽被跳过的调用不该算「有工具」',
  )
  assert.match(call, /hasSayOutput:\s*!!\(response\.say\s*&&\s*response\.say\.trim\(\)\)/, 'say 必须去空判非空')
  assert.match(call, /planProgressed:\s*planSignature\(task\.planItems\)\s*!==\s*planSigBefore/, '必须与 Act 前快照比较')
})

test('TC-STALLG-005 快照在 Act **之前**取（否则恒等比较 → 守卫永不触发）', () => {
  const sigIdx = loopSrc.indexOf('const planSigBefore = planSignature(task.planItems)')
  const actIdx = loopSrc.indexOf('const actions = collectActionsForIteration(response)')
  assert.notEqual(sigIdx, -1, '必须有 Act 前快照')
  assert.notEqual(actIdx, -1, '必须有 Act 取动作')
  assert.ok(sigIdx < actIdx, '快照必须在 Act 之前取 —— 取在执行之后就是「自己跟自己比」，守卫形同虚设')
  // 并且快照必须早于工具执行
  const execIdx = loopSrc.indexOf('await executeAct(')
  if (execIdx !== -1) assert.ok(sigIdx < execIdx, '快照必须早于 executeAct')
})

test('TC-STALLG-006 allReadonly 认「写类 shell 命令」，不能只看工具名', () => {
  // 锚定 Act 路径的判定块（无工具分支的 allReadonly 是常量 true，不参与此判定）
  const actBlock = slice('const stalledRound = isStalledRound({', 'if (stalledRound)')
  const call = actBlock.slice(actBlock.indexOf('allReadonly:'), actBlock.indexOf('hasSayOutput:'))
  assert.match(call, /a\.tool === 'shell'/, 'shell 是读写同源工具，必须先分流')
  assert.match(call, /WRITE_COMMAND_RE\.test\(/, 'shell 必须按命令行判定是否写类')
  assert.match(call, /READONLY_TOOLS\.has\(a\.tool\)/, '非 shell 工具走只读白名单')
  // 分流方向不能反：命中写命令 → 非只读
  assert.match(
    call,
    /a\.tool === 'shell'\s*\?\s*!WRITE_COMMAND_RE\.test\(/,
    'shell 命中写命令时必须是「非只读」（感叹号不可少 —— 少了就把写当成读，守卫会误杀正常实现）',
  )
})

/* ============================================================
 * 3. 终局路径：与 maxIter 超限同一形态（paused + ask_user），且**不封图**
 *    （v0.34.x 起收尾抽为 pauseForStalledRounds，Act 路径与无工具分支共用）
 * ============================================================ */

test('TC-STALLG-007 共用暂停函数发出 max_iterations_reached + ask_user（同既有优雅暂停路径）', () => {
  const helper = pauseHelperSrc()
  assert.match(helper, /type:\s*'max_iterations_reached'/, '应复用既有的「迭代类终局」事件，前端无需新增分支')
  assert.match(helper, /type:\s*'ask_user'/, '必须问用户，不能静默停')
  assert.match(helper, /askUser\.stalledQuestion/, '文案必须是专用的 stalledQuestion（不能用 maxIterQuestion 冒充）')
  assert.match(helper, /suggest\.resumeRun\.label/, '选项沿用既有 ask_user 卡片（继续运行）')
  assert.match(helper, /suggest\.finishHere\.label/, '选项沿用既有 ask_user 卡片（就此结束）')
})

test('TC-STALLG-008 终局必须落到 paused + pendingAskUser + 广播，且两条路径都接了线', () => {
  const helper = pauseHelperSrc()
  assert.match(helper, /status:\s*'paused'/, '任务必须置 paused（不是 failed —— 模型能力不足不是系统错误）')
  assert.match(helper, /pendingAskUser:\s*\{\s*question/, '必须写 pendingAskUser，否则重开任务时问题丢失')
  assert.match(helper, /broadcastTaskStatus\(/, '必须广播 —— 实测教训：只改记录不广播，UI 会停在上一帧')
  assert.doesNotMatch(helper, /status:\s*'failed'/, '绝不置 failed：这是「需要用户决策」，不是失败')
  assert.doesNotMatch(helper, /status:\s*'done'/, '绝不置 done：零产出 ≠ 任务完成')
  // 接线：两条终局路径（Act 路径 + 无工具分支）都必须调用并 return
  const callSites = loopSrc.match(/await pauseForStalledRounds\(task, iteration, MAX_STALLED_ROUNDS\)\n\s*return/g) ?? []
  assert.equal(callSites.length, 2, `终局调用点必须恰好两处（Act 路径 + 无工具分支）且调用后立即 return，实际 ${callSites.length}`)
})

test('TC-STALLG-009 终局**不封图**（暂停可恢复，与 v0.32.1 D36 的「暂停刻意不封口」一致）', () => {
  const helper = pauseHelperSrc()
  assert.doesNotMatch(
    helper,
    /sealGraphForTaskOutcome/,
    '暂停是可恢复的 —— 封图会让「继续运行」后的图与任务状态错位（D36 已明确：暂停不封口）',
  )
  assert.doesNotMatch(helper, /markRunningPlanItemFailed/, '清单项不得被标失败：进度要保留给用户续跑')
})

test('TC-STALLG-010 每轮零产出留 warn 日志（真实环境复盘靠它，不能只静默计数）', () => {
  const body = slice('if (stalledRound) {', 'if (isStallTerminal(consecutiveStalledRounds))')
  assert.match(body, /logger\.warn\(/, '每轮零产出必须有 warn')
  assert.match(body, /stalled round \$\{consecutiveStalledRounds\}\/\$\{MAX_STALLED_ROUNDS\}/, '日志应含 N/6 进度')
  assert.match(body, /tools=/, '日志应含本轮工具名，便于判断是不是同一工具空转')
})

/* ============================================================
 * 4. 既有保护不得被新守卫替代（设计 §2.2「既有保护不动」）
 * ============================================================ */

test('TC-STALLG-011 四道既有保护全部保留（新守卫是正交维度，不是替代品）', () => {
  assert.match(loopSrc, /const\s+MAX_CONSECUTIVE_NO_TOOL\s*=\s*\d/, '① 无工具调用自愈不得删')
  assert.match(loopSrc, /const\s+MAX_PER_SIGNATURE\s*=\s*\d/, '② 同签名预算不得删')
  assert.match(loopSrc, /consecutiveReadOnly\s*>=\s*3/, '③ 只读停滞提示不得删')
  assert.match(loopSrc, /maxIterations|maxIter\b/, '④ 迭代上限兜底不得删')
  // 零产出守卫必须与只读提示**并存**：提示负责「给机会」，守卫负责「给终局」
  const hintIdx = loopSrc.indexOf('consecutiveReadOnly >= 3')
  const guardIdx = loopSrc.indexOf('const stalledRound = isStalledRound({')
  assert.ok(hintIdx !== -1 && guardIdx !== -1)
  assert.ok(hintIdx < guardIdx, '只读提示应先于零产出终局判定 —— 先警告、后终局，别一上来就暂停')
})

test('TC-STALLG-012 i18n 文案在 4 语言齐备且插值名与调用点一致（D54 同类缺陷的回归门）', () => {
  const zh = messagesSrc.match(/'askUser\.stalledQuestion':\s*'([^']*)'/)
  assert.ok(zh, 'zh 必须有 askUser.stalledQuestion')
  assert.match(zh![1]!, /\{count\}/, 'zh 文案必须含 {count} 插值')
  // 收尾函数内插值传参名必须与模板一致（否则界面会原样显示 {count}）
  assert.match(
    pauseHelperSrc(),
    /tFor\(getUiLocale\(\),\s*'askUser\.stalledQuestion',\s*\{\s*count:\s*rounds\s*\}\)/,
    '收尾函数必须传 { count: rounds }，与模板同名',
  )
  // 4 语言各一条（en / ja / ko 的键名相同，取值不同 —— 按出现次数断言穷尽）
  const occurrences = messagesSrc.match(/'askUser\.stalledQuestion':/g) ?? []
  assert.equal(occurrences.length, 4, `stalledQuestion 应在 4 个语言块各出现一次，实际 ${occurrences.length}`)
})

/* ============================================================
 * 5. v0.34.x 补口：无工具分支的零产出接线（空响应/纯文字回合的终局）
 * ============================================================ */

test('TC-STALLG-013 无工具分支的判定输入正确（无工具、无清单推进、say 判产出）', () => {
  const block = slice('const stalledNoTool = isStalledRound({', 'continue')
  assert.match(block, /hasToolCall:\s*false/, '无工具分支必须如实报 hasToolCall=false')
  assert.match(block, /planProgressed:\s*false/, '无工具回合没有清单推进（迭代 0 的自动标 running 是引擎行为，不是模型进展）')
  assert.match(
    block,
    /hasSayOutput:\s*!!\(response\.say\s*&&\s*response\.say\.trim\(\)\)/,
    'say 叙述非空算有产出（与 Act 路径同口径，归零而非计数）',
  )
})

test('TC-STALLG-014 无工具分支的接线在提示注入之后、continue 之前（真实会走的路径）', () => {
  const hintIdx = loopSrc.indexOf('pendingSystemHint = labelEngineHint(hint)')
  const stallIdx = loopSrc.indexOf('const stalledNoTool = isStalledRound({')
  assert.notEqual(hintIdx, -1, '无工具分支的提示注入必须在位')
  assert.ok(stallIdx > hintIdx, '零产出计数必须挂在无工具分支的提示注入之后 —— 挂在别处就测不到这条循环路径')
  const block = slice('const stalledNoTool = isStalledRound({', 'continue')
  assert.match(block, /advanceStallCounter\(consecutiveStalledRounds,\s*stalledNoTool\)/, '必须推进同一任务级计数器')
  assert.match(block, /if\s*\(isStallTerminal\(consecutiveStalledRounds\)\)/, '必须判终局')
  assert.match(block, /await pauseForStalledRounds\(/, '达阈值必须走共用暂停收尾')
  assert.match(block, /return\b/, '终局后必须退出循环（不得继续跑到下一次 Reason）')
  // 计数器声明在循环外、本接线在无工具分支内（作用域正确性）
  const declIdx = loopSrc.indexOf('let consecutiveStalledRounds = 0')
  assert.ok(declIdx !== -1 && declIdx < stallIdx, '计数器必须先声明后使用，且为循环外任务级变量')
})

test('TC-STALLG-015 无工具分支的终局与 Act 路径共用同一收尾函数（形态一致，不另起炉灶）', () => {
  // 两处调用在 TC-STALLG-008 已钉死数量；此处钉住「无工具分支那份」确实存在
  const noToolBlock = slice('const stalledNoTool = isStalledRound({', 'continue')
  assert.match(noToolBlock, /await pauseForStalledRounds\(task, iteration, MAX_STALLED_ROUNDS\)/)
  // 共用函数不得只服务单一路径（如被内联回去，两处形态会漂移）
  const helper = pauseHelperSrc()
  assert.match(helper, /async function pauseForStalledRounds/)
})

/* ============================================================
 * 6. v0.34.x 误杀修正：「思考翻新」产出口径（探索类任务的只读探索）
 *    qwen3.5:9b @ Ollama 实测：「分析工作区」每轮读新文件 + 每轮有新思考，
 *    但 say 恒空（不遵守 SAY 协议）、清单不收口（T-01 恒 in_progress）——
 *    旧口径连杀两轮「6 轮零产出」，用户点「继续运行」6 轮后又被拦。
 * ============================================================ */

test('TC-STALLG-016 freshNarrative 接线：两处判定都吃「叙述翻新」信号，基准每任务独立', () => {
  // 基准声明：任务级局部变量（不得提到模块级 —— 否则跨任务串味）
  assert.match(loopSrc, /let prevNarrativeSig = ''/, '必须有上一轮叙述基准')
  assert.equal(
    /^(?:const|let|var)\s+prevNarrativeSig/m.test(loopSrc),
    false,
    '基准必须是任务级局部变量，不得提到模块级',
  )
  // 叙述签名：thought（content）优先，空则退回 reasoning（原生思考）——
  // 真机 qwen3.5:9b 实测探索阶段叙述全走 reasoning、content 恒空
  assert.match(loopSrc, /const thoughtTrim = \(response\.thought \?\? ''\)\.trim\(\)/)
  assert.match(loopSrc, /const reasoningTrim = \(response\.reasoningContent \?\? ''\)\.trim\(\)/)
  assert.match(
    loopSrc,
    /const narrativeSig = thoughtTrim \|\| reasoningTrim/,
    '叙述签名必须同时覆盖 thought 与 reasoning 通道',
  )
  // 计算口径：非空 且 与上一轮不同（复读不算叙述）
  assert.match(
    loopSrc,
    /const freshNarrative = !!\(narrativeSig && narrativeSig !== prevNarrativeSig\)/,
    '叙述翻新 = 非空且与上一轮不同',
  )
  // 基准只在非空时更新（空轮不清基准 —— 重复检测始终对上一条真叙述进行）
  assert.match(loopSrc, /if \(narrativeSig\) prevNarrativeSig = narrativeSig/, '空轮不得清基准')
  // 两处判定（Act 路径 + 无工具分支）都吃同一信号
  const occurrences = loopSrc.match(/hasNewThought: freshNarrative/g) ?? []
  assert.equal(occurrences.length, 2, `两处 isStalledRound 都必须传 hasNewThought，实际 ${occurrences.length}`)
  // 计算必须发生在两处判定之前（检查终止前）
  const calcIdx = loopSrc.indexOf('const freshNarrative =')
  const noToolIdx = loopSrc.indexOf('const stalledNoTool = isStalledRound({')
  const actIdx = loopSrc.indexOf('const stalledRound = isStalledRound({')
  assert.ok(calcIdx !== -1 && calcIdx < noToolIdx && calcIdx < actIdx, 'freshNarrative 必须在两处判定之前计算')
})
