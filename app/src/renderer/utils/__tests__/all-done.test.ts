/* ============================================================
 * ArkWork — 完成横幅口径纯函数（v0.43.1 · TC-BANNER，对应 D217）
 *
 * 实机现象（任务 T-20261001-2r3063）：横幅渲染出无数字的「✓ 12/12 完成 · tokens」。
 * 根因两层：① `taskPanel.allDone` 模板硬编码 ` tokens` 后缀，而图快照
 * `budget.tokensUsed` 全仓从未写入非 0 值 → `formatTokens(0)` 返回空串；
 * ② `progressCounts`（completed+cancelled）把 2 个账本 `skipped` 计成「完成」。
 *
 * 修复口径：展示层诚实 —— 无数据整段隐藏；已跳过项显式补「含跳过 N」。
 * 统计语义（progressCounts / 头部 12/12）不动（快照契约明示口径）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs all-done
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { skippedCountOf, tokensLabelOf } from '../all-done'
import { formatTokens } from '../../components/graph/graphMeta'
/** 注释剥离器唯一真源（纪律㉒） */
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

test('TC-BANNER-001 skippedCountOf 真值表：undefined/空 → 0；9 态混合仅数 skipped', () => {
  assert.equal(skippedCountOf(undefined), 0, '无账本快照 → 0')
  assert.equal(skippedCountOf(null), 0, 'null 快照 → 0')
  assert.equal(skippedCountOf([]), 0, '空清单 → 0')
  assert.equal(
    skippedCountOf([
      { status: 'done' },
      { status: 'done' },
      { status: 'skipped' },
      { status: 'skipped' },
      { status: 'running' },
      { status: 'pending' },
      { status: 'failed' },
      { status: 'cancelled' },
      { status: 'verifying' },
    ]),
    2,
    '9 态混合只数 skipped（实机形态：10 完成 + 2 跳过 → 含跳过 2）',
  )
  assert.equal(skippedCountOf([{ status: 'done' }]), 0, '全完成无跳过 → 0（不渲染后缀）')
})

test('TC-BANNER-002 tokensLabelOf 真值表：0/undefined → null（整段隐藏）；非 0 → formatTokens 结果', () => {
  assert.equal(tokensLabelOf(undefined, formatTokens), null, '无数据 → null（不渲染 tokens 段，D217 主缺陷）')
  assert.equal(tokensLabelOf(0, formatTokens), null, '结构性 0（tokensUsed 未接线，L-43-01）→ null（显示 "0 tokens" 是假数据）')
  assert.equal(tokensLabelOf(500, formatTokens), '500', '小值原样')
  assert.equal(tokensLabelOf(182_200, formatTokens), '182.2k', '大值走 formatTokens 千分位缩写（单一事实源）')
  // 格式化函数返回空串（理论防御）→ 仍视为无数据
  assert.equal(tokensLabelOf(42, () => ''), null, 'formatter 空串 → null')
})

test('TC-BANNER-003 i18n 四语言：allDone 模板去硬编码 tokens 后缀；allDoneSkipped 四语言齐备', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
    const json = JSON.parse(read(`../../i18n/locales/${lang}.json`)) as {
      taskPanel: { allDone: string; allDoneSkipped: string }
    }
    assert.ok(json.taskPanel.allDone, `${lang}.taskPanel.allDone 存在`)
    assert.ok(json.taskPanel.allDone.includes('{{done}}') && json.taskPanel.allDone.includes('{{total}}'), `${lang} allDone 保留 done/total 占位`)
    assert.ok(!json.taskPanel.allDone.includes('tokens'), `${lang} allDone 模板不得再硬编码 tokens 段（空数据时渲染出「· tokens」即本缺陷）`)
    assert.ok(json.taskPanel.allDoneSkipped.includes('{{count}}'), `${lang} allDoneSkipped 须带 count 占位`)
  }
})

test('TC-BANNER-004 TaskPanel 源码守卫：横幅组装必须经 tokensLabelOf/skippedCountOf（无条件 tokens 段不得回潮）', () => {
  const panel = stripComments(read('../../components/dock/TaskPanel.tsx'))
  assert.ok(panel.includes('tokensLabelOf'), '横幅 tokens 段必须经 tokensLabelOf 判空（D217）')
  assert.ok(panel.includes('skippedCountOf'), '横幅必须消费 skippedCountOf 补「含跳过 N」')
  assert.ok(
    !panel.includes('tokens: formatTokens('),
    '旧形态回潮检测：allDone 直传 `tokens: formatTokens(...)` 会把空串塞进模板（D215 同型静默退化）',
  )
  assert.ok(panel.includes('allDoneSkipped'), '横幅须引用 taskPanel.allDoneSkipped 文案键')
})

test('TC-BANNER-005 ★ D218 实机回归守卫：横幅派生值不得用 useMemo（早退路径 hook 数漂移 → React #310 白屏）', () => {
  const panel = stripComments(read('../../components/dock/TaskPanel.tsx'))
  assert.match(panel, /(?:const|let) allDoneNoticeText/, '横幅派生值应存在')
  // 实机根因：TaskPanel 主组件在派生值之前有两个早退 return（轻量图回退
  // `<TodoPanel />` / 图 schema 损坏）——早退渲染的 hook 数比全量渲染少 1，
  // 快照到达后即 React #310「Rendered more hooks than during the previous
  // render」→ 整个渲染层崩到错误兜底页。派生展示态必须是普通计算。
  assert.doesNotMatch(panel, /allDoneNoticeText = useMemo/, 'D218 回潮检测：allDoneNoticeText 不得经 useMemo 创建')
  assert.doesNotMatch(panel, /allDoneNoticeText: string \| undefined\s*=\s*useMemo/, '同上（类型注解形态）')
})
