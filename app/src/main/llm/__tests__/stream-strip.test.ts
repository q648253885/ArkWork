/* ============================================================
 * v0.31.0 B1 — stream-strip.ts 单元测试（TC-STREAM-001…010）
 *
 * 依据：docs/versions/v0.31.0/04-system-design.md §6.1
 *      docs/versions/v0.31.0/testcases/00-cumulative-matrix.md §3.2
 * 验收：C-4（协议标记零泄漏）/ R5（畸形标记不永久吞内容）
 *
 * 防的是「流式期把 content 原文（含裸 `<<<SAY>>>` 标记）当成思考渲染」——
 * 这是 RC-2，也是用户「思考内容展示不全」症状里最容易看见的一半。
 *
 * 纪律：纯函数 + 有状态实例的密闭测试 —— 不 import electron / window，
 * 沿用 `llm-stream.ts` 既有纪律（源码契约类用例除外，见 TC-STREAM-006/009）。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/llm/__tests__/stream-strip.test.ts
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSayStripper, type StripChunk } from '../stream-strip.js'
import { MAX_SAY_CHARS, extractSayMarker } from '../say-marker.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const SRC = read('../stream-strip.ts')
const REASON_PHASE = read('../../agent/engine/reason-phase.ts')

/** 把若干批增量喂进剥离器并汇总输出（便于一次性断言） */
function feed(chunks: string[]): StripChunk[] {
  const s = createSayStripper()
  const out: StripChunk[] = []
  for (const c of chunks) out.push(...s.push(c))
  return out
}

const textOf = (out: StripChunk[]): string =>
  out.filter((c) => c.channel === 'text').map((c) => c.text).join('')
const sayOf = (out: StripChunk[]): string =>
  out.filter((c) => c.channel === 'say').map((c) => c.text).join('')

describe('stream-strip · TC-STREAM', () => {
  /* ---------- 001 单批完整标记 → 分流 ---------- */
  it('TC-STREAM-001 单批完整 `<<<SAY>>>…<<<END>>>` → say 通道输出、text 通道零输出', () => {
    const out = feed(['<<<SAY>>>结论：已完成<<<END>>>'])
    assert.equal(textOf(out), '', 'text 通道必须零输出（标记与 say 正文都不得漏进叙述通道）')
    assert.equal(sayOf(out), '结论：已完成')
    assert.equal(out.length, 1, '应恰好产出一个 say 片段')
  })

  /* ---------- 002 跨 delta 切分安全 ---------- */
  it('TC-STREAM-002 跨 delta 切分安全：`<<<SA` + `Y>>>` 分两批到达仍识别（未决字符不提前吐）', () => {
    const s = createSayStripper()
    // 半截开标记：一个字符都不能吐（否则下游永远拼不回完整标记）
    assert.deepEqual(s.push('<<<SA'), [], '开标记的半截前缀必须滞留')
    assert.deepEqual(s.push('Y>>>'), [], '闭合后进入 SAY 态但尚无正文 → 仍无输出')
    assert.deepEqual(s.push('正文<<<END>>>'), [{ channel: 'say', text: '正文' }])
    assert.equal(s.saySegments, 1)
  })

  /* ---------- 003 前缀不匹配 → 回吐不丢字 ---------- */
  it('TC-STREAM-003 前缀不匹配（`<<<SX`）→ 缓存字符回吐到 text 通道，一个字符不丢', () => {
    const s = createSayStripper()
    const out = s.push('<<<SX')
    assert.equal(textOf(out), '<<<SX', '误判为标记前缀的字符必须原样回吐')
    assert.equal(s.saySegments, 0, '未完整匹配不得计入 SAY 段数')
    // 后续正常文本继续透传
    assert.equal(textOf(s.push('abc')), 'abc')
  })

  /* ---------- 004 只看不说 ---------- */
  it('TC-STREAM-004 SAY 态内容绝不进 text 通道；闭合后状态回 CONTENT', () => {
    const s = createSayStripper()
    const a = s.push('<<<SAY>>>机密内容')
    assert.equal(textOf(a), '', 'SAY 态正文不得出现在 text 通道')
    const b = s.push('<<<END>>>后置文本')
    assert.equal(sayOf(b), '机密内容')
    assert.equal(textOf(b), '后置文本', '闭合后应回到 CONTENT 态继续透传')
  })

  /* ---------- 005 R5 超长兜底 ---------- */
  it('TC-STREAM-005 超长兜底（R5）：进 SAY 态后累计超 MAX_SAY_CHARS×2 未闭合 → 全部按 text 输出', () => {
    const body = 'x'.repeat(MAX_SAY_CHARS * 2 + 100)
    const s = createSayStripper()
    const out = s.push(`<<<SAY>>>${body}`)
    assert.equal(sayOf(out), '', '回退时不得残留 say 片段（否则通道归属前后矛盾）')
    assert.equal(textOf(out), body, '全部内容按 text 输出，不吞字')
    // 关键：回到可继续消费的形态，且其后到达的闭合标记不再泄漏（C-4）
    assert.equal(textOf(s.push('后续内容')), '后续内容', 'R5 后必须继续透传后续内容，不得永久吞掉')
    assert.equal(textOf(s.push('<<<END>>>')), '', '孤立的闭合标记必须被剔除（协议零泄漏）')
  })

  /* ---------- 006 阈值复用同一常量（源码契约） ---------- */
  it('TC-STREAM-006 阈值复用同一常量：从 llm/say-marker import，不硬编码 1200 / 600', () => {
    assert.match(
      SRC,
      /import\s*\{[^}]*MAX_SAY_CHARS[^}]*\}\s*from\s*'\.\/say-marker\.js'/,
      '必须从 say-marker 具名导入 MAX_SAY_CHARS（禁止在本模块另立阈值）',
    )
    assert.match(SRC, /MAX_SAY_CHARS\s*\*\s*2/, 'R5 阈值必须写作 MAX_SAY_CHARS × 2（可追溯来源）')
    // 允许出现在注释里的说明，但不得作为**字面量**出现在代码中
    const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(codeOnly, /\b1200\b/, '不得硬编码 1200')
    assert.doesNotMatch(codeOnly, /\b600\b/, '不得硬编码 600')
  })

  /* ---------- 007 多段标记 ---------- */
  it('TC-STREAM-007 多段标记连续出现 → 各段分流正确、段间 text 不污染', () => {
    const out = feed(['前言<<<SAY>>>第一条<<<END>>>中间<<<SAY>>>第二条<<<END>>>尾声'])
    assert.deepEqual(out, [
      { channel: 'text', text: '前言' },
      { channel: 'say', text: '第一条' },
      { channel: 'text', text: '中间' },
      { channel: 'say', text: '第二条' },
      { channel: 'text', text: '尾声' },
    ])
  })

  /* ---------- 008 零标记零开销 ---------- */
  it('TC-STREAM-008 完全无标记 → 原样逐字符透传（输出 === 输入）', () => {
    const plain = '普通叙述，无任何协议标记。\n第二行也正常。'
    assert.equal(textOf(feed([plain])), plain, '整串输入应原样输出')
    assert.equal(textOf(feed([...plain])), plain, '逐字符切分后拼回也必须一致')
    assert.equal(textOf(feed(['<', '<', 'a', 'b', '>', '>'])), '<<ab>>', '伪前缀不得被吞')
  })

  /* ---------- 009 不改最终数据（硬约束） ---------- */
  it('TC-STREAM-009 硬约束：流式剥离结论 ≠ 权威结论时，最终数据仍取 extractSayMarker', () => {
    // 构造分歧输入：超长 SAY 正文（> MAX_SAY_CHARS × 2 ⇒ 触发 R5）
    //   流式期 → 正文累积到上限时闭合标记**尚未到达**，据 R5 判定畸形，全部按 text 输出
    //   落定期 → 闭合标记随后到达，extractSayMarker 看到的是合法 SAY（正文超上限 → 截断）
    // 注意必须**分两批**喂入：单批喂入时闭合标记同时到达，剥离器不会走 R5 分支。
    const longBody = 'y'.repeat(MAX_SAY_CHARS * 2 + 300)
    const content = `<<<SAY>>>${longBody}<<<END>>>`

    const streamed = feed([`<<<SAY>>>${longBody}`, '<<<END>>>'])
    const streamSay = sayOf(streamed)
    const authoritative = extractSayMarker(content)

    // 先证明"确有分歧"（否则本用例是空转）
    assert.equal(streamSay, '', '流式剥离器在此输入上不产出 say（R5 已回退 text）')
    assert.equal(textOf(streamed), longBody, '回退内容应完整落在 text 通道（不吞字、不含标记）')
    assert.ok(authoritative.say, '落定期权威解析必须产出 say')
    assert.equal(authoritative.say.length, MAX_SAY_CHARS + 1, '权威 say 应被截断到上限 + 省略号')
    assert.equal(authoritative.thought, '', '权威 thought 应为空（SAY 之外无内容）')

    // 再证明权威来源不受流式结论影响：引擎仍取 adapter 的响应字段，
    // 剥离器产物只用于 text 通道（源码契约，防未来有人"顺手"用剥离结果落盘）
    assert.match(
      REASON_PHASE,
      /say:\s*response\.say/,
      'step.say 必须来自 adapter（extractSayMarker 产物），不得来自剥离器',
    )
    assert.match(
      REASON_PHASE,
      /if\s*\(chunk\.channel === 'text'\)\s*textPump\.push\(chunk\.text\)/,
      '剥离器产物只允许按 text 通道入泵；say 通道在流式期不外发',
    )
    assert.doesNotMatch(
      REASON_PHASE,
      /say:\s*pending|say:\s*stripper|chunk\.text\s*\/\/\s*say/,
      '不得出现「剥离器结论写入 step.say」的形态',
    )
  })

  /* ---------- 010 finish 残余兜底 ---------- */
  it('TC-STREAM-010 finish() 残余兜底：半截开标记 / 未闭合 SAY 一律回退 text', () => {
    // (a) CONTENT 态滞留的开标记半截前缀
    const a = createSayStripper()
    a.push('前面<<<SA')
    assert.deepEqual(a.finish(), [{ channel: 'text', text: '<<<SA' }], '半截开标记必须回退 text（不丢字）')
    assert.deepEqual(a.finish(), [], 'finish 幂等：再次调用无残余')

    // (b) SAY 态从未闭合 → 与 extractSayMarker「未闭合视为无 SAY」的口径一致
    const b = createSayStripper()
    b.push('<<<SAY>>>未闭合正文')
    assert.deepEqual(b.finish(), [{ channel: 'text', text: '未闭合正文' }], '未闭合 SAY 必须回退 text')

    // (c) R5 透传态滞留的半截闭合标记
    const c = createSayStripper()
    c.push(`<<<SAY>>>${'z'.repeat(MAX_SAY_CHARS * 2 + 1)}<<<EN`)
    const tail = textOf(c.finish())
    assert.equal(tail, '<<<EN', '透传态的半截闭合标记必须在 finish 时回吐（提示：其前的内容已按 text 输出）')
  })

  /* ---------- 补充：空增量与段数统计（非 TC 编号，防御性） ---------- */
  it('空增量不产生输出；saySegments 统计完整段数', () => {
    const s = createSayStripper()
    assert.deepEqual(s.push(''), [])
    s.push('<<<SAY>>>a<<<END>>>b<<<SAY>>>c<<<END>>>')
    assert.equal(s.saySegments, 2)
  })
})
