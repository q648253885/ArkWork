/* ============================================================
 * TC-NORM —— v0.38.0（D159）工具名形态归一化契约
 *
 * 缺陷现场（2026-09-25 22:33）：模型调 `task-plan`（连字符）→ act 拦截分支
 * 只认 `task_plan` → 掉进 registry 报错 → classifyRunWork 因名字不在任何
 * 白名单判 `mutating` → 完成门禁误拦（连续三轮被拒）。
 *
 * 本套件钉住三件事：
 *   ① 归一化真值表（真执行，非形状校验）；
 *   ② 别名表纯净性 —— 派生表不得把别名指回未知名 / 与已知名冲突；
 *   ③ 接线契约 —— loop.ts 必须在首次消费 response 之前调用归一化（顺序断言）。
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const {
  normalizeToolName,
  normalizeResponseToolNames,
  classifyRunWork,
  READONLY_TOOLS,
  CONTROL_TOOLS,
  PLAN_TOOLS,
} = await import('../work-class.js')

const ENGINE_KNOWN = new Set<string>([...READONLY_TOOLS, ...CONTROL_TOOLS, ...PLAN_TOOLS])

const read = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

test('TC-NORM-001: normalizeToolName 真值表 —— 引擎自有名的连字符孪生归一到正名', () => {
  // 控制 / 清单族（下划线正名）的连字符孪生
  assert.equal(normalizeToolName('task-plan'), 'task_plan', '实机缺陷形态：模型调 task-plan 必须落到 task_plan')
  assert.equal(normalizeToolName('turn-note'), 'turn_note')
  assert.equal(normalizeToolName('task-complete'), 'task_complete')
  assert.equal(normalizeToolName('ask-user'), 'ask_user')
  // 已下架历史名的连字符孪生 → 归一到历史名 → 命中 act 废弃兜底（人话提示），而非 registry 崩
  assert.equal(normalizeToolName('task-create'), 'task_create')
  assert.equal(normalizeToolName('submit-plan'), 'submit_plan')
  // 只读工具（连字符正名）的下划线孪生同样归一，防 classifyRunWork 误判 mutating
  assert.equal(normalizeToolName('file_reader'), 'file-reader')
  assert.equal(normalizeToolName('glob_search'), 'glob-search')
  // 已知名 / 双向同形名原样
  assert.equal(normalizeToolName('task_plan'), 'task_plan')
  assert.equal(normalizeToolName('file-reader'), 'file-reader')
  assert.equal(normalizeToolName('todo-update'), 'todo-update')
  assert.equal(normalizeToolName('todo_update'), 'todo_update')
  // 未知名（MCP / 市场技能）一律透传 —— 归一化不得吞掉第三方命名空间
  assert.equal(normalizeToolName('mcp__foo_bar'), 'mcp__foo_bar')
  assert.equal(normalizeToolName('unknown-market-skill'), 'unknown-market-skill')
  assert.equal(normalizeToolName(''), '')
})

test('TC-NORM-002: 别名表纯净性 —— 派生表无冲突、键必未知、值必已知', () => {
  // 通过行为侧验证派生表的三个不变量（表本身未导出，纪律⑧：只经守卫访问）
  const knownNames = [...ENGINE_KNOWN]
  for (const name of knownNames) {
    if (!name.includes('_') && !name.includes('-')) continue
    const twin = name.includes('_') ? name.replace(/_/g, '-') : name.replace(/-/g, '_')
    if (ENGINE_KNOWN.has(twin)) continue // 双向同形名（todo_update/todo-update）不需要别名
    assert.equal(normalizeToolName(twin), name, `孪生形态 ${twin} 必须归一到正名 ${name}`)
  }
  // 别名键绝不能是已知名本身（否则归一化会改写正名调用 —— 行为上即恒等，已被上面真值表覆盖）
  assert.equal(normalizeToolName('task_plan'), 'task_plan')
})

test('TC-NORM-003: normalizeResponseToolNames 就地改写 action / actions', () => {
  const action = { tool: 'task-plan', args: { items: [] } }
  const actions = [{ tool: 'turn-note', args: { text: 'x' } }, { tool: 'file-reader', args: {} }]
  normalizeResponseToolNames({ action, actions })
  assert.equal(action.tool, 'task_plan')
  assert.equal(actions[0]!.tool, 'turn_note')
  assert.equal(actions[1]!.tool, 'file-reader', '已知名不动')
  // 空响应安全
  assert.doesNotThrow(() => normalizeResponseToolNames({}))
  assert.doesNotThrow(() => normalizeResponseToolNames({ action: null, actions: null }))
})

test('TC-NORM-004: classifyRunWork 对连字符形态不再误判 mutating（D159 回归）', () => {
  // 缺陷现场：classifyRunWork(['task-plan']) 曾判 mutating → 完成门禁误拦 3/3
  assert.equal(classifyRunWork(['task-plan']), 'readonly', '清单族孪生形态 = 清单操作，不构成实质工作')
  assert.equal(classifyRunWork(['task-plan', 'file-reader']), 'readonly')
  assert.equal(classifyRunWork(['turn-note']), 'readonly', 'turn_note 是输出动作 = 控制类')
  assert.equal(classifyRunWork(['file_reader']), 'readonly', '只读工具的下划线孪生不得判 mutating')
  // 对照：真正的写工具仍判 mutating
  assert.equal(classifyRunWork(['file_reader', 'file-writer']), 'mutating')
  assert.equal(classifyRunWork(['unknown-market-skill']), 'mutating', '未知名仍落保守侧（FR8.2 不变）')
})

test('TC-NORM-005: 接线契约 —— loop.ts 必须在首次消费 response 之前归一（顺序断言）', () => {
  const LOOP = read('../../engine/loop.ts')
  const ingestIdx = LOOP.indexOf('normalizeResponseToolNames(response)')
  assert.notEqual(ingestIdx, -1, 'loop.ts 必须调用 normalizeResponseToolNames（唯一摄取点）')
  assert.match(LOOP, /import \{[^}]*normalizeResponseToolNames[^}]*\} from '\.\/work-class\.js'/)
  // 顺序：归一化必须先于 controlTool 判定 / collectActionsForIteration / toolsThisRun 收集
  const firstConsumeIdx = LOOP.indexOf('const action = response.action')
  assert.notEqual(firstConsumeIdx, -1)
  assert.ok(ingestIdx < firstConsumeIdx, `归一化（char ${ingestIdx}）必须先于首次消费 response（char ${firstConsumeIdx}）`)
  const collectIdx = LOOP.indexOf('collectActionsForIteration(response)')
  assert.ok(ingestIdx < collectIdx, '归一化必须先于 pendingActions 收集')
})

test('TC-NORM-006: work-class 保持叶子模块 —— 不得新增运行时 import（避免循环依赖）', () => {
  const SRC = read('../work-class.ts')
  const imports = [...SRC.matchAll(/^import\s.+$/gm)].map((m) => m[0]!)
  for (const line of imports) {
    assert.match(line, /import type/, 'work-class.ts 只允许 type import（叶子模块硬规则）')
  }
})

test('TC-NORM-007: 接线契约 —— reason-phase 必须在 step 落盘之前归一（D219 回归）', () => {
  const RP = read('../reason-phase.ts')
  // 调用与 import 必须存在
  const ingestIdx = RP.indexOf('normalizeResponseToolNames(response)')
  assert.notEqual(ingestIdx, -1, 'reason-phase.ts 必须调用 normalizeResponseToolNames（D219 唯一摄取点）')
  assert.match(RP, /import \{[^}]*normalizeResponseToolNames[^}]*\} from '\.\/work-class\.js'/)
  // 顺序：归一化必须先于 L1 meta 构造与 reason step 构造 —— 否则孪生拼写
  // 会原样进 steps.jsonl / meta / reason_end 事件（实机缺陷 T-20261002-2k584x：
  // 模型调 task-complete，落盘原样，渲染层最终答复整条丢失）
  const metaIdx = RP.indexOf('const reasoningMeta')
  const stepIdx = RP.indexOf('const reasonStep')
  assert.notEqual(metaIdx, -1)
  assert.notEqual(stepIdx, -1)
  assert.ok(ingestIdx < metaIdx, `归一化（char ${ingestIdx}）必须先于 L1 meta 构造（char ${metaIdx}）`)
  assert.ok(ingestIdx < stepIdx, `归一化（char ${ingestIdx}）必须先于 reason step 构造（char ${stepIdx}）`)
  // loop.ts 防线保留（幂等），且仍在首次消费 response 之前（TC-NORM-005 已钉）
  const LOOP = read('../../engine/loop.ts')
  assert.notEqual(LOOP.indexOf('normalizeResponseToolNames(response)'), -1, 'loop.ts 幂等防线不得移除')
})
