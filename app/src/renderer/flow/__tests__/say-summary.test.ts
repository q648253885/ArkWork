/* ============================================================
 * ArkWork — 交互区展示对齐 ZCode（v0.41.0 / D210）
 * TC-FLW-003…005（矩阵 §二 模块 S；001/002 在 flow/project.test.ts）
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs say-summary
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '@shared/utils/source-guard'
import { lastResultSummaryOf } from '@shared/utils/flow-fold'
import type { FlowBlock } from '@shared/types/flow'

const FLOW = fileURLToPath(new URL('../..', import.meta.url)) // app/src/renderer/flow/
const codeOf = (p: string): string => stripComments(readFileSync(join(FLOW, p), 'utf-8'))

let seq = 0
const toolBlock = (over: {
  summary?: string
  status?: 'success' | 'failed' | 'guarded' | 'running'
  errorMessage?: string
}): FlowBlock => {
  seq += 1
  return {
    kind: 'tool',
    id: `t${seq}`,
    turn: 1,
    step: 1,
    call: { card: 'generic', title: `工具${seq}` },
    result: over.summary === undefined ? undefined : { card: 'generic', summary: over.summary },
    status: over.status ?? 'success',
    startedAt: 1_000 + seq,
    durationMs: 10,
    ...(over.errorMessage ? { errorMessage: over.errorMessage } : {}),
  }
}

test('TC-FLW-003 lastResultSummaryOf：取最后一个有结果摘要的块；失败优先；空 → 空串', () => {
  const runs = [
    toolBlock({ summary: '读取 src/a.ts · 120 行' }),
    toolBlock({ summary: '读取 src/b.ts · 40 行' }),
  ]
  assert.equal(lastResultSummaryOf(runs), '读取 src/b.ts · 40 行', '取最后一个（最新进展）')
  // 失败优先：任一失败块 → 显示失败信息（即使它不是最后一个）
  const withFail = [runs[0]!, toolBlock({ status: 'failed', errorMessage: 'shell 退出码 1' }), runs[1]!]
  assert.equal(lastResultSummaryOf(withFail), 'shell 退出码 1')
  // 纯思考 run → 空串
  assert.equal(lastResultSummaryOf([]), '')
  // 超长按码点截断 60 + 省略号
  const long = toolBlock({ summary: '长'.repeat(80) })
  const out = lastResultSummaryOf([long])
  assert.equal(Array.from(out).length, 61, '60 字 + 省略号，不劈代理对')
  assert.ok(out.endsWith('…'))
})

test('TC-FLW-004 AnswerBlock 强调容器：三种形态统一左主色边、无底色（v0.42.0 降调：线 ≠ 面）', () => {
  const code = codeOf('components/flow/blocks/AnswerBlock.tsx')
  // v0.42.0 语义变更（用户反馈「蓝色背景有点奇怪」+ 配色纪律）：bg-accent-soft 铺底退役，
  // 强调信号收窄为左 2px 主色边线。纪律㉔ 两条腿钉：
  assert.doesNotMatch(code, /bg-accent-soft/, '浅蓝铺底不得回归（TC-UI42-001 同源，双重把守）')
  assert.match(code, /border-l-2 border-l-accent/, '左主色边线必须保留（「最终答复 = 唯一强终点」不推翻）')
  assert.equal((code.match(/shell}/g) ?? []).length >= 3, true, '流式 / 未分层 / 分层三种形态都包裹')
  assert.match(code, /data-testid="answer-layered"/, '分层渲染标识不回退')
})

test('TC-FLW-005 ReasoningBlock userOpen 入 store（重挂载不丢意图，与 ProcessFold 同模式）', () => {
  const code = codeOf('components/flow/blocks/ReasoningBlock.tsx')
  assert.doesNotMatch(code, /useState<boolean \| null>/, '组件 useState 形态必须移除（虚拟化后丢意图）')
  assert.match(code, /flow\.blockUiState\[block\.id\]/, '展开意图必须存 store blockUiState')
  assert.match(code, /uiState\?\.userOpen/, 'userOpen 必须真的读自 store（有写无读 = 静默丢失，纪律㊳）')
  assert.match(code, /setBlockOpen\(block\.id, !showFull\)/, '切换必须走 setBlockOpen（userOpen 三态语义）')
  assert.match(code, /resolveReasoningOpen/, '解析链保持（既有契约 TC-THINK-001…003 方向不变）')
})
