/**
 * v0.27.0 R2（§3.1）一次性切片工具：engine.ts → engine/ 各职责模块。
 * 纯移动（字节级保真）：统一导入头 + 行区间切片 + 导出标记 + 游离 import 提升。
 * 用后即删，不入库。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const ROOT = '/Users/gongzheng/ai/ArkWork/app/src/main/agent'
const src = readFileSync(`${ROOT}/engine.ts`, 'utf8').replace(/\r\n/g, '\n')
const lines = src.split('\n')
const S = (a, b) => lines.slice(a - 1, b).join('\n')

// ---------- 统一导入头：原 5-105 行，./ → ../ ----------
const baseImports = S(5, 105).replace(/from '\.\//g, "from '../")

// ---------- 从切片体内提升游离 import（如 dispatch 尾部中置导入）----------
function hoist(body) {
  const kept = []
  const moved = []
  for (const l of body.split('\n')) {
    if (/^\s*import\b/.test(l)) moved.push(l.replace(/from '\.\//g, "from '../"))
    else kept.push(l)
  }
  return { body: kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''), moved: moved.join('\n') }
}

// ---------- 导出标记 ----------
function markExport(text, names) {
  let t = text
  for (const n of names) {
    const re = new RegExp(`^(async function |function |interface |type |const )(${n}\\b)`, 'm')
    if (!re.test(t)) throw new Error(`markExport 未命中: ${n}`)
    t = t.replace(re, 'export $1$2')
  }
  return t
}

// ---------- 模块定义：行区间（1-indexed 闭区间）+ 导出标记 + 兄弟模块导入 ----------
const MODULES = [
  {
    file: 'loop.ts',
    desc: 'ReAct 主循环：预算控制、Reason/Act 编排、迭代推进、终止分支',
    ranges: [[1, 4], [118, 133], [135, 169], [177, 178], [180, 1556], [1646, 1666]],
    exports: [],
    siblings: [
      "import { safeSlice, emitEvent, emitProgress } from './broadcast.js'",
      "import { emitContextSizeReport } from './context.js'",
      "import { buildFallbackAskUserQuestion, markRunningPlanItemFailed, discardIncompletePlanItems, isProductiveTool, decidePlanAdvance, emitPlanStatus } from './gates.js'",
      "import { tryGeneratePlan, generatePlan } from './plan.js'",
      "import { findPlanItemForStage } from './plan-parser.js'",
      "import { injectSkillInstruction, broadcastSkillAutoLoaded } from './skills.js'",
      "import { buildObservationSummary, collectActionsForIteration, appendPairedControlObservations, executeAct, toFinishedProgress } from './act.js'",
      "import { maybePrecallCompact, assembleMessages, assembleTools } from './messages.js'",
      "import { buildMemoryInjection, buildKbStatusLine, autoRecallKb, maybeAutoCompress, runDoneMemoryHooks, buildDistillContext } from './memory-hooks.js'",
    ],
  },
  {
    file: 'broadcast.ts',
    desc: '广播辅助：安全截断与进度/事件发射（通用叶子模块）',
    ranges: [[107, 116], [1626, 1644], [1668, 1686]],
    exports: ['safeSlice', 'emitEvent', 'emitProgress'],
    siblings: [],
  },
  {
    file: 'gates.ts',
    desc: '门禁与计划推进判定：ask_user 兜底、阶段门禁、计划项失败/丢弃处理',
    ranges: [[171, 175], [1558, 1624], [2170, 2332]],
    exports: ['buildFallbackAskUserQuestion', 'markRunningPlanItemFailed', 'discardIncompletePlanItems', 'isProductiveTool', 'decidePlanAdvance', 'emitPlanStatus'],
    siblings: ["import { findPlanItemForStage } from './plan-parser.js'"],
  },
  {
    file: 'context.ts',
    desc: '上下文体量评估：任务上下文估算与明细拆解报告',
    ranges: [[1688, 1857]],
    exports: ['emitContextSizeReport'],
    siblings: [],
  },
  {
    file: 'plan.ts',
    desc: '计划生成编排：PLAN_SYSTEM_PROMPT 家族与 tryGeneratePlan/generatePlan',
    ranges: [[1859, 2048]],
    exports: ['tryGeneratePlan', 'generatePlan'],
    siblings: [
      "import { safeSlice, emitProgress } from './broadcast.js'",
      "import { emitContextSizeReport } from './context.js'",
      "import { assembleMessages } from './messages.js'",
    ],
  },
  {
    file: 'plan-parser.ts',
    desc: '计划解析适配层：单源共享解析器再导出 + 阶段匹配（叶子模块）',
    ranges: [[2126, 2168]],
    exports: ['findPlanItemForStage'],
    siblings: [
      "export { parsePlanItems, parsePlanItemsJson, parsePlanItemsLines, parsePlanItemsArrows, sanitizePlanItemText, isPhaseHeader } from '@shared/utils/plan-parse'",
    ],
  },
  {
    file: 'skills.ts',
    desc: '技能指令注入与自动加载广播',
    ranges: [[2356, 2414]],
    exports: ['injectSkillInstruction', 'broadcastSkillAutoLoaded'],
    siblings: [],
  },
  {
    file: 'act.ts',
    desc: 'Act 执行段：动作收集、观察摘要、executeAct 工具执行循环',
    ranges: [[2416, 3010]],
    exports: ['buildObservationSummary', 'collectActionsForIteration', 'appendPairedControlObservations', 'executeAct', 'toFinishedProgress', 'ActExecutionResult', 'ActContext'],
    siblings: ["import { safeSlice } from './broadcast.js'"],
  },
  {
    file: 'messages.ts',
    desc: '消息装配：assembleMessages、预压缩、工具调用账目对账、工具面组装',
    ranges: [[3012, 3323]],
    exports: ['maybePrecallCompact', 'assembleMessages', 'assembleTools'],
    siblings: [],
  },
  {
    file: 'memory-hooks.ts',
    desc: '记忆六钩子：L1 注入、KB 召回、自动压缩、完成态蒸馏、画像沉淀',
    ranges: [[3325, 3569]],
    exports: ['buildMemoryInjection', 'buildKbStatusLine', 'autoRecallKb', 'maybeAutoCompress', 'runDoneMemoryHooks', 'buildDistillContext'],
    siblings: [
      "import { safeSlice, emitProgress } from './broadcast.js'",
    ],
  },
  {
    file: 'dispatch.ts',
    desc: '入口分发：chat / task 双通道路由与回合驱动',
    ranges: [[3571, 3743]],
    exports: [],
    siblings: [],
  },
]

mkdirSync(`${ROOT}/engine`, { recursive: true })

for (const m of MODULES) {
  const rawBody = m.ranges.map(([a, b]) => S(a, b)).join('\n\n')
  const { body, moved } = hoist(rawBody)
  const marked = markExport(body, m.exports)
  const parts = [
    `/**\n * v0.27.0 R2（§3.1 引擎拆分）：${m.desc}\n * 由 engine.ts 纯移动而来（行区间 ${m.ranges.map(([a, b]) => `${a}-${b}`).join(' / ')}）。\n */`,
    baseImports,
    moved,
    m.siblings.join('\n'),
    marked,
  ]
  writeFileSync(`${ROOT}/engine/${m.file}`, parts.filter(Boolean).join('\n\n') + '\n')
  console.log(`${m.file.padEnd(16)} ${marked.split('\n').length} lines`)
}

// ---------- index.ts 纯出口桶 ----------
writeFileSync(
  `${ROOT}/engine/index.ts`,
  `/**
 * v0.27.0 R2（§3.1 引擎拆分）：engine 公共出口。
 * 原 engine.ts 拆分为本目录各职责模块；外部一律从这里导入公共 API。
 */
export type { RunOptions } from './loop.js'
export { runReActLoop } from './loop.js'
export { estimateTaskContext, getTaskContextBreakdown } from './context.js'
export { reconcileToolCalls } from './messages.js'
export type { ChatOrTask } from './dispatch.js'
export { runChatOnce, runTurnForTask, dispatchChatOrTask } from './dispatch.js'
`,
)
console.log(`${'index.ts'.padEnd(16)} barrel`)
console.log('DONE')
