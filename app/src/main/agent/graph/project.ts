/**
 * ArkWork — Sync · S1 Project（活跃窗口投影）
 *
 * 依据：docs/versions/v0.30.0/04-system-design.md §6.1
 *       agent-design-v1.0/04-ReAct内核与任务协同.md §2.2-S1 / §6
 *
 * 解决的问题（设计稿 §02）：**F1 上下文腐烂 + F5 计划衰变**。
 * 任务清单如果在开头注入一次，跑到第 20 轮时早已沉入"遗忘区"
 * （lost-in-the-middle）。所以必须**每轮**把当前任务、它的验收条件、
 * 已完成计数重新复述一遍。
 *
 * 三条硬约束（改动前先读）：
 *  1. **只投影 5–7 个节点**。全量投影本身就是 F1 的来源 —— 这正是 v0.29
 *     `plan_status` 随历史累积膨胀的问题。
 *  2. **恒在项不裁剪**：GOAL 与 SCOPE-OUT 永远出现。它们是抗漂移的锚点。
 *  3. **预算 ≤ 800 tok**（活跃窗口本身）；超预算按 `DONE 计数 → NEXT → 验收细节`
 *     顺序裁剪。裁剪记录进返回值（`trimmed`），便于埋点观测 H1。
 *
 * 为什么投影里必须带**验收条件**（设计稿 §6.3）：让模型每轮都能看到
 * "什么叫做完"，直接对冲 **F2 上下文焦虑导致的过早完成**。
 */
import {
  assigneeLabel,
  type NodeStatus,
  type TaskGraph,
  type TaskNode,
} from '@shared/types/graph'
import { estimateTextTokens } from '../context.js'
import { logger } from '../../system/logger.js'

/** 活跃窗口的 token 预算（硬约束，设计稿 §2.2-S1） */
export const ACTIVE_WINDOW_BUDGET = 800
/** 锚点（GOAL + SCOPE-OUT）的 token 预算 */
export const ANCHOR_BUDGET = 200
/** 工具结果后那一行的 token 预算 */
export const AFTER_TOOL_BUDGET = 60
/** 三段合计预算（设计稿 §6.2 的 ≤1200 tok 扣掉余量后的自用值） */
export const TOTAL_INJECTION_BUDGET = 1200

/** NEXT 最多前瞻几项 */
const NEXT_LIMIT = 3
/** 验收摘要最多几条 */
const ACCEPTANCE_LIMIT = 2

/** 投影结果 */
export interface Projection {
  text: string
  tokens: number
  /** 因超预算被裁掉的维度（按裁剪顺序） */
  trimmed: ('done' | 'next' | 'acceptance')[]
}

/** 状态图标（与交互文档 §0.5 的 11 态视觉映射一致） */
const STATUS_GLYPH: Record<NodeStatus, string> = {
  draft: '○',
  proposed: '◐',
  approved: '○',
  ready: '○',
  in_progress: '●',
  verifying: '◑',
  blocked: '⊘',
  needs_human: '⊗',
  completed: '✓',
  cancelled: '—',
  failed: '✗',
}

/** 节点在投影里的一行短标识：`T-03 未读角标` */
function nodeLabel(node: TaskNode): string {
  return node.key ? `${node.key} ${node.title}` : node.title
}

/**
 * 渲染恒在锚点：`[GOAL]` + `[SCOPE-OUT]`。
 *
 * 这两行**永远出现**（只要预算够放下），是抗 F4 目标漂移与防范围蔓延的核心。
 * `goal` 用 `graph.goal`（≤200 字），`scopeOut` 最多取 3 条。
 */
export function renderAnchors(graph: TaskGraph): Projection {
  const lines: string[] = []
  lines.push(`[GOAL] ${graph.goal || graph.title}`)
  const out = graph.spec.scopeOut.slice(0, 3)
  if (out.length > 0) {
    const more = graph.spec.scopeOut.length > out.length ? ` 等 ${graph.spec.scopeOut.length} 项` : ''
    lines.push(`[SCOPE-OUT] ${out.join('；')}${more}`)
  }
  const text = lines.join('\n')
  return { text, tokens: estimateTextTokens(text), trimmed: [] }
}

/**
 * 渲染活跃窗口：`[NOW]` + 验收摘要 + `[NEXT]` + `[DONE]` + `[BUDGET]`。
 *
 * @param graph  当前图
 * @param opts.budget  覆盖默认预算（单测用）
 * @param opts.now     时间戳注入（单测用）
 *
 * 裁剪顺序（先裁列表尾部，最后才裁内容）：
 *  1. 去掉 `[DONE]` 行的状态明细（保留 `n/m completed`）—— 信息量最低
 *  2. 减少 `[NEXT]` 条数（3 → 2 → 1 → 0）
 *  3. 减少 `[NOW]` 的验收摘要（2 条 → 1 条 → 0 条）
 *  4. 都裁完仍超预算 → 截断 `[NOW]` 的标题（**不允许**不输出 NOW 行）
 */
export function renderActiveWindow(
  graph: TaskGraph,
  opts?: { budget?: number; now?: number },
): Projection {
  const budget = opts?.budget ?? ACTIVE_WINDOW_BUDGET
  const now = opts?.now ?? Date.now()
  const trimmed: ('done' | 'next' | 'acceptance')[] = []

  const nodes = Object.values(graph.nodes)
  const running = nodes.find((n) => n.status === 'in_progress')
  const verifying = nodes.find((n) => n.status === 'verifying')
  const needsHuman = nodes.filter((n) => n.status === 'needs_human')
  const doneCount = nodes.filter((n) => n.status === 'completed').length
  const totalCount = nodes.filter((n) => n.layer !== 'goal').length
  const tokensUsed = nodes.reduce((s, n) => s + (n.tokensUsed || 0), 0)
  const tokenBudget = graph.policy.tier >= 2 ? sumDeclaredBudget(graph) : undefined

  /** 当前聚焦节点：优先 needs_human（人必须先回答它）→ verifying → in_progress */
  const focus: TaskNode | undefined = needsHuman[0] ?? verifying ?? running

  // NEXT：ready 且依赖已满足的都算候选（按图顺序），最多 NEXT_LIMIT 项
  const readyNodes = orderByTree(graph).filter((n) => n.status === 'ready')

  const build = (nextLimit: number, accLimit: number): string => {
    const lines: string[] = []

    if (focus) {
      lines.push(`[NOW] ${STATUS_GLYPH[focus.status]} ${nodeLabel(focus)} (${focus.status})`)
      // 验收条件摘要 —— 直接对冲 F2 过早完成
      const accs = focus.acceptance
        .filter((a) => a.status !== 'waived')
        .slice(0, accLimit)
        .map((a) => `${a.id} ${a.statement}${a.verify?.command ? ` → \`${a.verify.command}\`` : ''}`)
      for (const a of accs) lines.push(`      └─ 验收: ${a}`)
      if (focus.status === 'verifying' && focus.verification.command) {
        lines.push(`      └─ 正在验证: \`${focus.verification.command}\``)
      }
      if (focus.status === 'needs_human' && focus.blockingQuestion) {
        lines.push(`      └─ 等你回答: ${focus.blockingQuestion}`)
      }
      if (focus.attempts > 0) {
        lines.push(`      └─ 已尝试 ${focus.attempts}/${focus.verification.maxAttempts}`)
      }
    } else {
      lines.push('[NOW] 无进行中节点')
    }

    if (nextLimit > 0 && readyNodes.length > 0) {
      const picked = readyNodes.slice(0, nextLimit)
      lines.push(`[NEXT] ${picked.map((n) => nodeLabel(n)).join(' · ')}`)
      const blocked = nodes.filter((n) => n.status === 'blocked').slice(0, 2)
      for (const b of blocked) {
        const by = b.dependsOn
          .map((d) => graph.nodes[d])
          .filter((d): d is TaskNode => !!d && d.status !== 'completed')
          .map((d) => d.key ?? d.id)
        lines.push(`       ⊘ ${nodeLabel(b)}${by.length ? ` (blocked by ${by.join(', ')})` : ''}`)
      }
    }

    lines.push(
      `[DONE] ${doneCount}/${totalCount} completed` +
        (needsHuman.length > 0 ? ` · ${needsHuman.length} needs_human` : ''),
    )

    if (tokenBudget) {
      lines.push(
        `[BUDGET] ${fmtTokens(tokensUsed)} / ${fmtTokens(tokenBudget)} tokens` +
          ` · 已运行 ${fmtDuration(now - (graph.createdAt || now))}`,
      )
    }

    return lines.join('\n')
  }

  // 逐级裁剪，直到进预算
  let nextLimit = NEXT_LIMIT
  let accLimit = ACCEPTANCE_LIMIT
  let text = build(nextLimit, accLimit)
  let tokens = estimateTextTokens(text)

  if (tokens > budget) {
    trimmed.push('done')
    accLimit = ACCEPTANCE_LIMIT
    nextLimit = NEXT_LIMIT
    text = build(nextLimit, accLimit)
    tokens = estimateTextTokens(text)
  }
  while (tokens > budget && nextLimit > 0) {
    if (!trimmed.includes('next')) trimmed.push('next')
    nextLimit -= 1
    text = build(nextLimit, accLimit)
    tokens = estimateTextTokens(text)
  }
  while (tokens > budget && accLimit > 0) {
    if (!trimmed.includes('acceptance')) trimmed.push('acceptance')
    accLimit -= 1
    text = build(nextLimit, accLimit)
    tokens = estimateTextTokens(text)
  }
  if (tokens > budget && focus) {
    // 最后手段：截断标题，但保住 NOW 行本身
    const short = `${focus.key ?? ''} ${focus.title}`.trim().slice(0, 24)
    text = `[NOW] ${STATUS_GLYPH[focus.status]} ${short}… (${focus.status})\n[DONE] ${doneCount}/${totalCount}`
    tokens = estimateTextTokens(text)
  }

  return { text, tokens, trimmed }
}

/**
 * 渲染"工具结果之后"的一行轻量刷新（设计稿 §6.2 的第三段）。
 *
 * 为什么需要这一行：中段最容易发生 lost-in-the-middle。把"我在做 T-03、
 * 已经用了多少预算"贴在**刚刚发生的工具结果后面**，是成本最低的位置红利。
 */
export function renderAfterTool(graph: TaskGraph, opts?: { now?: number }): Projection {
  const now = opts?.now ?? Date.now()
  const nodes = Object.values(graph.nodes)
  const focus = nodes.find((n) => n.status === 'in_progress') ?? nodes.find((n) => n.status === 'verifying')
  const tokensUsed = nodes.reduce((s, n) => s + (n.tokensUsed || 0), 0)
  const budget = sumDeclaredBudget(graph)
  const doneCount = nodes.filter((n) => n.status === 'completed').length
  const totalCount = nodes.filter((n) => n.layer !== 'goal').length

  const text = focus
    ? `→ ${nodeLabel(focus)} 仍在进行，已用 ${fmtTokens(tokensUsed)}${budget ? `/${fmtTokens(budget)}` : ''} tokens，进度 ${doneCount}/${totalCount}`
    : `→ 无进行中节点，进度 ${doneCount}/${totalCount}`
  void now
  return { text, tokens: estimateTextTokens(text), trimmed: [] }
}

/**
 * 渲染完整的三段式注入（S1 的对外入口）。
 *
 * 返回值里 `anchorText` 应放进 system 段尾部，`windowText` 追加为独立 L1 消息，
 * `afterToolText` 附在 observation 尾部。
 */
export interface ThreeSegInjection {
  anchorText: string
  windowText: string
  afterToolText: string
  totalTokens: number
  trimmed: ('done' | 'next' | 'acceptance')[]
  /** 是否超出三段合计预算（≥1200 tok）—— 超了要记日志，是 H1 观测点 */
  overBudget: boolean
}

export function buildThreeSegInjection(graph: TaskGraph, opts?: { now?: number }): ThreeSegInjection {
  const anchors = renderAnchors(graph)
  const win = renderActiveWindow(graph, { now: opts?.now })
  const after = renderAfterTool(graph, { now: opts?.now })
  const totalTokens = anchors.tokens + win.tokens + after.tokens
  const overBudget = totalTokens > TOTAL_INJECTION_BUDGET
  if (overBudget) {
    logger.warn(
      'Agent',
      `sync: S1 三段注入超预算 ${totalTokens}/${TOTAL_INJECTION_BUDGET} tok（anchor=${anchors.tokens} window=${win.tokens} afterTool=${after.tokens}）`,
    )
  }
  return {
    anchorText: anchors.text,
    windowText: win.text,
    afterToolText: after.text,
    totalTokens,
    trimmed: [...win.trimmed],
    overBudget,
  }
}

/* ============================================================
 * 内部工具
 * ============================================================ */

/** 汇总各节点声明的 tokenBudget（投影的 [BUDGET] 行使用） */
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

/** 按 graph 的自然顺序（rootIds + children DFS）返回节点 */
function orderByTree(graph: TaskGraph): TaskNode[] {
  const out: TaskNode[] = []
  const visit = (id: string): void => {
    const node = graph.nodes[id]
    if (!node) return
    out.push(node)
    for (const c of node.children) visit(c)
  }
  for (const rootId of graph.rootIds) visit(rootId)
  return out
}

/** 12.4k / 3.1k 形态 */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

/** 2m14s 形态 */
function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 > 0 ? `${s % 60}s` : ''}`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

/** 供 UI 复用：等待时长（needs_human 卡片显示"等待 2m14s"） */
export function formatWaiting(ms: number): string {
  return fmtDuration(ms)
}

/** 供 UI 复用：assignee 短标签 */
export { assigneeLabel }
