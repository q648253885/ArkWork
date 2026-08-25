import { Icon } from '../../icons'
import { useTranslation } from 'react-i18next'

interface StatusBarProps {
  statusText: string
  loading: boolean
  title?: string
  agentDriven: boolean
}

/** dock 模式状态栏（float 模式不渲染 —— 40px 高度放不下第三行） */
export function StatusBar({ statusText, loading, title, agentDriven }: StatusBarProps) {
  const { t } = useTranslation()
  const text = statusText || (loading ? t('browserchrome.status.loadingIdle') : title || '')
  return (
    <div className="flex h-6 flex-shrink-0 items-center justify-between gap-2 bg-bg-surface px-2.5">
      <span className="min-w-0 truncate text-xs text-text-tertiary">{text}</span>
      {agentDriven && (
        <span className="flex flex-shrink-0 items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent">
          <Icon.Bot width={12} height={12} />
          {t('browserchrome.status.agentOperating')}
        </span>
      )}
    </div>
  )
}
