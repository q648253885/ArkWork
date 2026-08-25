/* ============================================================
 * ArkWork — PlanItem 六态 UI 映射（v0.14.0 Task 8）
 * 纯函数/常量层：Sidebar 任务行 / Inspector 清单 Tab / 对话流 PlanMessage 三视图共用。
 * 颜色全部引用 globals.css 既有 token（var(--xxx)），不引入魔法色值。
 * 独立成文件且无 React/DOM 依赖，便于 node:test 直接单测。
 * ============================================================ */
import type { PlanItemStatus } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'

/** 六态元信息 */
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

/** 六态 → 元信息映射表（SubTask 8.5 测试断言对象） */
export const PLAN_STATUS_META: Record<PlanItemStatus, PlanStatusMeta> = {
  pending:   { label: 'plantatus.waiting',   color: 'var(--text-tertiary)', strikethrough: false, animated: false, terminal: false },
  running:   { label: 'plantatus.running',   color: 'var(--accent)',        strikethrough: false, animated: true,  terminal: false },
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
