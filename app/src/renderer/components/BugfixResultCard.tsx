/* ============================================================
 * ArkWork — BugfixResultCard (v0.14.0 Task 11.8)
 * 修复结果卡片：diff 摘要 + 测试输出 + 达成结论。
 * 由 BugfixIsland 在终态（achieved / not-achieved）时渲染。
 * ============================================================ */
import type { BugfixResultSummary } from '@shared/types/ipc'
import { Icon } from '../icons'

const STATUS_META = {
  achieved: { label: '已达成', tone: 'success' as const, icon: 'Check' as const },
  exhausted: { label: '路径耗尽', tone: 'danger' as const, icon: 'Stop' as const },
  failed: { label: '未达成（单轮）', tone: 'danger' as const, icon: 'Stop' as const },
}

export function BugfixResultCard({ result }: { result: BugfixResultSummary }) {
  const meta = STATUS_META[result.status]
  const StatusIcon = Icon[meta.icon]
  const achieved = result.status === 'achieved'

  return (
    <div className="w-full rounded-xl border border-border-subtle bg-bg-overlay overflow-hidden shadow-sm fade-in-up">
      {/* 头部：结论徽章 + 尝试轮数 */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-border-subtle">
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs font-medium ${
            achieved ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'
          }`}
        >
          <StatusIcon width={13} height={13} />
          {meta.label}
        </span>
        <span className="text-2xs text-text-tertiary tabular">{result.attemptCount} 轮尝试</span>
      </div>

      {/* diff 摘要 */}
      <div className="px-3.5 pt-2.5">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary mb-1">
          <Icon.Branch width={12} height={12} />
          diff 摘要
        </div>
        <pre className="text-2xs leading-relaxed text-text-secondary bg-bg-base rounded-md px-2.5 py-2 border border-border-subtle max-h-24 overflow-auto whitespace-pre-wrap">
          {result.diffSummary || '（无改动）'}
        </pre>
      </div>

      {/* 测试输出 */}
      <div className="px-3.5 pt-2.5">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary mb-1">
          <Icon.Terminal width={12} height={12} />
          测试输出
        </div>
        <pre className="text-2xs leading-relaxed text-text-secondary bg-bg-base rounded-md px-2.5 py-2 border border-border-subtle max-h-32 overflow-auto whitespace-pre-wrap">
          {result.testOutput || '（无测试输出）'}
        </pre>
      </div>

      {/* 目标 */}
      <div className="px-3.5 pt-2.5 pb-3">
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary mb-1">
          <Icon.Book width={12} height={12} />
          目标
        </div>
        <p className="text-2xs leading-relaxed text-text-tertiary whitespace-pre-wrap line-clamp-3">
          {result.goal}
        </p>
      </div>
    </div>
  )
}
