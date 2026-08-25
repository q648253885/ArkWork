/* ============================================================
 * ArkWork — Shared Types: Conversation / Folder / Automation / KB
 * 渲染层用于组装对话流和模块视图的辅助类型
 * ============================================================ */
import type { PlanContent, ReActStep, ReActEvent } from './react'

export type ConversationItemType = 'user' | 'assistant' | 'react' | 'plan'

/**
 * v0.19.0 M2：会话事件（唯一真源日志条目）。
 * = ReActEvent 的完整负载 + 落盘元数据（id / seq / ts）。
 * 落盘于 task 内存目录的 session.jsonl，仅追加不可改写；
 * 模型历史 / UI 时间线最终可从此日志投影派生（当前先双轨，L1 仍为索引缓存）。
 */
export type SessionEvent = ReActEvent & {
  /** 落盘 id（genId 生成） */
  id: string
  /** 单调递增序号（append 时自动填充） */
  seq: number
  /** 时间戳（毫秒） */
  ts: number
}

/** v0.8.0：计划清单条目状态；v0.14.x Task 1 扩展 'failed'（中途失败的项） */
export type PlanItemState = 'pending' | 'running' | 'done' | 'failed'

/**
 * Task 4：建议优先的任务交互 — 建议卡片数据模型。
 * 用于 ask_user 暂停态（Agent 给出可选回答建议）和 task_complete 完成态（下一步建议）。
 */
export interface Suggestion {
  id: string
  label: string
  description?: string
  /** 是否为推荐项（渲染高亮 + "推荐"标签） */
  recommended?: boolean
}

export interface ConversationItem {
  id: string
  type: ConversationItemType
  /** user / assistant 文本 */
  text?: string
  /** react 类型内嵌的 ReAct 序列 */
  steps?: ReActStep[]
  /** plan 类型：计划内容 + 逐项状态（由步骤流派生） */
  plan?: PlanContent
  planStates?: PlanItemState[]
  /** 时间戳（毫秒，用于头部展示，可格式化） */
  ts?: number
  /** 显示用字符串（如 '12:04'） */
  tsLabel?: string
}

export interface Automation {
  id: string
  name: string
  agentId: string
  prompt: string
  trigger: 'manual' | 'cron'
  cronExpr?: string
  status: 'active' | 'paused'
  createdAt: string
  lastRun?: string
  /** v0.9.1：下次触发时间（ISO，仅 cron 且 active 时由 list 接口计算填充，不落盘） */
  nextRun?: string
  /** 自动化专用模型，缺省回退 Agent 默认/全局默认 */
  modelId?: string
}

export interface KnowledgeBase {
  id: string
  name: string
  path: string
  /** 文件类型（pdf/docx/txt/md/folder） */
  type: string
  size: number
  addedAt: string
  /** v0.8.0：切块数量（导入完成后写入） */
  chunks?: number
  /** v0.8.0：面板级总开关（默认 true） */
  enabled?: boolean
  /** v0.8.0：解析失败原因（成功时为空） */
  parseError?: string
}

/** v0.8.0：知识库切块——存于 chunks.jsonl，用于全文检索 */
export interface KbChunk {
  id: string
  kbId: string
  /** 切块序号（从 0 开始） */
  seq: number
  text: string
  startChar: number
  endChar: number
}
