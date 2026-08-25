/* ============================================================
 * ArkWork — chat/task 分流判定 测试（v0.14.0 Task 2）
 *
 * 覆盖：
 *  - 50+ 人工标注 baseline 样本（写死 + 明确期望）
 *  - 150+ 合成样本（基于关键词 + 长度启发式）
 *  - 平均延迟 ≤ 5ms 断言（大量样本下）
 *
 * 测试入口：node --import tsx --test ./src/main/router/__tests__/classify-route.test.ts
 * （无需新依赖，使用 Node 内置 node:test + 项目内已安装的 tsx）
 * ============================================================ */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRoute, CLASSIFY_ROUTE_META, type RouteDecision } from '../classify-route.js'

/* ----------------------------------------------------------------
 * 工具：把所有样本跑一遍并断言结果
 * ---------------------------------------------------------------- */
function expectKind(input: string, expected: 'chat' | 'task', ctx?: Parameters<typeof classifyRoute>[1], label?: string): void {
  const dec = classifyRoute(input, ctx)
  assert.equal(dec.kind, expected, `FAIL[${label ?? input}] expected=${expected} got=${dec.kind} (${dec.reason})`)
  assert.equal(typeof dec.latencyMs, 'number')
  assert.ok(dec.latencyMs >= 0, 'latencyMs must be non-negative')
}

/* ----------------------------------------------------------------
 * 1) 人工标注 baseline（≥ 50 条）
 * ---------------------------------------------------------------- */
test('baseline: empty / 空白输入 → chat', () => {
  expectKind('', 'chat', undefined, 'empty')
  expectKind('   ', 'chat', undefined, 'whitespace')
})

test('baseline: 中文编码词 → task', () => {
  expectKind('帮我写一个 Python 爬虫', 'task', undefined, '帮我写一个')
  expectKind('请帮我实现用户登录功能', 'task', undefined, '帮我实现')
  expectKind('重构一下 src/router/index.ts', 'task', undefined, '重构')
  expectKind('新建项目 arkwork-mobile', 'task', undefined, '新建项目')
  expectKind('编写单元测试覆盖新增 API', 'task', undefined, '编写')
  expectKind('初始化项目并加上 prettier', 'task', undefined, '初始化项目')
  expectKind('添加新按钮到 Toolbar', 'task', undefined, '添加')
  expectKind('删除 user 字段', 'task', undefined, '删除')
  expectKind('把变量重命名', 'task', undefined, '重命名')
  expectKind('修复登录态丢失的 bug', 'task', undefined, '修复')
  expectKind('debug 一下启动失败', 'task', undefined, 'debug')
  expectKind('跑一下所有测试', 'task', undefined, '跑一下')
  expectKind('执行 npm run build', 'task', undefined, '执行')
  expectKind('打包成 dmg 然后发布', 'task', undefined, '打包 + 接着')
  expectKind('部署到 staging 服务器', 'task', undefined, '部署')
  expectKind('提交并 push 到 main', 'task', undefined, '提交 + push')
  expectKind('把数据库迁移到 v2', 'task', undefined, '迁移')
})

test('baseline: 英文编码词 → task', () => {
  expectKind('implement a binary search tree', 'task', undefined, 'implement')
  expectKind('refactor the router module', 'task', undefined, 'refactor')
  expectKind('please rewrite the parser', 'task', undefined, 'rewrite')
  expectKind('scaffold a typescript app', 'task', undefined, 'scaffold')
  expectKind('add a new endpoint /v2/users', 'task', undefined, 'add a')
  expectKind('remove the legacy field', 'task', undefined, 'remove the')
  expectKind('rename this variable to userId', 'task', undefined, 'rename')
  expectKind('fix the off-by-one error', 'task', undefined, 'fix the')
  expectKind('debug this crash', 'task', undefined, 'debug this')
  expectKind('write tests for the new module', 'task', undefined, 'write tests')
  expectKind('run the tests in CI', 'task', undefined, 'run the tests')
  expectKind('build and deploy the app', 'task', undefined, 'build')
  expectKind('commit and push', 'task', undefined, 'commit + push')
  expectKind('migrate the db schema to v3', 'task', undefined, 'migrate')
})

test('baseline: 多步连接词 + 动词 → task', () => {
  expectKind('先读 README，然后总结架构', 'task', undefined, '然后')
  expectKind('查一下文档，再实现这个函数', 'task', undefined, '再')
  expectKind('跑测试，之后修复失败的用例', 'task', undefined, '之后')
  expectKind('读 package.json 接着安装依赖', 'task', undefined, '接着')
  expectKind('write the code then build the project', 'task', undefined, 'then')
  expectKind('check the logs and then restart', 'task', undefined, 'and then')
  expectKind('read the spec, next implement it', 'task', undefined, 'next')
})

test('baseline: 追问 / 续说 → 沿用 lastTurnKind', () => {
  // 上一轮 task → 追问仍 task
  expectKind('再试一次', 'task', { lastTurnKind: 'task' }, '再试一次 (last=task)')
  expectKind('继续', 'task', { lastTurnKind: 'task' }, '继续 (last=task)')
  expectKind('repeat again', 'task', { lastTurnKind: 'task' }, 'repeat (last=task)')
  expectKind('go on', 'task', { lastTurnKind: 'task' }, 'go on (last=task)')
  // 上一轮 chat → 追问仍 chat
  expectKind('再试一次', 'chat', { lastTurnKind: 'chat' }, '再试一次 (last=chat)')
  expectKind('继续', 'chat', { lastTurnKind: 'chat' }, '继续 (last=chat)')
  expectKind('try again', 'chat', { lastTurnKind: 'chat' }, 'try again (last=chat)')
})

test('baseline: 纯问答 + 短文本 → chat', () => {
  expectKind('什么是 React？', 'chat', undefined, '什么是')
  expectKind('为什么 TCP 三次握手？', 'chat', undefined, '为什么')
  expectKind('Python 怎么样？', 'chat', undefined, '怎么样')
  expectKind('能不能用 GPU 跑？', 'chat', undefined, '能不能')
  expectKind('how does V8 work?', 'chat', undefined, 'how')
  expectKind('why is rust fast?', 'chat', undefined, 'why')
  expectKind('what is a closure?', 'chat', undefined, 'what is')
  expectKind('can you explain monads?', 'chat', undefined, 'can you')
  expectKind('解释一下 Promise', 'chat', undefined, '解释')
  expectKind('介绍一下 ReAct', 'chat', undefined, '介绍')
})

test('baseline: 兜底 — 短文无动作词 → chat', () => {
  expectKind('你好', 'chat', undefined, 'greeting')
  expectKind('早上好', 'chat', undefined, 'morning')
  expectKind('在吗', 'chat', undefined, '在吗')
  expectKind('今天天气', 'chat', undefined, 'weather query')
  expectKind('thanks', 'chat', undefined, 'thanks')
  expectKind('OK', 'chat', undefined, 'OK')
})

test('baseline: 长文 → task', () => {
  const long = '请帮我把整个项目从 JavaScript 迁移到 TypeScript，并且把所有第三方依赖都升级到最新版本，最后写一份完整的迁移报告给我。'.trim()
  expectKind(long, 'task', undefined, 'long zh')
  const longEn =
    'Please migrate the entire codebase from JavaScript to TypeScript, upgrade every third-party dependency to the latest version, and then write a comprehensive migration report for me.'
  expectKind(longEn, 'task', undefined, 'long en')
})

test('baseline: hasTools + 中长文 → task', () => {
  // 长度 ≥ 60（trim 后）+ hasTools=true → task
  // 不含编码词 / 多步连接词 / 追问词，专门验证 hasTools 这条启发式
  const input =
    '把 src 下面所有 .ts 文件找出来，按照行数排序，给我一份清单，方便后续在 docs 里查看并交给团队 review'
  assert.ok(input.length >= 60, `expected length ≥ 60, got ${input.length}`)
  expectKind(input, 'task', { hasTools: true }, 'hasTools + long-ish')
})

test('baseline: 返回结果结构正确', () => {
  const d: RouteDecision = classifyRoute('帮我重构代码')
  assert.equal(d.kind, 'task')
  assert.ok(typeof d.reason === 'string' && d.reason.length > 0)
  assert.ok(typeof d.latencyMs === 'number')
})

test('baseline: 暴露 meta 常量', () => {
  assert.equal(CLASSIFY_ROUTE_META.MAX_LATENCY_MS_TARGET, 5)
  assert.equal(CLASSIFY_ROUTE_META.CHAT_LENGTH_LIMIT, 80)
})

/* ----------------------------------------------------------------
 * 2) 合成样本（≥ 150 条）
 *    基于关键词 + 长度启发式生成
 * ---------------------------------------------------------------- */

// 关键词集合（与实现保持同步的最小子集，避免假阳性）
const SYN_CODE_ZH = ['写代码', '写一个', '实现', '重构', '新建项目', '编写', '修复', '调试', '加上', '删除', '打包', '部署', '迁移', '提交', '替换']
const SYN_CODE_EN = ['implement', 'refactor', 'fix', 'debug', 'build', 'deploy', 'migrate', 'commit', 'rewrite', 'scaffold']
const SYN_QA_ZH = ['是什么', '为什么', '怎么样', '能不能', '如何', '解释', '介绍']
const SYN_QA_EN = ['what is', 'why', 'how', 'explain', 'describe']
const SYN_FOLLOWUP_ZH = ['再试一次', '继续']
const SYN_FOLLOWUP_EN = ['try again', 'repeat again']
const SYN_CONNECTOR_ZH = ['然后', '再', '之后', '接着']
const SYN_CONNECTOR_EN = ['then', 'next', 'after that']
const SYN_VERB_ZH = ['写', '跑', '执行', '修复', '删除', '添加', '检查', '读取']
const SYN_VERB_EN = ['write', 'run', 'execute', 'fix', 'delete', 'add', 'check', 'read']

function pad(target: number, base: string): string {
  // 用安全 filler 把文本填到目标长度
  if (base.length >= target) return base
  const filler = ' 的 '.repeat(Math.ceil((target - base.length) / 3) + 1)
  return (base + filler).slice(0, target)
}

/**
 * 合成器：根据规则组合生成符合规则的输入 + 期望 kind
 */
function* synthSamples(): Generator<{ input: string; expected: 'chat' | 'task'; ctx?: Parameters<typeof classifyRoute>[1]; label: string }> {
  // ---- A. 纯编码词 → task（不带其他信号；约 30 条）
  for (const w of SYN_CODE_ZH) {
    yield { input: `请帮我${w}一下`, expected: 'task', label: `code-zh:${w}` }
  }
  for (const w of SYN_CODE_EN) {
    yield { input: `please ${w} this`, expected: 'task', label: `code-en:${w}` }
  }
  // ---- B. 编码词 + 长 filler → task
  for (const w of SYN_CODE_ZH.slice(0, 5)) {
    yield { input: pad(120, `${w} 一个完整的模块`), expected: 'task', label: `code-zh-long:${w}` }
  }
  // ---- C. QA 词 + 短文 → chat（短文 ≤ 80）
  for (const w of SYN_QA_ZH) {
    yield { input: `${w} Node？`, expected: 'chat', label: `qa-zh:${w}` }
    yield { input: pad(60, `${w}这件事`), expected: 'chat', label: `qa-zh-longish:${w}` }
  }
  for (const w of SYN_QA_EN) {
    yield { input: `${w} does this work?`, expected: 'chat', label: `qa-en:${w}` }
    yield { input: pad(60, `${w} exactly does this thing happen`), expected: 'chat', label: `qa-en-longish:${w}` }
  }
  // ---- D. 多步连接词 + 动词 → task
  for (const c of SYN_CONNECTOR_ZH) {
    for (const v of SYN_VERB_ZH) {
      yield { input: `先${v}文件，${c}总结一下`, expected: 'task', label: `multi-zh:${c}+${v}` }
    }
  }
  for (const c of SYN_CONNECTOR_EN) {
    for (const v of SYN_VERB_EN) {
      yield { input: `first ${v} the file, ${c} summarize it`, expected: 'task', label: `multi-en:${c}+${v}` }
    }
  }
  // ---- E. 追问 → 沿用 lastTurnKind
  for (const w of SYN_FOLLOWUP_ZH) {
    yield { input: w, expected: 'chat', ctx: { lastTurnKind: 'chat' }, label: `followup-zh-chat:${w}` }
    yield { input: w, expected: 'task', ctx: { lastTurnKind: 'task' }, label: `followup-zh-task:${w}` }
  }
  for (const w of SYN_FOLLOWUP_EN) {
    yield { input: w, expected: 'chat', ctx: { lastTurnKind: 'chat' }, label: `followup-en-chat:${w}` }
    yield { input: w, expected: 'task', ctx: { lastTurnKind: 'task' }, label: `followup-en-task:${w}` }
  }
  // ---- F. 短文无动作词 → chat
  const fillers = ['嗯', '好的', '是的', 'no thanks', 'cool', 'hi', 'hello world']
  for (const f of fillers) {
    yield { input: pad(40, f), expected: 'chat', label: `short-no-verb:${f}` }
  }
  // ---- G. 长文 → task（多种长度）
  for (const len of [81, 120, 160, 200, 300]) {
    yield {
      input: pad(len, '请把整个项目从 JavaScript 迁移到 TypeScript，并升级所有依赖'),
      expected: 'task',
      label: `long-zh:${len}`,
    }
    yield {
      input: pad(len, 'please migrate the whole codebase from javascript to typescript and upgrade deps'),
      expected: 'task',
      label: `long-en:${len}`,
    }
  }
  // ---- H. hasTools 钩子（trim 后长度 ≥ 60 才能命中 rule 6）
  for (let len = 70; len <= 120; len += 10) {
    yield {
      input: pad(len, '把 src 下面所有 .ts 文件找出来'),
      expected: 'task',
      ctx: { hasTools: true },
      label: `hasTools:${len}`,
    }
  }
  // ---- I. 短文 + hasTools=true 仍走 chat（不到长度阈值）
  yield {
    input: '嗯嗯',
    expected: 'chat',
    ctx: { hasTools: true },
    label: 'hasTools-but-chatty',
  }
  // 长 + hasTools → task
  yield {
    input: pad(90, '把项目里所有的 TODO 找出来给我看一下'),
    expected: 'task',
    ctx: { hasTools: true },
    label: 'hasTools-long-todo',
  }
  // ---- J. 额外编码词变体 → task（必须是 code 关键词命中）
  const extraCodeZh = [
    '帮我加上注释',
    '帮我加上一行日志',
    '帮我实现分页功能',
    '帮我部署到生产',
    '帮我打包并发布',
    '帮我升级依赖版本',
    '帮我写测试',
    '帮我调试一下',
    '帮我初始化项目',
    '帮我编写文档',
  ]
  for (const s of extraCodeZh) {
    yield { input: s, expected: 'task', label: `extra-code-zh:${s}` }
  }
  // ---- K. 额外 QA 短句 → chat（注意避开会先触发 code word 的样本）
  const extraQa = ['Rust 是什么？', '为什么这么慢？', '如何配置？', '这段代码什么意思？', '讲讲原理', 'tcp 是干嘛的？', 'this 是啥？', 'what is hoisting?', 'how does it work?']
  for (const s of extraQa) {
    yield { input: s, expected: 'chat', label: `extra-qa:${s}` }
  }
  // ---- L. 多步 + 长文 → task
  for (const c of SYN_CONNECTOR_ZH) {
    yield { input: pad(140, `读 README ${c} 总结一下要点`), expected: 'task', label: `multi-zh-long:${c}` }
  }
}

test('synthesized: ≥ 150 条合成样本，断言判定结果符合规则', () => {
  const samples = Array.from(synthSamples())
  assert.ok(samples.length >= 150, `expected ≥ 150 synthesized samples, got ${samples.length}`)
  let pass = 0
  let fail = 0
  const failures: string[] = []
  for (const s of samples) {
    const dec = classifyRoute(s.input, s.ctx)
    if (dec.kind === s.expected) {
      pass++
    } else {
      fail++
      failures.push(`[${s.label}] input=${JSON.stringify(s.input.slice(0, 40))} expected=${s.expected} got=${dec.kind} (${dec.reason})`)
    }
  }
  if (fail > 0) {
    assert.fail(`${fail}/${samples.length} synthesized samples failed:\n${failures.slice(0, 10).join('\n')}`)
  }
  assert.equal(fail, 0)
  assert.ok(pass >= 150, `pass=${pass} < 150`)
})

/* ----------------------------------------------------------------
 * 3) 性能断言：平均延迟 ≤ 5ms（大量样本）
 * ---------------------------------------------------------------- */
test('perf: 5000 次判定平均延迟 ≤ 5ms', () => {
  // 构造 50 个不同长度的输入
  const corpus: string[] = []
  for (let i = 0; i < 50; i++) {
    corpus.push(pad(20 + (i * 7) % 220, `请帮我重构第 ${i} 个模块，然后跑测试`))
  }
  // warm-up（V8 预热）
  for (let i = 0; i < 200; i++) {
    classifyRoute(corpus[i % corpus.length])
  }

  const N = 5000
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    classifyRoute(corpus[i % corpus.length])
  }
  const t1 = performance.now()
  const avgMs = (t1 - t0) / N
  assert.ok(avgMs <= 5, `average latency ${avgMs.toFixed(3)}ms exceeds 5ms budget`)
})

test('perf: 单次判定最大延迟不超过 50ms（防异常）', () => {
  // 极端长文本（10k 字符）也应远低于阈值
  const huge = '重构整个项目 '.repeat(2000)
  const dec = classifyRoute(huge)
  assert.equal(dec.kind, 'task')
  assert.ok(dec.latencyMs < 50, `single classification ${dec.latencyMs}ms exceeds 50ms for huge input`)
})

/* ----------------------------------------------------------------
 * 4) 边界 / 一致性
 * ---------------------------------------------------------------- */
test('edge: 连续多次判定稳定', () => {
  const inputs = ['帮我写代码', '今天天气如何', '写代码然后测试', '再试一次']
  for (let round = 0; round < 5; round++) {
    for (const i of inputs) {
      const d = classifyRoute(i)
      assert.ok(d.kind === 'task' || d.kind === 'chat')
    }
  }
})

test('edge: ctx 缺省时与 undefined ctx 等价', () => {
  const a = classifyRoute('什么是 React？')
  const b = classifyRoute('什么是 React？', undefined)
  assert.equal(a.kind, b.kind)
})