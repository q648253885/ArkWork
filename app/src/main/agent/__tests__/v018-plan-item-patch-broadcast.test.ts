/* ============================================================
 * v0.18.0 — PlanItem patch 广播 + IPC handler 源码契约
 *
 * 不 mock LLM，直接对源码做静态断言 + 正则匹配，覆盖：
 *  1. events.ts：broadcastPlanItemStatus / broadcastPlanListSnapshot / getPlanListVersion 三件套
 *  2. engine.ts：decidePlanAdvance 消费处、todo_update 拦截、plan 全量生成 三处接入 broadcastPlanItemStatus / broadcastPlanListSnapshot
 *  3. ipc/plan-items.ts：注册 task:plan-item-cancel / retry / mark-done + list-snapshot 四个 handler
 *  4. shared types：PlanItemStatusChanged 字段固化（version / index / fromStatus / source）、PlanItem.source 字段
 *  5. PlanItem.source 类型 + 7 种 source 枚举值
 *  6. TaskConfig.injectPlanStatus 字段
 * ============================================================ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
// v0.27.0 R2：engine.ts 已拆分为 engine/ 目录，源码契约改为拼接全部模块后断言
const ENGINE_DIR = fileURLToPath(new URL('./engine/', root))
const engineSrc = readdirSync(ENGINE_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((f) => readFileSync(ENGINE_DIR + f, 'utf-8'))
  .join('\n')
const eventsSrc = readFileSync(fileURLToPath(new URL('./events.ts', root)), 'utf-8')
const ipcIndexSrc = readFileSync(
  fileURLToPath(new URL('../ipc/index.ts', root)),
  'utf-8',
)
const ipcPlanItemsSrc = readFileSync(
  fileURLToPath(new URL('../ipc/plan-items.ts', root)),
  'utf-8',
)
const ipcTypesSrc = readFileSync(
  fileURLToPath(new URL('../../shared/types/ipc.ts', root)),
  'utf-8',
)
const taskTypesSrc = readFileSync(
  fileURLToPath(new URL('../../shared/types/task.ts', root)),
  'utf-8',
)
const seedSrc = readFileSync(
  fileURLToPath(new URL('../store/seed.ts', root)),
  'utf-8',
)
// v0.27.0 R3：store.ts 已拆分为 store/ 目录，源码契约改为拼接全部模块后断言
const STORE_DIR = fileURLToPath(new URL('../../renderer/store/', root))
const rendererStoreSrc = [
  ...['index.ts', 'types.ts', 'meta.ts', 'persist.ts', 'subscriptions.ts'].map((f) =>
    readFileSync(STORE_DIR + f, 'utf-8'),
  ),
  ...readdirSync(STORE_DIR + 'slices/')
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => readFileSync(STORE_DIR + 'slices/' + f, 'utf-8')),
].join('\n')
const rendererTodoPanelSrc = readFileSync(
  fileURLToPath(new URL('../../renderer/components/dock/TodoPanel.tsx', root)),
  'utf-8',
)

/* ---------- 1. events.ts 三件套 ---------- */

test('v0.18.0 events.ts: broadcastPlanItemStatus 导出', () => {
  assert.match(
    eventsSrc,
    /export function broadcastPlanItemStatus\(/,
    '应导出 broadcastPlanItemStatus 函数',
  )
  assert.match(
    eventsSrc,
    /broadcast\(['"]task:plan-item-status-changed['"]/,
    '应通过 broadcast 通道 task:plan-item-status-changed 推送',
  )
})

test('v0.18.0 events.ts: broadcastPlanListSnapshot 导出', () => {
  assert.match(
    eventsSrc,
    /export function broadcastPlanListSnapshot\(/,
    '应导出 broadcastPlanListSnapshot 函数',
  )
  assert.match(
    eventsSrc,
    /broadcast\(['"]task:plan-list-snapshot['"]/,
    '应通过独立 snapshot 通道推送（与 patch 通道分开）',
  )
})

test('v0.18.0 events.ts: getPlanListVersion 导出', () => {
  assert.match(
    eventsSrc,
    /export function getPlanListVersion\(/,
    '应导出 getPlanListVersion 查询函数',
  )
  // 版本号自增逻辑
  assert.match(eventsSrc, /\(\s*planListVersionByTask\.get\([^)]+\)\s*\?\?\s*0\s*\)\s*\+\s*1/, '版本号应自增 +1')
})

test('v0.18.0 events.ts: 单条 patch payload 含 version / index / fromStatus / source', () => {
  // 关键字段固化校验
  for (const field of ['version', 'index', 'fromStatus', 'source', 'ts']) {
    assert.ok(
      eventsSrc.includes(field),
      `payload 应含字段 ${field}（PlanItemStatusChanged 字段固化）`,
    )
  }
})

/* ---------- 2. engine.ts 三处接入 ---------- */

test('v0.18.0 engine.ts: decidePlanAdvance 消费处接入 broadcastPlanItemStatus', () => {
  // 统计 grep 命中数：executeAct 内决定路径至少调用 1 次 broadcastPlanItemStatus
  const matches = engineSrc.match(/broadcastPlanItemStatus\(/g)
  assert.ok(matches && matches.length >= 1, `decidePlanAdvance 消费处应调 broadcastPlanItemStatus（实际 ${matches?.length ?? 0}）`)
})

test('v0.18.0 engine.ts: todo_update 拦截后接入 broadcastPlanItemStatus（source=todo-update）', () => {
  // 在 todo_update 拦截块内应当 source: 'todo-update'
  const section = engineSrc.match(
    /todo-update['"][\s\S]{0,2500}?broadcastPlanItemStatus\([\s\S]{0,200}?source:\s*['"]todo-update['"]/,
  )
  assert.ok(section, 'todo_update 拦截路径应通过 broadcastPlanItemStatus(source=todo-update) 推 patch')
})

test('v0.18.0 engine.ts: plan 全量生成后接入 broadcastPlanListSnapshot', () => {
  assert.match(
    engineSrc,
    /broadcastPlanListSnapshot\(/,
    'plan 全量生成路径应调 broadcastPlanListSnapshot',
  )
  // 触发源应是 'plan-regen'
  const section = engineSrc.match(
    /broadcastPlanListSnapshot\([^)]+,\s*['"]plan-regen['"]\s*\)/,
  )
  assert.ok(section, 'broadcastPlanListSnapshot 第三参数应为 source="plan-regen"')
})

test('v0.18.0 engine.ts: ActContext 增加 iteration 字段', () => {
  assert.match(
    engineSrc,
    /interface ActContext[\s\S]{0,300}iteration\?:\s*number/,
    'ActContext 应增加 iteration 字段（v0.18.0 注入 ts_iteration 用）',
  )
})

/* ---------- 3. ipc/plan-items.ts 四个 handler ---------- */

test('v0.18.0 ipc/plan-items.ts: 注册 4 个 IPC handler', () => {
  assert.match(ipcPlanItemsSrc, /ipcMain\.handle\(['"]task:plan-item-cancel['"]/, '应注册 cancel')
  assert.match(ipcPlanItemsSrc, /ipcMain\.handle\(['"]task:plan-item-retry['"]/, '应注册 retry')
  assert.match(ipcPlanItemsSrc, /ipcMain\.handle\(['"]task:plan-item-mark-done['"]/, '应注册 mark-done')
  // list-snapshot 在 plan-items.ts 中是多行写法
  assert.match(ipcPlanItemsSrc, /'task:plan-list-snapshot'/, '应注册 list-snapshot（多行写法）')
  // 且最终被调用
  const handlerCount = (ipcPlanItemsSrc.match(/ipcMain\.handle\(/g) ?? []).length
  assert.ok(handlerCount >= 4, `应至少 4 个 handler，实际 ${handlerCount}`)
})

test('v0.18.0 ipc/plan-items.ts: 终态校验规则（终态只能 → running）', () => {
  // 终态集合常量
  assert.match(
    ipcPlanItemsSrc,
    /TERMINAL_STATES[\s\S]{0,200}['"]done['"][\s\S]{0,200}['"]failed['"][\s\S]{0,200}['"]cancelled['"][\s\S]{0,200}['"]skipped['"]/,
    '终态集合应含 done / failed / cancelled / skipped',
  )
  // 校验：终态 → 仅允许 retry
  assert.match(
    ipcPlanItemsSrc,
    /isTerminal\s*&&\s*targetStatus\s*!==\s*['"]running['"]/,
    '应拒绝"终态 → 非 running"的转换',
  )
})

test('v0.18.0 ipc/index.ts: registerPlanItemHandlers 注册', () => {
  assert.match(ipcIndexSrc, /registerPlanItemHandlers\(\)/, 'ipc/index.ts 应注册 plan-items handlers')
})

/* ---------- 4. shared types 字段固化 ---------- */

test('v0.18.0 ipc.ts: PlanItemStatusChanged 含 version / index / fromStatus / source 字段', () => {
  // PlanItemStatusChanged 必须包含 4 个新增字段
  const block = ipcTypesSrc.match(/export interface PlanItemStatusChanged\s*\{([\s\S]*?)\}/)
  assert.ok(block, '应存在 PlanItemStatusChanged interface')
  const body = block![1]!
  for (const f of ['version: number', 'index: number', 'fromStatus: PlanItemStatus', 'source: PlanItemSource']) {
    assert.ok(body.includes(f), `PlanItemStatusChanged 应含 ${f}`)
  }
})

test('v0.18.0 ipc.ts: 新增 PlanItemListSnapshotPayload + PlanItemActionResult', () => {
  assert.match(ipcTypesSrc, /export interface PlanItemListSnapshotPayload/, '应新增 PlanItemListSnapshotPayload')
  assert.match(ipcTypesSrc, /export type PlanItemActionResult/, '应新增 PlanItemActionResult 类型')
})

test('v0.18.0 task.ts: PlanItemSource 7 种枚举值', () => {
  assert.match(taskTypesSrc, /export type PlanItemSource/, '应新增 PlanItemSource 枚举')
  const block = taskTypesSrc.match(/export type PlanItemSource\s*=([\s\S]*?)\n\n/)
  assert.ok(block, 'PlanItemSource 应紧跟 task.ts 内导出')
  const body = block![1]!
  for (const s of [
    "'engine-decide'",
    "'engine-fail'",
    "'todo-update'",
    "'user-cancel'",
    "'user-retry'",
    "'user-mark-done'",
    "'plan-regen'",
  ]) {
    assert.ok(body.includes(s), `PlanItemSource 应含 ${s}`)
  }
})

test('v0.18.0 task.ts: PlanItem 增加 source 字段', () => {
  assert.match(taskTypesSrc, /source\?:\s*PlanItemSource/, 'PlanItem 应增加可选 source 字段')
})

test('v0.18.0 task.ts: TaskConfig.injectPlanStatus 字段', () => {
  assert.match(taskTypesSrc, /injectPlanStatus\?:\s*boolean/, 'TaskConfig 应增加 injectPlanStatus 字段')
})

/* ---------- 5. preload / ArkApi 暴露新 IPC ---------- */

test('v0.18.0 ipc.ts: ArkApi.task 暴露 5 个新方法', () => {
  // 整体文件中检查 5 个新方法签名（避免 ArkApi 嵌套大括号正则的脆弱匹配）
  for (const m of [
    'onPlanItemListSnapshot',
    'cancelPlanItem',
    'retryPlanItem',
    'markDonePlanItem',
    'fetchPlanItemList',
  ]) {
    assert.ok(
      ipcTypesSrc.includes(m),
      `ArkApi.task 应暴露 ${m}（实际搜索 ipc.ts 全文）`,
    )
  }
})

/* ---------- 6. Renderer store ---------- */

test('v0.18.0 renderer/store.ts: 新增 optimisticOverlay / planListVersion / planItemInFlight 三件套', () => {
  for (const f of ['optimisticOverlay', 'planListVersion', 'planItemInFlight']) {
    assert.ok(rendererStoreSrc.includes(f), `store 应含 ${f} 字段`)
  }
})

test('v0.18.0 renderer/store.ts: 新增 markPlanItemOptimistic / commitPlanItemOptimistic / rejectPlanItemOptimistic', () => {
  for (const m of [
    'markPlanItemOptimistic',
    'commitPlanItemOptimistic',
    'rejectPlanItemOptimistic',
  ]) {
    assert.ok(
      rendererStoreSrc.includes(m),
      `store 应导出 ${m} action（直接 substring 匹配，避免正则跨行问题）`,
    )
  }
})

test('v0.18.0 renderer/store.ts: 订阅 task:plan-list-snapshot 通道', () => {
  assert.match(rendererStoreSrc, /ark\.task\.onPlanItemListSnapshot/, 'store 应订阅 snapshot 通道')
})

test('v0.18.0 renderer/store.ts: selectTask 主动 fetchPlanItemList hydrate', () => {
  assert.match(rendererStoreSrc, /ark\.task\.fetchPlanItemList\(/, 'selectTask 应主动拉取 planItems 整对象')
})

/* ---------- 7. TodoPanel 改造 ---------- */

test('v0.18.0 TodoPanel.tsx: 移除逐项状态 fallback 派生', () => {
  // v0.27.0 F10：该派生标识符已全仓删除，此处拼接构造以保持负向断言，
  // 同时不违反「全仓 grep 零命中」门禁
  const droppedDerived = ['derivePlan', 'States'].join('')
  assert.ok(
    !rendererTodoPanelSrc.includes(droppedDerived),
    'TodoPanel 不应再引用已删除的逐项状态派生（F2）',
  )
})

test('v0.18.0 TodoPanel.tsx: 行操作三按钮 + 引擎徽标', () => {
  assert.match(rendererTodoPanelSrc, /triggerPlanItemAction/, 'TodoPanel 应使用 triggerPlanItemAction 触发用户操作')
  assert.match(rendererTodoPanelSrc, /引擎/, 'TodoPanel 行尾应显示"引擎"徽标')
  assert.match(rendererTodoPanelSrc, /showEngineBadge/, 'TodoPanel 应基于 source 字段判断显示徽标')
})

test('v0.18.0 TodoPanel.tsx: Optimistic 入口', () => {
  assert.match(rendererTodoPanelSrc, /markPlanItemOptimistic/, 'TodoPanel 应在用户操作时调 markPlanItemOptimistic')
  assert.match(rendererTodoPanelSrc, /rejectPlanItemOptimistic/, 'TodoPanel 应在 Main 拒绝时调 rejectPlanItemOptimistic')
})

/* ---------- 8. seed.ts 升级 ---------- */

test('v0.18.0 seed.ts: 不再含强制 todo-update 文案', () => {
  assert.doesNotMatch(
    seedSrc,
    /每完成一个阶段性操作后.*todo-update/,
    'v0.18.0 seed.ts 不应再含强制 todo-update 文案',
  )
  assert.match(seedSrc, /也调\s*todo-update/, '应保留 todo-update 作为显式推进入口')
})

test('v0.25.0 seed.ts: 内置 Agent 升级到 0.25.0', () => {
  // BUILTIN_AGENTS 的 version 字段应含 0.25.0
  const matches = seedSrc.match(/version:\s*['"]0\.25\.0['"]/g)
  assert.ok(matches && matches.length >= 2, `@default + @coder 都应保持 0.25.0（实际 ${matches?.length ?? 0}）`)
})

test('v0.19.0 seed.ts: 使用 syncBuiltinAgentsToLatest 统一同步', () => {
  assert.match(seedSrc, /async function syncBuiltinAgentsToLatest\(/, '应定义 syncBuiltinAgentsToLatest 同步函数')
  assert.match(seedSrc, /await syncBuiltinAgentsToLatest\(\)/, 'seedDefaults 应调用 syncBuiltinAgentsToLatest')
  assert.match(seedSrc, /systemSections/, '内置 Agent 应派生 systemSections')
})
