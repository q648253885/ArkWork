/* ============================================================
 * ArkWork — PlanItem 六态 UI 映射（v0.14.0 Task 8）
 * 纯函数/常量层：Sidebar 任务行 / Inspector 清单 Tab / 对话流 PlanMessage 三视图共用。
 * 颜色全部引用 globals.css 既有 token（var(--xxx)），不引入魔法色值。
 * 独立成文件且无 React/DOM 依赖，便于 node:test 直接单测。
 * ============================================================ */
import type { PlanItemStatus } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'

/**
 * v0.37.0：七态元信息（新增 `paused` = 中断保留）。
 * `paused` 与 `cancelled` 的区别对用户必须可见：前者"可以接着做"，后者"已作废"。
 */
export interface PlanStatusMeta {
  /** 面向用户的中文状态文案 */
  label: string
  /** 状态点 / 圆环 / 徽标主色（CSS 变量，globals.css token） */
  color: string
  /** 文本删除线（done / cancelled） */
  strikethrough: boolean
  /** 运行中动画（蓝脉冲；配合全局 prefers-reduced-motion 停用） */
  animated: boolean
  /** 是否为终态（不再自动流转） */
  terminal: boolean
}

/** 七态 → 元信息映射表（SubTask 8.5 测试断言对象） */
export const PLAN_STATUS_META: Record<PlanItemStatus, PlanStatusMeta> = {
  pending:   { label: 'plantatus.waiting',   color: 'var(--text-tertiary)', strikethrough: false, animated: false, terminal: false },
  running:   { label: 'plantatus.running',   color: 'var(--accent)',        strikethrough: false, animated: true,  terminal: false },
  paused:    { label: 'plantatus.paused',    color: 'var(--warning)',       strikethrough: false, animated: false, terminal: false },
  done:      { label: 'plantatus.done',      color: 'var(--success)',       strikethrough: true,  animated: false, terminal: true },
  failed:    { label: 'plantatus.failed',    color: 'var(--danger)',        strikethrough: false, animated: false, terminal: true },
  cancelled: { label: 'plantatus.cancelled', color: 'var(--text-tertiary)', strikethrough: true,  animated: false, terminal: true },
  skipped:   { label: 'plantatus.skipped',   color: 'var(--warning)',       strikethrough: false, animated: false, terminal: true },
}

/** 六态 → 文本颜色 Tailwind class（全部来自 tailwind.config 颜色 token，无魔法色值） */
export function planStatusTextClass(status: PlanItemStatus): string {
  switch (status) {
    case 'running':
      return 'text-accent'
    case 'paused':
      return 'text-warning'
    case 'done':
      return 'text-text-tertiary line-through decoration-success'
    case 'failed':
      return 'text-danger'
    case 'skipped':
      return 'text-warning'
    case 'cancelled':
      return 'text-text-tertiary line-through'
    case 'pending':
      return 'text-text-secondary'
  }
}

/**
 * 任务行清单聚合（SubTask 8.4）：
 *  - 全部 done → 'done'（任务行视为完成）
 *  - 否则按 failed > running > cancelled > skipped > pending 取最高优先级
 *  - planItems 缺失 / 为空 → undefined（调用方回退任务级状态，保持旧行为）
 */
export function aggregatePlanStatus(
  statuses: readonly PlanItemStatus[] | undefined | null,
): PlanItemStatus | undefined {
  if (!statuses || statuses.length === 0) return undefined
  if (statuses.every((s) => s === 'done')) return 'done'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('running')) return 'running'
  // v0.37.0：paused 优先于 cancelled/skipped —— 「中断待续」比「已作废」更值得用户看见
  if (statuses.includes('paused')) return 'paused'
  if (statuses.includes('cancelled')) return 'cancelled'
  if (statuses.includes('skipped')) return 'skipped'
  return 'pending'
}

/**
 * 取第 index 个清单项对应的工具调用记录（按「工具切换分段」规则分组），
 * 供 Inspector 清单行展开详情展示（工具调用 / 结果摘要 / 异常标记）。
 */
export function planItemToolSteps(steps: ReActStep[], index: number): ReActStep[] {
  const acts = steps
    .filter((s) => s.type === 'act')
    .sort((a, b) => a.startedAt - b.startedAt)
  const segments: ReActStep[][] = []
  let prev = ''
  for (const a of acts) {
    const t = a.toolName ?? ''
    if (t !== prev) {
      segments.push([])
      prev = t
    }
    segments[segments.length - 1].push(a)
  }
  return segments[index] ?? []
}

/**
 * v0.27.0 R0：自 store 迁入的纯函数 — 派生计划项。
 * 仅取真实 plan.items；无真实计划时返回空数组（不展示兜底 5 步）。
 * 独立于 store 实例，node:test 可直接单测；store 层保留 re-export 兼容旧导入方。
 */
export function derivePlanItems(steps: ReActStep[]): string[] {
  const planStep = steps.find((s) => s.type === 'plan' && s.plan)
  if (planStep?.plan && planStep.plan.items.length > 0) return planStep.plan.items
  return []
}

/* ============================================================
 * v0.41.0（D209 / TC-TDP-001…003）：清单层级与筛选纯函数
 * 语义镜像 main 侧 ledger/project.ts 的 buildDepthMap（渲染层不得 import
 * main 模块）；孤儿父引用 / 自引用环 / 越级一律兜底为顶级，深度 clamp ≤1
 *（账本层级 ≤2 的镜像，数据坏时 UI 不破版）。
 * ============================================================ */

export interface PlanItemHierarchy {
  id: string
  parentId?: string | null
}

/** 每项深度（0 = 顶级；与 items 下标对齐返回） */
export function planItemDepths(items: readonly PlanItemHierarchy[]): number[] {
  const byId = new Map(items.map((it, i) => [it.id, i]))
  const depth: number[] = new Array(items.length).fill(0)
  for (let i = 0; i < items.length; i++) {
    const pid = items[i]!.parentId
    if (!pid) continue
    const p = byId.get(pid)
    // 父不存在 / 自引用环 → 顶级兜底
    if (p === undefined || p === i) continue
    depth[i] = Math.min(depth[p]! + 1, 1)
  }
  return depth
}

/** 复合编号（'1' / '1.1' / '1.2' / '2' …；与 items 下标对齐返回）。
 *  两遍法：先给全部顶级项编号，再回填子项 —— 父项在子项之后声明也能对上。 */
export function planItemNumbering(items: readonly PlanItemHierarchy[]): string[] {
  const byId = new Map(items.map((it, i) => [it.id, i]))
  const depth = planItemDepths(items)
  const labels: string[] = new Array(items.length).fill('')
  let topSeq = 0
  for (let i = 0; i < items.length; i++) {
    const pid = items[i]!.parentId
    const p = pid ? byId.get(pid) : undefined
    if (depth[i]! === 0 || p === undefined || p === i) {
      topSeq += 1
      labels[i] = String(topSeq)
    }
  }
  // 兄弟序号按出现顺序计（父项出现序 → 已遇到的子项个数）
  const childCount = new Map<number, number>()
  for (let i = 0; i < items.length; i++) {
    if (labels[i] !== '') continue
    const pid = items[i]!.parentId
    const p = byId.get(pid!)
    if (p === undefined || p === i) {
      // 兜底：父缺失但 depth 推断为子（不会发生，防御式收口）
      topSeq += 1
      labels[i] = String(topSeq)
      continue
    }
    const n = (childCount.get(p) ?? 0) + 1
    childCount.set(p, n)
    labels[i] = `${labels[p] ?? topSeq}.${n}`
  }
  return labels
}

/** TodoPanel 筛选口径：'all' = 仅未终态（完成项归档出主视线）；'ended' = 全部终态 */
export type PlanFilter = 'all' | 'ended' | PlanItemStatus

const TERMINAL_STATUSES: ReadonlySet<PlanItemStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])

export function isTerminalPlanStatus(s: PlanItemStatus): boolean {
  return TERMINAL_STATUSES.has(s)
}

/**
 * 筛选 → 可见下标（与 states 对齐）。
 * 计数与列表口径一致性由调用方保证：「全部」chip 计数必须取本函数 'all' 的长度。
 */
export function filterPlanItemIndices(
  states: readonly PlanItemStatus[],
  filter: PlanFilter,
): number[] {
  const out: number[] = []
  for (let i = 0; i < states.length; i++) {
    const s = states[i] ?? 'pending'
    if (filter === 'all') {
      if (!isTerminalPlanStatus(s)) out.push(i)
    } else if (filter === 'ended') {
      if (isTerminalPlanStatus(s)) out.push(i)
    } else if (s === filter) {
      out.push(i)
    }
  }
  return out
}
