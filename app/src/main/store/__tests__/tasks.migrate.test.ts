/* ============================================================
 * v0.14.0 Task 1 — PlanItem 六态迁移单测
 *
 * 测试运行方式：
 *   ./node_modules/.bin/tsx \
 *     --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     src/main/store/__tests__/tasks.migrate.test.ts
 *
 *   - 使用 Node 18+ 内置 node:test（避免引入 vitest 等新依赖；spec 要求 vitest 但项目未安装且不允许新增依赖）
 *   - tsx 提供 ESM + TS 即时转译 + path alias 解析
 *   - electron-mock-loader.mjs 是 Node ESM loader，把 'electron' 与 '../system/logger.js'
 *     解析到桩模块（electron-stub.mjs / logger.stub.mjs），避免 tasks.migrate.ts 的传递依赖
 * ============================================================ */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateTasks } from '../tasks.migrate.js'

/* ----------------------------------------------------------
 * 1. 旧 done → done
 * -------------------------------------------------------- */
test('migrateTasks: legacy done status is preserved as done', () => {
  const input = [
    {
      id: 'T-20260101-000001',
      workspaceId: 'default',
      title: 'legacy done task',
      status: 'done',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        { id: 'p1', text: 'do thing', status: 'done', createdAt: 1, updatedAt: 1 },
      ],
    },
  ]
  const { tasks, migratedCount } = migrateTasks(input)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.planItems!.length, 1)
  assert.equal(tasks[0]!.planItems![0]!.status, 'done')
  // done 是合法六态，不应触发迁移计数
  assert.equal(migratedCount, 0)
})

/* ----------------------------------------------------------
 * 2. 旧 failed → failed
 * -------------------------------------------------------- */
test('migrateTasks: legacy failed status is preserved as failed', () => {
  const input = [
    {
      id: 'T-20260101-000002',
      workspaceId: 'default',
      title: 'legacy failed task',
      status: 'failed',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        { id: 'p2', text: 'do thing', status: 'failed', createdAt: 1, updatedAt: 1 },
      ],
    },
  ]
  const { tasks, migratedCount } = migrateTasks(input)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.planItems![0]!.status, 'failed')
  // failed 是合法六态，不应触发迁移计数
  assert.equal(migratedCount, 0)
})

/* ----------------------------------------------------------
 * 3. 缺 status 字段默认 pending
 * -------------------------------------------------------- */
test('migrateTasks: missing status defaults to pending', () => {
  const input = [
    {
      id: 'T-20260101-000003',
      workspaceId: 'default',
      title: 'no status task',
      status: 'pending',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        // 完全缺失 status 字段
        { id: 'p3', text: 'no status', createdAt: 1, updatedAt: 1 },
      ],
    },
  ]
  const { tasks, migratedCount } = migrateTasks(input)
  assert.equal(tasks[0]!.planItems![0]!.status, 'pending')
  // 缺少 status 字段视为迁移变更
  assert.equal(migratedCount, 1)
})

/* ----------------------------------------------------------
 * 4. 非法 status → pending（视为迁移变更）
 * -------------------------------------------------------- */
test('migrateTasks: invalid status becomes pending', () => {
  const input = [
    {
      id: 'T-20260101-000004',
      workspaceId: 'default',
      title: 'invalid status task',
      status: 'pending',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        { id: 'p4a', text: 'unknown state', status: 'bogus', createdAt: 1, updatedAt: 1 },
        { id: 'p4b', text: 'null state', status: null, createdAt: 1, updatedAt: 1 },
        { id: 'p4c', text: 'number state', status: 42, createdAt: 1, updatedAt: 1 },
      ],
    },
  ]
  const { tasks, migratedCount } = migrateTasks(input)
  assert.equal(tasks[0]!.planItems!.length, 3)
  for (const item of tasks[0]!.planItems!) {
    assert.equal(item.status, 'pending')
  }
  assert.equal(migratedCount, 1)
})

/* ----------------------------------------------------------
 * 5. 重复调用幂等
 * -------------------------------------------------------- */
test('migrateTasks: repeated calls are idempotent', () => {
  const input = [
    {
      id: 'T-20260101-000005',
      workspaceId: 'default',
      title: 'idempotent task',
      status: 'pending',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        { id: 'p5a', text: 'missing status', createdAt: 1, updatedAt: 1 },
        { id: 'p5b', text: 'invalid status', status: 'bogus', createdAt: 1, updatedAt: 1 },
      ],
    },
  ]

  const first = migrateTasks(input)
  // 第一次执行：检测到 2 个 planItems 的 status 字段需要规范化为 pending → migratedCount >= 1
  assert.ok(first.migratedCount >= 1, 'first migration should detect changes')

  const second = migrateTasks(first.tasks as unknown)
  // 第二次执行：所有 status 已是合法六态（pending），不应再触发变更
  assert.equal(second.migratedCount, 0, 'second migration should be no-op')
  assert.deepEqual(
    second.tasks.map((t) => t.planItems?.map((p) => p.status)),
    first.tasks.map((t) => t.planItems?.map((p) => p.status)),
    'normalized output should be stable across calls',
  )

  const third = migrateTasks(second.tasks as unknown)
  assert.equal(third.migratedCount, 0, 'third migration should also be no-op')
})

/* ----------------------------------------------------------
 * 6. （补充）新六态值（cancelled / skipped / running）原样保留
 * -------------------------------------------------------- */
test('migrateTasks: new six-state values pass through unchanged', () => {
  const input = [
    {
      id: 'T-20260101-000006',
      workspaceId: 'default',
      title: 'new states task',
      status: 'running',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        { id: 'p6a', text: 'pending item', status: 'pending', createdAt: 1, updatedAt: 1 },
        { id: 'p6b', text: 'running item', status: 'running', createdAt: 1, updatedAt: 1 },
        { id: 'p6c', text: 'cancelled item', status: 'cancelled', createdAt: 1, updatedAt: 1 },
        { id: 'p6d', text: 'skipped item', status: 'skipped', createdAt: 1, updatedAt: 1 },
      ],
    },
  ]
  const { tasks, migratedCount } = migrateTasks(input)
  const statuses = tasks[0]!.planItems!.map((p) => p.status)
  assert.deepEqual(statuses, ['pending', 'running', 'cancelled', 'skipped'])
  assert.equal(migratedCount, 0)
})

/* ----------------------------------------------------------
 * 7. （补充）非数组输入回退为空 + 计 1 次迁移
 * -------------------------------------------------------- */
test('migrateTasks: non-array input returns empty with migratedCount=1', () => {
  const r1 = migrateTasks(null)
  assert.deepEqual(r1.tasks, [])
  assert.equal(r1.migratedCount, 1)

  const r2 = migrateTasks({ not: 'an array' })
  assert.deepEqual(r2.tasks, [])
  assert.equal(r2.migratedCount, 1)
})

/* ----------------------------------------------------------
 * 8. （补充）缺失顶层字段容错补齐
 * -------------------------------------------------------- */
test('migrateTasks: missing planItem id/createdAt/updatedAt are filled in', () => {
  const input = [
    {
      id: 'T-20260101-000008',
      workspaceId: 'default',
      title: 'sparse planItem',
      status: 'pending',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        { text: 'no id and no timestamps', status: 'pending' },
      ],
    },
  ]
  const { tasks, migratedCount } = migrateTasks(input)
  const item = tasks[0]!.planItems![0]!
  assert.equal(typeof item.id, 'string')
  assert.ok(item.id.startsWith('T-20260101-000008#pi1'))
  assert.equal(typeof item.createdAt, 'number')
  assert.equal(typeof item.updatedAt, 'number')
  assert.ok(migratedCount >= 1)
})

/* ----------------------------------------------------------
 * 9. v0.18.0 (V018-002)：迁移透传新增可选字段 source
 * -------------------------------------------------------- */
test('migrateTasks: v0.18.0 source passthrough (V018-002 regression)', () => {
  const input = [
    {
      id: 'T-20260101-000009',
      workspaceId: 'default',
      title: 'v0.18.0 source task',
      status: 'in_progress',
      agentId: 'a1',
      skillIds: [],
      mcpIds: [],
      modelId: 'm',
      input: { text: 'x' },
      config: {},
      createdAt: 1,
      updatedAt: 1,
      startedAt: null,
      completedAt: null,
      parentTaskId: null,
      tags: [],
      planItems: [
        { id: 'p1', text: 'engine decided', status: 'done', createdAt: 1, updatedAt: 1, source: 'engine-decide' },
        { id: 'p2', text: 'engine failed', status: 'failed', createdAt: 1, updatedAt: 1, source: 'engine-fail' },
        { id: 'p3', text: 'user mark done', status: 'done', createdAt: 1, updatedAt: 1, source: 'user-mark-done' },
        { id: 'p4', text: 'legacy without source', status: 'pending', createdAt: 1, updatedAt: 1 },
        { id: 'p5', text: 'invalid source dropped', status: 'pending', createdAt: 1, updatedAt: 1, source: 'bogus-value' },
      ],
    },
  ]
  const { tasks } = migrateTasks(input)
  const items = tasks[0]!.planItems!
  assert.equal(items[0]!.source, 'engine-decide')
  assert.equal(items[1]!.source, 'engine-fail')
  assert.equal(items[2]!.source, 'user-mark-done')
  // 缺失合法（旧数据）→ undefined
  assert.equal(items[3]!.source, undefined)
  // 非法值丢弃 → undefined
  assert.equal(items[4]!.source, undefined)
})