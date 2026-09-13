/**
 * ArkWork — P8 · Plan 审批卡（对话流内联卡）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P8
 *       docs/versions/v0.30.0/04-system-design.md §5.1
 *       prototype/page-08-plan-approval.html（已冻结的视觉基准）
 *
 * ★ 这是「规划 → 执行」的闸门：**不批准不执行**（三层确认闸门的第一层）。
 *   批准后 `SpecBlock.state = approved` + AC 冻结（不变量 I3 生效）。
 *
 * 三个出口（缺一即视为未完成）：
 *  1. `[批准执行]`   → `decidePlan({ decision:'approve' })`；AC 覆盖率不足时**禁用**（I7）；
 *  2. `[打回并说明]` → 内联输入框 → 意见作为 user message 注入对话流；
 *  3. `[编辑为 Markdown]` → 本版为只读占位（graph.md 编辑器与反向解析校验见 v0.30.1，
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
import type { GraphSnapshot, PlanApproval, Tier } from '@shared/types/ipc'
import { useStore } from '../../store'
import { CardButton } from './ActionCards'
import { AC_META } from './graphMeta'

/** 可覆盖的四档 Tier（与 TaskPanel 的升降级菜单一致） */
const TIERS: Tier[] = [0, 1, 2, 3]

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
  const [tierMenuOpen, setTierMenuOpen] = useState(false)
  const [acExpanded, setAcExpanded] = useState(false)
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
      extra?: { userNote?: string; markdown?: string },
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

  const overrideTier = useCallback(
    async (tier: Tier) => {
      if (!taskId) return
      setTierMenuOpen(false)
      try {
        const res = await window.ark.graph.setTier({ taskId, tier })
        if (!res.ok) {
          toast(res.error.message || t('taskPanel.planApproval.failed'), 'danger')
          return
        }
        await load()
        toast(t('taskPanel.planApproval.tierChanged', { tier: `T${tier}` }))
      } catch (e) {
        toast((e as Error).message || t('taskPanel.planApproval.failed'), 'danger')
      }
    },
    [taskId, load, toast, t],
  )

  /** 结构摘要：优先里程碑；无里程碑时退回 task 层（与交互文档「milestone/task 摘要」一致） */
  const structureRows = useMemo(() => {
    if (!snapshot) return []
    const milestones = snapshot.rows.filter((r) => r.layer === 'milestone')
    const tasks = snapshot.rows.filter((r) => r.layer === 'task')
    return milestones.length > 0 ? milestones : tasks
  }, [snapshot])

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
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border-default bg-bg-surface px-4 py-3 text-sm text-text-secondary">
        <span className="shrink-0 text-success" aria-hidden>
          ✓
        </span>
        <span>
          {t('taskPanel.planApproval.approvedFold', { tasks: taskCount, acs: acceptance.length })}
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
          <CardButton variant="primary" disabled onClick={noop}>
            {t('taskPanel.planApproval.approve')}
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

        {/* tier 徽章（可点升降级；覆盖记入 revisions 作为 few-shot） */}
        {snapshot && (
          <div className="relative ml-auto">
            <button
              type="button"
              onClick={() => setTierMenuOpen((v) => !v)}
              title={snapshot.tierReason ?? tierLabel(tier, i18n.language)}
              className="rounded-sm border border-transparent bg-info-soft px-2 py-0.5 text-2xs text-info hover:border-info"
            >
              {tierLabel(tier, i18n.language)} ⌄
            </button>
            {tierMenuOpen && (
              <ul className="absolute right-0 top-full z-[40] mt-1 w-[180px] rounded-md border border-border-default bg-bg-overlay py-1 shadow-md">
                {TIERS.map((ti) => (
                  <li key={ti}>
                    <button
                      type="button"
                      onClick={() => void overrideTier(ti)}
                      className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-bg-surface-2 ${
                        ti === tier ? 'text-accent' : 'text-text-primary'
                      }`}
                    >
                      {tierLabel(ti, i18n.language)}
                    </button>
                  </li>
                ))}
                <li className="border-t border-border-subtle px-3 py-1.5 text-2xs text-text-tertiary">
                  {t('taskPanel.planApproval.tierOverrideHint')}
                </li>
              </ul>
            )}
          </div>
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
          {structureRows.slice(0, STRUCTURE_LIMIT).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => toast(t('taskPanel.planApproval.nodeFocusHint'))}
              className="flex w-full items-center gap-3 rounded-sm px-1 py-0.5 text-left text-sm leading-5 hover:bg-bg-surface-2"
            >
              <span className="w-11 shrink-0 font-mono text-xs text-text-tertiary">
                {r.key ?? r.id.slice(0, 4)}
              </span>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text-secondary">
                {r.title}
              </span>
              <span
                className="h-[10px] min-w-[12px] flex-1 border-b border-dotted border-border-default"
                aria-hidden
              />
              {r.childCount > 0 && (
                <span className="shrink-0 text-2xs text-text-tertiary">
                  {t('taskPanel.planApproval.nodeChildren', { n: r.childCount })}
                </span>
              )}
            </button>
          ))}
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
        <CardButton
          variant="primary"
          disabled={!coverageOk || busy}
          loading={busy}
          title={coverageOk ? undefined : coverageMissingText}
          onClick={() => void decide('approve')}
        >
          {t('taskPanel.planApproval.approve')}
        </CardButton>
      </footer>
    </div>
  )
}
