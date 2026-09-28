/* ============================================================
 * v0.36.0（B9.4 / F6.2 / P10）—— 计划确认卡 **UI 契约**（渲染层结构事实）
 *
 * 为什么是源码契约而不是渲染断言（沿用 permission-panel-contract / profile-ui-contract 体例）：
 *   · 卡片自订阅 `graph:update` + 走 ipc/client 读 `window` → node:test 无法 import；
 *   · 组件依赖 zustand + i18next（本仓无 jsdom）。
 * 因此这里守住**不可退化的结构事实**，并把语义交给主进程套件：
 *
 * ★ 组合关系（缺一层就有「全绿但功能坏」的空档）：
 *   本套件（渲染层结构）
 *     + `main/agent/graph/__tests__/graph-store-ipc.test.ts` TC-IPC-018/019
 *       （语义：勾选子集 → 未勾选＋后代 cancelled · 祖先受保护 · 覆盖率复算 · 空/未知 id 拒绝 · startExecution）
 *     + `main/agent/graph/pending.ts`（闸门瞬时态记账 approvedItemIds / editedItemIds）
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs plan-approval-contract
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
/** 源码守卫的注释剥离器唯一真源（v0.36.0 · D101 / D102） */
import { stripComments } from '@shared/utils/source-guard'

const APP = '../../../..'
/** 注意：R/CODE 的路径是**相对本测试文件**解析的 */
const R = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const CODE = (rel: string): string => stripComments(R(rel))

const CARD = '../graph/PlanApprovalCard.tsx'
const CARD_ABS = fileURLToPath(new URL(CARD, import.meta.url))
const TURNLIST = `${APP}/src/renderer/components/flow/TurnList.tsx`
const PRELOAD = `${APP}/src/preload/index.ts`
const IPC_TYPES = `${APP}/src/shared/types/ipc.ts`
const MAIN_IPC = `${APP}/src/main/ipc/graph.ts`
const LOCALES = `${APP}/src/renderer/i18n/locales`

const LANGS = ['zh', 'en', 'ja', 'ko'] as const
type PlanApprovalBlock = Record<string, string>
const localeBlock = (lang: string): PlanApprovalBlock =>
  (JSON.parse(R(`${LOCALES}/${lang}.json`)) as {
    taskPanel: { planApproval: PlanApprovalBlock }
  }).taskPanel.planApproval

/** 抽取 `{{var}}` 插值变量名（集合比较，顺序无关） */
const varsOf = (s: string): string[] => (s.match(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g) ?? []).map((m) => m.replace(/[{}\s]/g, '')).sort()

/* ============================================================
 * TC-PCARD-001：卡片真在渲染树里（防「写了组件没人挂」）
 * ============================================================ */

test('TC-PCARD-001 计划卡必须被 TurnList 真实渲染，且导出/文件都在位', () => {
  const s = CODE(TURNLIST)
  assert.match(s, /import \{ PlanApprovalCard \} from '\.\.\/graph\/PlanApprovalCard'/, '必须具名 import 卡片')
  assert.match(s, /<PlanApprovalCard taskId=\{task\?\.id \?\? ''\} \/>/, '必须在对话流里真实渲染（不是只 import）')
  assert.ok(existsSync(CARD_ABS), `${CARD} 必须存在`)
  // 卡片自订阅的增量通道必须是 kind==='plan'（执行期高频 graph:update 不得触发重拉）
  const c = CODE(CARD)
  assert.match(c, /window\.ark\.graph\.onUpdate/, '卡片必须自订阅 graph:update（对话流是独立消费方）')
  assert.match(c, /payload\.kind !== 'plan'/, '必须只对 plan 闸门事件刷新，避免执行期高频重拉')
})

/* ============================================================
 * TC-PCARD-002：F6.2 四项能力齐备（缺一即「增强」未落地）
 * ============================================================ */

test('TC-PCARD-002 F6.2 四项能力齐备：逐项勾选 / 行内改题 / 双出口 / 折叠计数', () => {
  const c = CODE(CARD)
  // ① 逐项勾选：复选框 + 勾选态派生自 excluded（未勾选集合）
  assert.ok(c.includes('type="checkbox"'), '每行必须有复选框')
  assert.match(c, /const on = !excluded\.has\(r\.id\)/, '勾选态必须由 excluded（未勾选集合）派生')
  // ② 行内改题：标题点击进入编辑
  assert.match(c, /setEditingId\(r\.id\)/, '标题点击必须进入行内编辑')
  assert.ok(c.includes('editedBadge'), '改过的项必须有「已调整」徽标')
  // ③ 双出口
  assert.ok(c.includes('approveSelected'), '必须有「批准所选并开始」')
  assert.ok(c.includes('keepOnly'), '必须有「仅保留计划不执行」')
  // ④ 折叠计数
  assert.ok(c.includes('approvedSelectedFold'), '成功态必须有「已批准 N/M 项」折叠文案')
})

/* ============================================================
 * TC-PCARD-003：默认全勾选 + 未动过勾选时**不传** approvedItemIds（旧行为零变化）
 * ============================================================ */

test("TC-PCARD-003 缺省 = 全选：excluded 初值空集，且仅在动过勾选时才传 approvedItemIds", () => {
  const c = CODE(CARD)
  assert.match(
    c,
    /useState<Set<string>>\(\(\) => new Set\(\)\)/,
    'excluded 初值必须是空集（= 默认全勾选），否则「缺省全选」语义不成立',
  )
  // 关键：excluded.size === 0 时载荷里不得出现 approvedItemIds —— 让主进程走 `?? nodeIds` 兜底，
  // 保证「用户没动过勾选」与旧版本行为逐字节一致（避免子集语义被静默激活）。
  assert.match(
    c,
    /\.\.\.\(excluded\.size > 0 && structureRows\.length > 0 \? \{ approvedItemIds: checkedIds \} : \{\}\)/,
    '仅在动过勾选时才携带 approvedItemIds（否则主进程按全选兜底）',
  )
})

/* ============================================================
 * TC-PCARD-004：行内编辑三键语义（Enter 提交 / Esc 取消 / 失焦提交）
 * ============================================================ */

test('TC-PCARD-004 行内编辑：Enter 与失焦提交、Esc 取消（且 Esc 后紧随的 blur 必须 no-op）', () => {
  const c = CODE(CARD)
  assert.match(c, /onBlur=\{\(\) => void commitEdit\(\)\}/, '失焦必须提交（鼠标点走不丢改题）')
  assert.match(c, /if \(e\.key === 'Enter'\)/, 'Enter 必须提交')
  assert.match(c, /if \(e\.key === 'Escape'\)/, 'Esc 必须取消')
  // Esc 先置空 editingId，紧随的 blur 看到 cur===null 即 no-op —— 否则「取消」会被 blur 追认为提交
  assert.match(c, /setEditingId\(\(cur\) => \{[\s\S]*?if \(cur === null\) return null/, 'commitEdit 必须对 editingId===null 短路（防 Esc 后被 blur 追认）')
  // 空标题 = 撤销该项改动（不是写入空标题）
  assert.match(c, /if \(trimmed\) next\[cur\] = trimmed/, '非空草稿才记入 edits')
  assert.match(c, /else delete next\[cur\]/, '清空草稿必须删掉该项改动')
})

/* ============================================================
 * TC-PCARD-005：「已调整」徽标只在**真改动**时出现
 * ============================================================ */

test('TC-PCARD-005 「已调整」徽标不得对未改动项显示（改回原文即视为未改动）', () => {
  const c = CODE(CARD)
  assert.match(
    c,
    /\{edited !== undefined && edited !== r\.title && \(/,
    '徽标判据必须是「有改动 且 与原文不同」—— 只判 undefined 会把改回原文的项也标成已调整',
  )
})

/* ============================================================
 * TC-PCARD-006：双出口的 startExecution 语义方向不能反
 * ============================================================ */

test('TC-PCARD-006 双出口：仅保留计划 = startExecution:false；批准所选并开始 = startExecution:true', () => {
  const c = CODE(CARD)
  assert.match(
    c,
    /void decide\('approve', \{ \.\.\.approveExtra, startExecution: false \}\)/,
    '「仅保留计划不执行」必须传 startExecution:false',
  )
  assert.match(
    c,
    /void decide\('approve', \{ \.\.\.approveExtra, startExecution: true \}\)/,
    '「批准所选并开始」必须传 startExecution:true',
  )
  // 两个出口都必须带上 approveExtra（勾选子集 + 改题），否则「仅保留」会丢掉勾选
  const keepOnlyIdx = c.indexOf('startExecution: false')
  const extraCount = (c.match(/\.\.\.approveExtra/g) ?? []).length
  assert.equal(extraCount, 2, '两个批准出口都必须展开 approveExtra（勾选 + 改题不可只挂一个出口）')
  assert.ok(keepOnlyIdx > 0, '保留出口必须存在')
})

/* ============================================================
 * TC-PCARD-007：零勾选 / 覆盖率不足 → 两个批准按钮都必须禁用（I7 + 空集语义）
 * ============================================================ */

test('TC-PCARD-007 零勾选与覆盖率不足时，两个批准按钮都禁用（前端兜底，主进程另有一道）', () => {
  const c = CODE(CARD)
  const disabled = (c.match(/disabled=\{!coverageOk \|\| busy \|\| noneChecked\}/g) ?? []).length
  assert.equal(disabled, 2, '「仅保留计划不执行」与「批准所选并开始」都必须被同一条件禁用')
  assert.match(
    c,
    /const noneChecked = structureRows\.length > 0 && checkedIds\.length === 0/,
    'noneChecked 必须只在「有结构项但一个都没勾」时成立（零结构项属空态，不属零勾选）',
  )
  // 禁用必须给得出理由（避免「按钮灰了不知道为什么」）
  assert.ok(c.includes('approveNoneHint'), '零勾选禁用必须给悬停理由')
  assert.ok(c.includes('coverageMissing'), '覆盖率不足禁用必须给缺失 AC 列表')
})

/* ============================================================
 * TC-PCARD-008：成功态折叠条条件化（有勾选记录 → N/M；旧路径 → 旧文案）
 * ============================================================ */

test('TC-PCARD-008 成功态折叠：有 approvedItemIds 才显示「N/M 项」，否则保持旧折叠文案', () => {
  const c = CODE(CARD)
  assert.match(c, /const approvedN = plan\.approvedItemIds\?\.length/, '折叠计数必须取自闸门瞬时态记录')
  assert.match(
    c,
    /approvedN !== undefined\s*\?\s*t\('taskPanel\.planApproval\.approvedSelectedFold'/,
    '有勾选记录 → 显示「已批准 N/M 项」',
  )
  assert.match(
    c,
    /:\s*t\('taskPanel\.planApproval\.approvedFold'/,
    '无勾选记录（旧路径）→ 保持旧折叠文案，不倒退成 0/M',
  )
})

/* ============================================================
 * TC-PCARD-009：闸门轮换必须重置本地勾选与改题
 * ============================================================ */

test('TC-PCARD-009 闸门轮换（换任务 / 打回后重规划）必须清空勾选、改题与编辑态', () => {
  const c = CODE(CARD)
  assert.match(c, /const planState = plan\?\.state/, '必须以闸门态作为轮换信号')
  assert.match(c, /\}, \[taskId, planState\]\)/, '重置副作用的依赖必须是 [taskId, planState]')
  const resetIdx = c.indexOf('[taskId, planState])')
  const scope = resetIdx >= 0 ? c.slice(Math.max(0, c.lastIndexOf('useEffect', resetIdx)), resetIdx) : ''
  for (const call of ['setExcluded(new Set())', 'setEdits({})', 'setEditingId(null)', "setDraft('')"]) {
    assert.ok(scope.includes(call), `轮换重置必须包含 ${call}（否则上一轮选择串到下一轮）`)
  }
})

/* ============================================================
 * TC-PCARD-010：P10 空态 —— 无结构项时直接提示（D109）
 * ============================================================ */

test('TC-PCARD-010 P10 空态：无结构项时给提示，且**不得**连带禁用批准（防功能回归）', () => {
  const c = CODE(CARD)
  assert.match(c, /\{structureRows\.length === 0 && \(/, '结构行为空时必须渲染空态提示分支')
  assert.ok(c.includes('planApproval.itemsEmpty'), '空态必须使用 itemsEmpty 文案')
  // 反向：空态不得并入 disabled 条件 —— 零 AC 的退化图仍可批准执行（既有语义，主进程 approvedItemIds 缺省兜底）
  assert.doesNotMatch(
    c,
    /disabled=\{!coverageOk \|\| busy \|\| noneChecked \|\| structureRows\.length === 0\}/,
    '空态不得禁用批准按钮（会把「可执行」变成「不可执行」的功能回归）',
  )
})

/* ============================================================
 * TC-PCARD-011：四语言键 parity（F6.2 全部新键 × 4 语言 + 插值变量名一致）
 * ============================================================ */

test('TC-PCARD-011 F6.2 计划卡文案四语言 parity（键集一致 + 插值变量名一致）', () => {
  const F62_KEYS = [
    'approveSelected',
    'keepOnly',
    'keepOnlyHint',
    'approveNoneHint',
    'itemCheckbox',
    'editItemHint',
    'editedBadge',
    'itemsEmpty',
    'approvedSelectedFold',
  ]
  const zh = localeBlock('zh')
  for (const k of F62_KEYS) {
    assert.ok(typeof zh[k] === 'string' && zh[k].trim().length > 0, `zh 缺 F6.2 文案键 ${k}`)
  }
  for (const lang of LANGS) {
    const blk = localeBlock(lang)
    // ① 键集与 zh 完全一致（多一个孤儿键 / 少一个键都是漂移）
    assert.deepEqual(
      Object.keys(blk).sort(),
      Object.keys(zh).sort(),
      `${lang} 的 taskPanel.planApproval 键集必须与 zh 完全一致`,
    )
    // ② 每个键的插值变量名一致（{{approved}}/{{total}} 写错就是运行期显示字面量）
    for (const k of Object.keys(zh)) {
      assert.deepEqual(varsOf(blk[k]), varsOf(zh[k]), `${lang}.${k} 的插值变量名必须与 zh 一致`)
    }
  }
  // ③ 折叠文案的两个变量必须真被用在句子里（不能只声明不插值）
  assert.deepEqual(varsOf(zh.approvedSelectedFold), ['acs', 'approved', 'total'])
})

/* ============================================================
 * TC-PCARD-012：文案纪律（禁「诊断」用户可见词 / 禁 emoji）
 * ============================================================ */

test('TC-PCARD-012 计划卡文案纪律：不得出现「诊断」字样，不得用 emoji 充当图标', () => {
  // 只取**绘文字区**（1F300–1FAFF + 变体选择符）—— 刻意排除 Dingbats（2600–27BF）：
  // 既有 degradeTier 文案用 `①✗` 作**排印符号**而非 emoji，收进范围会造成假红（实测确认）。
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{FE0F}]/u
  for (const lang of LANGS) {
    const blk = localeBlock(lang)
    for (const [k, v] of Object.entries(blk)) {
      assert.doesNotMatch(v, /诊断|診断|진단/, `${lang}.${k} 不得出现「诊断」字样（项目文案纪律：用用户语言）`)
      assert.doesNotMatch(v, /Diagnostics/i, `${lang}.${k} 不得出现 Diagnostics（面向用户的是「未生效的能力」）`)
      assert.ok(!EMOJI.test(v), `${lang}.${k} 不得用 emoji 充当图标（一律走 Icon.*）`)
    }
  }
})

/* ============================================================
 * TC-PCARD-013：F6.2 载荷字段「一处类型、三处引用」不漂移
 * ============================================================ */

test('TC-PCARD-013 F6.2 载荷三处同步：preload 通道 / ipc 类型 / 主进程消费字段完全一致', () => {
  // ① preload 通道名
  const pre = CODE(PRELOAD)
  assert.match(pre, /decidePlan: \(payload\) => ipcRenderer\.invoke\('graph:decide-plan', payload\)/, 'preload 必须原样透传 payload')
  // ② 类型定义（唯一真源）
  const types = CODE(IPC_TYPES)
  for (const field of ['approvedItemIds?: string[]', 'nodeEdits?: { id: string; title: string }[]', 'startExecution?: boolean']) {
    assert.ok(types.includes(field), `GraphPlanDecisionPayload 缺字段 ${field}`)
  }
  // ③ 主进程真消费这三个字段（缺一条就是「类型有、没人读」的静默空转）
  const main = CODE(MAIN_IPC)
  assert.match(main, /const approvedIds = p\.approvedItemIds \?\? nodeIds/, '缺省 = 全选（旧行为）必须显式写在主进程')
  assert.match(main, /for \(const e of p\.nodeEdits \?\? \[\]\)/, '主进程必须消费 nodeEdits')
  assert.match(main, /if \(p\.startExecution !== false\)/, 'startExecution 必须按「只有显式 false 才不执行」判定')
})
