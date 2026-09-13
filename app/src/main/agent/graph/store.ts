/**
 * ArkWork — TaskGraph 持久化（graph/store.ts）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §4.7 / §5.2 / §6.3
 *
 * 铁律（改动本文件前先读）：
 *  1. **`graph.json` 是唯一真相**；`graph.md`、UI、`Task.planItems` 三者都是渲染产物。
 *  2. **`mirrorPlanItems` 是 `Task.planItems` 的唯一写入来源**。任何其它代码路径
 *     都不允许直接改 `planItems` —— 否则会产生第二个真相源（v0.29 的清单漂移 bug
 *     就是"多写入方"造成的）。
 *  3. **写盘顺序固定**：快照 → schema 校验 → 原子写 graph.json → 追加 Revision →
 *     重算 graph.md → 重算 planItems 镜像 → 广播。任何一步失败都不留下半成品。
 *
 * 存储布局（相对当前工作区）：
 *   .arkwork/specs/<graphId>/graph.json          唯一真相，入 git
 *   .arkwork/specs/<graphId>/graph.md            只读渲染产物，入 git
 *   .arkwork/specs/<graphId>/evidence/           证据文件（graph.json 只存 ref 指针）
 *   .arkwork/specs/<graphId>/.snapshots/<ts>.json 写盘前自动快照，保留最近 5 份
 *   .arkwork/specs/index.json                    项目内全部 graph 索引
 *   .arkwork/specs/config.json                   默认 policy
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GRAPH_SCHEMA_VERSION,
  LAYER_BADGE,
  NODE_STATUSES,
  REPLAN_EVENT_LABEL,
  findBlockedNodes,
  flattenGraph,
  isValidGraphId,
  countStatuses,
  sumTokens,
  type GraphNotice,
  type GraphSnapshot,
  type GraphWriteError,
  type NodeStatus,
  type Revision,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import type { PlanItem, PlanItemSource } from '@shared/types/task'
import { getWorkspaceDir, JsonDoc } from '../../store/db.js'
import { updateTask } from '../../store/tasks.js'
import { getPlanApproval, listPendingPatches } from './pending.js'
import { logger } from '../../system/logger.js'

/** 快照保留份数 */
const SNAPSHOT_KEEP = 5

/* ============================================================
 * 一、路径
 * ============================================================ */

/** 规格目录根：{workspace}/.arkwork/specs */
export function getSpecsDir(): string {
  return join(getWorkspaceDir(), '.arkwork', 'specs')
}

/** 单个图的目录：{specs}/<graphId> */
export function getGraphDir(graphId: string): string {
  assertGraphId(graphId)
  return join(getSpecsDir(), graphId)
}

/** 唯一真相文件：{graphDir}/graph.json */
export function getGraphJsonPath(graphId: string): string {
  return join(getGraphDir(graphId), 'graph.json')
}

/** 只读渲染产物：{graphDir}/graph.md */
export function getGraphMdPath(graphId: string): string {
  return join(getGraphDir(graphId), 'graph.md')
}

/** 证据目录：{graphDir}/evidence */
export function getEvidenceDir(graphId: string): string {
  return join(getGraphDir(graphId), 'evidence')
}

/** 快照目录：{graphDir}/.snapshots */
export function getSnapshotsDir(graphId: string): string {
  return join(getGraphDir(graphId), '.snapshots')
}

/** graph 索引：{specs}/index.json */
export function getSpecsIndexPath(): string {
  return join(getSpecsDir(), 'index.json')
}

/** 默认 policy 配置：{specs}/config.json */
export function getSpecsConfigPath(): string {
  return join(getSpecsDir(), 'config.json')
}

/**
 * 目录穿越防护。
 * graphId / nodeId 会参与路径拼接，必须过白名单正则
 * （系统设计 §7.2 安全）。
 */
function assertGraphId(graphId: string): void {
  if (!isValidGraphId(graphId)) {
    throw new Error(`非法 graphId（拒绝拼路径）：${graphId}`)
  }
}

/* ============================================================
 * 二、Schema 校验
 * ============================================================ */

/** graph 索引条目 */
export interface GraphIndexEntry {
  graphId: string
  taskId: string
  title: string
  status: NodeStatus
  tier: number
  updatedAt: number
}

const NODE_STATUS_SET: ReadonlySet<string> = new Set<string>(NODE_STATUSES)

/**
 * 校验图对象的形状（不跑不变量 —— 不变量由 invariants.ts 负责）。
 *
 * 与 `validateGraph`（invariants.ts）的分工：
 *  - 本函数：**形状**问题（缺字段、类型错、schemaVersion 不匹配）→ 拒绝加载
 *  - `validateGraph`：**语义**问题（I1–I7）→ 加载后告警，不阻断
 *
 * 返回全部形状错误（加载时一次性把问题都告诉用户，而不是修一个报一个）。
 */
export function validateGraphShape(raw: unknown): GraphWriteError[] {
  const errs: GraphWriteError[] = []
  const fail = (message: string, hint: string, field?: string): void => {
    errs.push({ code: 'SCHEMA_INVALID', message, hint, violatedBy: { field } })
  }

  if (!raw || typeof raw !== 'object') {
    fail('graph.json 不是一个对象', '文件可能被外部编辑器破坏。请用 .snapshots/ 下的快照恢复，或删除该 graph.json 回退到扁平清单模式。')
    return errs
  }
  const g = raw as Partial<TaskGraph>

  if (g.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    fail(
      `schemaVersion 不匹配：期望 "${GRAPH_SCHEMA_VERSION}"，实际 "${String(g.schemaVersion)}"`,
      '该文件由不兼容的版本写入。请升级 ArkWork，或删除该 graph.json 让引擎按当前版本重建。',
      'schemaVersion',
    )
  }
  if (!g.id || typeof g.id !== 'string' || !isValidGraphId(g.id)) {
    fail(`id 缺失或格式非法："${String(g.id)}"`, 'id 必须形如 tg_20260913_ab12cd。', 'id')
  }
  if (typeof g.goal !== 'string') fail('goal 缺失', 'goal 是投影的恒在锚点，必须存在（可为空字符串）。', 'goal')
  if (!g.nodes || typeof g.nodes !== 'object') {
    fail('nodes 缺失或不是对象', 'nodes 必须是扁平的 Record<string, TaskNode>。', 'nodes')
    return errs
  }
  if (!Array.isArray(g.rootIds)) fail('rootIds 缺失或不是数组', 'rootIds 记录顶层节点顺序。', 'rootIds')
  if (!g.spec || typeof g.spec !== 'object') fail('spec 缺失', 'spec 承载验收契约，必须存在。', 'spec')
  if (!g.policy || typeof g.policy !== 'object') fail('policy 缺失', 'policy 承载 tier / 并行度 / 开关。', 'policy')
  if (!Array.isArray(g.revisions)) fail('revisions 缺失或不是数组', 'revisions 是审计流，必须存在（可为空数组）。', 'revisions')

  // 逐节点形状
  for (const [nodeId, node] of Object.entries(g.nodes as Record<string, TaskNode>)) {
    const at = (field: string): string => `nodes.${nodeId}.${field}`
    if (!node || typeof node !== 'object') {
      fail(at('(self)'), `节点 ${nodeId} 不是对象`, at('(self)'))
      continue
    }
    if (!node.id || node.id !== nodeId) fail(at('id'), `节点 id 与键不一致（键=${nodeId}）`, at('id'))
    if (!node.title || typeof node.title !== 'string') fail(at('title'), '标题缺失', at('title'))
    if (!NODE_STATUS_SET.has(node.status)) {
      fail(at('status'), `未知状态 "${String(node.status)}"，合法值：${NODE_STATUSES.join(' / ')}`, at('status'))
    }
    if (!['goal', 'milestone', 'task', 'step'].includes(node.layer)) {
      fail(at('layer'), `未知层级 "${String(node.layer)}"`, at('layer'))
    }
    if (!Array.isArray(node.children)) fail(at('children'), 'children 必须是数组', at('children'))
    if (!Array.isArray(node.dependsOn)) fail(at('dependsOn'), 'dependsOn 必须是数组', at('dependsOn'))
    if (!Array.isArray(node.acceptance)) fail(at('acceptance'), 'acceptance 必须是数组', at('acceptance'))
    if (!Array.isArray(node.evidence)) fail(at('evidence'), 'evidence 必须是数组', at('evidence'))
    if (!node.verification || typeof node.verification !== 'object') {
      fail(at('verification'), 'verification 缺失', at('verification'))
    }
    if (!node.assignee || typeof node.assignee !== 'object') {
      fail(at('assignee'), 'assignee 缺失（至少应为 { kind: "system" }）', at('assignee'))
    }
    // acceptance 的形状（type=test/command 时 verify 必填 —— 这条最容易踩）
    for (const [i, ac] of (node.acceptance ?? []).entries()) {
      if (!ac?.id) fail(at(`acceptance[${i}].id`), 'AC 缺少 id（如 AC-01）', at(`acceptance[${i}].id`))
      if (!ac?.statement) fail(at(`acceptance[${i}].statement`), `AC ${ac?.id ?? i} 缺少 statement`, at(`acceptance[${i}].statement`))
      if ((ac?.type === 'test' || ac?.type === 'command') && !ac?.verify?.command && !ac?.verify?.testIds?.length) {
        fail(
          at(`acceptance[${i}].verify`),
          `AC ${ac?.id ?? i} 的 type=${ac.type}，但 verify.command / verify.testIds 均缺失`,
          at(`acceptance[${i}].verify`),
        )
      }
    }
  }
  return errs
}

/* ============================================================
 * 三、读写
 * ============================================================ */

/** 每个 graphId 一个 JsonDoc 单例（复用其原子写：tmp + rename） */
const docs = new Map<string, JsonDoc<TaskGraph>>()

function getDoc(graphId: string): JsonDoc<TaskGraph> {
  const cached = docs.get(graphId)
  if (cached) return cached
  // fallback 用空对象形状占位；真实缺失由 loadGraphChecked 判定为 null
  const doc = new JsonDoc<TaskGraph>(getGraphJsonPath(graphId), {} as TaskGraph)
  docs.set(graphId, doc)
  return doc
}

/** 图加载结果（形状错误不 throw，交给调用方决定降级方式） */
export interface GraphLoadResult {
  graph: TaskGraph | null
  /** 形状错误。非空时 graph 为 null（**拒绝加载**，不做"尽力而为"的部分渲染） */
  shapeErrors: GraphWriteError[]
}

/**
 * 加载并校验图。
 *
 * **形状校验失败时返回 null（拒绝加载）** —— 设计稿硬要求：
 * 半张图比没有图更危险（会误导用户以为任务在正常推进）。
 * UI 侧的表现为 F20 的错误态：展示错误字段 + 快照恢复入口。
 */
export async function loadGraphChecked(graphId: string): Promise<GraphLoadResult> {
  if (!isValidGraphId(graphId)) {
    return {
      graph: null,
      shapeErrors: [{ code: 'SCHEMA_INVALID', message: `非法 graphId：${graphId}`, hint: 'id 必须形如 tg_20260913_ab12cd。' }],
    }
  }
  if (!existsSync(getGraphJsonPath(graphId))) return { graph: null, shapeErrors: [] }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(getGraphJsonPath(graphId), 'utf-8'))
  } catch (err) {
    return {
      graph: null,
      shapeErrors: [
        {
          code: 'SCHEMA_INVALID',
          message: `graph.json 不是合法 JSON：${(err as Error).message}`,
          hint: '文件可能被外部编辑器破坏。请用 .snapshots/ 下的快照恢复。',
          violatedBy: { field: '(file)' },
        },
      ],
    }
  }
  const shapeErrors = validateGraphShape(raw)
  if (shapeErrors.length > 0) {
    logger.warn('Agent', `graph ${graphId}: 形状校验失败（${shapeErrors.length} 项），拒绝加载`)
    return { graph: null, shapeErrors }
  }
  return { graph: raw as TaskGraph, shapeErrors: [] }
}

/** 简化版加载：校验失败返回 null（不再区分"不存在"与"损坏"，调用方需要区分时用 loadGraphChecked） */
export async function loadGraph(graphId: string): Promise<TaskGraph | null> {
  return (await loadGraphChecked(graphId)).graph
}

/**
 * 保存图。**唯一写入入口**。
 *
 * 副作用（按顺序）：
 *  1. 写前快照到 `.snapshots/<ts>.json`（保留最近 SNAPSHOT_KEEP 份）
 *  2. 形状校验（失败抛 SCHEMA_INVALID，不落盘）
 *  3. 原子写 `graph.json`
 *  4. 追加 Revision 到入参副本（调用方从返回值取最终图）
 *  5. 重算 `graph.md`（只读渲染产物）
 *  6. 重算 `Task.planItems` 镜像
 *  7. 维护 `specs/index.json`
 *
 * @param graph   要保存的图（会被冻结为不可变语义：本函数不修改入参）
 * @param options.revision  要追加的审计记录（op/reason 等由调用方填；seq/at 由本函数补齐）
 * @param options.skipSnapshot  跳过快照（迁移首次落盘时用，避免快照一个空状态）
 */
export async function saveGraph(
  graph: TaskGraph,
  options?: { revision?: Omit<Revision, 'seq' | 'at'>; skipSnapshot?: boolean; taskId?: string },
): Promise<TaskGraph> {
  assertGraphId(graph.id)

  // 1) 写前快照
  if (!options?.skipSnapshot && existsSync(getGraphJsonPath(graph.id))) {
    await snapshotGraph(graph.id).catch((err) =>
      logger.warn('Agent', `graph ${graph.id}: 快照失败（不阻断写入）：${(err as Error).message}`),
    )
  }

  // 2) 形状校验（保存前再校一次：防止代码 bug 写出坏图）
  const shapeErrors = validateGraphShape(graph)
  if (shapeErrors.length > 0) {
    const err: GraphWriteError = {
      code: 'SCHEMA_INVALID',
      message: `图形状校验失败：${shapeErrors[0].message}`,
      hint: '这是引擎内部错误，请不要重试同一操作；把该消息反馈给 ArkWork 维护者。',
    }
    throw Object.assign(new Error(err.message), { graphError: err })
  }

  // 3) 追加 Revision + 更新 updatedAt，再原子写
  const next: TaskGraph = { ...graph, updatedAt: Date.now() }
  if (options?.revision) {
    const seq = (next.revisions.at(-1)?.seq ?? 0) + 1
    next.revisions = [...next.revisions, { ...options.revision, seq, at: Date.now() }]
  }
  next.graphRevision = (graph.graphRevision ?? 0) + 1
  await getDoc(graph.id).write(next)

  // 5) 渲染 graph.md（失败不阻断主流程 —— 它只是给人看的产物）
  try {
    const { writeFile } = await import('node:fs/promises')
    await mkdir(getGraphDir(graph.id), { recursive: true })
    await writeFile(getGraphMdPath(graph.id), renderGraphMd(next), 'utf-8')
  } catch (err) {
    logger.warn('Agent', `graph ${graph.id}: graph.md 渲染失败：${(err as Error).message}`)
  }

  // 6) 重算 planItems 镜像（唯一写入点）
  if (options?.taskId) {
    try {
      await updateTask(options.taskId, {
        graphId: next.id,
        graphRevision: next.graphRevision,
        planItems: mirrorPlanItems(next),
      })
    } catch (err) {
      logger.warn('Agent', `graph ${graph.id}: planItems 镜像写入失败：${(err as Error).message}`)
    }
  }

  // 7) 维护索引
  await upsertIndex(next, options?.taskId).catch(() => {})

  return next
}

/** 删除图目录（连同快照）。仅在图损坏且用户选择"删除重建"时调用 */
export async function deleteGraph(graphId: string): Promise<void> {
  assertGraphId(graphId)
  docs.delete(graphId)
  const { rm } = await import('node:fs/promises')
  await rm(getGraphDir(graphId), { recursive: true, force: true })
  await removeIndexEntry(graphId).catch(() => {})
}

/* ============================================================
 * 四、快照
 * ============================================================ */

/** 写一份快照，返回时间戳名（当前文件已损坏时跳过并返回 ''，不把坏图收进快照目录）。保留最近 SNAPSHOT_KEEP 份（多的删掉） */
export async function snapshotGraph(graphId: string): Promise<string> {
  assertGraphId(graphId)
  const dir = getSnapshotsDir(graphId)
  await mkdir(dir, { recursive: true })
  const stamp = String(Date.now())
  const raw = await readFile(getGraphJsonPath(graphId), 'utf-8')
  // 快照目录的信任前提：每份快照都必须是可加载的好图。若当前 graph.json
  // 已损坏（外部编辑 / 半写），复制它只会污染恢复候选集（D6）。
  try {
    if (validateGraphShape(JSON.parse(raw)).length > 0) return ''
  } catch {
    return ''
  }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, `${stamp}.json`), raw, 'utf-8')

  // 清理旧快照
  const all = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  for (const old of all.slice(0, Math.max(0, all.length - SNAPSHOT_KEEP))) {
    await unlink(join(dir, old)).catch(() => {})
  }
  return stamp
}

/** 列出全部快照时间戳（升序） */
export async function listSnapshots(graphId: string): Promise<string[]> {
  assertGraphId(graphId)
  const dir = getSnapshotsDir(graphId)
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
}

/**
 * 恢复指定快照为当前图。
 * 返回恢复后的图（已通过形状校验）；快照不存在或已损坏时返回 null。
 *
 * `stamp` 传空串 = 恢复**最近一份可用快照**（UI「恢复上次可用快照」入口的语义，
 * 该按钮不知道具体时间戳，只知道"给我最近能用的"）。
 */
export async function restoreSnapshot(graphId: string, stamp: string): Promise<TaskGraph | null> {
  assertGraphId(graphId)
  let target = stamp
  if (!/^\d+$/.test(target)) {
    if (target !== '') return null
    const stamps = await listSnapshots(graphId)
    target = stamps.at(-1) ?? ''
    if (!target) return null
  }
  const path = join(getSnapshotsDir(graphId), `${target}.json`)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as unknown
    if (validateGraphShape(raw).length > 0) return null
    const graph = raw as TaskGraph
    // 恢复也要经 saveGraph（重算 md + 镜像 + 索引），并记一条审计
    return await saveGraph(graph, {
      revision: {
        by: { kind: 'human', id: 'user' },
        op: 'update',
        targetId: graph.id,
        reason: `从快照 ${stamp} 恢复（原始写入被判定损坏）`,
      },
    })
  } catch {
    return null
  }
}

/* ============================================================
 * 五、planItems 镜像（Task.planItems 的唯一写入来源）
 * ============================================================ */

/**
 * NodeStatus（11 态）→ PlanItemStatus（6 态）映射。
 *
 * 为什么需要映射：`planItems` 降级为**派生镜像**后，既有消费方
 * （StepList / 三视图 / 筛选器 / i18n 文案）仍按 6 态读取。
 * 映射原则：**非终态一律映射为 'running' 或 'pending'**，绝不让镜像
 * 表现出"已完成"的假象（这正是 v0.28.1 修过的"提前完成"bug 的同源风险）。
 */
export function mapNodeStatusToPlanItemStatus(status: NodeStatus): PlanItem['status'] {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'in_progress':
    case 'verifying':
    case 'needs_human':
      // verifying：正在验证 —— 仍是"在途"，绝不能显示成 done
      // needs_human：等人 —— 也仍在途，UI 的"待回答"由 graph 通道表达
      return 'running'
    case 'draft':
    case 'proposed':
    case 'approved':
    case 'ready':
    case 'blocked':
      return 'pending'
  }
}

/** Revision.by + op → v0.29 的 PlanItemSource（保留既有"引擎/模型/用户"徽标的语义） */
export function mapRevisionToPlanItemSource(rev: Revision | undefined): PlanItemSource | undefined {
  if (!rev) return undefined
  switch (rev.by.kind) {
    case 'system':
      return rev.op === 'migrate' ? 'plan-fallback' : 'engine-decide'
    case 'agent':
      return 'todo-update'
    case 'human':
      return 'user-mark-done'
    case 'external':
      return 'continuation'
  }
}

/**
 * 由图生成扁平清单镜像（**纯函数**）。
 *
 * 顺序：按 rootIds + children 深度优先，跳过 cancelled 的子树根
 * —— 与 flattenGraph 保持一致，保证面板树与镜像清单同序。
 */
export function mirrorPlanItems(graph: TaskGraph): PlanItem[] {
  // 每个节点最近一次与该节点相关的 Revision（用于 source 徽标）
  const lastRevByNode = new Map<string, Revision>()
  for (const rev of graph.revisions) lastRevByNode.set(rev.targetId, rev)

  const out: PlanItem[] = []
  const visit = (id: string): void => {
    const node: TaskNode | undefined = graph.nodes[id]
    if (!node) return
    // 层 goal 不进清单（它是整个任务的目标，不是"一项待办"）
    if (node.layer !== 'goal') {
      const status = mapNodeStatusToPlanItemStatus(node.status)
      out.push({
        id: node.id,
        text: node.key ? `${node.key} ${node.title}` : node.title,
        status,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        completedAt:
          status === 'done' || status === 'failed' || status === 'cancelled'
            ? node.updatedAt
            : undefined,
        source: mapRevisionToPlanItemSource(lastRevByNode.get(node.id)),
      })
    }
    for (const child of node.children) visit(child)
  }
  for (const rootId of graph.rootIds) visit(rootId)
  return out
}

/* ============================================================
 * 六、graph.md 渲染（只读产物，供人阅读与 PR review）
 * ============================================================ */

/** 状态 → markdown 复选框/符号 */
function statusMark(status: NodeStatus): string {
  switch (status) {
    case 'completed':
      return '[x]'
    case 'in_progress':
      return '[~]'
    case 'verifying':
      return '[?]'
    case 'needs_human':
      return '[!]'
    case 'failed':
      return '[✗]'
    case 'cancelled':
      return '[-]'
    case 'blocked':
      return '[b]'
    case 'proposed':
      return '[p]'
    default:
      return '[ ]'
  }
}

/**
 * 渲染 graph.md。
 *
 * **纯函数，只读产物** —— 人编辑这个文件不会影响 graph.json；
 * 反向解析走独立的校验器（v0.30.0 只做只读展示，双向编辑器放后续版本）。
 */
export function renderGraphMd(graph: TaskGraph): string {
  const lines: string[] = []
  const tierLabel = graph.policy.tierReason
    ? `T${graph.policy.tier} · ${graph.policy.tierReason}`
    : `T${graph.policy.tier}`

  lines.push(`# ${graph.title}`)
  lines.push('')
  lines.push('> 本文件是 `graph.json` 的**只读渲染产物**。请勿直接编辑 —— 改动会被下次写入覆盖。')
  lines.push('')
  lines.push(`- **目标**：${graph.goal}`)
  lines.push(`- **复杂度**：${tierLabel}`)
  lines.push(`- **Spec 状态**：${graph.spec.state}`)
  lines.push(`- **图版本**：${graph.graphRevision} · **修订次数**：${graph.revisions.length}`)
  lines.push(`- **更新时间**：${new Date(graph.updatedAt).toISOString()}`)
  lines.push('')

  if (graph.spec.scopeOut.length > 0) {
    lines.push('## 不做（Scope Out）')
    lines.push('')
    for (const s of graph.spec.scopeOut) lines.push(`- ${s}`)
    lines.push('')
  }
  if (graph.spec.scopeIn.length > 0) {
    lines.push('## 范围内（Scope In）')
    lines.push('')
    for (const s of graph.spec.scopeIn) lines.push(`- ${s}`)
    lines.push('')
  }

  lines.push('## 任务')
  lines.push('')
  const visit = (id: string, depth: number): void => {
    const node = graph.nodes[id]
    if (!node) return
    const indent = '  '.repeat(depth)
    const key = node.key ? `${node.key} ` : ''
    const badge = depth === 0 && node.layer === 'goal' ? '' : ` \`${LAYER_BADGE[node.layer]}\``
    lines.push(
      `${indent}- ${statusMark(node.status)} ${key}${node.title}${badge}${node.intent ? ` — ${node.intent}` : ''}`,
    )
    if (node.dependsOn.length > 0) {
      const deps = node.dependsOn.map((d) => graph.nodes[d]?.key ?? d).join(', ')
      lines.push(`${indent}  - 依赖：${deps}`)
    }
    for (const ac of node.acceptance) {
      const cmd = ac.verify?.command ? ` · \`${ac.verify.command}\`` : ''
      lines.push(`${indent}  - 验收 ${ac.id}[${ac.status}] ${ac.statement}${cmd}`)
    }
    for (const ev of node.evidence) {
      lines.push(`${indent}  - 证据 ${ev.kind}：${ev.summary}${ev.ref ? ` (${ev.ref})` : ''}`)
    }
    if (node.status === 'needs_human' && node.blockingQuestion) {
      lines.push(`${indent}  - ❓ 待回答：${node.blockingQuestion}`)
    }
    if (node.lastError) lines.push(`${indent}  - ⚠ 最近错误：${node.lastError}`)
    for (const child of node.children) visit(child, depth + 1)
  }
  for (const rootId of graph.rootIds) visit(rootId, 0)
  lines.push('')

  if (graph.spec.acceptance.length > 0) {
    lines.push('## 验收条件（Spec 层）')
    lines.push('')
    for (const ac of graph.spec.acceptance) {
      const cmd = ac.verify?.command ? ` · \`${ac.verify.command}\`` : ''
      const covered = ac.coveredBy.length > 0 ? ` · 覆盖：${ac.coveredBy.join(', ')}` : ' · ⚠ 无节点覆盖'
      lines.push(`- ${ac.id} **[${ac.status}]** ${ac.statement}${cmd}${covered}`)
    }
    lines.push('')
  }

  if (graph.spec.assumptions.length > 0) {
    lines.push('## 假设')
    lines.push('')
    for (const a of graph.spec.assumptions) {
      lines.push(`- ${a.id} ${a.text}${a.invalidated ? ` ⚠ **已失效**：${a.invalidated}` : ''}`)
    }
    lines.push('')
  }

  lines.push('## 审计（最近 20 条）')
  lines.push('')
  const recent = graph.revisions.slice(-20)
  if (recent.length === 0) {
    lines.push('_（无）_')
  } else {
    for (const rev of recent) {
      const who = rev.by.kind === 'agent' ? rev.by.id : rev.by.kind
      lines.push(
        `- #${rev.seq} ${new Date(rev.at).toISOString()} \`${rev.op}\` ${rev.targetId} by ${who}${rev.reason ? ` —— ${rev.reason}` : ''}`,
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}

/* ============================================================
 * 六、反向解析 + schema 校验（P8「编辑为 Markdown」出口）
 *
 * 依据：02-prd.md Scope Out 9 —— v0.30.0 **不做** graph.md 的双向编辑器，
 * 只做「只读渲染（renderGraphMd）+ 反向解析校验器」。
 *
 * 这个校验器只吃 renderGraphMd 产出的**安全子集**（目标 / scopeIn / scopeOut /
 * Spec 层验收条件），逐字段校验，任何一个字段非法就整包拒绝并回传
 * `violatedBy.field`（前端据此高亮字段、保留原 JSON）—— 这是 Cursor 2.2
 * 「模型/用户手改结构化产物后静默写坏」血案的直接对策：**宁拒绝，不猜测**。
 * ============================================================ */

/** 反向解析出的可合并子集（未列出的字段一律以 graph.json 原值为准） */
export interface PlanMarkdownParse {
  goal?: string
  scopeIn?: string[]
  scopeOut?: string[]
  acceptance?: { id: string; statement: string; verifyCommand?: string }[]
}

export type PlanMarkdownResult =
  | { ok: true; data: PlanMarkdownParse }
  | { ok: false; error: GraphWriteError }

const MD_SECTION_SCOPE_OUT = '## 不做（Scope Out）'
const MD_SECTION_SCOPE_IN = '## 范围内（Scope In）'
const MD_SECTION_AC = '## 验收条件（Spec 层）'

function schemaError(field: string, message: string, hint: string): PlanMarkdownResult {
  return {
    ok: false,
    error: { code: 'SCHEMA_INVALID', message, hint, violatedBy: { field, value: undefined } },
  }
}

/** 收集某个 `## ` 小节下的 `- ` 列表项（到下一个 `## ` 或结尾为止） */
function collectSectionItems(lines: string[], header: string): string[] {
  const start = lines.findIndex((l) => l.trim() === header)
  if (start < 0) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) break
    const m = /^-\s+(.+)$/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

/**
 * 反向解析 graph.md → 可合并子集。纯函数，不触碰图。
 *
 * 校验规则（对齐 SpecBlock 的硬约束）：
 *  - 目标：若出现则非空且 ≤ 200 字（TaskGraph.goal 的压缩约束）
 *  - scopeOut：**必须存在且非空**（交互文档 §P8：不做必须显式、不可折叠）
 *  - 验收条件：至少 1 条；AC id 同图唯一；陈述非空
 */
export function parsePlanMarkdown(md: string): PlanMarkdownResult {
  const lines = md.split(/\r?\n/)
  const data: PlanMarkdownParse = {}

  const goalLine = lines.find((l) => /^-\s+\*\*目标\*\*：/.test(l))
  if (goalLine) {
    const goal = goalLine.replace(/^-\s+\*\*目标\*\*：/, '').trim()
    if (!goal) return schemaError('goal', '目标为空', '请填写一句话目标（≤ 200 字），它会被投影到每轮上下文。')
    if (goal.length > 200) {
      return schemaError('goal', `目标过长（${goal.length} 字 > 200）`, '目标必须 ≤ 200 字（压缩第一优先级），请精简。')
    }
    data.goal = goal
  }

  const scopeOut = collectSectionItems(lines, MD_SECTION_SCOPE_OUT)
  if (scopeOut.length === 0) {
    return schemaError(
      'scopeOut',
      '「不做（Scope Out）」为空或缺失',
      'Scope Out 是必填项，且不可折叠。请至少列出 1 条明确不做的事 —— 没有边界的计划会范围蔓延。',
    )
  }
  data.scopeOut = scopeOut

  const scopeIn = collectSectionItems(lines, MD_SECTION_SCOPE_IN)
  if (scopeIn.length > 0) data.scopeIn = scopeIn

  const acItems = collectSectionItems(lines, MD_SECTION_AC)
  if (acItems.length === 0) {
    return schemaError('acceptance', '「验收条件（Spec 层）」为空或缺失', '至少需要 1 条验收条件，否则无法判断任务完成。')
  }
  const seen = new Set<string>()
  const acceptance: PlanMarkdownParse['acceptance'] = []
  for (const raw of acItems) {
    const m = /^(AC-[\w-]+)\s+\*\*\[[\w]+\]\*\*\s+(.*)$/.exec(raw)
    if (!m) {
      return schemaError(
        'acceptance',
        `无法解析验收条件行：${raw.slice(0, 60)}`,
        '验收条件行格式应为「- AC-01 **[pending]** 陈述 · `verify 命令`」。请勿改动行首的 id 与状态标记。',
      )
    }
    const [, id, restRaw] = m
    if (seen.has(id)) {
      return schemaError(`acceptance.${id}`, `验收条件 id 重复：${id}`, '同一图内 AC id 必须唯一，请改名。')
    }
    seen.add(id)
    let rest = restRaw.replace(/\s*·\s*覆盖：.*$/, '').replace(/\s*·\s*⚠?\s*无节点覆盖$/, '')
    let verifyCommand: string | undefined
    const cmdMatch = /\s*·\s*`([^`]+)`\s*$/.exec(rest)
    if (cmdMatch) {
      verifyCommand = cmdMatch[1].trim()
      rest = rest.slice(0, cmdMatch.index)
    }
    const statement = rest.trim()
    if (!statement) {
      return schemaError(`acceptance.${id}`, `${id} 陈述为空`, '验收条件必须有可读陈述（WHEN x THE SYSTEM SHALL y）。')
    }
    acceptance.push({ id, statement, verifyCommand })
  }
  data.acceptance = acceptance

  return { ok: true, data }
}

/* ============================================================
 * 六·五、面板快照（IPC graph:snapshot 的载荷构造）
 * ============================================================ */

/**
 * 构造面板快照（**纯函数**，只读 graph + pending 注册表）。
 *
 * 设计意图：让面板**一次 IPC 拿齐**画面所需的全部信息（树 + 计数 + 预算 +
 * 通知条 + 轻量模式判定），而不是让渲染层发 4–5 个请求再自己拼。
 * 依据：交互文档 §P1 的元素清单。
 *
 * @param graph  当前图
 * @param taskId 关联任务 id（回传给渲染层，便于多任务切换时校验）
 */
export function buildSnapshot(graph: TaskGraph, taskId: string): GraphSnapshot {
  const counts = countStatuses(graph)
  const pending = listPendingPatches(graph.id)
  const notices: GraphNotice[] = []

  // 1) Replan 通知（需批准的补丁 → danger/warn；已自动应用的 → info）
  for (const patch of pending) {
    if (patch.state === 'pending') {
      notices.push({
        kind: 'replan',
        severity: patch.approvalLevel >= 2 ? 'warn' : 'info',
        text: `计划需调整 · ${REPLAN_EVENT_LABEL[patch.triggerEvent]} · ${patch.reason.slice(0, 60)}`,
        refId: patch.id,
        dismissible: false, // 需批准的补丁不可随手关掉（要用户做决定）
      })
    }
  }

  // 2) 收敛通知（有发现时才出现；无发现静默 —— 与 converge.ts 的取向一致）
  const report = graph.spec.driftReport
  if (report && report.at && graph.spec.lastConvergeAt === report.at) {
    const parts: string[] = []
    const passing = report.acCoverage.filter((a) => a.status === 'passing' || a.status === 'waived').length
    if (report.acCoverage.length > 0) parts.push(`验收覆盖 ${passing}/${report.acCoverage.length}`)
    if (report.unmodeledWork.length > 0) parts.push(`${report.unmodeledWork.length} 项未建模工作`)
    if (report.zombieTasks.length > 0) parts.push(`${report.zombieTasks.length} 项僵尸任务`)
    if (report.invalidAssumptions.length > 0) parts.push(`${report.invalidAssumptions.length} 项假设失效`)
    if (report.degraded?.length) parts.push(`${report.degraded.join('/')} 检查未启用`)
    if (parts.length > 0) {
      notices.push({
        kind: report.invalidAssumptions.length > 0 ? 'assumption' : 'converge',
        severity: report.degraded?.length ? 'info' : 'warn',
        text: parts.join(' · '),
        refId: graph.id,
        dismissible: true,
      })
    }
  }

  // 3) needs_human 置顶提示（最高视觉优先级 —— 它是唯一"必须由人打破僵局"的状态）
  const waiting = findBlockedNodes(graph)
  if (waiting.length > 0) {
    notices.unshift({
      kind: 'replan',
      severity: 'danger',
      text: `${waiting.length} 项等待你回答 · ${waiting[0].blockingQuestion?.slice(0, 50) ?? ''}`,
      refId: waiting[0].id,
      dismissible: false,
    })
  }

  // 4) 外部系统镜像提示
  if (!graph.policy.builtinTaskListEnabled) {
    notices.unshift({
      kind: 'external-mirror',
      severity: 'info',
      text: '任务由外部系统驱动（只读镜像）',
      dismissible: false,
    })
  }

  const rows = flattenGraph(graph, { autoFoldDone: true })
  const lightweight = graph.policy.tier <= 1

  return {
    graphId: graph.id,
    taskId,
    title: graph.title,
    goal: graph.goal,
    status: graph.status,
    tier: graph.policy.tier,
    tierReason: graph.policy.tierReason,
    spec: {
      state: graph.spec.state,
      scopeIn: graph.spec.scopeIn,
      scopeOut: graph.spec.scopeOut,
      acceptance: graph.spec.acceptance.map((a) => ({
        id: a.id,
        statement: a.statement,
        status: a.status,
        verifyCommand: a.verify?.command,
        coveredBy: a.coveredBy,
      })),
    },
    policy: {
      builtinTaskListEnabled: graph.policy.builtinTaskListEnabled,
      autoConverge: graph.policy.autoConverge,
      allowSelfAttest: graph.policy.allowSelfAttest,
    },
    rows,
    counts,
    budget: { tokensUsed: sumTokens(graph), tokenBudget: sumBudget(graph) },
    notices,
    lightweight,
    source: !graph.policy.builtinTaskListEnabled
      ? 'external-mirror'
      : lightweight
        ? 'lightweight'
        : 'graph',
    planApproval: getPlanApproval(taskId),
    updatedAt: graph.updatedAt,
  }
}

/** 汇总各节点声明的 token 预算（面板的 `12.4k/40k` 显示） */
function sumBudget(graph: TaskGraph): number | undefined {
  let sum = 0
  let any = false
  for (const n of Object.values(graph.nodes)) {
    if (typeof n.tokenBudget === 'number' && n.tokenBudget > 0) {
      sum += n.tokenBudget
      any = true
    }
  }
  return any ? sum : undefined
}

/* ============================================================
 * 七、索引
 * ============================================================ */

interface GraphIndex {
  version: 1
  entries: GraphIndexEntry[]
}

const INDEX_FALLBACK: GraphIndex = { version: 1, entries: [] }

function indexDoc(): JsonDoc<GraphIndex> {
  return new JsonDoc<GraphIndex>(getSpecsIndexPath(), INDEX_FALLBACK)
}

/** 读取索引（损坏时返回空索引，不阻断） */
export async function readIndex(): Promise<GraphIndexEntry[]> {
  const idx = await indexDoc().read()
  return Array.isArray(idx?.entries) ? idx.entries : []
}

/** 写入/更新索引条目 */
export async function upsertIndex(graph: TaskGraph, taskId?: string): Promise<void> {
  const doc = indexDoc()
  const idx = await doc.read()
  const entries = Array.isArray(idx?.entries) ? idx.entries : []
  const now = Date.now()
  const entry: GraphIndexEntry = {
    graphId: graph.id,
    taskId: taskId ?? entries.find((e) => e.graphId === graph.id)?.taskId ?? '',
    title: graph.title,
    status: graph.status,
    tier: graph.policy.tier,
    updatedAt: now,
  }
  const at = entries.findIndex((e) => e.graphId === graph.id)
  if (at >= 0) entries[at] = entry
  else entries.push(entry)
  await doc.write({ version: 1, entries })
}

/** 从索引移除条目 */
export async function removeIndexEntry(graphId: string): Promise<void> {
  const doc = indexDoc()
  const idx = await doc.read()
  const entries = (Array.isArray(idx?.entries) ? idx.entries : []).filter((e) => e.graphId !== graphId)
  await doc.write({ version: 1, entries })
}

/** 按 taskId 反查 graphId（Task.graphId 缺失时的兜底查找） */
export async function findGraphIdByTaskId(taskId: string): Promise<string | null> {
  const entries = await readIndex()
  return entries.find((e) => e.taskId === taskId)?.graphId ?? null
}

/* ============================================================
 * 八、测试辅助
 * ============================================================ */

/** 清空内存中的 JsonDoc 缓存（切换工作区时调用；与 resetTaskCollection 同生命周期） */
export function resetGraphDocs(): void {
  docs.clear()
}
