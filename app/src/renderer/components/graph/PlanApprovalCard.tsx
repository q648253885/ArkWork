/**
 * ArkWork — P8 · Plan 审批卡（对话流内联卡）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P8
 *       docs/versions/v0.30.0/04-system-design.md §5.1
 *       docs/versions/v0.36.0/03-interaction.md §P10（F6.2 勾选/行内编辑/双按钮增强）
 *       prototype/page-08-plan-approval.html（已冻结的视觉基准）
 *
 * ★ 这是「规划 → 执行」的闸门：**不批准不执行**（三层确认闸门的第一层）。
 *   批准后 `SpecBlock.state = approved` + AC 冻结（不变量 I3 生效）。
 *
 * F6.2（v0.36.0）：计划项逐条勾选（默认全选）+ 行内改题（对标 Claude Code plan mode）：
 *   · 每行前置复选框，未勾选项（含后代）由主进程按 `cancelled` 收口并复算覆盖率；
 *   · 标题点击进入行内编辑，Enter/失焦提交、Esc 取消，改过的项标「已调整」徽标；
 *   · 批准出口拆为双按钮：「批准所选并开始」（`startExecution:true`）与
 *     「仅保留计划不执行」（`startExecution:false`，不注入续跑消息，任务保持待命）；
 *   · 成功态折叠条显示「已批准 N/M 项」（`plan.approvedItemIds` / 结构行数）。
 *
 * 出口（缺一即视为未完成）：
 *  1. `[批准所选并开始]` → `decidePlan({ decision:'approve', approvedItemIds, nodeEdits, startExecution:true })`；AC 覆盖率不足或零勾选时**禁用**（I7）；
 *  2. `[仅保留计划不执行]` → 同 1 但 `startExecution:false`；
 *  3. `[打回并说明]` → 内联输入框 → 意见作为 user message 注入对话流；
 *  4. `[编辑为 Markdown]` → 本版为只读占位（graph.md 编辑器与反向解析校验见 v0.30.1，
 *     见 prd Scope Out 9 / 01-research A3），按钮置为**禁用态 + 「即将支持」角标**，
 *     悬停 `title` 说明原因（避免"点击才知不可用"）。
 *
 * ★ 架构：本卡**自订阅** `graph:update`（`kind==='plan'`）。
 *   `useGraph`（任务面板）把状态放在组件内部、只服务面板这一消费方 —— 对话流的
 *   内联卡是**第二个独立消费方**，不能复用面板实例，故在此自带订阅与竞态防护，
 *   与 `useGraph.load()` 的写法保持一致（首帧 `pendingPlan` + `snapshot`，后续增量
 *   由 `onUpdate` 触发；见 04-system-design §5.1 "后续增量走 onUpdate kind='plan'"）。
 *
 * ★ 五态映射（原型五态 → 本卡）：
 *   默认 = `pending`；加载 = `generating`；空 = **无 PlanApproval → 不渲染**（Tier 0）；
 *   错误 = `degraded`；成功 = `approved` 折叠为一行。另有 `rejected` 折叠一行（交互文档四态）。
 *
 * 视觉约束：AC 状态颜色一律取自 `graphMeta.AC_META`（「状态 → 视觉」单一真源），
 * 本卡不自行拼颜色，避免"面板里琥珀色、对话卡里绿色"这类漂移。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { tierLabel } from '@shared/types/graph'
import type { GraphSnapshot, PlanApproval } from '@shared/types/ipc'
import { useStore } from '../../store'
import { CardButton } from './ActionCards'
import { AC_META } from './graphMeta'

/** 节点摘要最多展示的行数，超出走「另有 N 个节点，见任务面板」 */
const STRUCTURE_LIMIT = 6

/** AC 折叠时展示的条数 */
const AC_COLLAPSED = 3

export interface PlanApprovalCardProps {
  /** 当前任务 id；为空时不渲染（保持空态） */
  taskId: string
}

export function PlanApprovalCard({ taskId }: PlanApprovalCardProps) {
  const { t, i18n } = useTranslation()
  const pushToast = useStore((s) => s.pushToast)

  const [plan, setPlan] = useState<PlanApproval | null>(null)
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  const [acExpanded, setAcExpanded] = useState(false)
  /** F6.2：被用户取消勾选的计划项 id（默认全选 → 空集；未勾选项由主进程级联 cancelled） */
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  /** F6.2：行内改题（rowId → 新标题），只存实际改过的项（批准时合并进图并记 Revision） */
  const [edits, setEdits] = useState<Record<string, string>>({})
  /** F6.2：正在行内编辑的行 id 与输入草稿 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 竞态防护：只有最后一次请求的结果才允许落状态 */
  const reqSeq = useRef(0)

  const toast = useCallback(
    (message: string, type: 'success' | 'danger' = 'success') => {
      try {
        pushToast?.({ type, message, duration: type === 'danger' ? 4000 : 2000 })
      } catch {
        /* toast 失败不影响主流程 */
      }
    },
    [pushToast],
  )

  /** 拉一次闸门态 + 快照（快照提供 goal / scope / rows / AC 明细） */
  const load = useCallback(async () => {
    if (!taskId) {
      setPlan(null)
      setSnapshot(null)
      return
    }
    const seq = ++reqSeq.current
    try {
      const [p, snap] = await Promise.all([
        window.ark.graph.pendingPlan(taskId),
        window.ark.graph.snapshot(taskId),
      ])
      if (seq !== reqSeq.current) return // 已被更新的请求取代
      setPlan(p)
      setSnapshot(snap.ok ? snap.data : null)
    } catch {
      if (seq !== reqSeq.current) return
      setPlan(null)
      setSnapshot(null)
    }
  }, [taskId])

  useEffect(() => {
    void load()
  }, [load])

  // 订阅增量刷新：只在属于本任务的 plan 闸门事件时刷新（避免执行期高频刷新）
  useEffect(() => {
    if (!taskId) return
    const off = window.ark.graph.onUpdate((payload) => {
      if (payload.taskId !== taskId) return
      if (payload.kind !== 'plan') return
      void load()
    })
    return off
  }, [taskId, load])

  const decide = useCallback(
    async (
      decision: 'approve' | 'reject' | 'edit',
      extra?: {
        userNote?: string
        markdown?: string
        /** F6.2：勾选的结构行节点 id；缺省 = 全部（主进程兜底） */
        approvedItemIds?: string[]
        /** F6.2：行内改题（合并进图并记 Revision） */
        nodeEdits?: { id: string; title: string }[]
        /** F6.2：批准后是否放行执行；false = 仅保留计划不执行 */
        startExecution?: boolean
      },
    ) => {
      if (!taskId) return
      setBusy(true)
      try {
        const res = await window.ark.graph.decidePlan({ taskId, decision, ...extra })
        if (!res.ok) {
          // 失败不关卡片、不丢输入（与 P3/P4/P5 的约定一致）
          toast(res.error.message || t('taskPanel.planApproval.failed'), 'danger')
          return
        }
        setRejectOpen(false)
        setRejectNote('')
        await load()
      } catch (e) {
        toast((e as Error).message || t('taskPanel.planApproval.failed'), 'danger')
      } finally {
        setBusy(false)
      }
    },
    [taskId, load, toast, t],
  )

  /** F6.2：行内编辑提交（Enter/失焦）。用函数式更新防竞态：Esc 已把 editingId 置空后，
   *  紧随的 blur 会看到 cur===null 而 no-op（取消不丢已确认的历史修改） */
  const commitEdit = useCallback(() => {
    setEditingId((cur) => {
      if (cur === null) return null
      const trimmed = draft.trim()
      setEdits((prev) => {
        const next = { ...prev }
        if (trimmed) next[cur] = trimmed
        else delete next[cur]
        return next
      })
      return null
    })
    setDraft('')
  }, [draft])

  /** v0.38.1（D173）：降级错误卡手动关闭（唯一出口；正常待批准闸门不走此通道）。
   *  缺陷背景：降级闸门登记于建图前（无 graphId），终态清理对其失效 → 卡片常驻。 */
  const dismissDegraded = useCallback(async () => {
    if (!taskId) return
    setBusy(true)
    try {
      const res = await window.ark.graph.dismissPlanDegraded(taskId)
      if (!res.ok) {
        toast(res.error.message || t('taskPanel.planApproval.failed'), 'danger')
        return
      }
      setPlan(null) // 闸门已删 → 直接卸载卡片（无需再 load）
    } catch (e) {
      toast((e as Error).message || t('taskPanel.planApproval.failed'), 'danger')
    } finally {
      setBusy(false)
    }
  }, [taskId, toast, t])

  /** 结构摘要：优先里程碑；无里程碑时退回 task 层（与交互文档「milestone/task 摘要」一致） */
  const structureRows = useMemo(() => {
    if (!snapshot) return []
    const milestones = snapshot.rows.filter((r) => r.layer === 'milestone')
    const tasks = snapshot.rows.filter((r) => r.layer === 'task')
    return milestones.length > 0 ? milestones : tasks
  }, [snapshot])

  /** F6.2：勾选态派生 —— 未勾选项外的结构行 id；零勾选时禁用批准（主进程亦有 SCHEMA_INVALID 兜底） */
  const checkedIds = useMemo(
    () => structureRows.filter((r) => !excluded.has(r.id)).map((r) => r.id),
    [structureRows, excluded],
  )
  const noneChecked = structureRows.length > 0 && checkedIds.length === 0
  /** F6.2：行内改题合并为 IPC 载荷（只含实际改过的项） */
  const nodeEdits = useMemo(
    () => Object.entries(edits).map(([id, title]) => ({ id, title })),
    [edits],
  )
  /** F6.2：仅在用户动过勾选时才传 approvedItemIds —— 缺省时主进程按全选兜底，保持旧行为零变化 */
  const approveExtra = useMemo(
    () => ({
      ...(excluded.size > 0 && structureRows.length > 0 ? { approvedItemIds: checkedIds } : {}),
      ...(nodeEdits.length > 0 ? { nodeEdits } : {}),
    }),
    [excluded.size, structureRows.length, checkedIds, nodeEdits],
  )

  /** F6.2：闸门轮换（新任务 / 打回后重新规划）时重置勾选与行内编辑，避免上一轮选择串到下一轮 */
  const planState = plan?.state
  useEffect(() => {
    setExcluded(new Set())
    setEdits({})
    setEditingId(null)
    setDraft('')
  }, [taskId, planState])

  // 空态 Tier 0：无闸门 → 不渲染卡片（直接执行）
  if (!taskId || !plan) return null

  const goal = snapshot?.goal ?? ''
  const scopeIn = snapshot?.spec.scopeIn ?? []
  const scopeOut = snapshot?.spec.scopeOut ?? []
  const acceptance = snapshot?.spec.acceptance ?? []
  const uncovered = plan.uncovered ?? []
  const coverageOk = uncovered.length === 0
  const coverageMissingText = t('taskPanel.planApproval.coverageMissing', { ids: uncovered.join('、') })

  /* ---- 成功态：折叠为一行，保留在对话流中 ---- */
  if (plan.state === 'approved') {
    const taskCount = structureRows.length || (snapshot?.counts?.total ?? 0)
    // F6.2：走了勾选/改题路径时显示「已批准 N/M 项」；旧路径（无 approvedItemIds）保持原折叠文案
    const approvedN = plan.approvedItemIds?.length
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border-default bg-bg-surface px-4 py-3 text-sm text-text-secondary">
        <span className="shrink-0 text-success" aria-hidden>
          ✓
        </span>
        <span>
          {approvedN !== undefined
            ? t('taskPanel.planApproval.approvedSelectedFold', {
                approved: approvedN,
                total: taskCount,
                acs: acceptance.length,
              })
            : t('taskPanel.planApproval.approvedFold', { tasks: taskCount, acs: acceptance.length })}
        </span>
      </div>
    )
  }

  /* ---- 打回态：折叠为一行 + 用户意见 ---- */
  if (plan.state === 'rejected') {
    return (
      <div className="rounded-lg border border-border-default bg-bg-surface px-4 py-3 text-sm text-text-secondary">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-warning" aria-hidden>
            ↩
          </span>
          <span>{t('taskPanel.planApproval.rejectedFold')}</span>
        </div>
        {plan.userNote && (
          <div className="mt-1 pl-6 text-xs text-text-tertiary">
            {t('taskPanel.planApproval.rejectedNote', { note: plan.userNote })}
          </div>
        )}
      </div>
    )
  }

  /* ---- 错误态：规划失败已降级（原型 error 态） ---- */
  if (plan.degraded) {
    const noop = () => {}
    return (
      <div className="overflow-hidden rounded-xl border border-border-strong bg-bg-surface shadow-lg">
        <div className="flex items-start gap-2 border-b border-border-default bg-warning-soft px-5 py-3 text-xs leading-[18px]">
          <span aria-hidden>⚠</span>
          <span className="min-w-0">{t('taskPanel.planApproval.errorBanner')}</span>
        </div>
        <header className="flex items-center gap-2 border-b border-border-default px-5 py-4">
          <span className="shrink-0 text-lg text-warning" aria-hidden>
            ✦
          </span>
          <h3 className="min-w-0 truncate text-base font-semibold">
            {t('taskPanel.planApproval.errorTitle')}
          </h3>
          {/* v0.38.1（D173）：手动关闭出口 —— 此卡此前既不可点也不可关，常驻对话流 */}
          <button
            type="button"
            onClick={() => void dismissDegraded()}
            disabled={busy}
            title={t('taskPanel.planApproval.dismissDegraded')}
            aria-label={t('taskPanel.planApproval.dismissDegraded')}
            className="ml-auto shrink-0 rounded-md px-2 py-1 text-sm leading-none text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-4">
          <p className="mb-4 text-sm leading-5 text-text-secondary">
            {t('taskPanel.planApproval.errorBody')}
          </p>
          <div className="mb-2 flex items-center gap-2 text-2xs uppercase tracking-wide text-text-tertiary">
            {t('taskPanel.planApproval.degradeSection')}
            <span className="h-px flex-1 bg-border-subtle" aria-hidden />
          </div>
          <div className="font-mono text-xs leading-[22px] text-text-tertiary">
            <div>{t('taskPanel.planApproval.degradeTier1')}</div>
            <div>{t('taskPanel.planApproval.degradeTier2')}</div>
            <div>{t('taskPanel.planApproval.degradeTier3')}</div>
          </div>
          <div className="mt-4 rounded-md border border-warning bg-warning-soft px-3 py-3 text-xs leading-[18px] text-text-secondary">
            {t('taskPanel.planApproval.degradeNote')}
          </div>
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-border-default bg-bg-surface-2 px-5 py-4">
          <CardButton disabled title={t('taskPanel.planApproval.retryPlanHint')} onClick={noop}>
            {t('taskPanel.planApproval.retryPlan')}
          </CardButton>
          <CardButton disabled title={t('taskPanel.planApproval.acceptDegradedHint')} onClick={noop}>
            {t('taskPanel.planApproval.acceptDegraded')}
          </CardButton>
          <span className="ml-auto text-2xs text-text-tertiary">
            {t('taskPanel.planApproval.degradedEntryNote')}
          </span>
        </footer>
      </div>
    )
  }

  /* ---- 加载态：正在生成计划 ---- */
  if (plan.state === 'generating') {
    const sk = 'mb-3 h-3 rounded-sm bg-bg-surface-2'
    const noop = () => {}
    return (
      <div className="overflow-hidden rounded-xl border border-border-strong bg-bg-surface shadow-lg">
        <header className="flex items-center gap-2 border-b border-border-default px-5 py-4">
          <span className="shrink-0 text-lg text-text-tertiary" aria-hidden>
            ✦
          </span>
          <h3 className="text-lg font-semibold">{t('taskPanel.planApproval.generatingTitle')}</h3>
        </header>
        <div className="px-5 py-4">
          <div className={`${sk} w-[36%]`} />
          <div className={`${sk} w-[92%]`} />
          <div className={`${sk} w-[78%]`} />
          <div className={`${sk} mt-4 w-[36%]`} />
          <div className={`${sk} w-[88%]`} />
          <div className={`${sk} w-[76%]`} />
          <div className="h-3 w-[82%] rounded-sm bg-bg-surface-2" />
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-border-default bg-bg-surface-2 px-5 py-4">
          <CardButton disabled onClick={noop}>
            {t('taskPanel.planApproval.editMarkdown')}
          </CardButton>
          <CardButton disabled onClick={noop}>
            {t('taskPanel.planApproval.reject')}
          </CardButton>
          <span className="ml-auto" />
          <CardButton disabled onClick={noop}>
            {t('taskPanel.planApproval.keepOnly')}
          </CardButton>
          <CardButton variant="primary" disabled onClick={noop}>
            {t('taskPanel.planApproval.approveSelected')}
          </CardButton>
        </footer>
      </div>
    )
  }

  /* ---- 默认态：等待批准 ---- */
  const tier = snapshot?.tier ?? 0
  const visibleAcs = acExpanded ? acceptance : acceptance.slice(0, AC_COLLAPSED)

  return (
    <div className="overflow-hidden rounded-xl border border-border-strong bg-bg-surface shadow-lg">
      <header className="flex items-center gap-2 border-b border-border-default px-5 py-4">
        <span className="shrink-0 text-lg text-accent" aria-hidden>
          ✦
        </span>
        <h3 className="min-w-0 truncate text-lg font-semibold">{t('taskPanel.planApproval.title')}</h3>

        {/* tier 徽章（v0.37.0 · D137：**只读**。档位判定权归模型与引擎，
            UI 不再提供升降级入口 —— 用户手改会与模型的自主判断打架，
            也让简单任务被仪式化。徽标 + title 仍让用户看到档位与判定理由。） */}
        {snapshot && (
          <span
            data-testid="plan-approval-tier-badge"
            data-tier={tier}
            title={snapshot.tierReason ?? tierLabel(tier, i18n.language)}
            className="ml-auto rounded-sm border border-transparent bg-info-soft px-2 py-0.5 text-2xs text-info"
          >
            {tierLabel(tier, i18n.language)}
          </span>
        )}
      </header>

      <div className="px-5 py-4">
        {/* 三行元信息：「不做」必须展示且不可折叠（防范围蔓延） */}
        <dl className="mb-4 grid grid-cols-[78px_1fr] gap-x-3 gap-y-1.5 text-sm leading-5">
          <dt className="pt-px text-xs text-text-tertiary">{t('taskPanel.planApproval.goal')}</dt>
          <dd className="text-text-primary">{goal}</dd>
          <dt className="pt-px text-xs text-text-tertiary">{t('taskPanel.planApproval.scopeIn')}</dt>
          <dd className="text-text-secondary">{scopeIn.join(' / ')}</dd>
          <dt className="pt-px text-xs text-text-tertiary">{t('taskPanel.planApproval.scopeOut')}</dt>
          <dd className="text-warning">{scopeOut.join('、')}</dd>
        </dl>

        {/* 任务结构 */}
        <div className="mb-2 flex items-center gap-2 text-2xs uppercase tracking-wide text-text-tertiary">
          {t('taskPanel.planApproval.nodesSection')} ({structureRows.length})
          <span className="h-px flex-1 bg-border-subtle" aria-hidden />
        </div>
        <div>
          {/* P10 空态：闸门内没有任何可勾选的结构项（里程碑/任务）→ 直接提示。
              刻意**不**禁用批准按钮 —— 「零结构项的退化图」在零 AC 时仍可批准执行（既有语义，
              见 main/ipc/graph.ts 的 approvedItemIds 缺省兜底），禁用会变成功能回归。 */}
          {structureRows.length === 0 && (
            <div className="rounded-md border border-border-subtle bg-bg-surface-2 px-3 py-2 text-xs leading-[18px] text-text-tertiary">
              {t('taskPanel.planApproval.itemsEmpty')}
            </div>
          )}
          {structureRows.slice(0, STRUCTURE_LIMIT).map((r) => {
            const on = !excluded.has(r.id)
            const edited = edits[r.id]
            return (
              <div
                key={r.id}
                className={`flex w-full items-center gap-3 rounded-sm px-1 py-0.5 text-sm leading-5 hover:bg-bg-surface-2 ${
                  on ? '' : 'opacity-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setExcluded((prev) => {
                      const next = new Set(prev)
                      if (checked) next.delete(r.id)
                      else next.add(r.id)
                      return next
                    })
                  }}
                  aria-label={t('taskPanel.planApproval.itemCheckbox')}
                  className="mt-0.5 shrink-0 accent-accent"
                />
                <span className="w-11 shrink-0 font-mono text-xs text-text-tertiary">
                  {r.key ?? r.id.slice(0, 4)}
                </span>
                {editingId === r.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => void commitEdit()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitEdit()
                      }
                      if (e.key === 'Escape') {
                        setEditingId(null)
                        setDraft('')
                      }
                    }}
                    className="min-w-0 flex-1 rounded-sm border border-accent bg-bg-surface-2 px-1 text-sm text-text-primary outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(r.id)
                      setDraft(edited ?? r.title)
                    }}
                    title={t('taskPanel.planApproval.editItemHint')}
                    className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-secondary hover:text-text-primary"
                  >
                    {edited ?? r.title}
                  </button>
                )}
                {edited !== undefined && edited !== r.title && (
                  <span className="shrink-0 rounded-sm bg-info-soft px-1 py-px text-2xs leading-none text-info">
                    {t('taskPanel.planApproval.editedBadge')}
                  </span>
                )}
                {editingId !== r.id && (
                  <span
                    className="h-[10px] min-w-[12px] flex-1 border-b border-dotted border-border-default"
                    aria-hidden
                  />
                )}
                {r.childCount > 0 && (
                  <span className="shrink-0 text-2xs text-text-tertiary">
                    {t('taskPanel.planApproval.nodeChildren', { n: r.childCount })}
                  </span>
                )}
              </div>
            )
          })}
          {structureRows.length > STRUCTURE_LIMIT && (
            <div className="px-1 pt-1 text-2xs text-text-tertiary">
              {t('taskPanel.planApproval.nodesMore', { n: structureRows.length - STRUCTURE_LIMIT })}
            </div>
          )}
        </div>

        {/* 验收条件 */}
        <div className="mb-2 mt-4 flex items-center gap-2 text-2xs uppercase tracking-wide text-text-tertiary">
          {t('taskPanel.planApproval.acSection')} ({acceptance.length})
          <span className="h-px flex-1 bg-border-subtle" aria-hidden />
          {acceptance.length > AC_COLLAPSED && (
            <button
              type="button"
              onClick={() => setAcExpanded((v) => !v)}
              className="text-2xs normal-case tracking-normal text-business-primary hover:underline"
            >
              {acExpanded ? t('taskPanel.planApproval.acCollapse') : t('taskPanel.planApproval.acExpand')}
            </button>
          )}
        </div>
        <div>
          {visibleAcs.map((ac) => {
            const meta = AC_META[ac.status]
            return (
              <div key={ac.id} className="flex items-start gap-2 py-0.5 text-sm leading-5">
                <span className={`shrink-0 ${meta.text}`} aria-label={meta.aria} title={meta.aria}>
                  {meta.glyph}
                </span>
                <span className="shrink-0 font-mono text-xs text-info">{ac.id}</span>
                <span className="min-w-0">
                  <div className="text-text-secondary">{ac.statement}</div>
                  {ac.verifyCommand && (
                    <div className="font-mono text-2xs text-text-tertiary">
                      {t('taskPanel.planApproval.verifyLabel')}: {ac.verifyCommand}
                    </div>
                  )}
                </span>
              </div>
            )
          })}
        </div>

        {/* 覆盖率检查（I7：非空则禁用批准） */}
        <div className={`mt-2 text-2xs ${coverageOk ? 'text-success' : 'text-danger'}`}>
          {coverageOk
            ? `✓ ${t('taskPanel.planApproval.coverageOk', { covered: acceptance.length, total: acceptance.length })}`
            : `${t('taskPanel.planApproval.coverageMissing', { ids: uncovered.join('、') })}`}
        </div>
      </div>

      {/* 打回输入框（意见作为 user message 注入给 Planner） */}
      {rejectOpen && (
        <div className="border-t border-border-default px-5 py-4">
          <label htmlFor="plan-reject-note" className="mb-2 block text-xs text-text-secondary">
            {t('taskPanel.planApproval.rejectReason')}
          </label>
          <textarea
            id="plan-reject-note"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
            placeholder={t('taskPanel.planApproval.rejectPlaceholder')}
            className="w-full resize-none rounded-md border border-border-default bg-bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <div className="mt-2 flex gap-2">
            <CardButton
              variant="danger"
              disabled={!rejectNote.trim() || busy}
              loading={busy}
              onClick={() => void decide('reject', { userNote: rejectNote.trim() })}
            >
              {t('taskPanel.planApproval.confirmReject')}
            </CardButton>
            <CardButton
              variant="ghost"
              onClick={() => {
                setRejectOpen(false)
                setRejectNote('')
              }}
            >
              {t('taskPanel.planApproval.cancel')}
            </CardButton>
          </div>
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border-default bg-bg-surface-2 px-5 py-4">
        <CardButton
          disabled
          title={t('taskPanel.planApproval.editMarkdownHint')}
          onClick={() => {}}
        >
          {t('taskPanel.planApproval.editMarkdown')}
          <span className="rounded-sm bg-bg-surface-2 px-1 py-px text-2xs leading-none text-text-tertiary">
            {t('taskPanel.planApproval.editMarkdownSoon')}
          </span>
        </CardButton>
        <CardButton onClick={() => setRejectOpen((v) => !v)}>
          {t('taskPanel.planApproval.reject')}
        </CardButton>
        <span className="ml-auto" />
        {/* F6.2：仅保留计划不执行 —— 批准（冻结 AC / 勾选收口）但不注入续跑消息 */}
        <CardButton
          disabled={!coverageOk || busy || noneChecked}
          title={
            noneChecked
              ? t('taskPanel.planApproval.approveNoneHint')
              : t('taskPanel.planApproval.keepOnlyHint')
          }
          onClick={() => void decide('approve', { ...approveExtra, startExecution: false })}
        >
          {t('taskPanel.planApproval.keepOnly')}
        </CardButton>
        {/* F6.2：批准所选并开始 —— 勾选子集 + 行内改题一并提交，随即放行执行 */}
        <CardButton
          variant="primary"
          disabled={!coverageOk || busy || noneChecked}
          loading={busy}
          title={
            noneChecked
              ? t('taskPanel.planApproval.approveNoneHint')
              : coverageOk
                ? undefined
                : coverageMissingText
          }
          onClick={() => void decide('approve', { ...approveExtra, startExecution: true })}
        >
          {t('taskPanel.planApproval.approveSelected')}
        </CardButton>
      </footer>
    </div>
  )
}
