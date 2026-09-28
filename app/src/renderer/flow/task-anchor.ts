/**
 * ArkWork — TaskAnchor 锚点数据选择（v0.36.4 D121 · 纯函数）
 *
 * 设计（16-v0364-windows-compat-design.md §二 D121）：交互区的执行锚点
 * 全部来自 **LLM 规划产物的结构化字段**（graph.goal / 节点 title / intent），
 * UI 只渲染不造词 —— 对照 Claude Code（subject/activeForm）与 ZCode（Goal）。
 *
 * 焦点判定与主进程 `graph/sync.ts pickFocusId` 同口径：
 * needs_human → verifying → in_progress（S1 投影喂给模型的"当前任务"与
 * UI 锚点必须同源，否则会出现「UI 说的正在做」与「模型以为在做的」不一致）。
 */
import type { TaskGraph, TaskNode } from '@shared/types/graph'
import type { PlanItem } from '@shared/types/task'

/**
 * 挑选当前焦点节点（与 sync.ts pickFocusId 同口径）。
 * 无图 / 图中无在途节点 → null。
 */
export function pickFocusNode(graph: TaskGraph | null | undefined): TaskNode | null {
  if (!graph) return null
  const nodes = Object.values(graph.nodes)
  return (
    nodes.find((n) => n.status === 'needs_human') ??
    nodes.find((n) => n.status === 'verifying') ??
    nodes.find((n) => n.status === 'in_progress') ??
    null
  )
}

/** 无图任务的回落：planItems 中第一个 running 项的文本（同为模型规划产物） */
export function planRunningText(planItems: PlanItem[] | undefined): string | null {
  const running = planItems?.find((it) => it.status === 'running')
  return running?.text?.trim() || null
}

/** 焦点节点的展示文本：`T-01 标题 — 意图`（意图截断，锚点行保持一行语义） */
export function focusNodeLabel(node: TaskNode | null): string | null {
  if (!node) return null
  const key = node.key ? `${node.key} ` : ''
  const title = `${key}${node.title}`.trim()
  const intent = node.intent?.trim()
  if (!title && !intent) return null
  if (!intent) return title || null
  const shortIntent = intent.length > 60 ? intent.slice(0, 60) + '…' : intent
  return title ? `${title} — ${shortIntent}` : shortIntent
}

/** 首条用户消息展示文本（折叠口径：超 200 字截断） */
export function userIntentText(inputText: string | undefined): string | null {
  const firstLine = inputText?.split('\n').find((l) => l.trim()) ?? ''
  const t = firstLine.trim()
  if (!t) return null
  return t.length > 200 ? t.slice(0, 200) + '…' : t
}
