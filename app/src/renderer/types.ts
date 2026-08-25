/* ============================================================
 * ArkWork — Renderer Types (与 shared 对齐 + renderer 专用)
 * ============================================================ */
export type { Task, TaskStatus, TaskInput, TaskConfig } from '@shared/types/task'
export type { ReActStep, ReActEvent, ReActAction, ReActStepType, PlanContent } from '@shared/types/react'
export type { MemoryItem, MemoryLayer, MemoryRole, MemoryKind } from '@shared/types/memory'
export type { Agent, Skill, McpServer, LlmModel } from '@shared/types/agent'
export type {
  ArkApi,
  FsNode,
  FileContent,
  LogEntry,
  AppSettings,
  SecretKeys,
  TaskCreateInput,
  TaskUpdatePatch,
} from '@shared/types/ipc'
export type {
  ConversationItem,
  ConversationItemType,
  Automation,
  KnowledgeBase,
} from '@shared/types/conversation'

import type { Task } from '@shared/types/task'
import { shortTaskId as sharedShortTaskId } from '@shared/types/task'

/** 用于 UI 显示的短 ID */
export function shortTaskId(id: string): string {
  return sharedShortTaskId(id)
}

/** 任务更新时间格式化为相对时间 */
export function formatUpdatedAt(ts: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

/** 绝对时间格式化 → HH:MM */
export function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** 绝对时间格式化 → HH:MM（不含秒） */
export function formatTimeShort(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 在 Renderer 中用增强版 Task */
export type UiTask = Task & { shortId: string; updatedAtRelative: string }

export function toUiTask(task: Task): UiTask {
  return {
    ...task,
    shortId: sharedShortTaskId(task.id),
    updatedAtRelative: formatUpdatedAt(task.updatedAt),
  }
}
