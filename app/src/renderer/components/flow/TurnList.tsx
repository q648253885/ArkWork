/* ============================================================
 * ArkWork — TurnList（v0.31.0 B3 层级骨架）
 * 交互区唯一入口：滚动容器 + 贴底跟随 + 未读计数（迁移 ConversationFlow
 * :115-158 语义）+ 投影（flow/project）+ 轮序列渲染。
 *
 * 保留的历史行为（缺一即回归）：
 *  - ctxChips（v0.5.0）/ SuggestionCards（完成态）/ PlanApprovalCard（P8 闸门）
 *  - react:scroll-to-tool / react:scroll-to-plan-step 跨组件滚动锚点
 *  - 顶部渐隐 + back-to-bottom 浮按钮（v0.22.0 DSH ChatView）
 *
 * 流式：B1 管道的 `${taskId}:turn:reasoning` 缓冲直接进投影层（project.ts
 * 在最后一轮追加 streaming ReasoningBlock），不再有独立的 StreamingThinkBlock。
 * ============================================================ */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import { projectConversation } from '../../flow/project'
import type { FlowTurn } from '@shared/types/flow'
import { TurnView } from './TurnView'
import { SuggestionCards } from '../SuggestionCards'
import { PlanApprovalCard } from '../graph/PlanApprovalCard'

export function TurnList() {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  // v0.13.0：用户不在底部时累计新消息数；点击归零并滚底
  const [unreadCount, setUnreadCount] = useState(0)
  const lastSeenCountRef = useRef<number>(0)

  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const items = useStore((s) => s.conversation)
  const steps = useStore((s) => s.steps)
  const ctxChips = useStore((s) => s.ctxChips)
  const suggestions = useStore((s) => s.suggestions)
  const askUserQuestion = useStore((s) => s.askUserQuestion)
  const task = useStore((s) => s.tasks.find((tl) => tl.id === s.selectedTaskId))
  const flow = useStore((s) => s.flow)

  // B1 reasoning 通道缓冲（投影层在最后一轮追加 streaming ReasoningBlock）
  const streamBuffer = useStore((s) =>
    s.selectedTaskId ? s.streamBuffers[`${s.selectedTaskId}:turn:reasoning`] : undefined,
  )

  const taskId = task?.id ?? selectedTaskId ?? ''

  /* ---------- 投影（纯函数；now 由调用方注入，§3.3-2） ---------- */
  const turns: FlowTurn[] = useMemo(() => {
    if (!taskId) return []
    return projectConversation({
      taskId,
      items,
      steps,
      events: [], // 渲染层暂无 session 事件通道（§11 登记，B5/B6 接入）
      streamBuffers: streamBuffer ? { [`${taskId}:turn:reasoning`]: streamBuffer } : {},
      planItems: task?.planItems ?? [],
      viewMode: flow.viewMode,
      showThinking: flow.showThinking,
      ui: flow,
      now: Date.now(),
    })
    // now 刻意不入依赖：运行中轮的时长随 steps/buffer 更新自然刷新
  }, [taskId, items, steps, streamBuffer, task?.planItems, flow])

  /* ---------- 内容签名：贴底跟随依赖（迁移 ConversationFlow :105-130） ---------- */
  const contentSignature = useMemo(
    () =>
      items
        .map((i) => {
          const stepsSig = (i.steps ?? [])
            .map(
              (s) =>
                `${s.id}:${s.status}:${s.resultSummary ?? ''}:${s.summary ?? ''}:${s.thought ?? ''}:${s.reasoning ?? ''}`,
            )
            .join('|')
          return `${i.id}:${i.type}:${i.text ?? ''}:${stepsSig}`
        })
        .join(','),
    [items],
  )

  // 贴底时跟随内容变化；上翻则暂停。useLayoutEffect 流式更新无闪跳。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [contentSignature, atBottom, streamBuffer?.text])

  // v0.13.0：未读计数（不在底部 + 有新增 → 累加；贴底归零）
  useEffect(() => {
    const total = items.length
    if (total < lastSeenCountRef.current) {
      lastSeenCountRef.current = total
      setUnreadCount(0)
      return
    }
    const grown = total - lastSeenCountRef.current
    if (atBottom) {
      lastSeenCountRef.current = total
      setUnreadCount(0)
    } else if (grown > 0) {
      setUnreadCount((c) => c + grown)
      lastSeenCountRef.current = total
    }
  }, [items.length, atBottom])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // 贴底阈值 40px（迁移语义）
    const nextAtBottom = distanceFromBottom < 40
    setAtBottom(nextAtBottom)
    if (nextAtBottom) {
      lastSeenCountRef.current = items.length
      setUnreadCount(0)
    }
  }

  // 跨组件滚动锚点（ToolsPanel → ToolCard；TodoPanel → plan 步骤）—— 语义保留
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ stepId: string }>).detail
      const stepId = detail?.stepId
      if (!stepId) return
      const el = document.getElementById(`tool-${stepId}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    window.addEventListener('react:scroll-to-tool', handler as EventListener)
    return () => window.removeEventListener('react:scroll-to-tool', handler as EventListener)
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ index?: number; stepId?: string }>).detail
      let el: HTMLElement | null = null
      if (detail?.stepId) {
        el = document.getElementById(detail.stepId)
      } else if (typeof detail?.index === 'number' && Number.isFinite(detail.index)) {
        el = document.getElementById(`plan-step-${detail.index + 1}`)
      }
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.remove('plan-flash')
        void el.offsetWidth
        el.classList.add('plan-flash')
      }
    }
    window.addEventListener('react:scroll-to-plan-step', handler as EventListener)
    return () => window.removeEventListener('react:scroll-to-plan-step', handler as EventListener)
  }, [])

  // 任务切换：重置未读基线
  useEffect(() => {
    lastSeenCountRef.current = items.length
    setUnreadCount(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const isRunning = task?.status === 'running'

  return (
    <div className="flex-1 overflow-y-auto min-h-0 relative" ref={scrollRef} onScroll={onScroll}>
      <div className="max-w-[760px] mx-auto px-6 py-6 space-y-4">
        {items.length === 0 && ctxChips.length === 0 && turns.length === 0 && <div className="py-10" />}

        {/* v0.5.0（B4）：上下文变更 chip 渲染 */}
        {ctxChips.length > 0 && (
          <div className="flex flex-col items-center gap-1.5">
            {ctxChips.map((chip) => (
              <span key={chip.id} className="ctx-chip">
                {chip.text}
              </span>
            ))}
          </div>
        )}

        {/* 轮序列（投影层唯一真相） */}
        {turns.map((turn, idx) => (
          <TurnView
            key={turn.id}
            turn={turn}
            isLast={idx === turns.length - 1}
            showActivity={isRunning && idx === turns.length - 1}
          />
        ))}

        {/* Task 4：建议卡片（完成态兜底；ask_user 归 Composer 的 AskUserGate） */}
        {!isRunning && !askUserQuestion && suggestions.length > 0 && (
          <SuggestionCards suggestions={suggestions} />
        )}

        {/* v0.30.0：P8 · Plan 审批卡（不批准不执行的第一层闸门） */}
        <PlanApprovalCard taskId={task?.id ?? ''} />

        {/* 底部留白（防与 Composer / RunConsole 重叠） */}
        <div className="h-12" />
      </div>

      {!atBottom && (
        <div className="pointer-events-none absolute top-0 left-0 right-0 h-4 bg-gradient-to-b from-bg-base to-transparent" />
      )}

      {!atBottom && (
        <button
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            lastSeenCountRef.current = items.length
            setUnreadCount(0)
          }}
          aria-label={t('conversationflow.newMessagesAria', { count: unreadCount })}
          className="scroll-to-bottom"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  )
}
