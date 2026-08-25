/* ============================================================
 * ArkWork — 唯一真源会话事件日志（v0.19.0 M2）
 * 借鉴 dsh context-management 的「仅追加事件日志是唯一真源」：
 * 把 ReActEvent 流落盘为 session.jsonl，供审计 / 回放 / 投影。
 *
 * 当前为「双轨」第一步：日志为真源，L1 仍作为索引缓存；
 * deriveMessages 与 assembleMessages 一致后再切换 UI 投影。
 * ============================================================ */
import { join } from 'node:path'
import { JsonlCollection, getTaskMemoryDir } from '../store/db.js'
import { genId } from '@shared/utils/id'
import type { SessionEvent } from '@shared/types/conversation'
import type { ReActEvent } from '@shared/types/react'
import type { LlmMessage } from '../llm/adapter.js'

const sessionCollections = new Map<string, JsonlCollection<SessionEvent>>()
const seqByTask = new Map<string, number>()

function sessions(taskId: string): JsonlCollection<SessionEvent> {
  let col = sessionCollections.get(taskId)
  if (!col) {
    col = new JsonlCollection<SessionEvent>(join(getTaskMemoryDir(taskId), 'session.jsonl'))
    sessionCollections.set(taskId, col)
  }
  return col
}

/**
 * 读取 task 的全部会话事件（按 seq 升序）。
 * 副作用：无（读文件）。
 */
export async function listSessionEvents(taskId: string): Promise<SessionEvent[]> {
  const items = await sessions(taskId).list()
  return items.sort((a, b) => a.seq - b.seq)
}

/**
 * 追加一条会话事件（seq 自动递增，仅追加不可改写）。
 * 副作用：写 session.jsonl（追加一行）。
 */
export async function appendSessionEvent(taskId: string, event: ReActEvent): Promise<void> {
  let seq = seqByTask.get(taskId) ?? 0
  if (seq === 0) {
    const items = await sessions(taskId).list()
    seq = items.length === 0 ? 0 : items[items.length - 1]!.seq
  }
  seq += 1
  seqByTask.set(taskId, seq)
  await sessions(taskId).append({ ...event, id: genId('evt'), seq, ts: Date.now() })
}

/**
 * 从会话事件日志派生模型消息列表（纯函数投影）。
 * 职责：把 reason_end（assistant 消息 + toolCalls）与 act_end（tool 结果）投影为 LlmMessage[]。
 * 副作用：无。
 */
export function deriveMessages(events: SessionEvent[]): LlmMessage[] {
  const out: LlmMessage[] = []
  let pendingTool: string | null = null
  let pendingToolCallId: string | null = null
  for (const e of events) {
    if (e.type === 'reason_end') {
      const r = e as Extract<ReActEvent, { type: 'reason_end' }>
      if (r.action) {
        pendingTool = r.action.tool
        pendingToolCallId = `call-${r.iteration}`
        out.push({
          role: 'assistant',
          content: r.thought || '',
          toolCalls: [
            {
              id: pendingToolCallId,
              type: 'function',
              function: { name: r.action.tool, arguments: JSON.stringify(r.action.args) },
            },
          ],
        })
      } else {
        out.push({ role: 'assistant', content: r.thought || '' })
      }
    } else if (e.type === 'act_start') {
      pendingTool = (e as Extract<ReActEvent, { type: 'act_start' }>).tool
    } else if (e.type === 'act_end') {
      const a = e as Extract<ReActEvent, { type: 'act_end' }>
      out.push({
        role: 'tool',
        content: a.resultSummary ?? JSON.stringify(a.result ?? ''),
        name: pendingTool ?? undefined,
        toolCallId: pendingToolCallId ?? undefined,
      })
      pendingTool = null
      pendingToolCallId = null
    }
  }
  return out
}
