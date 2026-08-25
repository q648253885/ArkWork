import { Icon } from '../../icons'
import { useTranslation } from 'react-i18next'

export interface NavRowProps {
  /** float 模式紧凑单行（精确 40px，与主进程 FLOATING_TOOLBAR_HEIGHT 对齐）；dock 模式常规行 */
  compact?: boolean
  address: string
  onAddressChange: (value: string) => void
  onSubmit: () => void
  onFocusChange: (focused: boolean) => void
  canBack: boolean
  canForward: boolean
  loading: boolean
  agentDriven: boolean
  tabCount: number
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onNewTab: () => void
  onCloseTab: () => void
  onCycleTab: () => void
  onHostAction: () => void
  hostActionTitle: string
  hostActionIcon: 'detach' | 'attach'
}

/** 共享导航行：[循环 chip（仅 float 多标签）] ◀ ▶ ⟳ [地址栏 flex-1] [agent 徽章] [宿主动作] ＋ ✕ */
export function NavRow(props: NavRowProps) {
  const {
    compact = false,
    address,
    onAddressChange,
    onSubmit,
    onFocusChange,
    canBack,
    canForward,
    loading,
    agentDriven,
    tabCount,
    onBack,
    onForward,
    onReload,
    onNewTab,
    onCloseTab,
    onCycleTab,
    onHostAction,
    hostActionTitle,
    hostActionIcon,
  } = props
  const { t } = useTranslation()
  return (
    <div
      className={
        compact
          ? 'relative flex h-10 flex-shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-surface px-2'
          : 'relative flex flex-shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-surface px-2 py-1.5'
      }
    >
      {compact && tabCount > 1 && (
        <button
          type="button"
          className="bc-btn bc-btn--chip"
          title={t('browserchrome.nav.cycleTabs', { count: tabCount })}
          onClick={onCycleTab}
        >
          <Icon.List width={14} height={14} />
          <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] leading-none text-accent">
            {tabCount}
          </span>
        </button>
      )}
      <button type="button" className="bc-btn" title={t('browserchrome.nav.back')} disabled={!canBack} onClick={onBack}>
        <Icon.ChevronLeft width={14} height={14} />
      </button>
      <button type="button" className="bc-btn" title={t('browserchrome.nav.forward')} disabled={!canForward} onClick={onForward}>
        <Icon.ChevronRight width={14} height={14} />
      </button>
      <button
        type="button"
        className={`bc-btn${loading ? ' bc-btn--spin' : ''}`}
        title={loading ? t('browserchrome.nav.reloading') : t('browserchrome.nav.refresh')}
        onClick={onReload}
      >
        <Icon.Refresh width={14} height={14} />
      </button>
      <input
        className="bc-addr"
        value={address}
        placeholder={t('browserchrome.nav.addressPlaceholder')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => onAddressChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
        }}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
      />
      {compact && agentDriven && (
        <span
          className="flex h-7 flex-shrink-0 items-center rounded bg-accent-soft px-1.5 text-accent"
          title={t('browserchrome.nav.agentOperating')}
        >
          <Icon.Bot width={12} height={12} />
        </span>
      )}
      <button type="button" className="bc-btn" title={hostActionTitle} onClick={onHostAction}>
        {hostActionIcon === 'detach' ? (
          <Icon.ExternalLink width={14} height={14} />
        ) : (
          <Icon.ArrowDown width={14} height={14} />
        )}
      </button>
      <button type="button" className="bc-btn" title={t('browserchrome.nav.newTab')} onClick={onNewTab}>
        <Icon.Plus width={14} height={14} />
      </button>
      <button type="button" className="bc-btn bc-btn--danger" title={t('browserchrome.nav.closeTab')} onClick={onCloseTab}>
        <Icon.X width={14} height={14} />
      </button>
    </div>
  )
}
