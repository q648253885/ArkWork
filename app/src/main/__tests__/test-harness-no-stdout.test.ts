/* ============================================================
 * ArkWork — 测试夹具纪律：测试文件**禁止写 stdout**（v0.36.0 · D100）
 * 规格来源：docs/versions/v0.36.0/04-system-design.md §8（D100）
 *
 * ★ 为什么要有这条用例
 *   node:test 用 `--test` 跑多文件时，**每个文件是一个子进程**，子进程把测试结果
 *   序列化后写 **stdout**；父进程按帧反序列化。测试代码自己再往 stdout 写一行日志，
 *   就会和协议帧争用同一通道 —— 负载一高就撕裂，父进程报
 *     `Unable to deserialize cloned data due to invalid or unsupported version.`
 *   （failureType: uncaughtException，location 指向文件第 1 行）
 *   把**整份文件**判失败：断言全对、功能没坏，门禁却红了。这正是 v0.36.0 全量回归里
 *   出现的那种「偶发假红」—— 概率低、复现难、看着像产品 bug，实际是夹具自伤。
 *
 * ★ 实证（不是推断）
 *   同一形状（14 个文件 × 4 个异步用例，各写一行日志）：
 *     · 写 stdout → **20/20 轮复现** deserialize 失败；
 *     · 改写 stderr → **0/20 轮**（stderr 是独立通道，不承载协议帧）；
 *     · 同步用例写 stdout → 0/20（需要跨 await 边界才会撕裂）。
 *   真实套件命中率约 1/5 轮（只有一个文件在写），所以它才显得"偶发"。
 *
 * ★ 本用例把守什么
 *   扫描 `src` 下全部 `*.test.ts(x)`（= `scripts/run-tests.mjs` 的执行集合，含其
 *   EXCLUSIONS 欠账文件，口径更严），断言其中**没有任何 stdout 写入**。
 *   检测器本身也表驱动自检（TC-HARN-003）：只靠一条"全仓扫描"太容易空转或误报，
 *   而空转的守卫比没有守卫更危险（纪律⑨：静默退化）。
 *
 * 反向核验记录：在某测试文件里加回一行 stdout 日志 → TC-HARN-001 立即报红；
 * 同样的字样放进字符串字面量 / 注释 → 不报红（正反两侧由 TC-HARN-003 穷尽）。
 * ============================================================ */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'
// ★ v0.36.0（D101）：注释剥离器的**唯一真源**。
// 本文件原本自带一份实现（全仓 5 份副本中最健壮的一份：状态机、保行号、保留字符串），
// 收敛时以它为种子提升为共享模块，其余 4 份朴素正则副本（会把字符串里的 `//` 一并删掉）退役。
import { stripComments } from '@shared/utils/source-guard'
// v0.38.0（D158）：全仓快照每进程只扫一次（此前本文件两处独立全仓 walk + read）
import { getRepoScan } from '@shared/utils/repo-scan'

/** cwd = app/（与 run-tests.mjs 同口径） */
const APP_ROOT = process.cwd()
const SRC_ROOT = join(APP_ROOT, 'src')

/* ============================================================
 * 检测器（纯函数，供自检用例直接驱动）
 * ============================================================ */

/**
 * 用分段拼装构造调用名，绝不在本文件里写出完整调用字样 ——
 * 本文件自己也是 `.test.ts`，也在扫描集合内，写死就自命中。
 * 注意 `process.stderr.write` **不在**表内：stderr 是安全的。
 */
const CALL_NAME = (...parts: string[]): string => parts.join('.')

const STDOUT_CALL_NAMES = [
  CALL_NAME('console', 'log'),
  CALL_NAME('console', 'info'),
  CALL_NAME('console', 'debug'),
  CALL_NAME('process', 'stdout', 'write'),
]
  .map((s) => s.replace(/\./g, '\\.'))
  .join('|')

/**
 * 命中条件：**语句位置**的 stdout 写调用。
 * 前导字符若落在 `'` `"` `` ` `` 之内，说明它只是字符串/模板里的字样，不是真调用 —— 排除。
 * （`console\.log(` 这种带反斜杠的正则字面量天然不命中，因为 `console` 后面跟的是 `\`。）
 */
const RE_STDOUT_WRITE = new RegExp("(^|[^\\w$.'\"`])(" + STDOUT_CALL_NAMES + ')\\s*\\(', 'g')

export interface StdoutWriteHit {
  line: number
  text: string
}

/** 找出源码里所有 stdout 写入调用（剥注释后逐行扫描） */
export function findStdoutWrites(src: string): StdoutWriteHit[] {
  const stripped = stripComments(src)
  const hits: StdoutWriteHit[] = []
  stripped.split('\n').forEach((line, idx) => {
    RE_STDOUT_WRITE.lastIndex = 0
    if (RE_STDOUT_WRITE.test(line)) hits.push({ line: idx + 1, text: line.trim() })
  })
  return hits
}

/* ============================================================
 * 测试文件发现（镜像 run-tests.mjs 的 walk 规则）
 * ============================================================ */

/* ============================================================
 * 测试文件发现（v0.38.0 / D158：改用共享快照，不再重复全仓 walk）
 * 规则与 run-tests.mjs 的 walk 逐字对齐：只认 `*.test.(ts|tsx)`、跳过 node_modules
 * ============================================================ */

const REPO = getRepoScan(SRC_ROOT)
const testFiles = (): string[] => REPO.all.filter((p) => /\.test\.tsx?$/.test(p))

/* ============================================================
 * TC-HARN-001 · 全仓测试文件不得写 stdout
 * ============================================================ */

test('TC-HARN-001 src 下全部测试文件禁止写 stdout（与 node:test 协议通道争用 → 整文件假红）', () => {
  const files = testFiles().sort()
  assert.ok(
    files.length > 100,
    `测试文件发现数异常（${files.length}）—— 守卫疑似空转，先查 walk 规则`,
  )

  const offenders: string[] = []
  for (const f of files) {
    for (const hit of findStdoutWrites(REPO.raw(f))) {
      offenders.push(`${relative(APP_ROOT, f).split(sep).join('/')}:${hit.line}  ${hit.text}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '测试文件不得写 stdout（诊断输出请用 stderr）。\n' +
      '原因：node:test 子进程协议走 stdout，测试内写 stdout 会在并发满载时撕裂协议帧，\n' +
      '父进程报 deserialize 失败并把整份文件判失败 —— 断言全对也会红。\n' +
      `违规 ${offenders.length} 处：\n` +
      offenders.join('\n'),
  )
})

/* ============================================================
 * TC-HARN-002 · 守卫覆盖范围与 runner 一致（防"扫了个寂寞"）
 * ============================================================ */

test('TC-HARN-002 守卫扫描范围 ≡ run-tests 执行集合（含 EXCLUSIONS 欠账文件，口径更严）', () => {
  const files = testFiles().map((p) => relative(APP_ROOT, p).split(sep).join('/'))

  // ① 规则一致性：run-tests.mjs 的 walk 只认 `*.test.(ts|tsx)` 且跳过 node_modules
  for (const f of files) {
    assert.match(f, /\.test\.(ts|tsx)$/, `不该被扫进来的文件：${f}`)
    assert.ok(!f.includes('node_modules'), `不该扫 node_modules：${f}`)
  }

  // ② 必含哨兵文件（三处曾写 stdout 的代表 + 一个普通套件）——
  //    只要 walk 规则被改坏（例如只扫一层目录），这几条立刻红
  for (const sentinel of [
    'src/main/memory/__tests__/e2e-memory-layers.test.ts',
    'src/main/store/__tests__/e2e-doc-skill.test.ts',
    'src/main/agent/__tests__/delegate-parallel.test.ts',
    'src/renderer/components/__tests__/subagent-ui-contract.test.ts',
  ]) {
    assert.ok(files.includes(sentinel), `哨兵文件漏扫：${sentinel}`)
  }

  // ③ 比 runner 更严：runner 会排除 EXCLUSIONS，本守卫**不排除**。
  //    排除项也在仓库里，也会在有人单跑时撕裂协议 —— 所以口径只能更严不能更松。
  assert.ok(
    files.includes('src/main/memory/__tests__/e2e-memory-l4-llm.test.ts'),
    'EXCLUSIONS 欠账文件也应纳入本守卫（runner 不跑它，但它仍会被单跑）',
  )
})

/* ============================================================
 * TC-HARN-003 · 检测器自检：正例必中、反例不误报（表驱动）
 * ============================================================ */

test('TC-HARN-003 检测器正反例表驱动：语句位置必中，字符串/注释/正则里的字样不得误报', () => {
  // 样例一律**拼装构造**：本文件也在扫描集合里，写死完整字样会自命中
  const CL = CALL_NAME('console', 'log')
  const CI = CALL_NAME('console', 'info')
  const CD = CALL_NAME('console', 'debug')
  const PW = CALL_NAME('process', 'stdout', 'write')
  const SW = CALL_NAME('process', 'stderr', 'write')

  // ---- 正例：真·stdout 写入（覆盖各种语句位置） ----
  const positives: Array<[string, string]> = [
    ['缩进语句', `  ${CL}('x')`],
    ['行首裸调用', `${CL}('x')`],
    ['tab 缩进', `\t${CI}('x')`],
    ['箭头函数体', `const l = (...a) => ${CD}(a)`],
    ['分号后', `foo(); ${PW}('x')`],
    ['同行前置调用', `log(); ${CL}('y')`],
    ['多参形态', `${CL}('[e2e]', a, b)`],
    ['模板串参数', `  ${CL}(\`产物 \${p}\`)`],
  ]
  for (const [name, src] of positives) {
    assert.equal(findStdoutWrites(src).length, 1, `正例应命中而未命中：${name}`)
  }

  // ---- 反例：字样出现在不该命中的位置 ----
  const negatives: Array<[string, string]> = [
    ['单引号字面量', `const code = '${CL}("x")'`],
    ['双引号字面量', `const s = "${CL}(x)"`],
    ['模板字面量', `const t = \`${CL}(x)\``],
    ['行注释', `// ${CL}('x')`],
    ['块注释（单行）', `/* ${CL}('x') */`],
    ['块注释（多行）', `/*\n * ${CL}('x')\n */`],
    ['行尾注释', `const a = 1 // ${CL}('x')`],
    ['正则字面量', `const re = /${CL.replace('.', '\\.')}\\(/`],
    ['stderr 写法', `${SW}('x')`],
    ['断言里的字样', `assert.ok(src.includes('${CL}'))`],
    ['对象字面量里的字样', `{ path: 'bad.txt', content: { code: '${CL}("x")' } }`],
  ]
  for (const [name, src] of negatives) {
    assert.deepEqual(
      findStdoutWrites(src).map((h) => h.text),
      [],
      `反例被误报：${name} → ${JSON.stringify(findStdoutWrites(src))}`,
    )
  }

  // ---- 混合：同一行注释 + 真调用，只有真调用该被命中 ----
  const mixed = `const a = 1 // ${CL}('注释里的')\n  ${CL}('真调用')`
  assert.deepEqual(
    findStdoutWrites(mixed).map((h) => h.line),
    [2],
    '同行有注释字样时，只应命中真正的那一行',
  )

  // ---- 行号保真：块注释跨行后行号不得漂移（否则违规定位会指错地方） ----
  const withBlock = `/*\n\n\n*/\n${CL}('x')`
  assert.deepEqual(findStdoutWrites(withBlock).map((h) => h.line), [5], '块注释剥离后行号必须保真')

  // ---- 负向元断言：检测器不得对空输入/正常源码报红（否则守卫会满仓假红） ----
  assert.deepEqual(findStdoutWrites(''), [])
  assert.deepEqual(findStdoutWrites(`import { test } from 'node:test'\ntest('a', () => {})\n`), [])
})

/* ============================================================
 * TC-HARN-004 · 并发 run 隔离：slot 目录与 TAP 日志名必须按进程命名空间
 * （v0.39.0 · D191）
 *
 * ★ 为什么要有这条用例
 *   实测：并发跑两个 `scripts/run-tests.mjs` 时，一轮 7 个红里 6 个是**环境红**，
 *   但**证据本身被毁掉了** —— 两个 run 用同名 slot 目录（`arkwork-pool-tmp-0`）
 *   与同名日志（`arkwork-tests-file-0.log`），后跑的把先跑的日志覆盖，
 *   连报错原文都取不到，无法做纪律㉕要求的「代码红 vs 环境红」分诊。
 *   更糟的是清扫会**跨 run 破坏**：子进程注入的 `tmp-cleanup` 无条件清空自己的
 *   TMPDIR，而 `pruneTempWorkspaces('运行后')` 的 `minAgeMs=0` 清空全局 tmpdir 里
 *   **全部** `arkwork-*`（含另一个 run 活着的 slot）。
 *
 * ★ 不是形状校验（纪律④）
 *   ② ③ 两条**把 runner 里的命名表达式抽出来真执行**：同一 slot 序号在两个不同
 *   PID 下必须算出不同名字。只 grep「有没有 RUN_TAG 字样」是形状校验，
 *   把 `${RUN_TAG}` 从模板里删掉仍能通过 —— 这里真跑一遍才钉得住。
 *
 * 反向核验记录：把 `OWN_SLOT_PREFIX` 里的 `${RUN_TAG}-` 删掉 → ② 立即报红
 * （两名相同）；把 prune 的 foreign-slot 分支删掉 → ④ 报红。
 * ============================================================ */

const RUNNER_SRC = readFileSync(join(APP_ROOT, 'scripts/run-tests.mjs'), 'utf-8')

test('TC-HARN-004 run-tests 的 slot/日志名按进程命名空间隔离（并发第二个 run 不得互踩）', () => {
  // ① 命名空间源头必须是 **PID**（随机值会让日志无法归属到具体 run）
  assert.match(
    RUNNER_SRC,
    /const\s+RUN_TAG\s*=\s*String\(process\.pid\)/,
    'RUN_TAG 必须由 process.pid 派生（并发 run 才可区分，且日志可归属）',
  )

  // ② **真执行** OWN_SLOT_PREFIX 表达式：两个 PID 必须得到不同目录名
  const own = RUNNER_SRC.match(/const\s+OWN_SLOT_PREFIX\s*=\s*`([^`]+)`/)
  assert.ok(own, '应能提取 OWN_SLOT_PREFIX 模板字面量')
  const buildOwn = new Function('RUN_TAG', 'SLOT_PREFIX', 'return `' + own![1] + '`') as (
    tag: string,
    slotPrefix: string,
  ) => string
  const ownA = buildOwn('1111', 'arkwork-pool-tmp-')
  const ownB = buildOwn('2222', 'arkwork-pool-tmp-')
  assert.equal(ownA, 'arkwork-pool-tmp-1111-', `OWN_SLOT_PREFIX 形状变了：${ownA}`)
  assert.equal(ownB, 'arkwork-pool-tmp-2222-', `OWN_SLOT_PREFIX 形状变了：${ownB}`)
  assert.notEqual(ownA, ownB, '两个 run 必须得到不同的 slot 前缀，否则夹具互踩')

  // ③ 日志名同理 —— 真执行，两个 PID + 同一 fileSeq 必须得到不同文件名
  const logTpl = RUNNER_SRC.match(/`(arkwork-tests-file-\$\{RUN_TAG\}-\$\{fileSeq\+\+\}\.log)`/)
  assert.ok(logTpl, '应能提取 TAP 日志名模板（且必须含 ${RUN_TAG}）')
  const buildLog = new Function('RUN_TAG', 'let fileSeq = 0; return `' + logTpl![1] + '`') as (
    tag: string,
  ) => string
  const logA = buildLog('1111')
  const logB = buildLog('2222')
  assert.equal(logA, 'arkwork-tests-file-1111-0.log', `日志名形状变了：${logA}`)
  assert.notEqual(logA, logB, '两个 run 必须写不同的日志文件，否则失败证据互相覆盖')

  // ④ prune 必须**跳过别的 run 的 slot**（只在明显已死时按年龄回收）
  assert.match(
    RUNNER_SRC,
    /STALE_FOREIGN_SLOT_MS/,
    'prune 需要 foreign-slot 的陈年回收阈值常量（D191）',
  )
  assert.match(
    RUNNER_SRC,
    /if\s*\(\s*e\.name\.startsWith\(SLOT_PREFIX\)\s*&&\s*!e\.name\.startsWith\(OWN_SLOT_PREFIX\)\s*\)/,
    'prune 必须显式跳过非本 run 的 slot 目录（否则"运行后 minAge=0"会清掉并发 run 的夹具）——' +
      '判据必须落在 if 的**首个条件**上：`if (false && <判据>)` 这种恒假写法会把判据整体架空（纪律㉚ 假守卫）',
  )
  assert.match(
    RUNNER_SRC,
    /STALE_FOREIGN_SLOT_MS\)\s*continue/,
    'foreign slot 的回收必须受年龄门保护',
  )
})
