/* ============================================================
 * ArkWork — 激活报告视图（v0.33.0 · 配置中心）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §9.1
 *           docs/versions/v0.33.0/03-interaction.md §「激活报告面板」
 *
 * 为什么要有这一屏：正本 02 §5 与 03 §6 都要求「说不清 current configuration」
 * 必须无处藏身。因此报告要同时回答三个问题：
 *   ① **过没过**（校验问题，error 阻断 / warning 不阻断）
 *   ② **哪几项没生效**（降级四要素：layer / ref / reason / blocking 逐条可见）
 *   ③ **实际装了什么**（快照五层：agents / tools / ui / data / auto）
 *
 * 复用纪律：本组件是**纯展示**（入参即数据），因此 ProfileSwitcher 的下拉、
 * ProfilesView 的抽屉、DiagnosticsView 的快照区三处都能直接复用同一实现。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import type {
  ActivationReport,
  CompositionSnapshot,
  Degradation,
  ValidationIssue,
} from '@shared/types/profile'

const SNAPSHOT_LAYERS = ['agents', 'tools', 'ui', 'data', 'auto'] as const

function layerKey(layer: string): string {
  switch (layer) {
    case 'agents':
    case 'tools':
    case 'ui':
    case 'data':
    case 'auto':
      return layer
    default:
      return 'unknown'
  }
}

/* ============================================================
 * 校验问题清单（V1–V6）
 * ============================================================ */
export function ValidationIssuesView({ issues }: { issues: ValidationIssue[] }) {
  const { t } = useTranslation()
  if (issues.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-success">
        <Icon.Check width={13} height={13} aria-hidden />
        <span>{t('workbench.report.noIssues')}</span>
      </div>
    )
  }
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.length - errors
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-2xs text-text-tertiary">
        <span className={errors > 0 ? 'text-danger' : 'text-text-tertiary'}>
          {t('workbench.report.errorCount', { count: errors })}
        </span>
        <span>·</span>
        <span className={warnings > 0 ? 'text-warning' : 'text-text-tertiary'}>
          {t('workbench.report.warningCount', { count: warnings })}
        </span>
      </div>
      <ul className="space-y-1">
        {issues.map((i, idx) => (
          <li
            key={`${i.rule}:${i.path}:${idx}`}
            className={`rounded-md border px-2.5 py-1.5 ${i.level === 'error' ? 'border-danger bg-danger-soft' : 'border-warning bg-warning-soft'}`}
          >
            <div className="flex items-start gap-1.5">
              <span className={`text-2xs font-mono flex-shrink-0 mt-px ${i.level === 'error' ? 'text-danger' : 'text-warning'}`}>
                {i.rule}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-text-primary break-words">{i.message}</div>
                <div className="text-2xs text-text-faint font-mono truncate" title={i.path}>
                  {i.path}
                </div>
                {i.fix && <div className="text-2xs text-text-secondary mt-0.5 break-words">{t('workbench.report.fixHint', { fix: i.fix })}</div>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ============================================================
 * 降级清单（四要素齐全 —— 缺任何一项都会让用户无法自救）
 * ============================================================ */
export function DegradedView({ degraded }: { degraded: Degradation[] }) {
  const { t } = useTranslation()
  if (degraded.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-success">
        <Icon.Check width={13} height={13} aria-hidden />
        <span>{t('workbench.report.noDegraded')}</span>
      </div>
    )
  }
  return (
    <ul className="space-y-1">
      {degraded.map((d, i) => (
        <li
          key={`${d.layer}:${d.ref}:${i}`}
          className={`rounded-md border px-2.5 py-1.5 ${d.blocking ? 'border-danger bg-danger-soft' : 'border-border-subtle bg-bg-surface'}`}
        >
          <div className="flex items-center gap-1.5 text-2xs">
            <span className={`rounded px-1 border leading-4 ${d.blocking ? 'border-danger text-danger' : 'border-border-default text-text-tertiary'}`}>
              {t(`profile.degraded.layer.${layerKey(d.layer)}`)}
            </span>
            <span className="font-mono text-text-secondary truncate" title={d.ref}>
              {d.ref}
            </span>
            <span className={`ml-auto flex-shrink-0 ${d.blocking ? 'text-danger' : 'text-text-faint'}`}>
              {d.blocking ? t('workbench.report.blocking') : t('workbench.report.nonBlocking')}
            </span>
          </div>
          <div className="text-xs text-text-tertiary mt-0.5 break-words">{d.reason}</div>
        </li>
      ))}
    </ul>
  )
}

/* ============================================================
 * 快照五层
 * ============================================================ */
export function SnapshotView({ snapshot }: { snapshot: CompositionSnapshot | null }) {
  const { t } = useTranslation()
  if (!snapshot) {
    return <div className="text-xs text-text-faint">{t('profile.report.none')}</div>
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-5 gap-1.5">
        {SNAPSHOT_LAYERS.map((layer) => (
          <div key={layer} className="rounded-md border border-border-subtle bg-bg-surface px-2 py-1.5 text-center">
            <div className="text-2xs text-text-tertiary truncate">{t(`profile.report.layer.${layer}`)}</div>
            <div className="text-sm text-text-primary font-mono tabular-nums">{snapshot.layers[layer].length}</div>
          </div>
        ))}
      </div>
      <div className="text-2xs text-text-faint">
        {t('profile.report.resolvedAt', { time: new Date(snapshot.resolvedAt).toLocaleString() })}
        {' · '}
        <span className="font-mono">{snapshot.profileId} v{snapshot.profileVersion}</span>
      </div>

      {snapshot.layers.ui.length > 0 && (
        <div>
          <div className="text-2xs text-text-tertiary mb-0.5">{t('profile.report.layer.ui')}</div>
          <ul className="space-y-0.5">
            {snapshot.layers.ui.map((u) => (
              <li key={u.slot} className="flex items-center gap-2 text-2xs">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${u.applied ? 'bg-success' : 'bg-text-faint'}`} aria-hidden />
                <span className="font-mono text-text-secondary">{u.slot}</span>
                <span className="text-text-faint truncate flex-1" title={u.value}>
                  {u.value || '—'}
                </span>
                {!u.applied && <span className="text-text-faint flex-shrink-0">{t('workbench.report.notApplied')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * 完整报告（三问答合一）
 * ============================================================ */
export function ActivationReportView({
  report,
  snapshot,
  degraded,
}: {
  report: ActivationReport | null
  snapshot: CompositionSnapshot | null
  degraded: Degradation[]
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <section>
        <div className="text-xs font-medium text-text-primary mb-1.5 flex items-center gap-1.5">
          {report?.ok ? (
            <Icon.Check width={13} height={13} className="text-success" aria-hidden />
          ) : (
            <Icon.Warning width={13} height={13} className="text-warning" aria-hidden />
          )}
          {t('workbench.report.section.validation')}
        </div>
        <ValidationIssuesView issues={report?.validation.issues ?? []} />
      </section>

      <section>
        <div className="text-xs font-medium text-text-primary mb-1.5">{t('workbench.report.section.degraded')}</div>
        <DegradedView degraded={degraded} />
      </section>

      <section>
        <div className="text-xs font-medium text-text-primary mb-1.5">{t('workbench.report.section.snapshot')}</div>
        <SnapshotView snapshot={snapshot} />
      </section>
    </div>
  )
}
