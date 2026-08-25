import { Icon } from '../../icons'
import { useTranslation } from 'react-i18next'
import type { BrowserTabMeta } from '@shared/types/ipc'

interface TabStripProps {
  tabs: BrowserTabMeta[]
  currentId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
}

/** dock 模式标签条（float 模式不渲染）。v0.27.0 F11：32px 预算（h-8+pt-1），仅 >1 Tab 时出现 */
export function TabStrip({ tabs, currentId, onSelect, onClose, onNew }: TabStripProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-8 flex-shrink-0 items-end gap-1 bg-bg-surface-2 px-2 pt-1">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-hidden">
        {tabs.map((tab) => {
          const active = tab.tabId === currentId
          return (
            <button
              key={tab.tabId}
              type="button"
              title={tab.url}
              onClick={() => onSelect(tab.tabId)}
              className={`flex h-7 min-w-0 max-w-[180px] flex-1 flex-shrink items-center gap-1.5 rounded-t-md px-2 text-xs transition-colors ${
                active ? 'bg-bg-surface text-text-primary' : 'text-text-tertiary hover:bg-bg-hover'
              }`}
            >
              {tab.agentDriven && <Icon.Bot width={12} height={12} className="flex-shrink-0 text-accent" />}
              <span className="min-w-0 flex-1 truncate text-left">{tab.title || tab.url || t('browserchrome.tabs.newTabPage')}</span>
              <span
                role="button"
                tabIndex={-1}
                title={t('browserchrome.tabs.close')}
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.tabId)
                }}
              >
                <Icon.X width={12} height={12} />
              </span>
            </button>
          )
        })}
      </div>
      <button type="button" className="bc-btn" title={t('browserchrome.tabs.new')} onClick={onNew}>
        <Icon.Plus width={14} height={14} />
      </button>
    </div>
  )
}
