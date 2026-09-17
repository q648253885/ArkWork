/* ============================================================
 * v0.31.0 B1 — 思考双通道贯通（TC-DUAL-001…008）
 *
 * 依据：docs/versions/v0.31.0/testcases/00-cumulative-matrix.md §3.4
 *      docs/versions/v0.31.0/04-system-design.md §2.3 / §6.1 / §6.2
 *      agent_learn/docs/interaction-display-v1.0/04（G1–G5 / G7 / G11 / G13）
 *
 * 防的是 RC-1：`reason-phase.ts` 只接线 `onText`，`onReasoning` 全仓库无消费方
 * → 真思考从未进入 UI（症状①「思考内容展示不全」的根因）。
 *
 * ── 载体说明（对矩阵 §3.4 的取向）────────────────────────────
 * `reason-phase` 依赖真实 LLM 与 electron 运行时，node:test 无网络/无窗口，
 * 无法端到端跑。故本条采用**双轨**：
 *   ① 源码契约（readFileSync + 匹配）：锁结构性不变量（接线存在、签名四参、
 *      字段落位、透传不改类型）—— 这类不变量一旦被误改，行为测试也测不到；
 *   ② 纯函数行为（真实调用）：来源判定、摘要首句、占位场景 —— 这些有独立实现，
 *      能跑行为就不该只做正则（比矩阵原始要求**更强**）。
 *
 * 运行（cwd=app）：
 *   node scripts/run-tests.mjs reason-dual-channel
 * ============================================================ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EMPTY_REASON_KEY,
  deriveReasoningSource,
  describeEmptyReason,
  reasoningText,
  firstSentence,
} from '@shared/utils/reasoning'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')

const REASON_PHASE = read('../reason-phase.ts')
const ABORT = read('../abort.ts')
const LLM_STREAM = read('../../llm-stream.ts')
const IPC = read('../../../../shared/types/ipc.ts')
const PRELOAD = read('../../../../preload/index.ts')
// v0.31.0 B4 载体收敛：ThoughtStream.tsx 下线，思考块契约转写到
// components/flow/blocks/ReasoningBlock.tsx + 投影层 flow/project.ts（§4.1 登记表）
const REASONING_BLOCK = read('../../../../renderer/components/flow/blocks/ReasoningBlock.tsx')
const FLOW_PROJECT = read('../../../../renderer/flow/project.ts')

/** 去掉注释后的源码：避免「注释里提到过」被误判为「实现里有」。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const REASON_PHASE_CODE = stripComments(REASON_PHASE)
const LLM_STREAM_CODE = stripComments(LLM_STREAM)
const REASONING_BLOCK_CODE = stripComments(REASONING_BLOCK)
const FLOW_PROJECT_CODE = stripComments(FLOW_PROJECT)

describe('reason-dual-channel · TC-DUAL', () => {
  /* ---------- 001 onReasoning 接线（RC-1 根因） ---------- */
  it('TC-DUAL-001 `completeWithStream` handlers 传入 `onReasoning`（RC-1 根因修复落码）', () => {
    assert.match(
      REASON_PHASE_CODE,
      /onReasoning:\s*\(\s*d\s*\)\s*=>/,
      'handlers 必须包含 onReasoning —— 这是「真思考从未进入 UI」的根因，缺它整条链断',
    )
    // 两条通道必须各自入泵（而非把 reasoning 也塞进 text 泵）
    assert.match(
      REASON_PHASE_CODE,
      /onReasoning:\s*\(\s*d\s*\)\s*=>\s*reasoningPump\.push\(d\)/,
      'onReasoning 必须入 reasoningPump（若入 textPump 则通道分离失效）',
    )
    // 反面：onText 不得直接把原文推进 text 泵（必须过剥离器）
    assert.doesNotMatch(
      REASON_PHASE_CODE,
      /onText:\s*\(\s*d\s*\)\s*=>\s*textPump\.push\(d\)/,
      'onText 必须先过 createSayStripper（否则裸 <<<SAY>>> 会流到 UI —— RC-2）',
    )
  })

  /* ---------- 002 四参签名 + 两个 pump 通道分离 ---------- */
  it('TC-DUAL-002 `createTextDeltaPump` 四参签名存在，且两泵分别以 text / reasoning 构造', () => {
    assert.match(
      LLM_STREAM_CODE,
      /export function createTextDeltaPump\(\s*taskId:\s*string,\s*scope:\s*TextDeltaScope,\s*kind:\s*TextDeltaKind,\s*send:\s*TextDeltaSender,\s*\)/,
      '泵签名必须含第三维 kind —— 缺它两条通道会撞同一缓冲（RC-1 表现面）',
    )
    assert.match(
      REASON_PHASE_CODE,
      /createTextDeltaPump\(\s*task\.id,\s*'turn',\s*'text',\s*sendTextDelta\s*\)/,
      '叙述泵必须是 (turn, text)',
    )
    assert.match(
      REASON_PHASE_CODE,
      /createTextDeltaPump\(\s*task\.id,\s*'turn',\s*'reasoning',\s*sendTextDelta\s*\)/,
      '思考泵必须是 (turn, reasoning) —— 与叙述泵正交，各自计 seq',
    )
    // 广播载荷必须带上 kind（否则渲染层拿不到通道维）
    assert.match(LLM_STREAM_CODE, /const payload:\s*TaskTextDeltaPayload\s*=\s*\{[^}]*kind/s, '广播载荷必须含 kind')
  })

  /* ---------- 003 reasoning 落盘到 step（append-only） ---------- */
  it('TC-DUAL-003 `reasoning` 落盘到 step 的独立字段，且 append-only 不改写历史（U6）', () => {
    // 落 step：reasonStep 构造里出现 reasoning 字段
    assert.match(
      REASON_PHASE_CODE,
      /const reasonStep:\s*ReActStep\s*=\s*\{[\s\S]*?reasoning:\s*response\.reasoningContent/,
      '原生思考必须落到 step.reasoning（正本 G2 / C-1 断言的就是该字段）',
    )
    // 落事件：reason_end 也带 reasoning（订阅方无需回读 L1 raw）
    assert.match(
      REASON_PHASE_CODE,
      /type:\s*'reason_end',[\s\S]*?reasoning:\s*response\.reasoningContent/,
      'reason_end 事件必须随附 reasoning',
    )
    // append-only：L1 写入口径未被改写（thought 仍是 content 剥离物，reasoning 进 raw）
    assert.match(
      REASON_PHASE_CODE,
      /content:\s*response\.thought/,
      '`thought` 的既有语义（content 剥离 SAY 后的剩余物）不得被 reasoning 污染',
    )
    assert.match(
      REASON_PHASE_CODE,
      /raw:\s*response\.reasoningContent\s*\?\s*\{\s*reasoningContent:\s*response\.reasoningContent\s*\}\s*:\s*undefined/,
      'append-only 真源：reasoning 仍写 L1 raw.reasoningContent（新增 step 字段只是暴露同一数据）',
    )
  })

  /* ---------- 004 文本思考来源判定（行为） ---------- */
  it('TC-DUAL-004 「文本思考」来源判定：reasoning 无数据但 thought 非空 → source = content（G4）', () => {
    assert.equal(deriveReasoningSource({ reasoning: undefined, thought: '先确认脚本类型，再跑 typecheck。' }), 'content')
    assert.equal(deriveReasoningSource({ reasoning: '原生推理链…', thought: 'any' }), 'native', '原生通道胜出')
    assert.equal(deriveReasoningSource({ reasoning: '  ', thought: '  ' }), 'none', '纯空白不算内容（否则占位分支与统计口径分叉）')
    assert.equal(deriveReasoningSource({ reasoning: '', thought: '' }), 'none')
    // 展示文本：原生优先，回落 content
    assert.equal(reasoningText({ reasoning: 'N', thought: 'C' }), 'N')
    assert.equal(reasoningText({ reasoning: undefined, thought: 'C' }), 'C')
  })

  /* ---------- 005 折叠态摘要含首句（行为 + 渲染契约） ---------- */
  it('TC-DUAL-005 折叠头行 =「思考」标签 + 展开正文含全文（v0.31.0 C1 用户裁决：首句摘要与正文重复，删除）', () => {
    // B4 载体注记：say 首句优先的 reasoningSummary 已随块拆分删除 —— say 现在
    // 独立渲染为 SayBlock（全文可见），RC-4「把内部思考当面向用户摘要」的顾虑
    // 随之消解。
    // C1 载体注记（2026-09-17 用户裁决）：折叠头行不再渲染 block.summary ——
    // 展开正文必含同一首句，两处同文属重复；头行改为固定「思考」标签
    // （t('thought.label')），Trae Work 式交互。firstSentence 口径仍保留在
    // 投影层（数据契约 / TurnFooter 等消费者不变）。
    // 行为：native 来源取原生思考首句（投影层数据契约不变）
    assert.equal(
      firstSentence(reasoningText({ reasoning: '我在核对接口签名。第二句不该出现。', thought: '' })),
      '我在核对接口签名',
    )
    // 行为：content 来源（原生通道空）回落到 thought 剥离物的首句
    assert.equal(
      firstSentence(reasoningText({ reasoning: undefined, thought: '内容思考首句。' })),
      '内容思考首句',
    )
    // 行为：两通道皆空 → 空串（此时 UI 显示来源徽标 + 占位解释原因）
    assert.equal(firstSentence(reasoningText({ reasoning: '', thought: '' })), '')

    // 渲染契约：投影层数据口径不变 + 头行渲染「思考」标签、不再渲染 block.summary
    assert.match(
      FLOW_PROJECT_CODE,
      /summary:\s*firstSentence\(/,
      '投影层摘要数据仍走 firstSentence 统一口径（数据消费者依赖，流式/落定两态同长度）',
    )
    assert.match(REASONING_BLOCK_CODE, /thought\.label/, '折叠头行必须有「思考」标签渲染落点')
    assert.match(REASONING_BLOCK_CODE, /react-reason__label/, '「思考」标签必须有独立渲染节点（否则只有时长）')
    assert.doesNotMatch(
      REASONING_BLOCK_CODE,
      /react-reason__summary/,
      '首句摘要节点已删（与展开正文重复）——若恢复必须同步修订本契约',
    )
    assert.doesNotMatch(
      REASONING_BLOCK_CODE,
      /block\.summary/,
      '思考块 UI 不再消费 block.summary（数据层保留供其他消费者）',
    )
  })

  /* ---------- 006 空思考占位，无 return null ---------- */
  it('TC-DUAL-006 空思考渲染占位（4 场景文案齐备），源码内不存在 `return null` 路径（C-7 / G11）', () => {
    // 行为：四场景判定齐备且可分（统一一句「无思考」等于把三种原因糊成一个）
    assert.equal(describeEmptyReason({ status: 'failed', action: undefined, reasoning: '', thought: '' }), 'failed')
    assert.equal(describeEmptyReason({ status: 'success', action: { tool: 'file-reader', args: {} }, reasoning: '', thought: '' }), 'directExec')
    assert.equal(describeEmptyReason({ status: 'success', action: undefined, reasoning: '', thought: '' }, true), 'budgetExhausted')
    assert.equal(describeEmptyReason({ status: 'success', action: undefined, reasoning: '', thought: '' }), 'noChannel')
    // 四场景必须有各自的 i18n 键，且互不相同
    const keys = Object.values(EMPTY_REASON_KEY)
    assert.equal(new Set(keys).size, 4, '四场景文案键必须互不相同')

    // 源码契约：不存在 `if (!thought) return null` 这类静默消失路径
    assert.doesNotMatch(
      REASONING_BLOCK_CODE,
      /if\s*\(\s*!\s*thought\s*\)\s*return\s+null/,
      '空思考必须渲染占位，不得 return null（块静默消失 = RC-3 t3）',
    )
    assert.match(REASONING_BLOCK_CODE, /EMPTY_REASON_KEY\[emptyKind\]/, '占位文案必须经 EMPTY_REASON_KEY 取键渲染')

    // i18n：4 语言键集必须齐备且一致（C-G4）
    const locales = ['zh', 'en', 'ja', 'ko']
    const keySets = locales.map((l) => {
      const json = JSON.parse(read(`../../../../renderer/i18n/locales/${l}.json`)) as {
        thought?: { placeholder?: Record<string, string>; source?: Record<string, string> }
      }
      return {
        lang: l,
        placeholder: Object.keys(json.thought?.placeholder ?? {}).sort(),
        source: Object.keys(json.thought?.source ?? {}).sort(),
      }
    })
    for (const ks of keySets) {
      assert.deepEqual(ks.placeholder, ['budgetExhausted', 'directExec', 'failed', 'noChannel'], `${ks.lang}: 占位四场景键集不齐`)
      assert.deepEqual(ks.source, ['content', 'native', 'none'], `${ks.lang}: 来源徽标三键不齐`)
    }
  })

  /* ---------- 007 中断双通道留存 ---------- */
  it('TC-DUAL-007 中断后保留两个通道的部分思考（C-9 / G13）', () => {
    // 调用点：两个泵的 accumulated 一起交给 persistAbortedReason（不再只落 text）
    assert.match(
      REASON_PHASE_CODE,
      /persistAbortedReason\([\s\S]{0,240}?thought:\s*turnPumpRef\.current\?\.accumulated[\s\S]{0,120}?reasoning:\s*reasonPumpRef\.current\?\.accumulated/,
      '中断落盘必须同时传 thought 与 reasoning 两个通道（RC-12：此前只落 text → 连部分思考都没有）',
    )
    assert.doesNotMatch(
      REASON_PHASE_CODE,
      /persistAbortedReason\(\s*task\.id,\s*iteration,\s*startedAt,\s*turnPumpRef/,
      '不得残留旧形态「单通道字符串参数」',
    )
    // 被调方：双通道各自落到 step 的独立字段，互不覆盖
    assert.match(
      ABORT,
      /channels:\s*\{\s*thought:\s*string;\s*reasoning:\s*string\s*\}/,
      'persistAbortedReason 必须收双通道对象',
    )
    assert.match(ABORT, /reasoning:\s*trimmedReasoning\s*\|\|\s*undefined/, '中断 step 必须带 reasoning 字段')
    assert.match(
      ABORT,
      /if\s*\(\s*!\s*trimmed\s*&&\s*!\s*trimmedReasoning\s*\)\s*return/,
      '两路都空时直接返回，不得产生空 step',
    )
  })

  /* ---------- 008 载荷契约 + preload 透传 ---------- */
  it('TC-DUAL-008 `TaskTextDeltaPayload` 增 `kind`；preload 透传不重声明类型', () => {
    assert.match(IPC, /export type TextDeltaKind\s*=\s*'text'\s*\|\s*'reasoning'/, 'kind 联合类型必须存在')
    assert.match(
      IPC,
      /export interface TaskTextDeltaPayload\s*\{[\s\S]*?scope:\s*'turn'\s*\|\s*'chat'[\s\S]*?kind:\s*TextDeltaKind[\s\S]*?seq:\s*number/,
      'kind 必须与 scope 正交地挂进载荷（不扩 scope 枚举）',
    )
    // preload：走 Parameters<typeof cb>[0] 推导，不重复声明类型（§5.3 契约纪律）
    assert.match(PRELOAD, /onTextDelta:\s*\(cb\)\s*=>/, 'preload 必须暴露 onTextDelta')
    assert.match(PRELOAD, /ipcRenderer\.on\('task:text-delta',\s*handler\)/, 'preload 必须订阅 task:text-delta')
    assert.match(PRELOAD, /Parameters<typeof cb>\[0\]/, 'preload 必须由回调签名推导载荷类型（透传）')
    assert.doesNotMatch(PRELOAD, /TaskTextDeltaPayload/, 'preload 不得重声明/重复引用载荷类型（双份定义会静默漂移）')
  })
})
