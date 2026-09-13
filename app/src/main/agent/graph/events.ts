/**
 * ArkWork — Sync · S5 Event（事件判定）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.1
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §2.2-S5 / §4.2
 *
 * 解决的问题：v0.29 的"危机响应"是**散落在几处的局部守卫**
 * （无工具调用守卫、只读停滞、签名预算耗尽、迭代上限），而没有一个
 * **全局事件总线**回答"现在该不该重规划 / 该不该问人 / 该不该收敛"。
 *
 * 本模块把 E1–E9 九类触发条件集中判定，输出"动作建议"：
 *  `replan`（重规划） / `ask`（问人） / `converge`（收敛检查） / `none`。
 *
 * **设计原则：Replan 是事件驱动而非定时**（准则 C5）。
 * 理由（设计稿 §4.1）：定时 Replan 的成本是刚性的，而任务的不确定性是突发式的；
 * Manus 的教训是 1/3 的动作花在更新 todo 上。
 *
 * 关于三条"模型/外部驱动"事件的实现诚实性说明：
 *  E3（发现新依赖）/ E4（假设被证伪）/ E5（用户插需求）本质上**不是引擎能可靠
 *  推断的**（需要领域判断）。本版的处理：
 *   - E4 / E5 由**明确信号**驱动（converge 报告的失效假设 / 用户新增消息），可靠
 *   - E3 用**保守启发式**（产出文件落在声明模块之外）给出**建议**，不自动改图
 *  详见各条注释。
 */
import type { NodeStatus, ReplanEventType, TaskGraph } from '@shared/types/graph'
import type { DriftResult } from './drift.js'

/** 事件判定输出 */
export interface EventDecision {
  event: ReplanEventType
  action: 'none' | 'replan' | 'ask' | 'converge'
  reason: string
  /** 事件涉及的节点（用于 Replan 定位） */
  nodeId?: string
}

/** 判定输入（engine 侧组装） */
export interface EventInput {
  /** S2 的漂移结果 */
  drift?: DriftResult
  /** 是否刚刚发生过上下文压缩（E6） */
  afterCompaction?: boolean
  /** 用户是否在执行中插入了新需求（E5，由 run-setup 置位） */
  userInserted?: boolean
  /** 本轮 act 产出的文件（E3 启发式用） */
  files?: string[]
  /** 上次 converge 时的 completed 节点计数（E9 用） */
  lastConvergeCompleted?: number
  /** 距上次 converge 已完成多少个 task 才触发轻量收敛（默认 5） */
  convergeEvery?: number
}

/** 完成率与验收通过率不匹配的阈值（E7） */
const E7_DONE_RATIO = 0.8
const E7_AC_PASS_RATIO = 0.5
/** 单节点 token 消耗占其预算的比例阈值（E8） */
const E8_BUDGET_RATIO = 0.8
/** E9 默认间隔 */
const E9_DEFAULT_EVERY = 5

/**
 * 判定全部事件。返回**所有**命中项（调用方按优先级取第一个执行）。
 *
 * 优先级（执行顺序）：E1 失败 → E2 漂移 → E7 验收脱节 → E8 预算压力
 *  → E5 用户插需求 → E4 假设失效 → E3 新依赖 → E6 压缩后 → E9 定时兜底。
 * 理由：越靠前的问题越"必须马上处理"，越靠后的越"可以稍后处理"。
 */
export function evaluateEvents(graph: TaskGraph, input: EventInput = {}): EventDecision[] {
  const out: EventDecision[] = []
  const nodes = Object.values(graph.nodes)
  const completed = nodes.filter((n) => n.status === 'completed')
  const workNodes = nodes.filter((n) => n.layer !== 'goal')

  // ---- E1 连续失败：attempts 达上限 ----
  for (const node of nodes) {
    if (node.attempts >= node.verification.maxAttempts && node.status === 'failed') {
      out.push({
        event: 'E1',
        action: 'replan',
        nodeId: node.id,
        reason: `节点 ${node.key ?? node.id} 连续失败 ${node.attempts}/${node.verification.maxAttempts} 次${
          node.lastError ? `（${node.lastError.slice(0, 80)}）` : ''
        }`,
      })
      break // 一次只处理一个失败点，避免事件爆炸
    }
  }

  // ---- E2 漂移超限 ----
  if (input.drift?.action === 'hard') {
    const focus = nodes.find((n) => n.status === 'in_progress')
    out.push({
      event: 'E2',
      action: 'ask',
      nodeId: focus?.id,
      reason: `持续偏离当前任务 ${input.drift.streak} 轮（一致性 ${input.drift.score.toFixed(2)}）：${input.drift.detail}`,
    })
  }

  // ---- E7 完成率与验收不匹配 ----
  const acAll = collectAcceptance(graph)
  if (workNodes.length >= 3 && completed.length / Math.max(1, workNodes.length) >= E7_DONE_RATIO) {
    const passRatio =
      acAll.length === 0
        ? 1
        : acAll.filter((a) => a.status === 'passing' || a.status === 'waived').length / acAll.length
    if (passRatio < E7_AC_PASS_RATIO && acAll.length > 0) {
      out.push({
        event: 'E7',
        action: 'converge',
        reason: `已完成 ${completed.length}/${workNodes.length} 个节点，但验收通过率仅 ${(passRatio * 100).toFixed(0)}%（可能验收标准有问题，也可能实现有问题）`,
      })
    }
  }

  // ---- E8 上下文预算压力 ----
  const focus = nodes.find((n) => n.status === 'in_progress') ?? nodes.find((n) => n.status === 'verifying')
  if (focus) {
    const budget = focus.tokenBudget ?? sumDeclaredBudget(graph)
    if (budget && focus.tokensUsed > budget * E8_BUDGET_RATIO) {
      out.push({
        event: 'E8',
        action: 'replan',
        nodeId: focus.id,
        reason: `节点 ${focus.key ?? focus.id} 已消耗 ${fmtK(focus.tokensUsed)}/${fmtK(budget)} tokens（超 ${E8_BUDGET_RATIO * 100}%），建议拆分该任务`,
      })
    }
  }

  // ---- E5 用户插入需求 ----
  if (input.userInserted) {
    out.push({
      event: 'E5',
      action: 'replan',
      reason: '用户在执行中追加/修改了需求，需要评估影响范围并增量重规划',
    })
  }

  // ---- E4 假设被证伪（来自最近一次 converge 报告） ----
  const invalidAssumptions = graph.spec.assumptions.filter((a) => a.invalidated)
  if (invalidAssumptions.length > 0) {
    out.push({
      event: 'E4',
      action: 'replan',
      reason: `假设被证伪：${invalidAssumptions
        .map((a) => `「${a.text}」（${a.invalidated?.slice(0, 60)}）`)
        .join('；')} → 需走 Spec 修订流程`,
    })
  } else if (graph.spec.driftReport?.invalidAssumptions?.length) {
    const list = graph.spec.driftReport.invalidAssumptions
    out.push({
      event: 'E4',
      action: 'replan',
      reason: `收敛检查发现 ${list.length} 项假设失效：${list
        .map((a) => `「${a.assumption}」`)
        .join('；')}`,
    })
  }

  // ---- E3 发现新依赖（保守启发式） ----
  const e3 = detectNewDependency(graph, input.files)
  if (e3) out.push(e3)

  // ---- E6 上下文压缩后 ----
  if (input.afterCompaction) {
    out.push({
      event: 'E6',
      action: 'none', // 动作是"强制重新投影"，由 sync.ts 的 S1 承担，不是 Replan
      reason: '上下文已压缩，强制重新投影活跃窗口并做一次一致性检查',
    })
  }

  // ---- E9 定时兜底 ----
  const every = input.convergeEvery ?? E9_DEFAULT_EVERY
  const last = input.lastConvergeCompleted ?? 0
  if (completed.length - last >= every) {
    out.push({
      event: 'E9',
      action: 'converge',
      reason: `距上次收敛已完成 ${completed.length - last} 个节点（阈值 ${every}），执行轻量覆盖检查`,
    })
  }

  return out
}

/** 按优先级取"最该执行的那个"动作（调用方通常只处理它） */
export function pickPrimaryAction(decisions: EventDecision[]): EventDecision | undefined {
  const order: EventDecision['action'][] = ['replan', 'ask', 'converge', 'none']
  for (const a of order) {
    const hit = decisions.find((d) => d.action === a && d.event !== 'E6')
    if (hit) return hit
  }
  return decisions.find((d) => d.event === 'E6')
}

/* ============================================================
 * 内部
 * ============================================================ */

/**
 * E3 启发式：本轮产出的文件是否落在**当前节点声明模块之外**。
 *
 * 诚实说明：这不是可靠的"发现新依赖"检测 —— 真正的依赖发现需要领域判断。
 * 本启发式的定位是**给出建议**（写进事件日志与 UI 提示），**不自动改图**：
 * 一旦自动加节点，误判会直接污染任务图。
 *
 * 回退：当前节点没有声明 `contextRefs` 时**不判定**（无法比对 —— 判定等于
 * 惩罚"声明不全"的节点）。
 */
function detectNewDependency(graph: TaskGraph, files?: string[]): EventDecision | null {
  if (!files || files.length === 0) return null
  const focus =
    Object.values(graph.nodes).find((n) => n.status === 'in_progress') ??
    Object.values(graph.nodes).find((n) => n.status === 'verifying')
  if (!focus) return null
  const declared = focus.contextRefs.filter((r) => r.kind === 'file').map((r) => r.ref)
  if (declared.length === 0) return null

  const declaredTops = new Set(declared.map(topSegment))
  const outsiders = files.filter((f) => !declaredTops.has(topSegment(f)))
  if (outsiders.length === 0) return null

  return {
    event: 'E3',
    action: 'none', // 只提示，不自动改图（见函数注释）
    nodeId: focus.id,
    reason:
      `本轮写入了当前任务未声明的模块：${outsiders.slice(0, 3).join(', ')}` +
      `${outsiders.length > 3 ? ` 等 ${outsiders.length} 处` : ''}。` +
      `若这些改动是完成 ${focus.key ?? focus.id} 的前置条件，请用 replan 追加节点并建立依赖；否则请确认是否已偏离任务范围。`,
  }
}

/** 取路径的前两段作为"模块"标识（src/main/foo → src/main） */
function topSegment(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(0, 2).join('/')
}

/** 收集 Spec 层 + 节点层的全部 AC */
function collectAcceptance(graph: TaskGraph): { id: string; status: string }[] {
  const out: { id: string; status: string }[] = graph.spec.acceptance.map((a) => ({
    id: a.id,
    status: a.status,
  }))
  for (const node of Object.values(graph.nodes)) {
    for (const ac of node.acceptance) out.push({ id: `${node.key ?? node.id}:${ac.id}`, status: ac.status })
  }
  return out
}

function sumDeclaredBudget(graph: TaskGraph): number | undefined {
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

function fmtK(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
}

/* ============================================================
 * 收敛触发计数器（跨轮次的内存状态）
 * ============================================================ */

/**
 * 记录"上次收敛时的 completed 计数"。
 *
 * 为什么放内存而不放图：这是**调度元数据**，不是任务规格的一部分 ——
 * 写进 graph.json 会让它每次收敛都产生一次 diff，污染审计流。
 * 代价是重启后 E9 的计时会重置（可接受：重启本身就是一次人工干预）。
 */
const lastConvergeCompleted = new Map<string, number>()

/** 记录一次收敛完成 */
export function markConverged(graphId: string, completedCount: number): void {
  lastConvergeCompleted.set(graphId, completedCount)
}

/** 读取上次收敛时的计数（缺省 0） */
export function getLastConvergeCompleted(graphId: string): number {
  return lastConvergeCompleted.get(graphId) ?? 0
}

/** 清理（任务结束时调用，防内存泄漏） */
export function clearConvergeCounter(graphId: string): void {
  lastConvergeCompleted.delete(graphId)
}

/** 判定某个状态是否属于"在途"（引擎需要它继续推进） */
export function isInFlight(status: NodeStatus): boolean {
  return status === 'in_progress' || status === 'verifying' || status === 'needs_human'
}
