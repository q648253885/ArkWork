/* ============================================================
 * ArkWork — BugfixResultCard (v0.14.0 Task 11.8)
 * 修复结果卡片：diff 摘要 + 测试输出 + 达成结论。
 * 由 BugfixIsland 在终态（achieved / not-achieved）时渲染。
 * ============================================================ */
import type { BugfixResultSummary } from '@shared/types/ipc'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'

const STATUS_META = {
  achieved: { label: 'bugfixresult.statusAchieved', tone: 'success' as const, icon: 'Check' as const },
  exhausted: { label: 'bugfixresult.statusExhausted', tone: 'danger' as const, icon: 'Stop' as const },
  failed: { label: 'bugfixresult.statusFailed', tone: 'danger' as const, icon: 'Stop' as const },
}

export function BugfixResultCard({ result }: { result: BugfixResultSummary }) {
  const { t } = useTranslation()
  const meta = STATUS_META[result.status]
  const StatusIcon = Icon[meta.icon]
  const achieved = result.status === 'achieved'

  return (
    <div className="w-full rounded-xl border border-border-subtle bg-bg-overlay overflow-hidden shadow-sm fade-in-up">
      {/* 头部：结论徽章 + 尝试轮数 */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-border-subtle">
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs font-medium ${
            achieved ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
          }`}
        >
          <StatusIcon width={13} height={13} />
          {t(meta.label)}
        </span>
        <span className="text-2xs text-text-tertiary tabular">{t('bugfixresult.attemptCount', { count: result.attemptCount })}</span>
      </div>

      {/* diff 摘要 */}
      <div className="px-3.5 pt-2.5">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary mb-1">
          <Icon.Branch width={12} height={12} />
          {t('bugfixresult.diffSummary')}
        </div>
        <pre className="text-2xs leading-relaxed text-text-secondary bg-bg-base rounded-md px-2.5 py-2 border border-border-subtle max-h-24 overflow-auto whitespace-pre-wrap">
          {result.diffSummary || t('bugfixresult.noChanges')}
        </pre>
      </div>

      {/* 测试输出 */}
      <div className="px-3.5 pt-2.5">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary mb-1">
          <Icon.Terminal width={12} height={12} />
          {t('bugfixresult.testOutput')}
        </div>
        <pre className="text-2xs leading-relaxed text-text-secondary bg-bg-base rounded-md px-2.5 py-2 border border-border-subtle max-h-32 overflow-auto whitespace-pre-wrap">
          {result.testOutput || t('bugfixresult.noTestOutput')}
        </pre>
      </div>

      {/* 目标 */}
      <div className="px-3.5 pt-2.5 pb-3">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary mb-1">
          <Icon.Book width={12} height={12} />
          {t('bugfixresult.goal')}
        </div>
        <p className="text-2xs leading-relaxed text-text-tertiary whitespace-pre-wrap line-clamp-3">
          {result.goal}
        </p>
      </div>
    </div>
  )
}
