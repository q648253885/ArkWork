/* ============================================================
 * v0.38.0 详测 — 破坏性收敛的迁移契约（TC-MIGR-001…004）
 *
 * 对应文档：docs/versions/v0.38.0/04-system-design.md §4.2（下架清单）/ §12（迁移兼容）
 *
 * 为什么必须单独成组：
 *   本版把模型可见的清单工具从 **11 个压到 2 个**（`task_plan` + `turn_note`），
 *   属**破坏性收敛**。破坏性变更的经典翻车方式是"新代码是对的，但旧数据/旧会话
 *   一进来就静默失效"——工具名没了、来源标记丢了、提示词没同步到存量机器。
 *   这三条都不会报错，只会让用户觉得"怎么没反应"。故逐条立例。
 *
 * 手法：源码契约（readFileSync + stripComments）—— 迁移逻辑跨 store/agent 两侧，
 * 单测环境起不了完整引擎，锁结构性不变量（与 tree-sync-enforce 同手法）。
 *
 * 运行（cwd=app）：node scripts/run-tests.mjs migrate-tool-aliases
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '@shared/utils/source-guard'

const read = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf-8'))

const ACT = read('../../engine/act.ts')
const WORK_CLASS = read('../../engine/work-class.ts')
const TREE_SYNC_SRC = read('../../engine/plan-tree-sync.ts')
const SEED = read('../../../store/seed.ts')
const TASKS_MIGRATE = read('../../../store/tasks.migrate.ts')
const GRAPH_MIGRATE = read('../../graph/migrate.ts')
const TASK_TYPES = read('../../../../shared/types/task.ts')
const REGISTRY = read('../../registry.ts')

/** 9 个已下架的清单工具（模型工具表里不得再出现） */
const RETIRED = [
  'todo_update',
  'todo-update',
  'task_create',
  'task_update',
  'task_get',
  'task_list',
  'task_block',
  'replan',
  'request_plan',
  'submit_plan',
]

/* ============================================================
 * TC-MIGR-001 旧工具名仍可被识别 → 给出可执行的替代指令
 * ============================================================ */

test('TC-MIGR-001 ★ 弃用工具名被调用 → 返回可执行 observation，且不炸断循环', () => {
  assert.match(ACT, /\[deprecated-tool\]/, '必须有稳定标签（会话审计 / 检索锚点）')
  assert.match(ACT, /请改用 task_plan/, '必须给出**唯一**替代入口，否则模型会新造工具名')
  assert.match(ACT, /task_plan\(\{ items: \[/, '替代说明要带可照抄的调用形状（模型最容易卡在参数形状上）')

  // 关键：弃用兜底必须是 softFail（软失败）——否则一次误调就把整个 run 打红
  const idx = ACT.indexOf('[deprecated-tool]')
  const body = ACT.slice(Math.max(0, idx - 900), idx + 900)
  assert.match(body, /softFail: true/, '弃用调用是"兼容期正常现象"，不得当硬错误处理')
  assert.match(body, /status: 'failed'/, '仍要标 failed 让模型看见（但不是致命）')

  // 兜底的分支条件必须调唯一守卫，不得再展开成内联 if 链（纪律⑧）
  const guardIdx = ACT.indexOf('isRetiredPlanTool(')
  assert.ok(guardIdx > 0, '兜底条件必须调 isRetiredPlanTool 守卫；内联 if 链在下架名单扩容时会静默漏项')
  assert.doesNotMatch(
    ACT,
    /action\.tool === 'todo_update'/,
    '不得回退成内联 `action.tool === \'…\'` 链 —— v0.38.0 实现时正是它漏了 task_update/task_get/task_list',
  )
})

test('TC-MIGR-001c ★ 下架名单是唯一事实源，且覆盖设计稿全 9 个 + 连字符变体', () => {
  // 唯一事实源在 work-class.ts（与 PLAN_WRITE_TOOLS 同处，便于交叉核对）
  const arrIdx = WORK_CLASS.indexOf('export const RETIRED_PLAN_TOOLS = [')
  assert.ok(arrIdx > 0, 'RETIRED_PLAN_TOOLS 必须导出（act.ts 兜底 / 种子清理 / 本用例三方唯一的名字来源）')
  const arrBody = WORK_CLASS.slice(arrIdx, WORK_CLASS.indexOf('] as const', arrIdx))
  for (const t of RETIRED) {
    assert.ok(
      arrBody.includes(`'${t}'`),
      `历史工具名 ${t} 必须在 RETIRED_PLAN_TOOLS 里 —— 漏一个就是"模型调了但引擎毫无反应"（掉进 No handler 静默路径）`,
    )
  }
  assert.match(WORK_CLASS, /export function isRetiredPlanTool\(/, '必须有 isRetiredPlanTool 守卫')

  // 设计稿 §4.2 的 9 个下架名一个都不能少
  for (const t of ['task_create', 'task_update', 'replan', 'todo_update', 'submit_plan', 'request_plan', 'task_block', 'task_get', 'task_list']) {
    assert.ok(arrBody.includes(`'${t}'`), `设计稿 04-system-design §4.2 下架清单含 ${t}`)
  }
})

test('TC-MIGR-001d ★ 下架名不得被算作"写过账本"（否则门禁静默放行 → 续聊重做第一项）', () => {
  // 事实：旧名调用由 act.ts 在 invokeSkill **之前** return，账本没被写过。
  // 因此「写树」判定必须用 PLAN_WRITE_TOOLS（唯一写入口），不能用 PLAN_TOOLS（清单族）。
  assert.match(
    TREE_SYNC_SRC,
    /import \{ isPlanWriteTool \} from '\.\/work-class\.js'/,
    'plan-tree-sync 必须调写入口守卫（设计稿 §4.2：TREE_TOUCH_TOOLS 收敛为 {\'task_plan\'}）',
  )
  assert.match(TREE_SYNC_SRC, /isPlanWriteTool\(t\)/)
  assert.doesNotMatch(
    TREE_SYNC_SRC,
    /new Set<string>\(PLAN_TOOLS\)/,
    '不得把「清单族」（含已下架名）当作「写账本」—— 二者是不同的概念',
  )

  // 两个集合必须互斥：写入口里不许出现任何下架名
  const writeIdx = WORK_CLASS.indexOf('export const PLAN_WRITE_TOOLS = [')
  const writeBody = WORK_CLASS.slice(writeIdx, WORK_CLASS.indexOf('] as const', writeIdx))
  for (const t of RETIRED) {
    assert.ok(!writeBody.includes(`'${t}'`), `下架名 ${t} 不得出现在 PLAN_WRITE_TOOLS（写入口）里`)
  }
  assert.ok(writeBody.includes(`'task_plan'`), 'task_plan 是唯一写入口')
})

test('TC-MIGR-001b 弃用工具必须从模型工具表消失，但 handler 保留（引擎内部能力）', () => {
  // 工具表（seed）不得再出现
  for (const t of ['S-core.todo-update', 'S-core.task-create', 'S-core.replan', 'S-core.submit-plan', 'S-core.request-plan']) {
    assert.ok(!SEED.includes(`'${t}'`), `下架工具的规格 ${t} 不得再下发到模型工具表`)
  }
  // registry 仍保留 handler（历史会话回放 / 内部调用）
  assert.match(REGISTRY, /task_plan/, 'registry 必须认领新入口（否则工具表与 handler 两处漂移）')
  assert.match(REGISTRY, /turn_note/)
})

/* ============================================================
 * TC-MIGR-002 种子提示词与技能列表同步
 * ============================================================ */

test('TC-MIGR-002 ★ seed 技能列表含新入口、不含下架入口（悬挂 id 必须清掉）', () => {
  assert.ok(SEED.includes("'S-core.task-plan'"), '必须把 task_plan 加进 defaultSkillIds')
  assert.ok(SEED.includes("'S-core.turn-note'"), '必须把 turn_note 加进 defaultSkillIds')
  assert.ok(SEED.includes("'S-core.task-evidence'"), 'task_evidence 保留（V 层能力，不是清单操作）')

  for (const t of ['S-core.todo-update', 'S-core.task-create', 'S-core.task-update', 'S-core.task-get', 'S-core.task-list', 'S-core.task-block', 'S-core.replan', 'S-core.request-plan', 'S-core.submit-plan']) {
    assert.ok(!SEED.includes(`'${t}'`), `悬挂技能 id ${t} 必须删除 —— 留着会被静默过滤，属于"看不见的失效引用"`)
  }
})

test('TC-MIGR-002b ★ 内置 agent 版本必须升到本版，否则存量装机器的提示词永不更新', () => {
  // syncBuiltinAgentsToLatest 只在 `a.version !== latest.version` 时同步；
  // 改了提示词却不升版本 = 老用户永远看不到新口径（D66 同类事故）
  const versions = [...SEED.matchAll(/^\s*version: '([\d.]+)',\s*$/gm)].map((m) => m[1])
  assert.ok(versions.length >= 3, `应至少 3 个内置 agent 带 version（实际 ${versions.length}）`)
  for (const v of versions) {
    // v0.38.1（D172→D176）：D172 续聊清单边界收窄（0.38.0→0.38.1）；D176 成果产物门禁
    // 改动 §6/§7/§8 提示词与 task_plan schema —— 0.38.1 已被 BUILD7 消费 → 升 0.38.2
    assert.equal(v, '0.38.2', `内置 agent 版本须为 0.38.2（实际 ${v}）—— 提示词重写必须触发同步`)
  }
  assert.match(SEED, /task_plan/, '提示词必须提到唯一控制入口')
  assert.match(SEED, /turn_note/, '提示词必须提到阶段结论出口')
})

/* ============================================================
 * TC-MIGR-003 来源白名单的覆盖范围与本体组成对齐
 * ============================================================ */

test('TC-MIGR-003 ★ tasks.migrate 的 source 白名单覆盖 v0.37/v0.38 全部取值（不静默丢弃）', () => {
  // 真源：shared/types/task.ts 的 PlanItemSource
  const src = TASK_TYPES.slice(TASK_TYPES.indexOf('PlanItemSource'))
  const declared = [...src.slice(0, src.indexOf('\n\n')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
  assert.ok(declared.length >= 14, `PlanItemSource 应至少 14 个取值（实际 ${declared.length}）`)

  for (const s of declared) {
    assert.ok(
      TASKS_MIGRATE.includes(`'${s}'`),
      `PlanItemSource 的取值 '${s}' 必须出现在迁移白名单里 —— 漏一个就是"读一次旧任务，来源标记静默消失"`,
    )
  }
  assert.ok(TASKS_MIGRATE.includes("'task-plan'"), '本版新增的 task-plan 必须入白名单')
})

test('TC-MIGR-003b ★ graph/migrate 的 source → Revision 映射覆盖同一份取值（不留"未标记来源"洞）', () => {
  const src = TASK_TYPES.slice(TASK_TYPES.indexOf('PlanItemSource'))
  const declared = [...src.slice(0, src.indexOf('\n\n')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)

  for (const s of declared) {
    assert.ok(
      GRAPH_MIGRATE.includes(`case '${s}':`),
      `source '${s}' 必须有显式 case —— 落到 default 会让 UI 说不出"为什么它变成这个状态"`,
    )
  }
  assert.match(GRAPH_MIGRATE, /case 'park':/, 'v0.37 的 park 必须有人话溯源')
  assert.match(GRAPH_MIGRATE, /case 'sweep-stale':/)
  assert.match(GRAPH_MIGRATE, /case 'seal':/)
})

/* ============================================================
 * TC-MIGR-004 新入口在两处表里都有定义（形状与语义各一处）
 * ============================================================ */

test('TC-MIGR-004 seed 定义了 task_plan / turn_note 两个工具，且 schema 与设计稿一致', () => {
  const planIdx = SEED.indexOf("name: 'task_plan'")
  assert.ok(planIdx > 0, 'task_plan 工具规格必须存在')
  const planBody = SEED.slice(planIdx, planIdx + 2600)
  assert.match(planBody, /builtinHandler: 'task_plan'/)
  assert.match(planBody, /任务清单/, '描述要讲清"何时用 / 何时不用"')
  assert.match(planBody, /完整/, '必须写明提交的是**完整**清单（不是增量）—— 这是 D154 的核心约定')
  assert.match(planBody, /todo|doing|done|skipped|blocked/, '5 态枚举必须出现在 schema 描述里')
  assert.match(planBody, /minItems: 1/, 'items 不得为空数组（空清单用不着提交）')

  const noteIdx = SEED.indexOf("name: 'turn_note'")
  assert.ok(noteIdx > 0, 'turn_note 工具规格必须存在')
  const noteBody = SEED.slice(noteIdx, noteIdx + 1400)
  assert.match(noteBody, /builtinHandler: 'turn_note'/)
  assert.match(noteBody, /required: \['text'\]/, 'text 必填（空结论无意义）')
})
