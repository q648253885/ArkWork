/* ============================================================
 * ArkWork — Dock/TodoPanel（v0.18.0 重构）
 * v0.14.0 Task 4 起为清单面板；v0.18.0 重写为"task.planItems 真值唯一源"：
 *  - 移除逐项状态 fallback 派生（F2）
 *  - 三视图（Sidebar / TodoPanel / PlanMessage）必须消费同一 task.planItems（G3）
 *  - 用户手动切状态走 Optimistic UI（markPlanItemOptimistic → IPC → reconcile）
 *  - 行尾新增"引擎"徽标（engine-decide / engine-fail 时显示）
 *  - ↕ 联动按钮触发 react:scroll-to-plan-step 给 StepList（双向）
 *  - 推断占位卡：当 planItems 缺失且 steps 非空时短暂显示「推断」占位卡
 * ============================================================ */
import { useMemo, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { useStore, derivePlanItems } from '../../store'
import { Tooltip, EmptyState } from '../ui'
import type { PlanItemStatus, PlanItem, PlanItemSource } from '@shared/types/task'
import { PLAN_STATUS_META, planStatusTextClass, planItemToolSteps } from '../../utils/plan-status'
import { ark } from '../../ipc/client'

/** v0.17.0 F8 + v0.18.0：状态筛选顺序（全部 + 六态） */
const FILTER_ORDER: PlanItemStatus[] = ['pending', 'running', 'done', 'skipped', 'failed', 'cancelled']
const TERMINAL: ReadonlySet<PlanItemStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])

/** 行级有效状态 = optimisticOverlay（若存在） > planItem.status > 'pending' */
function effectiveStatus(
  optimistic: { targetStatus: PlanItemStatus; submittedTs: number; clientVersion?: number } | undefined,
  planItem: PlanItem | undefined,
): PlanItemStatus {
  if (optimistic?.targetStatus) return optimistic.targetStatus
  return planItem?.status ?? 'pending'
}

export function TodoPanel() {
  const { t } = useTranslation()
  const conversation = useStore((s) => s.conversation)
  const steps = useStore((s) => s.steps)
  const task = useStore((s) => s.tasks.find((t) => t.id === s.selectedTaskId))
  const optimisticOverlay = useStore((s) => s.optimisticOverlay)
  const planItemInFlight = useStore((s) => s.planItemInFlight)
  const markPlanItemOptimistic = useStore((s) => s.markPlanItemOptimistic)
  const rejectPlanItemOptimistic = useStore((s) => s.rejectPlanItemOptimistic)

  // v0.14.x Task 8：行级六态展开详情（工具调用记录 / 结果摘要 / 异常标记）
  // v0.17.0：单行展开改为集合，支持同时展开多行
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() => new Set())
  // v0.18.x：行级「⋯」菜单展开状态（单行互斥）
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const toggleExpand = (id: string) =>
    setExpandedSet((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const planItem = useMemo(
    () => conversation.find((i) => i.type === 'plan' && !!i.plan),
    [conversation],
  )

  // v0.18.0 F2：行文本真值源 = task.planItems（三视图同源，G3）。
  // 优先级：
  //   1. task.planItems[].text（权威，走查任务 / 续聊任务均命中）
  //   2. conversation.plan.items（旧数据兼容：planItems 缺失但对话有 plan 卡片）
  //   3. derivePlanItems(steps)（推断占位：对话无 plan 且 planItems 缺失）
  const persistedItems = task?.planItems
  const items = useMemo<string[]>(() => {
    if (persistedItems && persistedItems.length > 0) {
      return persistedItems.map((p) => p.text)
    }
    if (planItem?.plan && planItem.plan.items.length > 0) {
      return planItem.plan.items
    }
    return derivePlanItems(steps)
  }, [persistedItems, planItem?.plan, steps])

  // 按 id 对齐：persistedItems 是权威状态源；items 是文本来源
  const states: PlanItemStatus[] = useMemo(() => {
    if (!persistedItems || persistedItems.length === 0) {
      // 推断占位卡分支：planItems 缺失但 steps 非空时，全部按 pending 占位
      // v0.18.0 F2：只作为"推断"占位卡使用，**不**回退到默认渲染路径
      return items.map(() => 'pending')
    }
    return items.map((text, i) => {
      const p = persistedItems[i] ?? persistedItems.find((x) => x.text === text)
      if (!p) return 'pending'
      const overlay = optimisticOverlay[task?.id ?? '']?.[p.id]
      return effectiveStatus(overlay, p)
    })
  }, [persistedItems, optimisticOverlay, task?.id, items])

  const doneCount = states.filter((s) => s === 'done').length
  const planItemsLen = persistedItems?.length ?? 0

  // v0.17.0 F8：状态筛选
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
        .filter((i) => filter === 'all' || states[i] === filter),
    [items, states, filter],
  )

  // v0.18.0：目标优先取对话 plan 的 goal；无对话 plan 时回退任务标题（F2 真值源一致）
  const goal = planItem?.plan?.goal ?? task?.title ?? t('dock.todo.no_plan_yet')

  // v0.18.0 F5：行操作按钮 — 用户手动切状态入口
  // 走 Optimistic 先行：markPlanItemOptimistic 立即本地生效；
  // 同时调 IPC 通知 Main；Main 回执通过 task:plan-item-status-changed patch 触发 commit。
  const triggerPlanItemAction = useCallback(
    async (planItemId: string, targetStatus: PlanItemStatus) => {
      if (!task) return
      // 1. 立即本地生效（F5 Optimistic UI）
      markPlanItemOptimistic(task.id, planItemId, targetStatus)
      // 2. 选 IPC handler（v0.18.0：cancel / retry / mark-done 三选一）
      const invoke =
        targetStatus === 'cancelled'
          ? ark.task.cancelPlanItem({ taskId: task.id, planItemId })
          : targetStatus === 'running'
            ? ark.task.retryPlanItem({ taskId: task.id, planItemId })
            : ark.task.markDonePlanItem({ taskId: task.id, planItemId })
      try {
        const res = await invoke
        if (!res.ok) {
          // Main 端拒绝：回滚 + 弹 Toast
          rejectPlanItemOptimistic(task.id, planItemId, res.error.message)
        }
        // res.ok === true 走 patch 通道自动 commit，无需手动处理
      } catch (err) {
        rejectPlanItemOptimistic(
          task.id,
          planItemId,
          (err as Error).message ?? t('dock.todo.ipc_call_failed'),
        )
      }
    },
    [task, markPlanItemOptimistic, rejectPlanItemOptimistic, t],
  )

  // v0.18.0 F8：StepList 联动 —— 行点击 ↕ 触发滚动到 StepList 第一个 act 步骤
  const locateStep = useCallback((planItemId: string, index: number) => {
    window.dispatchEvent(
      new CustomEvent('react:scroll-to-plan-step', {
        detail: { planItemId, index, source: 'todo' },
      }),
    )
  }, [])

  // v0.18.0 F8：双向联动 —— StepList 中 act 步骤 ↕ 触发滚动到 TodoPanel 对应行
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ planItemIndex?: number }>).detail
      if (typeof detail?.planItemIndex !== 'number') return
      const target = document.querySelector<HTMLElement>(
        `[data-plan-row-index='${detail.planItemIndex}']`,
      )
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.classList.remove('plan-flash')
        void target.offsetWidth
        target.classList.add('plan-flash')
      }
    }
    window.addEventListener('react:scroll-to-plan-row', handler)
    return () => window.removeEventListener('react:scroll-to-plan-row', handler)
  }, [])

  const locatePlanCard = () => {
    const el = document.getElementById('plan-card')
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.remove('plan-flash')
      void el.offsetWidth
      el.classList.add('plan-flash')
    }
  }

  // v0.18.0 F6：断码态 UI — 推断占位卡分支
  // 触发条件：planItems 缺失 / 长度 0，且 steps 不为空，任务状态非 done
  const isInferred =
    (!persistedItems || persistedItems.length === 0) &&
    steps.length > 0 &&
    task?.status !== 'done'

  // v0.27.0 F10：空态显式化 — 生成中/推断占位显示「计划生成中…」，否则「无清单」
  if (items.length === 0) {
    const generating = isInferred || task?.status === 'running'
    return (
      <EmptyState
        icon={<Icon.Check width={22} height={22} />}
        title={generating ? t('dock.todo.generating') : t('dock.todo.no_list')}
        hint={generating ? t('dock.todo.generating_hint') : t('dock.todo.no_list_hint')}
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部：目标 + 进度 */}
      <div className="flex items-center gap-2 px-3 h-9 flex-shrink-0 border-b border-border-subtle">
        <span className="flex-1 min-w-0 text-sm text-text-primary font-medium truncate">{goal}</span>
        <span className="flex-shrink-0 whitespace-nowrap text-2xs text-text-tertiary tabular">
          {doneCount} / {items.length}
        </span>
        <Tooltip label={t('dock.todo.locate_card_tooltip')}>
          <button
            onClick={locatePlanCard}
            className="ml-auto flex-shrink-0 whitespace-nowrap flex items-center gap-1 px-2 h-6 rounded text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Icon.ExternalLink width={16} height={16} />
            {t('dock.todo.locate')}
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
          {t('dock.todo.filter_all')}<span className="opacity-60">{items.length}</span>
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
              {t(PLAN_STATUS_META[st].label)}
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
          <div className="px-2 py-3 text-2xs text-text-tertiary">{t('dock.todo.filter_empty')}</div>
        )}
        <ol className="space-y-1">
          {filteredIndices.map((i) => {
            const item = items[i]
            const pItem: PlanItem | undefined = persistedItems?.[i] ?? persistedItems?.find((x) => x.text === item)
            const st: PlanItemStatus = states[i] ?? 'pending'
            const meta = PLAN_STATUS_META[st]
            const expanded = pItem ? expandedSet.has(pItem.id) : false
            const toolSteps = planItemToolSteps(steps, i)
            const isTerminal = TERMINAL.has(st)
            const isOptimisticFlight = pItem
              ? planItemInFlight[task?.id ?? '']?.[pItem.id] === 'submitted'
              : false
            const source: PlanItemSource | undefined = pItem?.source
            const showEngineBadge =
              source === 'engine-decide' || source === 'engine-fail'

            const canMarkDone = !isTerminal && !!pItem
            const canRetry = st === 'failed' && !!pItem
            const canCancel = !isTerminal && !!pItem
            const canLocate = toolSteps.length > 0 && !!pItem
            const hasActions = canMarkDone || canRetry || canCancel || canLocate

            const closeMenu = () => setMenuOpenId(null)

            return (
              <li key={pItem?.id ?? `row-${i}`} className="relative">
                <div
                  className={`flex items-start gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
                    st === 'running' ? 'bg-bg-active' : 'hover:bg-bg-hover'
                  } ${pItem ? 'cursor-pointer' : ''}`}
                  data-plan-row-id={pItem?.id}
                  data-plan-row-index={i}
                  data-plan-row-status={st}
                  onClick={() => pItem && toggleExpand(pItem.id)}
                >
                  {/* 状态点 */}
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

                  {/* 文本（换行显示，不硬截断，完整文案 title 悬浮） */}
                  <div className="flex-1 min-w-0">
                    <span
                      className={`leading-relaxed block break-words ${planStatusTextClass(st)}`}
                      title={item}
                    >
                      {item}
                    </span>
                    <div className="flex items-center gap-1 mt-0.5">
                      {showEngineBadge && (
                        <Tooltip label={t('dock.todo.engine_tooltip')}>
                          <span className="px-1 py-px rounded text-2xs leading-none bg-bg-elevated text-text-tertiary">
                            {t('dock.todo.engine')}
                          </span>
                        </Tooltip>
                      )}
                      {isOptimisticFlight && (
                        <span className="px-1 py-px rounded text-2xs leading-none bg-accent-soft text-accent tabular">
                          {t('dock.todo.submitted')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 状态 label */}
                  <span
                    className="flex-shrink-0 text-2xs mt-0.5 tabular"
                    style={{ color: meta.color }}
                  >
                    {t(meta.label)}
                  </span>

                  {/* 展开指示（行点击折叠/展开） */}
                  <Icon.ChevronDown
                    width={12}
                    height={12}
                    className="flex-shrink-0 mt-0.5 text-text-tertiary transition-transform"
                    style={{ transform: expanded ? 'none' : 'rotate(-90deg)' }}
                  />

                  {/* v0.18.x：行操作汇聚为「⋯」菜单（仅在需要时显示对应动作） */}
                  {hasActions && (
                    <button
                      aria-label={t('dock.todo.more_actions')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpenId(menuOpenId === pItem?.id ? null : (pItem?.id ?? null))
                      }}
                      className="flex-shrink-0 w-5 h-5 mt-0.5 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
                    >
                      <Icon.MoreHorizontal width={14} height={14} />
                    </button>
                  )}
                </div>

                {/* 下拉菜单 */}
                {menuOpenId === pItem?.id && pItem && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={closeMenu} />
                    <div className="absolute right-2 top-8 z-20 min-w-[148px] rounded-lg border border-border-subtle bg-bg-surface shadow-lg py-1">
                      {canMarkDone && (
                        <button
                          onClick={() => { closeMenu(); void triggerPlanItemAction(pItem.id, 'done') }}
                          className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-2"
                        >
                          <Icon.Check width={13} height={13} className="text-success" />
                          {t('dock.todo.mark_done')}
                        </button>
                      )}
                      {canRetry && (
                        <button
                          onClick={() => { closeMenu(); void triggerPlanItemAction(pItem.id, 'running') }}
                          className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-2"
                        >
                          <Icon.RotateCcw width={13} height={13} className="text-accent" />
                          {t('dock.todo.retry')}
                        </button>
                      )}
                      {canCancel && (
                        <button
                          onClick={() => { closeMenu(); void triggerPlanItemAction(pItem.id, 'cancelled') }}
                          className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-2"
                        >
                          <Icon.X width={13} height={13} className="text-text-tertiary" />
                          {t('dock.todo.cancel')}
                        </button>
                      )}
                      {canLocate && (
                        <button
                          onClick={() => { closeMenu(); locateStep(pItem.id, i) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-hover transition-colors flex items-center gap-2"
                        >
                          <Icon.ArrowUpDown width={13} height={13} className="text-text-tertiary" />
                          {t('dock.todo.locate_step')}
                        </button>
                      )}
                    </div>
                  </>
                )}

                {expanded && (
                  <div className="ml-6 pl-2.5 pr-2 py-1.5 space-y-1 border-l-2 border-border-subtle">
                    {toolSteps.length === 0 ? (
                      <div className="text-2xs text-text-tertiary px-1">{t('dock.todo.no_artifact')}</div>
                    ) : (
                      toolSteps
                        .filter((step) => !!step.resultSummary)
                        .map((step) => (
                          <div
                            key={step.id}
                            className="px-2 py-1.5 rounded-md bg-bg-surface border border-border-subtle"
                          >
                            <div className="text-2xs text-text-secondary leading-relaxed break-all">
                              {step.resultSummary}
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>

        {/* v0.18.0 F6：推断占位卡（planItems 缺失时短暂显示） */}
        {isInferred && (
          <div className="mt-3 px-3 py-2 rounded-md border border-border-subtle bg-bg-surface-2 space-y-1.5">
            <div className="flex items-center gap-2 text-2xs text-text-secondary">
              <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin" />
              <span>{t('dock.todo.infer_title')}</span>
            </div>
            <div className="text-2xs text-text-tertiary">
              {t('dock.todo.infer_desc')}
            </div>
          </div>
        )}
        {isInferred && planItemsLen === 0 && (
          <div className="mt-1 px-3 py-1 text-2xs text-text-tertiary">
            <span className="px-1 py-px rounded bg-bg-elevated text-text-tertiary">{t('dock.todo.inferred')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
