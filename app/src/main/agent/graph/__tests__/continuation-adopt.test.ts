/**
 * v0.36.4 详测 — D122 续聊重做（用户实测：完成一轮任务后续聊新指令，
 * 任务清单更新异常 → 大模型重复执行已完成的任务，「非常严重」）
 *
 * 依据：docs/versions/v0.36.4/16-v0364-windows-compat-design.md §二 D122
 *
 * 根因链（三层叠加）：
 *   ① D119：Windows 文件锁 → `graph.json` 原子写失败 → `saveGraph` 第 ③ 步抛错
 *     → 第 ⑥ 步 planItems 镜像 + graphId 回写被整体跳过 → tasks.json 里该任务
 *     始终没有 graphId、planItems 停留在创建时全 pending；
 *   ② 续聊 run 的 `needsGraphMigration` 只看 graphId 字段 → 误判「未建图」
 *     → 用过期全 pending 清单重建第二张图 → 新图全部待执行 → 模型照单重做。
 *   ③ D119 修复（atomicWriteFile 重试 + 兜底）是根治，但历史受损 tasks.json
 *     仍需 ①的解耦 + ②的索引收养兜底。
 *
 * 修复面：
 *   - D122-①（graph/store.ts）：第 ③ 步 graph.json 写失败**不再中断**后续步骤，
 *     内存图仍是唯一真相，planItems 镜像 + graphId 照常回写（形状校验失败仍抛）；
 *   - D122-②（engine/run-setup.ts）：无 graphId 分支先查 specs 索引
 *     （findGraphIdByTaskId）收养既有图，绝不再迁移；查不到才走 needsGraphMigration。
 *
 * 手法：A 层真执行（真实临时工作区 + 目录占位 graph.json 制造写失败），
 *       B 层源码契约（剥离注释后断言，防 D89 式注释误报）。
 *
 * 运行（cwd=app）：
 *   ./node_modules/.bin/tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/agent/graph/__tests__/continuation-adopt.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/* ---------------- 模块引入（先于 setWorkspaceDir，纯加载无副作用） --------------- */

const { setWorkspaceDir } = await import('../../../store/db.js')
const { resetTaskCollection, createTask, getTask } = await import('../../../store/tasks.js')
const { saveGraph, loadGraph, getGraphJsonPath } = await import('../store.js')
const { putGraphCache, getGraphById } = await import('../sync.js')

import {
  GRAPH_SCHEMA_VERSION,
  defaultPolicy,
  defaultVerification,
  generateGraphId,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import { stripComments } from '@shared/utils/source-guard'

/* ---------------- 工作区构造（与 plan-sync.test.ts 同 harness） --------------- */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'arkwork-adopt-'))
setWorkspaceDir(WORKSPACE)
resetTaskCollection()

/* ---------------- 图构造器（与 plan-sync.test.ts 对齐） --------------- */

function node(over: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    parentId: null,
    layer: 'task',
    title: `节点 ${over.id}`,
    intent: 'D122 回归用意图',
    status: 'ready',
    assignee: { kind: 'system' },
    priority: 'p1',
    children: [],
    dependsOn: [],
    acceptance: [],
    evidence: [],
    verification: defaultVerification(),
    contextRefs: [],
    tokensUsed: 0,
    attempts: 0,
    sessionIds: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...over,
  }
}

function graph(nodes: TaskNode[], over: Partial<TaskGraph> = {}): TaskGraph {
  const map: Record<string, TaskNode> = {}
  for (const n of nodes) map[n.id] = n
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    id: generateGraphId(),
    title: 'D122 详测图',
    goal: '验证续聊不再用过期清单重建第二张图',
    status: 'in_progress',
    graphRevision: 1,
    spec: {
      state: 'draft',
      scopeIn: [],
      scopeOut: [],
      assumptions: [],
      constraints: [],
      acceptance: [],
      contextRefs: [],
    },
    nodes: map,
    rootIds: nodes.filter((n) => n.parentId === null).map((n) => n.id),
    policy: defaultPolicy(),
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** 剥离注释改用唯一真源 @shared/utils/source-guard（D101/D102，TC-D102-001 守卫）。
 * 不可自写朴素正则：源码字符串里存在 `prototype/*.html` 这类字面量，
 * 贪婪块剥离会把真实代码吞掉（本套件首版踩坑：run-setup.ts 中段调用点被误吞）。 */

const RUN_SETUP_SRC = readFileSync(new URL('../../engine/run-setup.ts', import.meta.url), 'utf-8')
const RUN_SETUP = stripComments(RUN_SETUP_SRC)

/* ============================================================
 * A. 运行时行为（D122-①）
 * ============================================================ */

test('TC-D122-001 saveGraph 第③步 graph.json 写失败不中断镜像回写（真执行）', async () => {
  const g = graph([
    node({ id: 't_d122a', key: 'T-01', title: '已完成节点', status: 'completed' }),
    node({ id: 't_d122b', key: 'T-02', title: '在途节点', status: 'in_progress' }),
  ])
  const task = await createTask({ title: 'D122 续聊任务', text: '', agentId: 'coder', modelId: 'test-model' })
  putGraphCache(g)

  // 制造 graph.json 写失败：用同名**目录**占位 —— tmp 写成功、rename 落到目录上
  // 得 EISDIR（非 EPERM/EACCES/EBUSY，不属于 D119 重试面）→ 原实现直接抛错。
  const jsonPath = getGraphJsonPath(g.id)
  mkdirSync(jsonPath, { recursive: true })
  assert.ok(statSync(jsonPath).isDirectory(), '前置：graph.json 已被目录占位（写必失败）')

  // 修复后：不抛错，返回值带 revision +1，且第 ⑥/⑦ 步照常执行
  const saved = await saveGraph(g, {
    revision: { by: { kind: 'system' }, op: 'update', targetId: g.id, reason: 'D122 回归：写失败不中断' },
    skipSnapshot: true,
    taskId: task.id,
  })
  assert.equal(saved.graphRevision, 2, 'revision 在内存副本上正常递增')

  // 关键断言：tasks.json 里 graphId + planItems 镜像照常回写（D119 失败窗口不再丢）
  const t = await getTask(task.id)
  assert.equal(t?.graphId, saved.id, 'graphId 必须回写（缺它就是续聊重做的根因）')
  assert.equal(t?.graphRevision, 2)
  assert.ok((t?.planItems?.length ?? 0) >= 2, 'planItems 镜像照常回写（不再停留在创建时全 pending）')

  // 磁盘上 graph.json 写确实失败了（仍是目录）—— 证明走的是降级路径而非侥幸成功
  assert.ok(statSync(jsonPath).isDirectory(), 'graph.json 写入确实失败（目录占位未被覆盖）')

  // 内存真相可从缓存恢复：getGraphById 缓存优先（磁盘 graph.json 写失败不影响内存真相）
  const reloaded = await getGraphById(g.id)
  assert.ok(reloaded, '内存图仍在（唯一真相保留）')
})

test('TC-D122-002 形状校验失败仍然抛出（坏图不允许流出）', async () => {
  const bad = graph([node({ id: 't_d122bad' })])
  // 破坏形状：schemaVersion 非法 → validateGraphShape 报错（写盘 IO 失败才被 D122 解耦）
  bad.schemaVersion = 'bogus-version' as unknown as typeof bad.schemaVersion
  await assert.rejects(
    () => saveGraph(bad, { skipSnapshot: true }),
    /图形状校验失败/,
    'SCHEMA_INVALID 必须抛，D122 解耦只针对「落盘 IO 失败」',
  )
})

/* ============================================================
 * B. 源码契约（D122-② run-setup 索引收养）
 * ============================================================ */

test('TC-D122-003 无 graphId 分支先查 specs 索引收养既有图，再判迁移（顺序不变量）', () => {
  assert.match(
    RUN_SETUP,
    /findGraphIdByTaskId\(task\.id\)/,
    'run-setup 应调用 specs 索引查询 findGraphIdByTaskId',
  )
  const adoptIdx = RUN_SETUP.indexOf('findGraphIdByTaskId(task.id)')
  const migrateJudgeIdx = RUN_SETUP.indexOf('needsGraphMigration(')
  assert.ok(adoptIdx >= 0, '收养查询锚点存在')
  assert.ok(migrateJudgeIdx > adoptIdx, '收养查询必须先于 needsGraphMigration 判定（否则过期清单先跑）')
  // 收养成功即短路迁移：迁移判定以「未收养到图」为前置条件
  assert.match(
    RUN_SETUP,
    /!task\.graphId && needsGraphMigration\(/,
    '迁移判定必须是 !task.graphId && needsGraphMigration(...)（收养成功则跳过迁移）',
  )
  // 收养路径写回 task（graphId + graphRevision），并留人话日志（纪律⑨：静默退化要留诊断）
  assert.match(RUN_SETUP, /task\.graphId = adopted\.id/, '收养应把既有图 id 写回 task.graphId')
  assert.match(RUN_SETUP, /graph adopted via index/, '收养路径应有 warn 日志（人话可诊断）')
  // 收养查询自身容错：索引不可用按无图处理，不阻断任务（注释已剥，只看空 catch 体）
  assert.match(RUN_SETUP, /catch \{\s*\}\s*/, '索引查询失败应有容错 catch（空体即按无图处理）')
})

test('TC-D122-004 needsGraphMigration 语义未被放松（graphId 判据保持）', () => {
  const MIGRATE = stripComments(readFileSync(new URL('../migrate.ts', import.meta.url), 'utf-8'))
  assert.match(
    MIGRATE,
    /if \(task\.graphId\) return false\s*return \(task\.planItems\?\.length \?\? 0\) > 0/,
    'needsGraphMigration 判据保持「graphId 缺失且有 planItems」；防误判由上游收养兜底负责',
  )
})

test('TC-D122-005 store.ts 第③步解耦契约（写失败 warn + 后续步骤保留）', () => {
  const STORE = stripComments(readFileSync(new URL('../store.ts', import.meta.url), 'utf-8'))
  // 第③步：getDoc().write 包 try/catch，catch 内只有 warn（不 rethrow）
  const writeAnchor = STORE.indexOf('await getDoc(graph.id).write(next)')
  assert.ok(writeAnchor >= 0, '第③步写图锚点存在')
  const after = STORE.slice(writeAnchor, writeAnchor + 600)
  assert.match(after, /catch \(err\)[\s\S]{0,400}logger\.warn/, '写图失败应有 catch + warn')
  // 关键：catch 块内不得 rethrow（D122 解耦的核心）
  const catchStart = after.indexOf('catch (err)')
  const catchBody = after.slice(catchStart, after.indexOf('}', catchStart) + 1)
  assert.doesNotMatch(catchBody, /throw/, '第③步 catch 块不得 rethrow（一抛镜像又被跳过）')
  // 第⑥步镜像回写在写图之后仍然存在，且 updateTask 带 graphId（代码锚点，不依赖注释）
  const mirrorIdx = STORE.indexOf('mirrorPlanItems(next)')
  assert.ok(mirrorIdx > writeAnchor, '第⑥步镜像回写应保留在第③步之后')
  assert.match(STORE, /updateTask\(options\.taskId, \{\s*graphId: next\.id/, '镜像回写必须带 graphId')
})
