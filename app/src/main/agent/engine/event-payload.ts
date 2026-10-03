/**
 * v0.46.0（PERF-2 W10）：act_end 广播载荷瘦身 —— 纯函数，独立模块可密闭单测。
 *
 * 背景：act_end 的完整工具结果（file-reader 整页 / shell stdout，可达 MB 级）此前
 * 同时经 `task:step`（broadcastStep，渲染层工具卡需要完整结果可展开）与
 * `task:event` 两条 IPC 送达，而渲染层对 task:event 的 act_end 只消费
 * `resultSummary`（store/subscriptions.ts）—— 完整 result 在这条通路上是纯死重。
 *
 * 语义：仅 act_end 且确实携带 result 时剥除；其余事件原样返回（同一引用）。
 * session.jsonl 落盘始终使用原始 event（日志真源不变，见 broadcast.ts emitEvent）。
 */
import type { ReActEvent } from '@shared/types/react'

export function stripEventResultForBroadcast(event: ReActEvent): ReActEvent {
  if (event.type !== 'act_end' || !('result' in event)) return event
  const { result: _omitted, ...rest } = event as typeof event & Record<string, unknown>
  return rest as ReActEvent
}
