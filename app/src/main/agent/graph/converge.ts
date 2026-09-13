/**
 * ArkWork — 收敛环 Converge（DriftReport）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §4.6 / §6.4
 *       agent-design-v1.0/03-统一任务模型TaskGraph.md §7
 *
 * 设计稿的判词：**"没有收敛环的 Spec 只是更长的 prompt。"**
 * v0.29 的 `planItems` 正落在这个判定里 —— 它是"更长的 prompt 的结构化版本"，
 * 还不是"能被对照校验的真相源"。本模块把它补上。
 *
 * 四项检查（设计稿 §7.2）：
 *  1. **覆盖检查** —— 所有 AC 是否都有节点覆盖、是否都 passing
 *  2. **漂移检查** —— 代码库实际状态 vs 图描述：
 *     未建模的工作（代码里做了但图没有）/ 僵尸任务（图有但代码已无对应）
 *  3. **假设校验** —— `spec.assumptions` 是否仍成立
 *  4. **重复检测** —— 是否出现与既有节点重复的新实现
 *
 * **两条必须坚守的诚实性原则**：
 *  1. **"未启用"与"无发现"必须区分**。无 git 时漂移检查整体不可用 →
 *     `degraded=['drift']`，UI 上显示灰色 ⊘ + 原因，**绝不显示为"0 项发现"**
 *     （那等于谎报绿灯）。
 *  2. **重复检测只标记"疑似"，不自动合并**。判断"两个节点是不是在做同一件事"
 *     需要领域理解，误判会直接删掉用户的真实工作。
 */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AcceptanceStatus,
  ConvergeDegradedDim,
  DriftReport,
  TaskGraph,
  TaskNode,
} from '@shared/types/graph'
import { getWorkspaceDir } from '../../store/db.js'
import { logger } from '../../system/logger.js'

const execFileAsync = promisify(execFile)

/** 一次 converge 的输入 */
export interface ConvergeInput {
  /** 工作区目录（缺省：当前工作区） */
  workspaceDir?: string
  /** 会话 id（写进报告，便于回溯） */
  sessionId?: string
  /** 是否做深度漂移分析（false 时只做覆盖检查 —— E9 的轻量收敛） */
  deep?: boolean
}

/**
 * 执行收敛检查。
 *
 * **不修改图** —— 它只产出报告。是否把未建模工作变成节点，由用户在
 * 收敛报告卡上决定（走 ReplanPatch，仅追加 → 自动应用）。
 */
export async function runConverge(graph: TaskGraph, input: ConvergeInput = {}): Promise<DriftReport> {
  const ws = input.workspaceDir ?? getWorkspaceDir()
  const degraded: ConvergeDegradedDim[] = []

  // ---- 1. 覆盖检查 ----
  const acCoverage = collectAcCoverage(graph)

  // ---- 2/4. 漂移与重复（依赖 git，可降级） ----
  let unmodeledWork: DriftReport['unmodeledWork'] = []
  let zombieTasks: DriftReport['zombieTasks'] = []
  if (input.deep !== false) {
    const gitOk = await isGitRepo(ws)
    if (!gitOk) {
      // ★ 能力不可用 —— 与"检查过且干净"是两回事
      degraded.push('drift', 'dup')
    } else {
      const changed = await listChangedFiles(ws)
      if (changed === null) {
        degraded.push('drift', 'dup')
      } else {
        unmodeledWork = detectUnmodeledWork(graph, changed)
      }
    }
    // 僵尸任务不依赖 git（只看声明文件是否存在）
    zombieTasks = detectZombieTasks(graph, ws)
  }

  // ---- 3. 假设校验 ----
  const invalidAssumptions = graph.spec.assumptions
    .filter((a) => a.invalidated)
    .map((a) => ({ assumptionId: a.id, assumption: a.text, contradictedBy: a.invalidated as string }))

  const report: DriftReport = {
    at: Date.now(),
    acCoverage,
    unmodeledWork,
    zombieTasks,
    invalidAssumptions,
    appendedTaskIds: [],
    degraded: degraded.length > 0 ? degraded : undefined,
  }

  logger.info(
    'Agent',
    `converge: ${acCoverage.filter((a) => a.status === 'passing').length}/${acCoverage.length} AC passing · ` +
      `${unmodeledWork.length} 未建模 · ${zombieTasks.length} 僵尸 · ${invalidAssumptions.length} 失效假设` +
      (degraded.length > 0 ? ` · 降级=[${degraded.join(',')}]` : ''),
  )
  return report
}

/**
 * 是否需要触发收敛（供 engine 侧判定，不依赖事件总线）。
 *
 * 与 E9 的分工：E9 是"每 N 个 completed 节点"的定时兜底；
 * 本函数额外覆盖"milestone 完成"与"会话恢复"两个触发点（设计稿 §7.1）。
 */
export function shouldConverge(
  graph: TaskGraph,
  opts: { reason: 'milestone' | 'session-resume' | 'user-request' | 'scheduled'; completedDelta?: number },
): boolean {
  if (!graph.policy.autoConverge) return false
  switch (opts.reason) {
    case 'milestone':
    case 'session-resume':
    case 'user-request':
      return true
    case 'scheduled':
      return (opts.completedDelta ?? 0) >= 5
  }
}

/* ============================================================
 * 内部：四项检查的实现
 * ============================================================ */

/** 1. AC 覆盖检查 */
function collectAcCoverage(graph: TaskGraph): DriftReport['acCoverage'] {
  const specAcs = graph.spec.acceptance.map((a) => ({
    acId: a.id,
    status: a.status as AcceptanceStatus,
    coveredBy: a.coveredBy,
  }))
  if (specAcs.length > 0) return specAcs
  // Spec 层没有 AC（迁移出来的老任务 / tier 1）→ 退化为收集节点层 AC，
  // 用 `节点key:AC-id` 作为标识。这样报告里不会出现"空覆盖 0/0"的假绿灯。
  const out: DriftReport['acCoverage'] = []
  for (const node of Object.values(graph.nodes)) {
    for (const ac of node.acceptance) {
      out.push({
        acId: `${node.key ?? node.id}:${ac.id}`,
        status: ac.status,
        coveredBy: ac.coveredBy.length > 0 ? ac.coveredBy : [node.id],
      })
    }
  }
  return out
}

/** 是否 git 仓库 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 3000 })
    return true
  } catch {
    return false
  }
}

/**
 * 列出工作区变更文件（相对路径）。
 * 返回 `null` 表示**能力不可用**（git 报错/超时），与"空数组（无变更）"严格区分。
 */
async function listChangedFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const files: string[] = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      // 格式：XY <path>（重命名是 "XY old -> new"）
      const raw = line.slice(3).trim()
      const path = raw.includes(' -> ') ? raw.split(' -> ')[1] : raw
      // 只关心源码/配置类变更，忽略 .arkwork（它是我们的产物）与构建产物
      if (path.startsWith('.arkwork/')) continue
      if (/(^|\/)(node_modules|out|dist|build|release)\//.test(path)) continue
      files.push(path)
    }
    return files
  } catch (err) {
    logger.warn('Agent', `converge: git status 失败，漂移检查降级：${(err as Error).message}`)
    return null
  }
}

/**
 * 2. 未建模工作：工作区里被改动、但没有任何节点把它声明为 contextRef 的文件。
 *
 * 这些是"代码里做了但图里没有"的候选。按**模块聚合**（不是逐文件）——
 * 否则改 10 个文件会生成 10 条待审条目，用户会直接点"忽略"。
 */
function detectUnmodeledWork(graph: TaskGraph, changedFiles: string[]): DriftReport['unmodeledWork'] {
  const declared = new Set<string>()
  for (const node of Object.values(graph.nodes)) {
    for (const ref of node.contextRefs) {
      if (ref.kind === 'file') declared.add(normalizePath(ref.ref))
    }
  }
  // 已完成的节点产出的文件也算"已建模"（否则刚做完的东西立刻被报成未建模）
  const filesByModule = new Map<string, string[]>()
  for (const f of changedFiles) {
    if (declared.has(normalizePath(f))) continue
    const mod = moduleOf(f)
    const list = filesByModule.get(mod) ?? []
    list.push(f)
    filesByModule.set(mod, list)
  }

  const out: DriftReport['unmodeledWork'] = []
  for (const [mod, files] of filesByModule) {
    // 疑似重复：模块路径或文件名与某个节点的标题/声明有词法交集
    const dupOf = findSuspectedDuplicate(graph, mod, files)
    out.push({
      description:
        files.length === 1
          ? `修改了 ${files[0]}`
          : `改动了 ${mod} 模块下 ${files.length} 个文件（${files.slice(0, 3).join(', ')}${files.length > 3 ? ' 等' : ''}）`,
      evidence: files.slice(0, 5).join('\n'),
      suggestedTask: {
        layer: 'task',
        title: `复核 ${mod} 的改动并补充验收`.slice(0, 80),
        intent: '代码库中出现了任务图未建模的改动，需要确认是否应纳入计划',
        status: 'ready',
        assignee: { kind: 'agent', id: 'agent' },
        priority: 'p2',
        children: [],
        dependsOn: [],
        derivedFrom: ['converge'],
        acceptance: [],
        evidence: [],
        verification: { required: false, maxAttempts: 3, allowSelfAttest: false },
        contextRefs: files.slice(0, 5).map((f) => ({ kind: 'file' as const, ref: f, note: '收敛检查发现的改动' })),
        tokensUsed: 0,
        attempts: 0,
        sessionIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        revision: 1,
      },
      dupOf,
    })
  }
  return out.slice(0, 10) // 上限：避免报告卡被淹没
}

/** 3. 僵尸任务：图里有、但声明的文件已不存在（且节点未完成） */
function detectZombieTasks(graph: TaskGraph, ws: string): DriftReport['zombieTasks'] {
  const out: DriftReport['zombieTasks'] = []
  for (const node of Object.values(graph.nodes)) {
    if (node.status === 'completed' || node.status === 'cancelled') continue
    const files = node.contextRefs.filter((r) => r.kind === 'file').map((r) => r.ref)
    if (files.length === 0) continue
    const allGone = files.every((f) => !existsSync(resolvePath(ws, f)))
    if (allGone) {
      out.push({
        taskId: node.id,
        reason: `声明的 ${files.length} 个文件均已不存在（${files.slice(0, 2).join(', ')}）—— 任务可能已被其它改动取代`,
      })
    }
  }
  return out.slice(0, 10)
}

/** 4. 疑似重复：模块/文件名与既有节点标题的词法重合 */
function findSuspectedDuplicate(graph: TaskGraph, mod: string, files: string[]): string | undefined {
  const moduleTokens = new Set(tokenize(mod))
  for (const f of files) for (const t of tokenize(f)) moduleTokens.add(t)
  if (moduleTokens.size === 0) return undefined

  let best: { id: string; hit: number } | undefined
  for (const node of Object.values(graph.nodes)) {
    if (node.layer === 'goal') continue
    const nodeTokens = tokenize(`${node.title} ${node.intent ?? ''}`)
    let hit = 0
    for (const t of nodeTokens) if (moduleTokens.has(t)) hit += 1
    if (hit >= 2 && (!best || hit > best.hit)) best = { id: node.id, hit }
  }
  return best?.id
}

/* ============================================================
 * 内部：路径工具
 * ============================================================ */

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/** 取前两段作为模块标识（src/main/foo.ts → src/main） */
function moduleOf(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length <= 1 ? parts[0] ?? p : parts.slice(0, 2).join('/')
}

function resolvePath(ws: string, p: string): string {
  return p.startsWith('/') ? p : `${ws.replace(/\/$/, '')}/${p}`
}

const STOPWORDS = new Set(['src', 'lib', 'the', 'and', 'for', 'with', 'ts', 'tsx', 'js', 'index'])

function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_]{3,}/g)) {
    if (!STOPWORDS.has(m[0])) out.push(m[0])
  }
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2))
  }
  return out
}

/* ============================================================
 * 渲染给 UI / 模型看的摘要
 * ============================================================ */

/** 收敛报告的一行摘要（面板顶部通知条用） */
export function renderConvergeNoticeText(report: DriftReport): string {
  const parts: string[] = []
  const passing = report.acCoverage.filter((a) => a.status === 'passing' || a.status === 'waived').length
  if (report.acCoverage.length > 0) parts.push(`验收覆盖 ${passing}/${report.acCoverage.length}`)
  if (report.unmodeledWork.length > 0) parts.push(`发现 ${report.unmodeledWork.length} 项未建模工作`)
  if (report.zombieTasks.length > 0) parts.push(`${report.zombieTasks.length} 项僵尸任务`)
  if (report.invalidAssumptions.length > 0) parts.push(`${report.invalidAssumptions.length} 项假设失效`)
  if (report.degraded?.length) parts.push(`（${report.degraded.join('/')} 检查未启用）`)
  return parts.join(' · ') || '收敛检查完成，无发现'
}

/** 报告是否有"需要用户注意"的内容（决定弹出卡片还是静默） */
export function hasConvergeFindings(report: DriftReport): boolean {
  return (
    report.unmodeledWork.length > 0 ||
    report.zombieTasks.length > 0 ||
    report.invalidAssumptions.length > 0 ||
    report.degraded !== undefined ||
    report.acCoverage.some((a) => a.status === 'failing')
  )
}

/** 供 node 展示用：节点是否"看起来是僵尸" */
export function looksZombie(report: DriftReport | undefined, nodeId: string): boolean {
  return (report?.zombieTasks ?? []).some((z) => z.taskId === nodeId)
}

/** 类型守卫：判断一个 unknown 是否可以当 TaskNode 用（IPC 入参校验） */
export function isTaskNodeLike(v: unknown): v is TaskNode {
  return !!v && typeof v === 'object' && typeof (v as TaskNode).title === 'string'
}
