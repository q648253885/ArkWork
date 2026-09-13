/**
 * ArkWork — 任务面板 · 顶部通知条（GraphNotices）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §P1 元素清单「通知条」/ §P4 / §P5
 *
 * 设计取舍（与"反馈规范"一致，03-interaction.md §5.1）：
 *  - 需要用户**做决定**的（Replan 需批准 / needs_human）：**不可关闭** —— 关掉它不会让问题消失
 *  - 只是**告知**的（收敛发现 / 自动应用 / 外部镜像）：可关闭
 *  - 收敛**无发现时静默**（这里根本不会出现任何条）—— 避免"每次都弹一切正常"变成噪音
 */
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import type { GraphNotice } from '@shared/types/ipc'

export interface GraphNoticesProps {
  notices: GraphNotice[]
  /** 点击通知条（打开对应的卡片） */
  onOpen: (notice: GraphNotice) => void
  /** 关闭（仅 dismissible 生效） */
  onDismiss: (notice: GraphNotice) => void
}

/** severity → 视觉（与原型 page-01 的通知条一致） */
const SEVERITY_STYLE: Record<GraphNotice['severity'], { cls: string; icon: string }> = {
  danger: { cls: 'bg-danger-soft border-l-2 border-danger', icon: '⊗' },
  warn: { cls: 'bg-warning-soft border-l-2 border-warning', icon: '⚠' },
  info: { cls: 'bg-info-soft border-l-2 border-info', icon: 'ℹ' },
  success: { cls: 'bg-success-soft border-l-2 border-success', icon: '✓' },
}

export function GraphNotices({ notices, onOpen, onDismiss }: GraphNoticesProps) {
  const { t } = useTranslation()
  if (notices.length === 0) return null

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border-subtle px-3 py-2">
      {notices.map((n, i) => {
        const s = SEVERITY_STYLE[n.severity] ?? SEVERITY_STYLE.info
        return (
          <div
            key={`${n.kind}-${n.refId ?? i}`}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(n)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(n)}
            className={`flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-xs leading-[18px] transition-colors hover:brightness-110 ${s.cls}`}
          >
            <span aria-hidden>{s.icon}</span>
            <span className="min-w-0 flex-1">{n.text}</span>
            <span className="shrink-0 text-text-tertiary" aria-hidden>
              ›
            </span>
            {n.dismissible && (
              <button
                type="button"
                aria-label={t('taskPanel.dismiss')}
                onClick={(e) => {
                  e.stopPropagation()
                  onDismiss(n)
                }}
                className="shrink-0 px-0.5 text-text-tertiary hover:text-text-primary"
              >
                <Icon.X width={11} height={11} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
