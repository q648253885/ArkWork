/**
 * ArkWork — 任务面板 · 三个动作卡片（ActionCards）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P3 / §P4 / §P5
 *       prototype/page-03-needs-human.html · page-04-replan.html · page-05-converge.html
 *
 * ★ **文件合并说明**：设计文档 §P3/P4/P5 是三个独立页面，实现上合并为一个文件。
 *   理由：三者共用同一套"模态卡片"骨架（标题行 + 分区 + 底部出口按钮）与同一套
 *   错误呈现约定（**失败不关卡片、不丢用户输入**）。拆成三个文件会有三份重复骨架，
 *   而它们的差异只在"分区内容"。卡片之间的边界由导出的三个具名组件保持清晰。
 *
 * 三条硬要求（缺一即视为未完成）：
 *  1. Replan 卡**必须展示三件事**：为什么 / 改了什么 / 代价是什么（设计稿 §4.3 原话：
 *     "缺一个用户就不敢点接受"）。
 *  2. needs_human 卡**必须给选项**（把开放式问题变成选择题），且允许"跳过先做别的"。
 *  3. 任何提交失败**不关闭卡片**（防止用户白填），并在卡片顶部显示红条 + 重试入口。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import type {
  DriftReport,
  GraphNotice,
  GraphWriteError,
  ReplanOp,
  ReplanPatch,
  TaskNode,
} from '@shared/types/ipc'
import { AC_META, formatWaiting } from './graphMeta'

/* ============================================================
 * 共用骨架
 * ============================================================ */

function ModalShell({
  icon,
  iconClass,
  title,
  badge,
  error,
  children,
  footer,
  width = 560,
}: {
  icon: string
  iconClass: string
  title: string
  badge?: React.ReactNode
  /** 结构化错误（失败不关卡片） */
  error?: GraphWriteError | null
  children: React.ReactNode
  footer: React.ReactNode
  width?: number
}) {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-0 z-[50] flex items-center justify-center bg-black/35 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[86vh] flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-surface shadow-lg"
        style={{ width }}
      >
        {error && (
          <div className="flex shrink-0 items-start gap-2 border-b border-border-default bg-danger-soft px-5 py-3 text-xs leading-[18px]">
            <span aria-hidden>⚠</span>
            <span className="min-w-0">
              <strong className="block">{error.message}</strong>
              <span className="text-text-secondary">{error.hint}</span>
              {error.invariant && <span className="ml-1 opacity-70">({error.invariant})</span>}
            </span>
          </div>
        )}
        <header className="flex shrink-0 items-center gap-2 border-b border-border-default px-5 py-4">
          <span className={`shrink-0 text-lg ${iconClass}`} aria-hidden>
            {icon}
          </span>
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          {badge && <span className="ml-auto shrink-0">{badge}</span>}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-default bg-bg-surface-2 px-5 py-4">
          {footer}
        </footer>
        <span className="sr-only">{t('taskPanel.cardHint')}</span>
      </div>
    </div>
  )
}

/** 按钮的四级（主 / 次 / 文字 / 危险）—— 全面板统一，避免各卡片各写一套 */
export function CardButton({
  variant = 'secondary',
  disabled,
  loading,
  onClick,
  children,
  title,
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  disabled?: boolean
  loading?: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}) {
  const cls: Record<string, string> = {
    primary: 'bg-accent text-white border-accent hover:brightness-110 font-medium',
    secondary: 'bg-bg-surface-3 text-text-primary border-border-default hover:bg-bg-overlay-l4',
    ghost: 'bg-transparent text-text-secondary border-transparent hover:bg-bg-surface-2',
    danger: 'bg-transparent text-danger border-border-default hover:bg-danger-soft',
  }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${cls[variant]}`}
    >
      {loading && <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />}
      {children}
    </button>
  )
}

/** 分区标题（为什么 / 改了什么 / 代价是什么） */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-2 flex items-center gap-2 text-2xs uppercase tracking-wide text-text-tertiary">
        {title}
        <span className="h-px flex-1 bg-border-subtle" aria-hidden />
      </h3>
      {children}
    </section>
  )
}

/** 卡片内的通用错误位（提交失败时把结构化错误显示在骨架顶部） */
function useCardErrorNode(err: GraphWriteError | null): GraphWriteError | null {
  return err
}

/* ============================================================
 * P3 · needs_human 待答卡片
 * ============================================================ */

export interface NeedsHumanCardProps {
  node: TaskNode
  onSubmit: (p: { nodeId: string; action: 'submit'; answer: string; note?: string }) => Promise<boolean>
  onSkip: (p: { nodeId: string; action: 'skip' }) => Promise<boolean>
  onCancelAll: (p: { nodeId: string; action: 'cancel-all' }) => Promise<boolean>
  onClose: () => void
  error?: GraphWriteError | null
  /** 是否还有其他待答节点（提交成功后自动聚焦下一个） */
  hasNext?: boolean
}

export function NeedsHumanCard({
  node,
  onSubmit,
  onSkip,
  onCancelAll,
  onClose,
  error,
  hasNext,
}: NeedsHumanCardProps) {
  const { t } = useTranslation()
  const [optionIdx, setOptionIdx] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'idle' | 'submit' | 'cancel'>('idle')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [done, setDone] = useState(false)

  // 等待时长实时递增（每 10s 由 TaskPanel 的 tick 驱动；此处只算差值）
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => forceTick((v) => v + 1), 10_000)
    return () => window.clearInterval(id)
  }, [])

  const options = node.blockingOptions ?? []
  const canSubmit = optionIdx !== null || custom.trim().length > 0
  const waiting = node.blockingSince ? formatWaiting(Date.now() - node.blockingSince) : ''

  const doSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy('submit')
    const answer = optionIdx !== null ? (options[optionIdx]?.label ?? '') : custom.trim()
    const okDone = await onSubmit({ nodeId: node.id, action: 'submit', answer, note: note.trim() || undefined })
    setBusy('idle')
    if (okDone) {
      setDone(true)
      // 成功态：短暂展示结果后关闭（若有下一个待答节点，面板会自动聚焦它）
      window.setTimeout(onClose, 900)
    }
  }

  if (done) {
    return (
      <ModalShell
        icon="✓"
        iconClass="text-success"
        title={t('taskPanel.answerSubmitted')}
        width={420}
        footer={
          <>
            <span className="text-xs text-text-secondary">
              {hasNext ? t('taskPanel.focusNext') : t('taskPanel.resumeAgent')}
            </span>
            <span className="ml-auto" />
            <CardButton variant="primary" onClick={onClose}>
              {t('taskPanel.ok')}
            </CardButton>
          </>
        }
      >
        <p className="text-sm leading-5 text-text-secondary">
          {t('taskPanel.answerWritten', { key: node.key ?? node.id })}
        </p>
        <p className="mt-2 text-2xs text-text-tertiary">{t('taskPanel.answerEvidenceNote')}</p>
      </ModalShell>
    )
  }

  return (
    <ModalShell
      icon="⊗"
      iconClass="text-danger"
      width={520}
      title={t('taskPanel.needsHumanTitle', { key: node.key ?? node.id })}
      error={useCardErrorNode(error ?? null)}
      badge={
        waiting && (
          <span className="rounded-full border border-warning bg-warning-soft px-2 py-0.5 text-2xs tabular-nums text-warning">
            {t('taskPanel.waiting', { time: waiting })}
          </span>
        )
      }
      footer={
        <>
          <CardButton
            onClick={async () => {
              setBusy('submit')
              await onSkip({ nodeId: node.id, action: 'skip' })
              setBusy('idle')
              onClose()
            }}
          >
            {t('taskPanel.skipThis')}
          </CardButton>
          <CardButton
            variant="danger"
            onClick={async () => {
              if (!confirmCancel) {
                setConfirmCancel(true)
                return
              }
              setBusy('cancel')
              await onCancelAll({ nodeId: node.id, action: 'cancel-all' })
              setBusy('idle')
              onClose()
            }}
            title={confirmCancel ? t('taskPanel.cancelAllConfirmHint') : undefined}
          >
            {confirmCancel ? t('taskPanel.cancelAllConfirm') : t('taskPanel.cancelAll')}
          </CardButton>
          <span className="ml-auto" />
          <CardButton variant="primary" disabled={!canSubmit} loading={busy === 'submit'} onClick={() => void doSubmit()}>
            {busy === 'submit' ? t('taskPanel.submitting') : t('taskPanel.submitAnswer')}
          </CardButton>
        </>
      }
    >
      <p className="mb-4 whitespace-pre-wrap text-base font-medium leading-[22px]">{node.blockingQuestion}</p>

      {/* 选项（把开放式问题变成选择题 —— 大幅降低回答成本） */}
      {options.length > 0 && (
        <ul className="mb-4">
          {options.map((o, i) => (
            <li key={`${o.label}-${i}`}>
              <button
                type="button"
                onClick={() => {
                  setOptionIdx(i)
                  setCustom('') // 与自定义回答互斥
                }}
                className={`mb-2 flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  optionIdx === i
                    ? 'border-accent bg-accent-soft'
                    : 'border-border-default hover:bg-bg-surface-2'
                }`}
              >
                <span
                  className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-[1.5px] ${
                    optionIdx === i ? 'border-accent' : 'border-border-strong'
                  }`}
                  aria-hidden
                >
                  {optionIdx === i && (
                    <span className="m-[3px] block h-2 w-2 rounded-full bg-accent" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-base leading-5">{o.label}</span>
                  {o.description && (
                    <span className="mt-0.5 block text-xs leading-[18px] text-text-tertiary">
                      {o.description}
                    </span>
                  )}
                </span>
                <span className="ml-auto shrink-0 font-mono text-2xs text-text-tertiary">{i + 1}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="mb-2 block text-xs text-text-tertiary">{t('taskPanel.customAnswer')}</label>
      <textarea
        value={custom}
        disabled={busy !== 'idle'}
        onChange={(e) => {
          setCustom(e.target.value)
          setOptionIdx(null) // 与选项互斥
        }}
        placeholder={t('taskPanel.customAnswerPlaceholder')}
        className="mb-4 min-h-[64px] w-full resize-y rounded-md border border-border-default bg-bg-surface-2 px-3 py-2 text-sm leading-5 text-text-primary outline-none focus:border-accent"
      />

      <label className="mb-2 block text-xs text-text-tertiary">{t('taskPanel.optionalNote')}</label>
      <input
        type="text"
        value={note}
        disabled={busy !== 'idle'}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t('taskPanel.optionalNotePlaceholder')}
        className="w-full rounded-md border border-border-default bg-bg-surface-2 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
      />
    </ModalShell>
  )
}

/* ============================================================
 * P4 · Replan 通知卡
 * ============================================================ */

/** op 的视觉：+ 新增 / ~ 更新 / − 删除 / ⊘ 作废 / ⇅ 重排 */
const OP_META: Record<ReplanOp['op'], { glyph: string; cls: string; badge: string }> = {
  add: { glyph: '+', cls: 'text-success', badge: 'border-success text-success' },
  update: { glyph: '~', cls: 'text-info', badge: 'border-info text-info' },
  remove: { glyph: '−', cls: 'text-danger', badge: 'border-danger text-danger' },
  relink: { glyph: '⇄', cls: 'text-info', badge: 'border-info text-info' },
  reorder: { glyph: '⇅', cls: 'text-text-tertiary', badge: 'border-border-default text-text-tertiary' },
}

export interface ReplanCardProps {
  patch: ReplanPatch
  /** 节点 id → `T-03 标题`（渲染 diff 文案用） */
  labelOf: (id: string) => string
  onAccept: () => Promise<boolean>
  onReject: (userNote?: string) => Promise<boolean>
  onEdit: () => void
  onViewDiff: () => void
  onClose: () => void
  error?: GraphWriteError | null
}

export function ReplanCard({
  patch,
  labelOf,
  onAccept,
  onReject,
  onEdit,
  onViewDiff,
  onClose,
  error,
}: ReplanCardProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<'idle' | 'accept'>('idle')
  const [rejecting, setRejecting] = useState(false)
  const [rejectNote, setRejectNote] = useState('')

  // 第 4 级（禁止）：不显示「接受」，只留「发起 Spec 修订」
  if (patch.approvalLevel === 4) {
    return (
      <ModalShell
        icon="🚫"
        iconClass="text-danger"
        title={t('taskPanel.replanForbiddenTitle')}
        width={520}
        footer={
          <>
            <CardButton onClick={onClose}>{t('taskPanel.later')}</CardButton>
            <span className="ml-auto" />
            <CardButton variant="primary" onClick={onEdit}>
              {t('taskPanel.startSpecRevision')}
            </CardButton>
          </>
        }
      >
        <p className="mb-2 text-base">{t('taskPanel.replanForbiddenBody')}</p>
        <p className="text-xs leading-[18px] text-text-tertiary">{t('taskPanel.replanForbiddenWhy')}</p>
      </ModalShell>
    )
  }

  const invalidated = patch.impact.invalidatedTasks
  const heavy = invalidated.length > 3

  return (
    <ModalShell
      icon="⚠"
      iconClass="text-warning"
      title={t('taskPanel.replanTitle')}
      error={error ?? null}
      badge={
        <span className="rounded-sm bg-warning-soft px-2 py-0.5 text-2xs text-warning">
          {t('taskPanel.replanTrigger', { event: patch.triggerEvent })}
        </span>
      }
      footer={
        <>
          <CardButton onClick={onViewDiff}>{t('taskPanel.viewFullDiff')}</CardButton>
          <CardButton onClick={onEdit}>{t('taskPanel.editMyself')}</CardButton>
          <CardButton onClick={() => setRejecting(true)} disabled={busy !== 'idle'}>
            {t('taskPanel.reject')}
          </CardButton>
          <span className="ml-auto" />
          <CardButton
            variant="primary"
            loading={busy === 'accept'}
            onClick={async () => {
              setBusy('accept')
              const okDone = await onAccept()
              setBusy('idle')
              if (okDone) onClose()
            }}
          >
            {t('taskPanel.accept')}
          </CardButton>
        </>
      }
    >
      {heavy && (
        <p className="mb-4 rounded-md border border-warning bg-warning-soft px-3 py-2 text-xs leading-[18px]">
          {t('taskPanel.replanHeavyWarning', { n: invalidated.length })}
        </p>
      )}

      {/* ① 为什么 */}
      <Section title={t('taskPanel.whyTitle')}>
        <p className="whitespace-pre-wrap text-sm leading-5 text-text-secondary">{patch.reason}</p>
      </Section>

      {/* ② 改了什么 */}
      <Section title={t('taskPanel.whatChanged')}>
        <ul>
          {patch.ops.map((op, i) => {
            const m = OP_META[op.op]
            const text =
              op.op === 'add'
                ? `${op.node.key ? `${op.node.key} ` : ''}${op.node.title}`
                : op.op === 'remove'
                  ? `${labelOf(op.id)}（${op.reason}）`
                  : op.op === 'update'
                    ? `${labelOf(op.id)} → ${Object.keys(op.patch).join(' / ')}`
                    : op.op === 'relink'
                      ? `${labelOf(op.id)} 依赖改为 ${op.dependsOn.map(labelOf).join(', ') || t('taskPanel.none')}`
                      : `${t('taskPanel.reorder')}: ${op.ids.map(labelOf).join(' → ')}`
            return (
              <li key={i} className="flex items-center gap-3 rounded-sm px-2 py-1.5 text-sm leading-5">
                <span className={`w-3.5 shrink-0 text-center font-mono ${m.cls}`} aria-hidden>
                  {m.glyph}
                </span>
                <span className="min-w-0 flex-1 truncate" title={text}>
                  {text}
                </span>
                <span className={`shrink-0 rounded-sm border px-1.5 text-2xs ${m.badge}`}>
                  {t(`taskPanel.op.${op.op}` as never)}
                </span>
              </li>
            )
          })}
        </ul>
      </Section>

      {/* ③ 代价是什么 */}
      <Section title={t('taskPanel.costTitle')}>
        <dl className="flex flex-col gap-1.5 text-sm leading-5">
          <div className={`flex gap-3 ${invalidated.length ? 'text-warning' : ''}`}>
            <dt className="w-[130px] shrink-0 pt-0.5 text-xs text-text-tertiary">
              {t('taskPanel.costInvalidated')}
            </dt>
            <dd className="min-w-0">
              {invalidated.length === 0
                ? t('taskPanel.costNone')
                : t('taskPanel.costInvalidatedValue', {
                    n: invalidated.length,
                    list: invalidated.map(labelOf).join(', '),
                  })}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-[130px] shrink-0 pt-0.5 text-xs text-text-tertiary">
              {t('taskPanel.costAcs')}
            </dt>
            <dd className="min-w-0">
              {patch.impact.affectedACs.length === 0
                ? t('taskPanel.costNone')
                : patch.impact.affectedACs.join(', ')}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-[130px] shrink-0 pt-0.5 text-xs text-text-tertiary">
              {t('taskPanel.costTokens')}
            </dt>
            <dd className="min-w-0">+{patch.impact.estimatedExtraTokens}</dd>
          </div>
        </dl>
        <p className="mt-4 rounded-md border border-accent bg-accent-soft px-3 py-2 text-2xs leading-[16px]">
          {t('taskPanel.atomicNote')}
        </p>
      </Section>

      {rejecting && (
        <div className="mt-4 rounded-md border border-border-default bg-bg-surface-2 p-3">
          <label className="mb-2 block text-xs text-text-tertiary">{t('taskPanel.rejectReason')}</label>
          <input
            type="text"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            className="mb-2 w-full rounded-md border border-border-default bg-bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <div className="flex gap-2">
            <CardButton
              onClick={async () => {
                await onReject(rejectNote.trim() || undefined)
                onClose()
              }}
            >
              {t('taskPanel.confirmReject')}
            </CardButton>
            <CardButton variant="ghost" onClick={() => setRejecting(false)}>
              {t('taskPanel.cancel')}
            </CardButton>
          </div>
        </div>
      )}
    </ModalShell>
  )
}

/* ============================================================
 * P5 · 收敛报告卡
 * ============================================================ */

export interface ConvergeCardProps {
  report: DriftReport
  /** 节点 id → 标签 */
  labelOf: (id: string) => string
  onAcceptAll: () => Promise<boolean>
  onAcceptSome: (indices: number[]) => Promise<boolean>
  onDismiss: () => Promise<boolean>
  onClose: () => void
  error?: GraphWriteError | null
}

export function ConvergeCard({
  report,
  labelOf,
  onAcceptAll,
  onAcceptSome,
  onDismiss,
  onClose,
  error,
}: ConvergeCardProps) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const passing = useMemo(
    () => report.acCoverage.filter((a) => a.status === 'passing' || a.status === 'waived').length,
    [report],
  )

  return (
    <ModalShell
      icon="⟳"
      iconClass="text-info"
      title={t('taskPanel.convergeTitle')}
      error={error ?? null}
      footer={
        <>
          <CardButton
            disabled={picked.size === 0 || busy}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              const okDone = await onAcceptSome([...picked])
              setBusy(false)
              if (okDone) onClose()
            }}
          >
            {t('taskPanel.addSelected', { n: picked.size })}
          </CardButton>
          <CardButton
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await onDismiss()
              setBusy(false)
              onClose()
            }}
          >
            {t('taskPanel.dismissMarked')}
          </CardButton>
          <span className="ml-auto" />
          <CardButton
            variant="primary"
            disabled={report.unmodeledWork.length === 0 || busy}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              const okDone = await onAcceptAll()
              setBusy(false)
              if (okDone) onClose()
            }}
          >
            {t('taskPanel.addAll')}
          </CardButton>
        </>
      }
    >
      {/* 验收覆盖 */}
      <Section title={t('taskPanel.convergeCoverage')}>
        <div className="flex items-center gap-2 text-sm">
          <span className={passing === report.acCoverage.length ? 'text-success' : 'text-warning'}>
            {passing === report.acCoverage.length ? '✓' : '⚠'}
          </span>
          <span className="tabular-nums">
            {passing}/{report.acCoverage.length}
          </span>
          <span className="text-xs text-text-tertiary">{t('taskPanel.convergeCoverageHint')}</span>
        </div>
        {report.acCoverage.length > 0 && (
          <ul className="mt-2">
            {report.acCoverage.map((a) => {
              const m = AC_META[a.status]
              return (
                <li key={a.acId} className="flex items-center gap-2 px-2 py-1 text-xs leading-[18px]">
                  <span className={`shrink-0 ${m.text}`} aria-hidden>
                    {m.glyph}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-text-tertiary">{a.acId}</span>
                  <span className="ml-auto shrink-0 text-2xs text-text-tertiary">
                    {a.coveredBy.map(labelOf).join(', ') || t('taskPanel.noCoverage')}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {/* 未建模工作（可勾选加入） */}
      <Section title={t('taskPanel.convergeUnmodeled', { n: report.unmodeledWork.length })}>
        {report.unmodeledWork.length === 0 ? (
          <p className="text-xs text-text-tertiary">{t('taskPanel.convergeNoUnmodeled')}</p>
        ) : (
          <ul>
            {report.unmodeledWork.map((w, i) => (
              <li key={i} className="mb-1 rounded-sm px-2 py-1.5 transition-colors hover:bg-bg-surface-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    onChange={(e) => {
                      setPicked((s) => {
                        const n = new Set(s)
                        if (e.target.checked) n.add(i)
                        else n.delete(i)
                        return n
                      })
                    }}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-5">{w.description}</span>
                    <span className="mt-0.5 block whitespace-pre-wrap font-mono text-2xs text-text-tertiary">
                      {w.evidence}
                    </span>
                  </span>
                  {w.dupOf && (
                    <span className="shrink-0 rounded-sm border border-warning px-1.5 text-2xs text-warning">
                      {t('taskPanel.suspectedDup', { key: labelOf(w.dupOf) })}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 失效假设（不改 AC —— 走 Spec 修订流程） */}
      <Section title={t('taskPanel.convergeAssumptions', { n: report.invalidAssumptions.length })}>
        {report.invalidAssumptions.length === 0 ? (
          <p className="text-xs text-text-tertiary">{t('taskPanel.convergeNoAssumptions')}</p>
        ) : (
          <ul>
            {report.invalidAssumptions.map((a) => (
              <li key={a.assumptionId} className="px-2 py-1.5 text-sm leading-5">
                <span className="block">{a.assumption}</span>
                <span className="mt-0.5 block text-2xs text-text-tertiary">
                  {t('taskPanel.contradictedBy')}: {a.contradictedBy}
                </span>
              </li>
            ))}
          </ul>
        )}
        {report.invalidAssumptions.length > 0 && (
          <p className="mt-2 rounded-md border border-warning bg-warning-soft px-3 py-2 text-2xs leading-[16px]">
            {t('taskPanel.assumptionNoAutoAc')}
          </p>
        )}
      </Section>

      {/* 僵尸任务 */}
      <Section title={t('taskPanel.convergeZombies', { n: report.zombieTasks.length })}>
        {report.zombieTasks.length === 0 ? (
          <p className="text-xs text-text-tertiary">{t('taskPanel.convergeNoZombies')}</p>
        ) : (
          <ul>
            {report.zombieTasks.map((z) => (
              <li key={z.taskId} className="px-2 py-1.5 text-sm leading-5">
                <span className="font-mono text-xs text-text-tertiary">{labelOf(z.taskId)}</span>
                <span className="ml-2">{z.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 能力降级（★ 必须与"检查过且干净"区分，否则等于谎报绿灯） */}
      {report.degraded && report.degraded.length > 0 && (
        <p className="mt-4 rounded-md border border-border-default bg-bg-surface-2 px-3 py-2 text-2xs leading-[16px] text-text-secondary">
          {t('taskPanel.convergeDegraded', { dims: report.degraded.join(', ') })}
        </p>
      )}
    </ModalShell>
  )
}

/* ============================================================
 * 通知条 → 卡片的打开映射
 * ============================================================ */

export type OpenedCard =
  | { kind: 'needs-human'; nodeId: string }
  | { kind: 'replan'; patchId: string }
  | { kind: 'converge' }

/**
 * 把通知条映射成"该开哪张卡"。
 *
 * 为什么集中在这里而不是让通知条自己决定：通知条是**无类型的摘要**
 * （只有 kind/refId），而卡片选择需要知道 refId 语义（是 nodeId 还是 patchId）。
 * 集中映射 + 返回 null 表示"只提示不开卡"（如 auto-applied），逻辑一目了然。
 */
export function noticeToCard(
  notice: GraphNotice,
  pendingPatches: ReplanPatch[],
): OpenedCard | null {
  switch (notice.kind) {
    case 'converge':
    case 'assumption':
      return { kind: 'converge' }
    case 'replan': {
      // needs_human 的通知条 refId 是 nodeId；Replan 的是 patchId
      const isPatch = pendingPatches.some((p) => p.id === notice.refId)
      if (isPatch && notice.refId) return { kind: 'replan', patchId: notice.refId }
      if (notice.refId) return { kind: 'needs-human', nodeId: notice.refId }
      return null
    }
    case 'external-mirror':
    case 'auto-applied':
    default:
      return null
  }
}
