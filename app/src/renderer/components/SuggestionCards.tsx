/* ============================================================
 * ArkWork — SuggestionCards (Task 4: 建议优先的任务交互)
 * 对话末尾 / ask_user 暂停态渲染的建议卡片列表。
 * - 横向排列的 chip/卡片，推荐项用 accent 边框高亮 + "推荐"标签
 * - 点击卡片 → 通过 composer:fill 事件把 label 填入 Composer 输入框
 * - 用户可点击建议或继续自由输入，两种方式都能推进任务
 * 样式与 ThoughtStream / Composer 一致（dark/light 主题兼容，使用语义色变量）
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import { Tooltip } from './ui'
import type { Suggestion } from '@shared/types/conversation'

interface SuggestionCardsProps {
  suggestions: Suggestion[]
  /** 点击建议时回调；未提供时默认派发 composer:fill 事件填充输入框 */
  onSelect?: (suggestion: Suggestion) => void
}

export function SuggestionCards({ suggestions, onSelect }: SuggestionCardsProps) {
  const { t } = useTranslation()
  if (suggestions.length === 0) return null

  const handleSelect = (s: Suggestion) => {
    if (onSelect) {
      onSelect(s)
    } else {
      // 默认行为：将建议 label 填入 Composer 输入框（用户可编辑后发送）
      window.dispatchEvent(new CustomEvent('composer:fill', { detail: s.label }))
    }
  }

  return (
    <div className="fade-in-up flex flex-col items-start w-full">
      <div className="flex items-center gap-1.5 mb-1.5 px-0.5">
        <Icon.Sparkle width={12} height={12} className="text-accent flex-shrink-0" />
        <span className="text-2xs text-text-tertiary uppercase tracking-wider font-medium">
          {t('suggestion.nextStep')}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 w-full">
        {suggestions.map((s) => {
          const recommended = s.recommended === true
          return (
            <Tooltip
              key={s.id}
              label={s.label}
              desc={s.description}
              placement="top"
              delay={200}
            >
              <button
                onClick={() => handleSelect(s)}
                className={`group inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-xs transition-all focus-ring ${
                  recommended
                    ? 'bg-accent-soft border-accent text-accent hover:border-accent hover:shadow-accent'
                    : 'bg-bg-surface border-border-subtle text-text-secondary hover:border-border-default hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {recommended && (
                  <span className="inline-flex items-center gap-0.5 text-2xs font-medium px-1 py-0.5 rounded bg-accent text-text-inverse flex-shrink-0">
                    {t('suggestion.recommended')}
                  </span>
                )}
                <span className="truncate max-w-[240px]">{s.label}</span>
                <Icon.ChevronRight
                  width={11}
                  height={11}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-60 transition-opacity"
                />
              </button>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
