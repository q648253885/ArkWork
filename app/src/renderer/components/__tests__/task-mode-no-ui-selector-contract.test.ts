/**
 * v0.37.0 详测 — 「任务模式 / 复杂度档位由模型自选」的 UI 守卫（TC-UIMODE-001…005）
 *
 * 依据：docs/versions/v0.37.0/02-prd.md F7 / 04-system-design.md §5.2
 *       docs/versions/v0.37.0/testcases/00-cumulative-matrix.md §二 模块 D
 *
 * 用户诉求原文：
 *   「模型使用哪种任务模式，应该由模型选择，取消 UI 层面用户选择 T1-T4 模式的选项。」
 *
 * 为什么必须用**源码守卫**钉住（而不是只改一次代码）：
 *   v0.30.1 曾专门把 tier 徽章做成**可点升降级**的下拉菜单（当时的诉求是"让用户
 *   看得懂并可覆盖"）。同一个组件在两次需求之间来回摆动，只靠人记是记不住的 ——
 *   必须有用例在**下一版有人顺手加回下拉框**时立刻报红。
 *
 * 本套件是源码契约（无 DOM）：断言"控件不存在"这个**否定性不变量**，
 * 以及只读徽标 / 缺段占位这些**肯定性不变量**同时成立（防止"删干净了但也删掉了展示"）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs task-mode-no-ui
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const { stripComments } = await import('@shared/utils/source-guard.js')
const readCode = (rel: string): string => stripComments(read(rel))

const TASK_PANEL = readCode('../../components/dock/TaskPanel.tsx')
const PLAN_APPROVAL = readCode('../../components/graph/PlanApprovalCard.tsx')
const USE_GRAPH = readCode('../../components/graph/useGraph.ts')
const TODO_PANEL = readCode('../../components/dock/TodoPanel.tsx')
const ANSWER_BLOCK = readCode('../../components/flow/blocks/AnswerBlock.tsx')
const ANSWER_LAYERS = readCode('../../../shared/utils/answer-layers.ts')

/* ============================================================
 * 一、任务模式：UI 无任何选择入口，只有只读徽标
 * ============================================================ */

test('TC-UIMODE-001 TaskPanel 不再有档位升降级下拉（只读徽标保留）', () => {
  assert.doesNotMatch(TASK_PANEL, /onSetTier/, 'TaskPanel 不应再接收档位设置回调')
  assert.doesNotMatch(TASK_PANEL, /setTierMenuOpen|tierMenuOpen/, '不应再有档位菜单开合状态')
  assert.doesNotMatch(TASK_PANEL, /graph\.setTier/, '不应再调用 graph:set-tier IPC')
  assert.doesNotMatch(TASK_PANEL, /taskPanel\.tierOverrideHint/, '不应再渲染"可覆盖档位"提示')
  // 只读展示必须还在（否则就是"把展示一起删掉了"）
  assert.match(TASK_PANEL, /data-testid="graph-tier-badge"/, '应保留只读档位徽标')
  assert.match(TASK_PANEL, /tierLabel\(snapshot\.tier, i18n\.language\)/, '徽标应继续显示档位释义')
  assert.match(
    TASK_PANEL,
    /title=\{snapshot\.tierReason \?\? tierLabel\(snapshot\.tier, i18n\.language\)\}/,
    'title 应继续给出判定理由（用户仍能知道"为什么是这个档位"）',
  )
})

test('TC-UIMODE-002 PlanApprovalCard 同样只读，且 useGraph 不再暴露 setTier', () => {
  assert.doesNotMatch(PLAN_APPROVAL, /setTier|TIERS|tierMenuOpen/, '计划批准卡不应再有档位覆盖入口')
  assert.doesNotMatch(PLAN_APPROVAL, /planApproval\.tierOverrideHint/, '不应再渲染覆盖提示')
  assert.match(PLAN_APPROVAL, /data-testid="plan-approval-tier-badge"/, '应保留只读档位徽标')
  assert.doesNotMatch(USE_GRAPH, /setTier/, '渲染层的 useGraph 不应再暴露 setTier（档位判定权归模型/引擎）')
})

/* ============================================================
 * 二、全仓扫描：渲染层不得出现"模式选择"类控件
 * ============================================================ */

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (statSync(p).isDirectory()) walk(p, out)
    } else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

test('TC-UIMODE-003 渲染层不存在任何「任务模式 / 复杂度」选择控件', () => {
  const rendererDir = new URL('../../', import.meta.url).pathname
  const files = walk(rendererDir)
  assert.ok(files.length > 50, `扫描范围异常（只找到 ${files.length} 个文件）`)
  // 只针对**任务模式 / 复杂度档位**，不误伤设置页的「性能模式」等无关 radiogroup
  const SELECTOR_PATTERNS: RegExp[] = [
    /setTier\s*\(/,
    /graph\.setTier/,
    /setTaskMode\s*\(/,
    /set-task-mode/,
    /\b(taskMode|task_mode|TASK_MODES|tierOptions)\s*\.\s*map\(/,
    /<select[^>]{0,200}\b(taskMode|task_mode|tier)\b/,
    /role=["']radiogroup["'][^>]{0,200}\b(taskMode|task_mode|tier)\b/,
  ]
  const hits: string[] = []
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf-8'))
    const hit = SELECTOR_PATTERNS.find((re) => re.test(src))
    if (hit) hits.push(`${f.replace(rendererDir, '')} ← ${hit}`)
  }
  assert.deepEqual(
    hits,
    [],
    `以下渲染层文件出现模式/档位选择控件（UI 不应提供选择入口）：\n${hits.join('\n')}`,
  )
})

/* ============================================================
 * 三、只读展示：模式徽标 + 恢复点提示条 + 输出层次
 * ============================================================ */

test('TC-UIMODE-004 清单块显示只读模式徽标与恢复点提示条（无切换入口）', () => {
  assert.match(TODO_PANEL, /data-testid="ledger-mode-badge"/, '应显示只读任务模式徽标')
  assert.match(TODO_PANEL, /data-mode=\{ledger\.mode\}/, '徽标应带上模式数据（供 UI 测试与排障）')
  assert.match(TODO_PANEL, /ledger\.modeTooltip/, '徽标应有 tooltip 说明"由模型自选"')
  assert.match(TODO_PANEL, /data-testid="ledger-resume-bar"/, '应显示恢复点提示条')
  assert.match(TODO_PANEL, /ledger\.resumeHint/, '提示条应展示人话恢复点')
  assert.doesNotMatch(TODO_PANEL, /<select[\s>]/, '清单块不应有下拉')
  assert.doesNotMatch(TODO_PANEL, /onChange=\{[^}]*setMode/, '清单块不应能改模式')
})

test('TC-UIMODE-005 最终答复按四段渲染 + 缺段占位（F9）', () => {
  assert.match(ANSWER_BLOCK, /parseAnswerLayers\(/, 'AnswerBlock 应调用四段解析')
  assert.match(ANSWER_BLOCK, /shouldRenderLayered\(/, '应只在成形（≥2 段）时启用分层')
  assert.match(ANSWER_BLOCK, /ANSWER_LAYER_SPECS\.map\(/, '应按策略表逐段渲染（顺序与默认可见性单源）')
  assert.match(ANSWER_BLOCK, /data-testid=\{`answer-layer-missing-\$\{spec\.id\}`\}/, '缺段必须渲染占位说明')
  assert.match(ANSWER_BLOCK, /answer-layer-verification-toggle/, '验证段应可展开/收起')
  assert.match(ANSWER_BLOCK, /if \(block\.streaming\)/, '流式期必须回退原样 <pre>（防残帧被渲染）')
  // 解析与策略的唯一真源在 shared（不得在组件里另写一份关键词表）
  assert.match(ANSWER_LAYERS, /ANSWER_LAYER_ORDER/, 'shared 应导出规范顺序')
  assert.doesNotMatch(
    ANSWER_BLOCK,
    /结论先行['"]\s*[:,]/,
    '组件内不得硬编码段名表（唯一真源在 shared/utils/answer-layers.ts）',
  )
})

/* ============================================================
 * 四、i18n：新增键四语言齐备且被引用
 * ============================================================ */

test('TC-UIMODE-006 answerLayer 键四语言齐备且被 UI 引用', () => {
  const KEYS = [
    'conclusion',
    'changes',
    'verification',
    'next',
    'expand',
    'collapse',
    'missingConclusion',
    'missingChanges',
    'missingVerification',
    'missingNext',
    'layerHint',
  ]
  for (const loc of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`../../i18n/locales/${loc}.json`)) as {
      answerLayer?: Record<string, unknown>
    }
    assert.ok(json.answerLayer, `${loc}.json 缺 answerLayer 命名空间`)
    for (const k of KEYS) {
      const v = json.answerLayer![k]
      assert.ok(typeof v === 'string' && v.length > 0, `${loc}.json 缺 answerLayer.${k}`)
    }
  }
  assert.match(ANSWER_BLOCK, /answerLayer\.conclusion/, 'AnswerBlock 应引用 answerLayer.* 键')
  assert.match(ANSWER_BLOCK, /answerLayer\.missingVerification/, '缺段占位应走 i18n')
})
