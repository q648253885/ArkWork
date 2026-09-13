/**
 * ArkWork — 任务面板 · Evidence 查看器（EvidenceDrawer）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P2
 *       prototype/page-02-evidence.html（已冻结的视觉基准）
 *       agent-design-v1.0/06 §3.4「Evidence 查看器」
 *
 * 这个组件回答设计稿定义的第三个必答问题 —— **「凭什么说做完了？」**
 *
 * 关键设计（三条，改动前先读）：
 *  1. **证据可点击**：整行可点，跳到对应的终端输出 / diff / 测试报告。
 *     这让"凭什么说做完了"可以被**一键验证**，而不是只给一句"已完成"。
 *  2. **失效的证据不隐藏**，只标记失效 —— 证据链的完整性优先于界面整洁。
 *     缺失的证据本身就是信息（它说明某个产物被清理了）。
 *  3. **`diff` 类证据显式标注"仅证明改动，不证明正确"** —— 与不变量 I2 的口径一致，
 *     避免用户以为"有 diff 就等于做完了"。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import type { TaskNode } from '@shared/types/ipc'
import { AC_META, EVIDENCE_META, formatDuration, formatTokens, statusMeta } from './graphMeta'

export interface EvidenceDrawerProps {
  node: TaskNode
  /** 关闭抽屉 */
  onClose: () => void
  /** 点证据跳转（引擎侧只返回 ref，跳转目标由渲染层决定） */
  onOpenEvidence: (ref: string | undefined, kind: string) => void
  /** 查看该节点的修订时间线 */
  onOpenRevisions: () => void
  /** 本节点是否被收敛检查标记为僵尸 */
  zombie?: boolean
}

/** 证据类型 → 是否有"仅证明改动"的弱证据提示 */
function weakNote(kind: string): boolean {
  return kind === 'diff'
}

export function EvidenceDrawer({
  node,
  onClose,
  onOpenEvidence,
  onOpenRevisions,
  zombie,
}: EvidenceDrawerProps) {
  const { t } = useTranslation()
  const [showAllEvidence, setShowAllEvidence] = useState(false)
  const m = statusMeta(node.status)

  // 证据超过 10 条时默认只显示前 5 条（避免抽屉被淹没）
  const EVIDENCE_PREVIEW = 5
  const evidences = showAllEvidence ? node.evidence : node.evidence.slice(0, EVIDENCE_PREVIEW)
  const hasMore = node.evidence.length > EVIDENCE_PREVIEW

  return (
    <div className="fixed inset-0 z-[50] flex items-start justify-end bg-black/20" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={t('taskPanel.evidenceDrawerTitle')}
        onClick={(e) => e.stopPropagation()}
        className="mt-0 flex h-full w-[520px] max-w-full flex-col overflow-hidden border-l border-border-default bg-bg-surface shadow-lg"
      >
        {/* 标题区 */}
        <header className="flex shrink-0 items-center gap-2 border-b border-border-default px-4 py-3">
          <span className={`shrink-0 ${m.text}`} aria-hidden>
            {m.glyph}
          </span>
          <span className="min-w-0 flex-1 truncate text-lg font-semibold">
            {node.key ? `${node.key} ` : ''}
            {node.title}
          </span>
          <button
            type="button"
            aria-label={t('taskPanel.close')}
            onClick={onClose}
            className="shrink-0 text-text-tertiary hover:text-text-primary"
          >
            <Icon.X width={14} height={14} />
          </button>
        </header>

        {/* 元信息条 */}
        <div className="flex shrink-0 flex-wrap gap-3 border-b border-border-subtle px-4 py-2 text-2xs tabular-nums text-text-tertiary">
          <span>{t('taskPanel.layerLabel')} {node.layer}</span>
          <span>{formatTokens(node.tokensUsed) || '0'} tokens</span>
          <span>
            {t('taskPanel.attempts', { n: node.attempts, max: node.verification.maxAttempts })}
          </span>
          <span className={m.text}>{t(`taskPanel.status.${node.status}` as never)}</span>
          {node.verification.required && <span className="text-warning">{t('taskPanel.verifyRequired')}</span>}
        </div>

        {zombie && (
          <div className="shrink-0 border-b border-border-subtle bg-warning-soft px-4 py-2 text-xs leading-[18px]">
            {t('taskPanel.zombieWarning')}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {/* ---------------- 证据 ---------------- */}
          <section className="mb-5">
            <SectionTitle
              title={t('taskPanel.evidenceTitle')}
              count={node.evidence.length}
              extra={
                hasMore ? (
                  <button
                    type="button"
                    onClick={() => setShowAllEvidence((v) => !v)}
                    className="text-2xs text-business-primary hover:underline"
                  >
                    {showAllEvidence
                      ? t('taskPanel.collapse')
                      : t('taskPanel.expandAll', { n: node.evidence.length })}
                  </button>
                ) : undefined
              }
            />
            {node.evidence.length === 0 ? (
              <p className="py-3 text-xs leading-[18px] text-text-tertiary">
                {node.status === 'in_progress' || node.status === 'verifying'
                  ? t('taskPanel.evidenceEmptyRunning')
                  : t('taskPanel.evidenceEmpty')}
              </p>
            ) : (
              <ul>
                {evidences.map((e, i) => {
                  const meta = EVIDENCE_META[e.kind]
                  return (
                    <li key={`${e.kind}-${e.at}-${i}`}>
                      <button
                        type="button"
                        onClick={() => onOpenEvidence(e.ref, e.kind)}
                        className="flex w-full items-start gap-3 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-bg-surface-2"
                      >
                        <span className="shrink-0 text-base" aria-hidden>
                          {meta.icon}
                        </span>
                        <span className="shrink-0 pt-0.5 text-2xs text-text-tertiary">{meta.label}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm leading-5">{e.summary}</span>
                          <span className="block text-2xs text-text-tertiary">
                            {t('taskPanel.trust')}: {meta.trust} · {new Date(e.at).toLocaleTimeString()}
                            {weakNote(e.kind) ? ` · ${t('taskPanel.weakEvidence')}` : ''}
                          </span>
                          {e.ref && (
                            <span className="block truncate font-mono text-2xs text-text-tertiary">
                              {e.ref}
                            </span>
                          )}
                        </span>
                        {e.exitCode !== undefined && (
                          <span
                            className={`shrink-0 font-mono text-2xs ${
                              e.exitCode === 0 ? 'text-success' : 'text-danger'
                            }`}
                          >
                            exit {e.exitCode}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {!hasSufficient(node) && node.status === 'completed' && (
              <p className="mt-2 rounded-sm border border-warning bg-warning-soft px-2 py-1.5 text-2xs leading-[16px]">
                {t('taskPanel.insufficientEvidence')}
              </p>
            )}
          </section>

          {/* ---------------- 验收 ---------------- */}
          <section className="mb-5">
            <SectionTitle title={t('taskPanel.acceptanceTitle')} count={node.acceptance.length} />
            {node.acceptance.length === 0 ? (
              <p className="py-3 text-xs text-text-tertiary">{t('taskPanel.noAcceptance')}</p>
            ) : (
              <ul>
                {node.acceptance.map((ac) => {
                  const am = AC_META[ac.status]
                  return (
                    <li key={ac.id} className="flex items-start gap-2 rounded-sm px-2 py-1.5 text-sm leading-5">
                      <span className={`shrink-0 font-mono text-2xs ${am.text}`} aria-label={am.aria}>
                        {am.glyph}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-text-tertiary">{ac.id}</span>
                      <span className="min-w-0">
                        <span className="block">{ac.statement}</span>
                        {ac.verify?.command && (
                          <span className="block font-mono text-2xs text-text-tertiary">
                            {t('taskPanel.verifyCommand')}: {ac.verify.command}
                          </span>
                        )}
                        {ac.lastResult && (
                          <span className="block text-2xs text-text-tertiary">
                            {t('taskPanel.lastRun')}: exit {ac.lastResult.exitCode} ·{' '}
                            {new Date(ac.lastResult.at).toLocaleTimeString()}
                          </span>
                        )}
                      </span>
                      {ac.coveredBy.length > 0 && (
                        <span className="ml-auto shrink-0 text-2xs text-text-tertiary">
                          {t('taskPanel.coveredBy')}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* ---------------- 元信息 ---------------- */}
          <section>
            <SectionTitle
              title={t('taskPanel.metaTitle')}
              extra={
                <button
                  type="button"
                  onClick={onOpenRevisions}
                  className="text-2xs text-business-primary hover:underline"
                >
                  {t('taskPanel.revisions', { n: node.revision })} →
                </button>
              }
            />
            <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-sm leading-5">
              <Meta label={t('taskPanel.intent')} value={node.intent} />
              <Meta label={t('taskPanel.derivedFrom')} value={node.derivedFrom?.join(', ')} />
              <Meta
                label={t('taskPanel.dependsOn')}
                value={node.dependsOn.length ? node.dependsOn.join(', ') : undefined}
              />
              <Meta
                label={t('taskPanel.contextRefs')}
                value={node.contextRefs.map((r) => `${r.kind}:${r.ref}`).join(' · ')}
              />
              <Meta
                label={t('taskPanel.tokenBudget')}
                value={
                  node.tokenBudget
                    ? `${formatTokens(node.tokensUsed)} / ${formatTokens(node.tokenBudget)}`
                    : formatTokens(node.tokensUsed)
                }
              />
              {node.blockingQuestion && (
                <Meta label={t('taskPanel.blockingQuestion')} value={node.blockingQuestion} />
              )}
              {node.notes && <Meta label={t('taskPanel.notes')} value={node.notes} pre />}
              {node.lastError && <Meta label={t('taskPanel.lastError')} value={node.lastError} danger />}
            </dl>
          </section>
        </div>

        {/* 底部：等待时长（needs_human） */}
        {node.status === 'needs_human' && node.blockingSince && (
          <footer className="shrink-0 border-t border-border-default px-4 py-2 text-2xs text-warning">
            {t('taskPanel.waiting', { time: formatDuration(Date.now() - node.blockingSince) })}
          </footer>
        )}
      </aside>
    </div>
  )
}

/* ============================================================
 * 小组件
 * ============================================================ */

function SectionTitle({
  title,
  count,
  extra,
}: {
  title: string
  count?: number
  extra?: React.ReactNode
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-sm font-medium text-text-secondary">{title}</h3>
      {count !== undefined && <span className="text-2xs text-text-tertiary">({count})</span>}
      <span className="h-px flex-1 bg-border-subtle" aria-hidden />
      {extra}
    </div>
  )
}

function Meta({
  label,
  value,
  pre,
  danger,
}: {
  label: string
  value?: string
  pre?: boolean
  danger?: boolean
}) {
  if (!value) return null
  return (
    <>
      <dt className="pt-0.5 text-xs text-text-tertiary">{label}</dt>
      <dd
        className={[
          'min-w-0 break-words',
          pre ? 'whitespace-pre-wrap' : '',
          danger ? 'text-danger' : 'text-text-secondary',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </dd>
    </>
  )
}

/** 与不变量 I2 同口径的"是否有充分证据"（前端只做展示提示，判定以引擎为准） */
function hasSufficient(node: TaskNode): boolean {
  const TRUST: Record<string, number> = {
    human: 5,
    test: 4,
    command: 3,
    lsp: 3,
    diff: 2,
    artifact: 2,
    screenshot: 2,
  }
  return node.evidence.some((e) => (TRUST[e.kind] ?? 0) >= 3)
}
