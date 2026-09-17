/* ============================================================
 * ArkWork — deriveConversation 纯模块（v0.31.0 B3 自 meta.ts 拆出）
 * 拆分原因：等价性测试（flow/__tests__/equivalence.test.ts）需在 node:test
 * 中导入旧路径 deriveConversation 做对照（§6.6 R1 缓解），而 meta.ts 依赖
 * i18n（import.meta.env 在 node 下不存在）。沿用 B0/B1「纯模块拆分让测试
 * 可密闭断言」的既有纪律：本模块零 store / 零 i18n / 零 DOM 依赖。
 * meta.ts 保留同名转出口，既有消费者零改动。
 * ============================================================ */
import type { Task } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import type { MemoryItem } from '@shared/types/memory'
import type { ConversationItem } from '@shared/types/conversation'

export function deriveConversation(
  task: Task | null,
  steps: ReActStep[],
  memory: MemoryItem[] = [],
): ConversationItem[] {
  if (!task) return []

  // v0.4.0-rev6：按时间戳合并 user_message 和 react 步骤组，避免多轮对话顺序错乱。
  // rev5 把所有 user_message 堆在开头、react 堆在后面，导致 [u1,u2,r1,r2] 而非 [u1,r1,u2,r2]。

  // 1. 从 memory 读取 user_message（过滤空 content 和 archived），按 createdAt 排序
  const userMessages = memory
    .filter((m) => m.kind === 'user_message' && m.content !== '' && !m.archivedAt)
    .sort((a, b) => a.createdAt - b.createdAt)

  // 旧任务兼容：memory 为空时回退到 task.input.text 作为单条用户消息
  const userEvents: ConversationItem[] = []
  if (userMessages.length > 0) {
    for (const m of userMessages) {
      userEvents.push({
        id: `${task.id}-user-${m.id}`,
        type: 'user',
        text: m.content,
        ts: m.createdAt,
        tsLabel: formatTimeLabel(m.createdAt),
      })
    }
  } else if (task.input.text !== '') {
    userEvents.push({
      id: `${task.id}-user`,
      type: 'user',
      text: task.input.text,
      ts: task.createdAt,
      tsLabel: formatTimeLabel(task.createdAt),
    })
  }

  // 2. v0.8.0：计划清单条目（TraeWork 式）——plan 步骤单独成卡。
  // v0.27.0 F10：渲染层不再派生逐项状态，
  // 单一真源为 task.planItems（Main patch/snapshot 推送）；
  // 卡片状态链：task.planItems > item.planStates > []，见 ConversationFlow.PlanMessage。
  // v0.30.2 修复②：续聊清空重建会广播**新的** plan step —— 每个带 plan 的 plan step
  // 各成一张计划卡（按 startedAt 排序入时间线），旧计划卡保留为历史，新计划卡显示新目标。
  const planSteps = steps.filter((s) => s.type === 'plan' && s.plan)
  const planEvents: ConversationItem[] = planSteps.map((s) => ({
    id: `${task.id}-plan-${s.id}`,
    type: 'plan',
    plan: s.plan!,
    ts: s.startedAt,
    tsLabel: formatTimeLabel(s.startedAt),
  }))

  // 3. 按 iteration 分组 reason/act/observation，每组作为带 ts 的事件
  // v0.8.0：plan 步骤单独作为清单条目（见上），不进入 react 分组，避免空步骤流
  const byIter = new Map<number, ReActStep[]>()
  for (const s of steps) {
    if (s.type === 'plan') continue
    const arr = byIter.get(s.iteration) ?? []
    arr.push(s)
    byIter.set(s.iteration, arr)
  }
  const iters = Array.from(byIter.keys()).sort((a, b) => a - b)

  type ReactEvent = { ts: number; items: ConversationItem[] }
  const reactEvents: ReactEvent[] = []
  for (const iter of iters) {
    const group = byIter.get(iter)!.sort((a, b) => a.startedAt - b.startedAt)
    const reasonStep = group.find((s) => s.type === 'reason')
    const isComplete = reasonStep?.action?.tool === 'task_complete'
    // v0.23.1：ask_user 的问题也是面向用户的最终输出 — 生成 assistant 消息
    // 永久保留在交互区（此前问题只存在于暂停态卡片，作答后即消失）。
    const isAskUser = reasonStep?.action?.tool === 'ask_user'
    // 最终回复：task_complete / ask_user / 无 action（模型直接回复未调用工具）
    const isFinalAnswer = isComplete || isAskUser || !reasonStep?.action
    const ts = reasonStep?.startedAt ?? group[0]?.startedAt ?? 0

    const items: ConversationItem[] = [{
      id: `${task.id}-react-${iter}`,
      type: 'react',
      steps: group,
      ts,
      tsLabel: formatTimeLabel(ts),
    }]

    if (isFinalAnswer && reasonStep) {
      items.push({
        id: `${task.id}-final-${iter}`,
        type: 'assistant',
        text: isComplete
          ? (reasonStep.action?.args?.summary as string) ?? reasonStep.thought ?? ''
          : isAskUser
            ? (reasonStep.action?.args?.question as string) ?? reasonStep.thought ?? ''
            : reasonStep.thought ?? '',
        ts: reasonStep.startedAt,
        tsLabel: formatTimeLabel(reasonStep.startedAt),
      })
    }
    reactEvents.push({ ts, items })
  }

  // 4. 空任务（无用户消息 + 无 react + 无计划卡）返回空，由 ConversationGreeting 接管
  if (userEvents.length === 0 && reactEvents.length === 0 && planEvents.length === 0) {
    return []
  }

  // 5. 按时间戳合并所有事件（计划清单插在用户消息之后、首个 react 之前）
  const allEvents: { ts: number; item: ConversationItem | ConversationItem[] }[] = [
    ...userEvents.map((e) => ({ ts: e.ts ?? 0, item: e as ConversationItem })),
    ...planEvents.map((e) => ({ ts: e.ts ?? 0, item: e })),
    ...reactEvents.map((e) => ({ ts: e.ts, item: e.items })),
  ]
  allEvents.sort((a, b) => a.ts - b.ts)

  const result: ConversationItem[] = []
  for (const ev of allEvents) {
    if (Array.isArray(ev.item)) {
      result.push(...ev.item)
    } else {
      result.push(ev.item)
    }
  }
  return result
}

function formatTimeLabel(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
