/* ============================================================
 * ArkWork — Dock/TodoPanel (v0.14.0 Task 4)
 * 任务清单面板：当前任务的 Plan/todo 清单
 * - 条目 + 状态（待办/进行/完成），与对话流内 PlanMessage 共用 store 派生
 *   (derivePlanItems / derivePlanStates)
 * - 点击条目 → 派发 react:scroll-to-plan-step，dialog 滚动锚点回 PlanMessage
 * - 无真实 plan 时空态文案「当前任务无需计划 · 直接处理中」，
 *   与对话区 PlanMessage 不再渲染空卡片保持一致
 * ============================================================ */
import { useMemo, useState } from 'react'
import { Icon } from '../../icons'
import { useStore, derivePlanItems, derivePlanStates } from '../../store'
import { Tooltip, EmptyState } from '../ui'
import type { PlanItemState } from '@shared/types/conversation'
import type { PlanItemStatus } from '@shared/types/task'
import { PLAN_STATUS_META, planStatusTextClass, planItemToolSteps } from '../../utils/plan-status'

/** v0.17.0 F8：状态筛选顺序（全部 + 六态） */
const FILTER_ORDER: PlanItemStatus[] = ['pending', 'running', 'done', 'skipped', 'failed', 'cancelled']

export function TodoPanel() {
  const conversation = useStore((s) => s.conversation)
  const steps = useStore((s) => s.steps)
  // v0.14.x Task 1：fallback 派生带任务状态 —— 只有任务真正 done（或 task_complete 事件）
  // 才允许全部勾完；与对话内 PlanMessage 同一数据源、同一时刻一致
  const task = useStore((s) => s.tasks.find((t) => t.id === s.selectedTaskId))
  // v0.14.0 Task 8：行级六态展开详情（工具调用记录 / 结果摘要 / 异常标记）
  // v0.17.0：由单行展开改为集合，支持同时展开多行对照工具执行明细
  const [expandedSet, setExpandedSet] = useState<Set<number>>(() => new Set())
  const toggleExpand = (i: number) =>
    setExpandedSet((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  // 与对话 PlanMessage 严格同源：优先取 conversation 内 plan 条目；
  // 即便 conversation 内还没有 plan item，也使用 store util 派生（与对话一致）
  const planItem = useMemo(
    () => conversation.find((i) => i.type === 'plan' && !!i.plan),
    [conversation],
  )

  // v0.14.0 Task 4：派生 items 与 states — 与 PlanMessage 共用同一组 util
  const items = useMemo<string[]>(
    () => planItem?.plan && planItem.plan.items.length > 0
      ? planItem.plan.items
      : derivePlanItems(steps),
    [planItem?.plan, steps],
  )
  // v0.14.0 Task 8：六态优先取任务持久化 planItems（与 Sidebar / PlanMessage 同源）；
  // 缺失 / 长度不匹配时回退 v0.14.x Task 4 的步骤派生（四态），保持旧行为不破坏
  const states = useMemo<PlanItemStatus[]>(() => {
    const persisted = task?.planItems
    if (persisted && persisted.length === items.length) {
      return persisted.map((p) => p.status)
    }
    const derived: PlanItemState[] =
      planItem?.planStates && planItem.planStates.length > 0
        ? planItem.planStates
        : derivePlanStates(items, steps, task?.status)
    return derived
  }, [task?.planItems, items, planItem?.planStates, steps, task?.status])
  const doneCount = states.filter((s) => s === 'done').length

  // v0.17.0 F8：状态筛选（全部 / 六态）
  const [filter, setFilter] = useState<'all' | PlanItemStatus>('all')
  const countBy = useMemo(() => {
    const m: Record<string, number> = {}
    for (const s of states) m[s] = (m[s] ?? 0) + 1
    return m
  }, [states])
  const filteredIndices = useMemo(
    () =>
      items
        .map((_, i) => i)
        .filter((i) => filter === 'all' || (states[i] ?? 'pending') === filter),
    [items, states, filter],
  )

  const goal = planItem?.plan?.goal ?? '尚未生成计划'

  const locatePlanCard = () => {
    const el = document.getElementById('plan-card')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.remove('plan-flash')
      void el.offsetWidth
      el.classList.add('plan-flash')
    }
  }

  const locateStep = (i: number) => {
    const stepId = `plan-step-${i + 1}`
    window.dispatchEvent(
      new CustomEvent('react:scroll-to-plan-step', { detail: { index: i, stepId } }),
    )
  }

  // 无真实计划时统一空态文案，与对话区 PlanMessage 保持一致
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Icon.Check width={22} height={22} />}
        title="当前任务无需计划"
        hint="当前任务无需计划 · 直接处理中"
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部：目标 + 进度 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="text-sm text-text-primary font-medium truncate">{goal}</span>
        <span className="text-2xs text-text-tertiary tabular">
          {doneCount} / {items.length}
        </span>
        <Tooltip label="定位到对话流中的计划卡片">
          <button
            onClick={locatePlanCard}
            className="ml-auto flex items-center gap-1 px-2 h-6 rounded text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Icon.ExternalLink width={16} height={16} />
            定位
          </button>
        </Tooltip>
      </div>

      {/* v0.17.0 F8：状态筛选 chips（全部 + 六态） */}
      <div className="flex items-center gap-1 px-3 pt-2 flex-shrink-0 flex-wrap">
        <button
          onClick={() => setFilter('all')}
          aria-pressed={filter === 'all'}
          className={`flex items-center gap-1 h-6 px-2 rounded-full text-2xs tabular transition-colors ${
            filter === 'all'
              ? 'bg-bg-active text-text-primary'
              : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
          }`}
        >
          全部<span className="opacity-60">{items.length}</span>
        </button>
        {FILTER_ORDER.filter((st) => (countBy[st] ?? 0) > 0).map((st) => {
          const active = filter === st
          return (
            <button
              key={st}
              onClick={() => setFilter(st)}
              aria-pressed={active}
              className={`flex items-center gap-1 h-6 px-2 rounded-full text-2xs tabular transition-colors ${
                active
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: PLAN_STATUS_META[st].color }}
              />
              {PLAN_STATUS_META[st].label}
              <span className="opacity-60">{countBy[st] ?? 0}</span>
            </button>
          )
        })}
      </div>

      {/* 进度条 */}
      {items.length > 0 && (
        <div className="px-3 pt-2.5 flex-shrink-0">
          <div className="w-full h-1.5 bg-bg-elevated rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-success transition-all duration-500"
              style={{ width: `${Math.round((doneCount / items.length) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* 清单 */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {filteredIndices.length === 0 && (
          <div className="px-2 py-3 text-2xs text-text-tertiary">当前筛选下没有任务</div>
        )}
        <ol className="space-y-1">
          {filteredIndices.map((i) => {
            const item = items[i]
            // v0.14.0 Task 8：行级六态（pending 灰 / running 蓝脉冲 / done 绿+删除线 /
            // failed 红 / cancelled 灰+删除线 / skipped 黄），映射表见 utils/plan-status.ts
            const st: PlanItemStatus = states[i] ?? 'pending'
            const meta = PLAN_STATUS_META[st]
            const expanded = expandedSet.has(i)
            const toolSteps = planItemToolSteps(steps, i)
            return (
              <li key={i}>
                <div
                  className={`flex items-start gap-2.5 px-2 py-1.5 rounded-md text-sm transition-colors cursor-pointer ${
                    st === 'running' ? 'bg-bg-active' : 'hover:bg-bg-hover'
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  aria-label={`计划步骤 ${i + 1}：${item}（状态：${meta.label}）`}
                  onClick={() => toggleExpand(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleExpand(i)
                    }
                  }}
                >
                  {st === 'done' ? (
                    <span className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full bg-success flex items-center justify-center">
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                        <path d="M2 5.2 4.2 7.4 8 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  ) : st === 'running' ? (
                    <span className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin" />
                  ) : st === 'failed' ? (
                    <span className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full bg-danger flex items-center justify-center text-white text-2xs font-semibold">
                      ✕
                    </span>
                  ) : st === 'skipped' ? (
                    <span className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-[1.5px] border-warning flex items-center justify-center text-warning text-2xs font-semibold">
                      →
                    </span>
                  ) : st === 'cancelled' ? (
                    <span className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border border-border-default flex items-center justify-center text-text-tertiary text-2xs font-semibold">
                      ✕
                    </span>
                  ) : (
                    <span className="flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border border-border-default flex items-center justify-center text-2xs text-text-tertiary tabular">
                      {i + 1}
                    </span>
                  )}
                  <span className={`leading-relaxed ${planStatusTextClass(st)}`}>{item}</span>
                  <span
                    className="ml-auto flex-shrink-0 text-2xs mt-0.5"
                    style={{ color: meta.color }}
                  >
                    {meta.label}
                  </span>
                  <span
                    className="flex-shrink-0 mt-0.5 text-text-tertiary transition-transform"
                    style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }}
                    aria-hidden="true"
                  >
                    <Icon.ChevronDown width={12} height={12} />
                  </span>
                </div>

                {/* v0.14.0 Task 8：行级展开详情 — 工具调用记录 / 结果摘要 / 异常标记 */}
                {expanded && (
                  <div className="ml-6 pl-2.5 pr-2 py-1.5 space-y-1 border-l-2 border-border-subtle">
                    {toolSteps.length === 0 ? (
                      <div className="text-2xs text-text-tertiary px-1">暂无工具调用记录</div>
                    ) : (
                      toolSteps.map((step) => (
                        <div
                          key={step.id}
                          className="px-2 py-1.5 rounded-md bg-bg-surface border border-border-subtle space-y-0.5"
                        >
                          <div className="flex items-center gap-1.5 text-2xs">
                            <span className="font-mono text-text-secondary truncate">
                              {step.toolName ?? '—'}
                            </span>
                            {step.status === 'running' && (
                              <span className="text-accent flex items-center gap-1 flex-shrink-0">
                                <span className="w-1 h-1 rounded-full bg-accent pulse-dot" />
                                运行中
                              </span>
                            )}
                            {step.status === 'success' && (
                              <span className="text-success flex-shrink-0">成功</span>
                            )}
                            {step.status === 'failed' && (
                              <span className="text-danger flex-shrink-0">失败</span>
                            )}
                            {step.durationMs > 0 && (
                              <span className="text-text-tertiary tabular flex-shrink-0 flex items-center gap-0.5">
                                <Icon.Clock width={10} height={10} />
                                {(step.durationMs / 1000).toFixed(2)}s
                              </span>
                            )}
                          </div>
                          {step.resultSummary && (
                            <div className="text-2xs text-text-secondary leading-relaxed break-all">
                              结果：{step.resultSummary}
                            </div>
                          )}
                          {step.errorMessage && (
                            <div className="text-2xs text-danger leading-relaxed break-all">
                              异常：{step.errorMessage}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                    <button
                      onClick={() => locateStep(i)}
                      className="px-1 text-2xs text-text-tertiary hover:text-accent transition-colors"
                    >
                      定位到对话流中的计划卡片 →
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
