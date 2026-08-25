/* ============================================================
 * ArkWork — ConversationFlow (v0.14.0)
 * 三类内容：user（右气泡）/ assistant（左主角，Markdown 全渲染）/
 *          react（步骤流，StepStream 折叠摘要）/
 *          plan（v0.14.0 Task 4：时间线卡片 PlanMessage）
 * 视觉层级：见设计文档 §5.1
 * 自动滚动：贴底时跟随；上翻超过一屏则暂停
 * ============================================================ */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore, detectRenderer, derivePlanItems } from '../store'
import type { Agent, ConversationItem } from '../types'
import type { PlanItemStatus } from '@shared/types/task'
import type { ReActStep } from '@shared/types/react'
import { Icon } from '../icons'
import { Markdown } from './Markdown'
import { ThoughtStream } from './ThoughtStream'
import { MessageActions } from './MessageActions'
import { ArtifactCard, type Artifact } from './ArtifactCard'
import { SuggestionCards } from './SuggestionCards'
import { executionDescription, reasoningDescription } from '../constants'
import { intentText } from '../utils/intent-text'
import { PLAN_STATUS_META, aggregatePlanStatus } from '../utils/plan-status'

export interface ConversationFlowHandle {
  scrollToTop: () => void
  scrollToBottom: () => void
  isAtBottom: () => boolean
  isLong: () => boolean
}

interface ConversationFlowProps {
  items: ConversationItem[]
}

export const ConversationFlow = forwardRef<ConversationFlowHandle, ConversationFlowProps>(
  function ConversationFlow({ items }, ref) {
    const { t } = useTranslation()
    const scrollRef = useRef<HTMLDivElement>(null)
    const [atBottom, setAtBottom] = useState(true)
    const [longMode, setLongMode] = useState(false)
    // v0.13.0：用户不在底部时累计新消息数；点击归零并滚底
    const [unreadCount, setUnreadCount] = useState(0)
    const lastSeenCountRef = useRef<number>(0)

    const selectedAgentId = useStore((s) => s.selectedAgentId)
    const agents = useStore((s) => s.agents)
    const task = useStore((s) => s.tasks.find((t) => t.id === s.selectedTaskId))
    const steps = useStore((s) => s.steps)
    // v0.5.0（B4）：上下文变更 chip 队列
    const ctxChips = useStore((s) => s.ctxChips)
    // Task 4：建议卡片数据（ask_user / task_complete 时由 store 写入）
    const suggestions = useStore((s) => s.suggestions)
    const askUserQuestion = useStore((s) => s.askUserQuestion)
    // v0.27.0 R1：当前任务的 Reason 流式预览文本（渲染加速通道；权威内容以 task:step 为准）
    const streamText = useStore((s) => {
      const tid = s.selectedTaskId
      return (tid ? s.streamBuffers[`${tid}:turn`]?.text : undefined) ?? ''
    })

    const agent: Agent | undefined = useMemo(
      () => agents.find((a) => a.id === selectedAgentId) ?? agents[0],
      [agents, selectedAgentId],
    )

    // v0.8.1：把连续的 react（步骤流）合并为同一视觉分组，共享一个 agent header，
    // 避免「@通用助手 · 步骤流」在每次工具调用后重复出现（对齐 TraeWork 的连续操作区）
    const groups = useMemo(() => {
      const out: { key: string; items: ConversationItem[] }[] = []
      for (const item of items) {
        const last = out[out.length - 1]
        if (item.type === 'react' && last && last.items[last.items.length - 1].type === 'react') {
          last.items.push(item)
        } else {
          out.push({ key: item.id, items: [item] })
        }
      }
      return out
    }, [items])

    // 暴露给父组件的滚动接口
    useImperativeHandle(ref, () => ({
      scrollToTop: () => {
        const el = scrollRef.current
        if (el) el.scrollTo({ top: 0, behavior: 'smooth' })
      },
      scrollToBottom: () => {
        const el = scrollRef.current
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      },
      isAtBottom: () => atBottom,
      isLong: () => longMode,
    }))

    // 内容签名：捕获「同一 item 内内容增长」— assistant 流式文本变长、
    // updateStep 改写 resultSummary、deriveConversation 重算但数组长度不变。
    // 签名变化即内容整体变化，贴底跟随 effect 依赖它而非仅 items.length。
    const contentSignature = useMemo(
      () =>
        items
          .map((i) => {
            const stepsSig = (i.steps ?? [])
              .map((s) => `${s.id}:${s.status}:${s.resultSummary ?? ''}:${s.summary ?? ''}:${s.thought ?? ''}`)
              .join('|')
            return `${i.id}:${i.type}:${i.text ?? ''}:${stepsSig}`
          })
          .join(','),
      [items],
    )

    // 贴底时跟随内容变化（新增消息 + 同一条消息内容增长）；上翻则暂停。
    // useLayoutEffect：渲染后立即校正，流式更新时无闪跳。
    // v0.27.0 R1：streamText 纳入依赖 → 流式追加同样贴底跟随（R-stream-2）。
    useLayoutEffect(() => {
      const el = scrollRef.current
      if (!el) return
      if (atBottom) {
        el.scrollTop = el.scrollHeight
      }
    }, [contentSignature, atBottom, streamText])

    // v0.13.0：累计新消息计数（用户不在底部时显示「↓ N 条新消息」）
    useEffect(() => {
      const total = items.length
      if (total < lastSeenCountRef.current) {
        // 任务切换或列表被重置（不应进入历史回退视作新增）
        lastSeenCountRef.current = total
        setUnreadCount(0)
        return
      }
      const grown = total - lastSeenCountRef.current
      if (atBottom) {
        // 贴底时把已读基线拉到当前值，计数清零
        lastSeenCountRef.current = total
        setUnreadCount(0)
      } else if (grown > 0) {
        // 不在底部 + 有新增 → 累加
        setUnreadCount((c) => c + grown)
        lastSeenCountRef.current = total
      }
    }, [items.length, atBottom])

    // 监听滚动：判断是否贴底、是否进入「长对话」
    const onScroll = () => {
      const el = scrollRef.current
      if (!el) return
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      // 贴底阈值 40px：同时决定未读计数浮层的显示边界（>40px 视为上翻暂停）
      const nextAtBottom = distanceFromBottom < 40
      setAtBottom(nextAtBottom)
      setLongMode(el.scrollHeight > el.clientHeight * 2.5)
      if (nextAtBottom) {
        // 滚到底部 → 归零
        lastSeenCountRef.current = items.length
        setUnreadCount(0)
      }
    }

    // v0.13.0：跨组件滚动锚点（ToolsPanel 点击某条 → 滚到 ToolCard）
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

    // v0.14.0 Task 4：TodoPanel / 对话 PlanMessage 步骤点击 → 滚动到对应 plan 步骤锚点。
    //   - 优先使用 detail.stepId（TodoPanel 当前约定的派发格式，携带预生成 id）
    //   - 兼容 detail.index 旧协议（仅 plan-step 计数）：按 idx+1 锚点 id 查找，超界不滚动
    //   - 任一查找命中即 scrollIntoView，未命中直接 return（不抛错、不假装滚到底）
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
          // 简短高亮提示（与 TodoPanel 同步感觉）
          el.classList.remove('plan-flash')
          void el.offsetWidth
          el.classList.add('plan-flash')
        }
      }
      window.addEventListener('react:scroll-to-plan-step', handler as EventListener)
      return () => window.removeEventListener('react:scroll-to-plan-step', handler as EventListener)
    }, [])

    if (!agent) {
      return (
        <div className="flex-1 flex items-center justify-center text-sm text-text-tertiary">
          {t('conversationflow.loadingAgent')}
        </div>
      )
    }

    const isRunning = task?.status === 'running'

    // Task 2：思考/执行中描述（自然语言、不抖动）
    const lastAct = [...steps].reverse().find((s) => s.type === 'act')
    const lastReason = [...steps].reverse().find((s) => s.type === 'reason')
    // v0.23.0：执行中文本要"较为详细的大模型感知的正在做的事情"（TraeWork 风格）
    // 优先用 reason 的 thought 摘要（最多 80 字），其次用 act 的 intent，最后兜底文案
    const truncate80 = (s: string) => (s.length > 80 ? s.slice(0, 80) + '…' : s)
    const thinkingDescription = lastReason?.thought
      ? truncate80(lastReason.thought.replace(/\n+/g, ' ').trim())
      : lastAct
        ? (intentText(lastAct) || executionDescription(lastAct.toolName))
        : reasoningDescription(lastReason ? 'finalizing' : 'thinking')

    return (
      /* v0.22.0 — DSH 风格 ChatView：column 居中 760px、column gap 16px；
         顶部 16px 渐隐提示保持；back-to-bottom 按钮改为 34×34 圆形浮按钮（CSS .scroll-to-bottom） */
      <div className="flex-1 overflow-y-auto min-h-0 relative" ref={scrollRef} onScroll={onScroll}>
        <div className="max-w-[760px] mx-auto px-6 py-6 space-y-4">
          {items.length === 0 && ctxChips.length === 0 && (
            <div className="py-10" />
          )}

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

          {groups.map((group, idx) => {
            // 单个 item → 原有渲染；连续 react → 共享 agent header 的步骤流分组
            if (group.items.length > 1) {
              return (
                <ReactStreamGroup
                  key={group.key}
                  items={group.items}
                  agent={agent}
                  tsLabel={group.items[0].tsLabel ?? ''}
                />
              )
            }
            const item = group.items[0]
            const isLast = idx === groups.length - 1
            return (
              <ConversationMessage
                key={group.key}
                item={item}
                agent={agent}
                taskId={task?.id ?? ''}
                streaming={isLast && isRunning && item.type === 'assistant'}
              />
            )
          })}

          {/* v0.27.0 R1：Reason 流式预览（渲染加速通道）。
              纯文本 + 闪烁光标（Markdown 对残缺语法会抖动）；reason step 落地后
              buffer 被 store 清空 → 权威步骤流接管渲染（R-stream-3）。 */}
          {isRunning && streamText && (
            <div className="fade-in-up" aria-live="polite">
              <div className="text-sm leading-6 text-text-secondary whitespace-pre-wrap break-words">
                {streamText}
                <span className="stream-caret" aria-hidden="true" />
              </div>
            </div>
          )}

          {/* running 但还没有 assistant 消息：v0.23.0 TraeWork 风格活动指示器
               - 展示最近 1-2 步（reason/act）的意图与摘要
               - 业务蓝 shimmer 渐变文本（DSH）
               - v0.27.0 R1：流式预览存在时主行让位（避免双份进度感），仅保留副活动行 */}
          {isRunning && (items.length === 0 || items[items.length - 1].type !== 'assistant') && (
            <div className="fade-in-up space-y-1" aria-live="polite">
              {/* 主活动行：最近 reason / act 的详细描述（80 字内） */}
              {!streamText && (
                <div
                  className="flex items-center gap-2 text-sm font-medium turn-status"
                  style={{ lineHeight: '26px' }}
                >
                  <span className="turn-status__text">{thinkingDescription}</span>
                  <span className="turn-status__clock" />
                </div>
              )}
              {/* 副活动行：最近 2 步的简短动作流（紧凑显示） */}
              <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
                {[...steps].slice(-2).map((s, i) => {
                  if (s.type === 'reason') return null
                  if (s.type === 'act') {
                    const verb = intentText(s) || (s.toolName ? `${s.toolName}` : t('conversationflow.executing'))
                    return (
                      <span
                        key={s.id || `${i}-act`}
                        className="inline-flex items-center gap-1"
                      >
                        <span
                          className="inline-block w-1 h-1 rounded-full"
                          style={{ background: s.status === 'running' ? 'var(--business-primary)' : s.status === 'failed' ? 'var(--danger)' : 'var(--success)' }}
                        />
                        <span>{verb.slice(0, 24)}</span>
                        {i === 0 && <span className="text-text-tertiary">·</span>}
                      </span>
                    )
                  }
                  return null
                })}
              </div>
            </div>
          )}

          {/* Task 4：建议卡片 — task_complete 完成态时渲染。
              v0.27.1：ask_user 暂停态不再在此渲染——此处的 SuggestionCards 无
              onSelect，点击只派发死通道 composer:fill（Composer 已被 RunConsole/
              AskUserGate 替换，填不进任何输入框），且与门禁交互冲突。由 Composer
              的 AskUserGate 独占展示；此处仅在无提问残留时兜底显示完成态建议 */}
          {!isRunning && !askUserQuestion && suggestions.length > 0 && (
            <SuggestionCards suggestions={suggestions} />
          )}

          {/* 底部留白（v0.23.0：增大 h-12 防止与 Composer / RunConsole 输入区重叠） */}
          <div className="h-12" />
        </div>

        {/* v0.22.0：DSH ChatView 顶部 16px 渐隐提示（保持） */}
        {!atBottom && (
          <div className="pointer-events-none absolute top-0 left-0 right-0 h-4 bg-gradient-to-b from-bg-base to-transparent" />
        )}

        {/* v0.22.0：DSH ChatView 圆形 back-to-bottom 按钮（34×34 浮按钮） */}
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
              <path d="M8 3v10M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>
    )
  },
)

/* ============================================================
 * extractArtifacts — 从 ReActStep[] 中提取产物文件
 * 规则：
 *   - act 步骤的 toolArgs 中含 path/file 字段 → 视为产物
 *   - rawL2Path 存在 → 大结果落盘文件（指向 .arkwork/steps 的内部副本跳过，
 *     其可读摘要已由 ToolCard 的 resultSummary 承担，不再生成产物卡片）
 *   - resultSummary 中匹配绝对路径 → 补充提取
 * ============================================================ */
function extractArtifacts(steps: ReActStep[]): Artifact[] {
  const out: Artifact[] = []
  const seen = new Set<string>()
  for (const s of steps) {
    if (s.type !== 'act') continue
    // 1. 从 toolArgs 中提取 path
    const args = parseArgs(s.toolArgs)
    const path = String(args.path ?? args.file ?? args.filePath ?? '')
    if (path && path.startsWith('/')) {
      if (!seen.has(path)) {
        seen.add(path)
        out.push({
          path,
          kind: detectRenderer(path),
          // 大小来自工具「结果」而非「入参」：file-reader 返回 size，file-writer 返回 bytes，
          // 入参 args 里从没有 size 字段，此前恒为 0。
          size: extractResultSize(s),
          step: s.iteration,
        })
      }
    }
    // 2. rawL2Path（大结果落盘）— 跳过指向内部 step 文件的副本：
    //    persistRawL2 落盘为 <taskDir>/.arkwork/steps/<stepId>.json，用户不可读。
    if (s.rawL2Path && !seen.has(s.rawL2Path) && !isInternalL2Path(s.rawL2Path)) {
      seen.add(s.rawL2Path)
      out.push({
        path: s.rawL2Path,
        kind: detectRenderer(s.rawL2Path),
        size: 0,
        step: s.iteration,
      })
    }
  }
  return out
}

/** 内部 L2 落盘副本（.arkwork/steps/step-*.json）不作为用户可见产物 */
function isInternalL2Path(path: string): boolean {
  return path.includes('/steps/step-') || (path.endsWith('.json') && path.includes('.arkwork'))
}

function parseArgs(toolArgs?: string): Record<string, unknown> {
  if (!toolArgs) return {}
  try { return JSON.parse(toolArgs) } catch { return {} }
}

/** 从工具结果中提取产物字节数：file-reader → size，file-writer → bytes，其余回退 0 */
function extractResultSize(s: ReActStep): number {
  const r = s.result as Record<string, unknown> | null | undefined
  if (!r || typeof r !== 'object') return 0
  if (s.toolName === 'file-writer') return Number(r.bytes ?? 0) || 0
  return Number(r.size ?? 0) || 0
}

/* ============================================================
 * ConversationMessage — 单条消息分发
 * ============================================================ */
function ConversationMessage({
  item,
  agent,
  taskId,
  streaming,
}: {
  item: ConversationItem
  agent: Agent
  taskId: string
  streaming: boolean
}) {
  if (item.type === 'user') {
    return <UserBubble text={item.text ?? ''} tsLabel={item.tsLabel ?? ''} />
  }
  // v0.14.0 Task 4：plan 类型改为 PlanMessage 卡片，在时间线中渲染；
  // 与右侧 TodoPanel 共用 store 导出的 derivePlanItems 派生结果。
  // 仅当存在真实 plan（item.plan.items 非空 或 steps 内 plan step items 非空）时渲染，
  // 否则返回 null 避免空卡片。
  if (item.type === 'plan') {
    if (!item.plan?.items || item.plan.items.length === 0) {
      const stepPlan = useStore.getState().steps.find((s) => s.type === 'plan' && s.plan)?.plan
      if (!stepPlan || stepPlan.items.length === 0) {
        return null
      }
    }
    return <PlanMessage item={item} agent={agent} />
  }
  if (item.type === 'assistant') {
    return (
      <AssistantMessage
        text={item.text ?? ''}
        agent={agent}
        tsLabel={item.tsLabel ?? ''}
        streaming={streaming}
        taskId={taskId}
        messageId={item.id}
      />
    )
  }
  return <ReactMessage steps={item.steps ?? []} agent={agent} tsLabel={item.tsLabel ?? ''} />
}

/* ============================================================
 * PlanMessage — v0.14.0 Task 4：对话流时间线内的计划卡
 * 视觉与原 PlanChecklist 一致：目标（plan.goal）+ 进度条 + 步骤列表（plan-row 状态样式）+ 状态。
 * 不再常驻 TaskHeader 下方，可与对话一起滚动；点击步骤号 → 派发 react:scroll-to-plan-step
 * 锚点自身，TodoPanel 与 PlanMessage 内部点击互通。
 * ============================================================ */
function PlanMessage({
  item,
  agent,
}: {
  item: ConversationItem
  agent: Agent
}) {
  const { t } = useTranslation()
  const planStep = useStore((s) => s.steps.find((st) => st.type === 'plan' && !!st.plan))
  // v0.14.x Task 1：六态以任务持久化 planItems 为准（G3 单一真源），
  // 只有任务真正 done（或 task_complete 事件）才允许全部勾完，禁止两套逻辑
  const task = useStore((s) => s.tasks.find((t) => t.id === s.selectedTaskId))
  // v0.14.0 Task 8：PlanMessage 卡片支持展开/折叠（默认展开，保持 v0.13.x 可见基线）
  const [collapsed, setCollapsed] = useState(false)
  // v0.14.x Task 3：无 fallback 时返回空数组；ConversationFlow 渲染入口已据此短路
  const planItems: string[] = useMemo(
    () => {
      const real = item.plan?.items ?? []
      if (real.length > 0) return real
      if (planStep?.plan && planStep.plan.items.length > 0) return planStep.plan.items
      return []
    },
    [item.plan?.items, planStep?.plan],
  )
  const items = planItems
  // v0.14.0 Task 8：六态优先取任务持久化 planItems（与 Inspector / Sidebar 同源）；
  // v0.27.0 F10：渲染层不再派生逐项状态，
  // 缺失 / 长度不匹配时回退 Main 推送的 item.planStates，再退空数组
  const states: PlanItemStatus[] = useMemo(() => {
    const persisted = task?.planItems
    if (persisted && persisted.length === items.length) {
      return persisted.map((p) => p.status)
    }
    return item.planStates && item.planStates.length > 0 ? item.planStates : []
  }, [task?.planItems, items, item.planStates])
  const goal = item.plan?.goal ?? t('conversationflow.plan')
  const tsLabel = item.tsLabel ?? ''
  const doneCount = states.filter((s) => s === 'done').length
  // 卡片级聚合状态徽标（与 Sidebar 任务行同源：aggregatePlanStatus）
  const aggregate = aggregatePlanStatus(states)
  const aggregateMeta = aggregate ? PLAN_STATUS_META[aggregate] : undefined
  const onStepClick = (i: number) => {
    const stepId = `plan-step-${i + 1}`
    window.dispatchEvent(
      new CustomEvent('react:scroll-to-plan-step', { detail: { index: i, stepId } }),
    )
  }
  return (
    <div className="fade-in-up flex flex-col items-start group" data-time-hover-root>
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar color={agent.avatarColor} initial={agent.name[0]} />
        <span className="text-sm text-text-secondary">@{agent.name}</span>
        <span className="text-sm text-text-tertiary">· {t('conversationflow.plan')}</span>
        <span className="text-sm text-text-tertiary tabular opacity-0 transition-opacity duration-100 group-hover:opacity-100">
          {tsLabel}
        </span>
      </div>
      {/* v0.22.0：DSH TodoPanel 风格卡片 — 12px 圆角、l1 边框、neutral tip 底 */}
      <div
        id="plan-card"
        className="w-full rounded-xl border border-border-subtle bg-bg-surface px-4 py-3 space-y-2"
      >
        {/* v0.14.0 Task 8：头部可点击展开/折叠（默认展开） */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="w-full text-left focus-ring flex items-center gap-2"
        >
          <span className="flex-1 min-w-0">
            <span className="block text-2xs text-text-tertiary font-medium">{t('conversationflow.goal')}</span>
            <span className="block text-sm text-text-primary" style={{ lineHeight: '24px' }}>{goal}</span>
          </span>
          {aggregateMeta && (
            <span
              className="flex-shrink-0 text-2xs font-medium px-2 py-0.5 rounded-full"
              style={{
                color: aggregateMeta.color,
                background: 'var(--bg-overlay)',
                border: '1px solid ' + aggregateMeta.color,
              }}
            >
              {t(aggregateMeta.label)}
            </span>
          )}
          <Icon.ChevronDown
            width={14}
            height={14}
            className={`flex-shrink-0 text-text-tertiary transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
        </button>

        {!collapsed && (
          <>
            {/* v0.22.0：DSH TodoPanel 进度信息（13/20，弹性布局） */}
            <div className="flex items-center gap-2 text-2xs text-text-tertiary tabular">
              <span>{t('conversationflow.completed', { done: doneCount, total: items.length })}</span>
              <span className="ml-auto text-text-tertiary">
                {items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0}%
              </span>
            </div>
            {/* v0.22.0：DSH 风格 4px 高进度条 */}
            <div className="w-full h-1 bg-bg-hover rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-business-primary transition-all duration-500"
                style={{ width: `${items.length === 0 ? 0 : Math.round((doneCount / items.length) * 100)}%` }}
              />
            </div>
            {/* v0.22.0：步骤列表 36px 行高，gap 4px */}
            <div className="space-y-1 mt-1">
              {items.map((it, i) => {
                const state: PlanItemStatus = states[i] ?? 'pending'
                const meta = PLAN_STATUS_META[state]
                return (
                  <button
                    key={i}
                    id={`plan-step-${i + 1}`}
                    type="button"
                    onClick={() => onStepClick(i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onStepClick(i)
                      }
                    }}
                    aria-label={t('conversationflow.planStepAria', { index: i + 1, text: it, status: t(meta.label) })}
                    className="plan-row w-full text-left focus-ring"
                    data-state={state}
                  >
                    <span className="plan-row__circle" aria-hidden="true">
                      {state === 'done' && (
                        <svg className="plan-row__check" viewBox="0 0 12 12" fill="none">
                          <path d="M3 6 5 8 9 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                      {state === 'failed' && (
                        <svg className="plan-row__check plan-row__cross" viewBox="0 0 12 12" fill="none">
                          <path d="M4 4l4 4M8 4l-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                      {state === 'cancelled' && (
                        <span className="text-[10px] leading-none text-text-tertiary">✕</span>
                      )}
                      {state === 'skipped' && (
                        <span className="text-[10px] leading-none text-warning">→</span>
                      )}
                    </span>
                    <span className="flex-1">{it}</span>
                    {state !== 'pending' && (
                      <span className="text-2xs flex-shrink-0" style={{ color: meta.color }}>
                        {t(meta.label)}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ============================================================
 * PlanChecklist — v0.14.0 Task 4 替换为 PlanMessage
 * PlanChecklist 过去在 ConversationFlow 中与 TaskHeader 下方 PlanBar 重复渲染；
 * 现 Task 4 统一由 ConversationFlow 内的 PlanMessage 卡片承担计划展示，
 * 派生源收敛至 store 导出的 derivePlanItems。
 * ============================================================ */

/* ============================================================
 * v0.22.0 — User Bubble（右对齐气泡，DSH MessageItem.userStack）
 * - figma 659:38813：r22 fill、max 525px / 82%、10/16 padding
 * - 16/24 主行节奏
 * ============================================================ */
function UserBubble({ text, tsLabel }: { text: string; tsLabel: string }) {
  return (
    <div className="fade-in-up flex flex-col items-end group" data-time-hover-root>
      {/* DSH IconActions 时时间端：hover/focus 才显示（timeStart） */}
      <div className="flex items-center gap-2 mb-1.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100">
        <span className="text-sm text-text-tertiary tabular">{tsLabel}</span>
      </div>
      <div
        className="select-text"
        style={{
          maxWidth: 'min(525px, 82%)',
          background: 'var(--bg-surface-2)',
          borderRadius: '22px',
          padding: '10px 16px',
          fontSize: '16px',
          lineHeight: '24px',
          color: 'var(--text-primary)',
        }}
      >
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{text}</p>
      </div>
    </div>
  )
}

/* ============================================================
 * v0.22.0 — Assistant Message（DSH AssistantMarkdown 风格）
 * - 16/28 主行节奏、block 间距 16px（CSS .md-body）
 * - 无背景卡片，纯流式叙事（DSH 左侧直接铺开）
 * - 头像 + @name + time + IconActions（DSH MessageIconActions）
 * ============================================================ */
function AssistantMessage({
  text,
  agent,
  tsLabel,
  streaming,
  taskId,
  messageId,
}: {
  text: string
  agent: Agent
  tsLabel: string
  streaming: boolean
  taskId: string
  messageId: string
}) {
  return (
    <div className="fade-in-up flex flex-col items-start group" data-time-hover-root>
      <div className="flex items-center gap-2 mb-2">
        <Avatar color={agent.avatarColor} initial={agent.name[0]} />
        <span className="text-sm text-text-secondary">@{agent.name}</span>
        {/* DSH：timeEnd 在 hover/focus 时浮现（与 IconActions 同节奏） */}
        <span className="text-sm text-text-tertiary tabular opacity-0 transition-opacity duration-100 group-hover:opacity-100">
          {tsLabel}
        </span>
      </div>
      {/* DSH 风格：流式叙事体，无独立气泡背景（headline + body） */}
      <div className="w-full">
        <Markdown content={text} streaming={streaming} />
      </div>
      {/* v0.22.0：hover 操作条 — DSH MessageIconActions，28×28 圆形按钮 */}
      {!streaming && text.trim() && taskId && (
        <MessageActions taskId={taskId} messageId={messageId} text={text} />
      )}
    </div>
  )
}

/* ============================================================
 * v0.22.0 — React Message（DSH ReasoningRow 风格）
 * - 头部 avatar + @name · 步骤流 + time
 * - ThoughtStream 内含折叠摘要 + 步骤卡
 * ============================================================ */
function ReactMessage({
  steps,
  agent,
  tsLabel,
}: {
  steps: ConversationItem['steps']
  agent: Agent
  tsLabel: string
}) {
  const artifacts = useMemo(() => extractArtifacts(steps ?? []), [steps])
  const { t } = useTranslation()
  return (
    <div className="fade-in-up flex flex-col items-start group" data-time-hover-root>
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar color={agent.avatarColor} initial={agent.name[0]} />
        <span className="text-sm text-text-secondary">@{agent.name}</span>
        <span className="text-sm text-text-tertiary">· {t('conversationflow.steps')}</span>
        <span className="text-sm text-text-tertiary tabular opacity-0 transition-opacity duration-100 group-hover:opacity-100">
          {tsLabel}
        </span>
      </div>
      <div className="w-full">
        <ThoughtStream steps={steps ?? []} />
        {artifacts.length > 0 && (
          <div className="mt-2">
            <ArtifactCard artifacts={artifacts} />
          </div>
        )}
      </div>
    </div>
  )
}

function Avatar({ color, initial }: { color: string; initial: string }) {
  return (
    <div
      className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0"
      style={{ background: color }}
    >
      {initial}
    </div>
  )
}

/* ============================================================
 * v0.22.0 — ReactStreamGroup（连续步骤流分组，DSH 风格）
 * 同一 agent 的多次工具调用共享一个 header，步骤流连续展示，
 * 产物卡片随对应 iteration 内联。time hover 显示。
 * ============================================================ */
function ReactStreamGroup({
  items,
  agent,
  tsLabel,
}: {
  items: ConversationItem[]
  agent: Agent
  tsLabel: string
}) {
  const { t } = useTranslation()
  return (
    <div className="fade-in-up flex flex-col items-start group" data-time-hover-root>
      <div className="flex items-center gap-2 mb-1.5">
        <Avatar color={agent.avatarColor} initial={agent.name[0]} />
        <span className="text-sm text-text-secondary">@{agent.name}</span>
        <span className="text-sm text-text-tertiary">· {t('conversationflow.steps')}</span>
        <span className="text-sm text-text-tertiary tabular opacity-0 transition-opacity duration-100 group-hover:opacity-100">
          {tsLabel}
        </span>
      </div>
      <div className="w-full space-y-2">
        {items.map((item) => {
          const steps = item.steps ?? []
          const artifacts = extractArtifacts(steps)
          return (
            <div key={item.id}>
              <ThoughtStream steps={steps} />
              {artifacts.length > 0 && (
                <div className="mt-1.5">
                  <ArtifactCard artifacts={artifacts} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
