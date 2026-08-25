/* ============================================================
 * ArkWork — AskUserGate (v0.27.1 修三)
 * ask_user 门禁：Agent 提问暂停时的独占问答交互位。
 *
 * 设计参考 opencode 阻塞式选项向导 / Claude Code AskUserQuestion：
 *   - Composer 槽位级整体替代 RunConsole（isPaused && askUserQuestion），
 *     非 ask 暂停仍走原 RunConsole，两形态互斥，输入框不再冲突
 *   - 建议项竖排单选：点击即作答；↑↓ 移动 / 数字 1-9 快选 / Enter 确认
 *   - 可选自由文本（IME 守卫；Enter 提交、Shift+Enter 换行）
 *   - 不提供无答案的「继续」（关闭 C1 绕过通道）；仅保留「停止任务」出口
 *   - 提交统一 clearAskUser() + onAnswer(text) → appendMessage 恢复协议不变
 *
 * 纯展示 + 事件转发；状态清理经 store.clearAskUser 单点收敛。
 * ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../icons'
import type { Suggestion } from '@shared/types/conversation'
import { isImeComposing } from '@shared/utils/ime'
import { moveSelection, digitToIndex } from '@shared/utils/gate-nav'
import { useStore } from '../store'

interface AskUserGateProps {
  question: string
  suggestions: Suggestion[]
  onAnswer: (text: string) => void
  onStop: () => void
}

export function AskUserGate({ question, suggestions, onAnswer, onStop }: AskUserGateProps) {
  const { t } = useTranslation()
  const recommendedIndex = useMemo(() => {
    const idx = suggestions.findIndex((s) => s.recommended === true)
    return idx >= 0 ? idx : 0
  }, [suggestions])
  const [selected, setSelected] = useState(recommendedIndex)
  const [customText, setCustomText] = useState('')
  const shellRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  // 新一轮提问（suggestions 变化）时选中位回落到推荐项
  useEffect(() => {
    setSelected(recommendedIndex)
  }, [recommendedIndex])

  // 有建议项时容器持焦，↑↓/数字/Enter 立即可用；无建议项时聚焦文本域
  useEffect(() => {
    if (suggestions.length > 0) {
      shellRef.current?.focus()
    } else {
      textRef.current?.focus()
    }
  }, [suggestions.length])

  const answer = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    useStore.getState().clearAskUser()
    onAnswer(trimmed)
  }

  const handleShellKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // IME 组合中的按键归输入法
    if (isImeComposing(e.nativeEvent)) return
    // 焦点在文本域内时走文本域自身快捷键，不触发选项导航
    if (e.target instanceof HTMLTextAreaElement) return
    if (suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => moveSelection(i, 1, suggestions.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => moveSelection(i, -1, suggestions.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      answer(suggestions[selected]?.label ?? '')
      return
    }
    const digit = Number(e.key)
    if (Number.isInteger(digit)) {
      const idx = digitToIndex(digit)
      if (idx >= 0 && idx < suggestions.length) {
        e.preventDefault()
        setSelected(idx)
      }
    }
  }

  const hasSuggestions = suggestions.length > 0

  return (
    <div
      ref={shellRef}
      tabIndex={-1}
      onKeyDown={handleShellKeyDown}
      className="relative border-t border-border-subtle bg-bg-base flex-shrink-0 outline-none"
    >
      <div className="px-3 pt-2 pb-3">
        {/* 问题卡 */}
        <div className="rounded-lg bg-accent-soft border border-accent px-3 py-2.5 text-sm text-text-primary">
          <div className="flex items-start gap-2">
            <Icon.Sparkle width={15} height={15} className="text-accent flex-shrink-0 mt-0.5" />
            <span className="whitespace-pre-wrap break-words">{question}</span>
          </div>
        </div>

        {/* 建议选项（竖排单选） */}
        {hasSuggestions && (
          <div role="radiogroup" aria-label={t('askuser.suggestionAria')} className="mt-2 space-y-1">
            {suggestions.map((s, i) => {
              const active = i === selected
              return (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={active}
                  onClick={() => answer(s.label)}
                  onMouseEnter={() => setSelected(i)}
                  title={s.description || undefined}
                  className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-md border text-left text-xs transition-colors focus-ring ${
                    active
                      ? 'border-accent bg-bg-input text-text-primary'
                      : 'border-border-subtle bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border flex-shrink-0 ${
                      active ? 'border-accent' : 'border-border-strong'
                    }`}
                  >
                    {active && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
                  </span>
                  <span className="flex-1 truncate">{s.label}</span>
                  {s.recommended === true && (
                    <span className="inline-flex items-center text-2xs font-medium px-1 py-0.5 rounded bg-accent text-text-inverse flex-shrink-0">
                      {t('askuser.recommended')}
                    </span>
                  )}
                  <kbd className="text-2xs text-text-tertiary tabular flex-shrink-0">{i + 1}</kbd>
                </button>
              )
            })}
          </div>
        )}

        {/* 自由文本回答（与选项二选一） */}
        <div className={`flex items-start gap-2 ${hasSuggestions ? 'mt-2' : ''}`}>
          <textarea
            ref={textRef}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              // v0.26.x 同款 IME 守卫：组合中的回车归输入法
              if (isImeComposing(e.nativeEvent)) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                answer(customText)
                setCustomText('')
              }
            }}
            placeholder={hasSuggestions ? t('askuser.customPlaceholder') : t('askuser.answerPlaceholder')}
            rows={1}
            aria-label={t('askuser.customAria')}
            className="flex-1 resize-none text-sm text-text-primary placeholder-text-tertiary bg-bg-input border border-border-subtle rounded-md px-3 py-1.5 focus:border-accent outline-none"
            style={{ minHeight: '36px', maxHeight: '120px' }}
          />
          <button
            onClick={() => {
              answer(customText)
              setCustomText('')
            }}
            disabled={customText.trim().length === 0}
            aria-label={t('askuser.submitAria')}
            className="inline-flex items-center gap-1 h-9 px-3 rounded-md bg-accent hover:bg-accent-hover disabled:bg-bg-hover disabled:text-text-tertiary text-text-inverse text-xs font-medium transition-colors focus-ring disabled:cursor-not-allowed"
          >
            <Icon.Send width={12} height={12} />
            {t('askuser.submit')}
          </button>
        </div>

        {/* 快捷键提示 + 停止出口 */}
        <div className="flex items-center gap-2 mt-1.5 px-0.5">
          <span className="text-2xs text-text-tertiary">
            {hasSuggestions ? t('askuser.navHint') : t('askuser.enterHint')}
          </span>
          <div className="flex-1" />
          <button
            onClick={onStop}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-text-tertiary hover:text-danger hover:bg-danger-soft text-2xs font-medium transition-colors focus-ring"
          >
            <Icon.Stop width={12} height={12} />
            {t('askuser.stop')}
          </button>
        </div>
      </div>
    </div>
  )
}
