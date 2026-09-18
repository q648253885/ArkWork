/* ============================================================
 * ArkWork — ReasoningBlock（v0.31.0 C1 · v0.32.0 进程折叠）
 * 思考块。转写 ThoughtStream ThinkBlock 契约（v0.30.2 问题③ + v0.31.0 B1
 * 解析链升级，断言方向不变）：
 *  - 展开态经 resolveReasoningOpen 解析链：用户意志最高 → 流式展开 →
 *    最短可见 1200ms → 失败必展开 → 视图策略；
 *  - 手动切换写 userOpen（手动优先于自动态）；无旧 setShowFull 直改形态；
 *  - 空思考走 EMPTY_REASON_KEY 占位（失败不静默，正本 G11）；
 *  - 折叠头行 = 固定「思考」标签（t('thought.label')，Trae Work 式交互）。
 *    v0.31.0 C1：不再渲染 block.summary（正文首句）——展开后正文包含同一
 *    首句，折叠行 + 正文两处显示同一段文字属于重复，用户裁决删除。
 * 全局 showThinking 开关关闭时不渲染（U5）。
 *
 * v0.32.0：新增 `forceOpen` —— 思考块现在总是被 ProcessFold 收进折叠条，
 * 折叠条自己的头行已承担「思考过程 + 来源 + 时长」，因此展开体内必须
 * **去掉内层头行**（否则出现「思考过程」/「思考」两个头 = 双重折叠）。
 * `forceOpen` 只作用于头行渲染与正文可见性，**不动 resolveReasoningOpen
 * 解析链本身**（源契约 TC-THINK-001/002/003 断言方向不变）。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../../../store'
import { EMPTY_REASON_KEY, reasoningSourceKey, resolveReasoningOpen } from '@shared/utils/reasoning'
import type { FlowBlock } from '@shared/types/flow'

interface ReasoningBlockProps {
  block: Extract<FlowBlock, { kind: 'reasoning' }>
  /** v0.32.0：由外层 ProcessFold 代持头行时置 true（正文直出） */
  forceOpen?: boolean
}

export function ReasoningBlock({ block, forceOpen = false }: ReasoningBlockProps) {
  const { t } = useTranslation()
  const showThinking = useStore((s) => s.flow.showThinking)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  if (!showThinking) return null

  const isRunning = block.status === 'streaming' || block.status === 'pending'
  const showFull = resolveReasoningOpen({
    userOpen,
    streaming: isRunning === true,
    elapsedMs: Date.now() - block.startedAt,
    failed: block.status === 'failed',
    autoOpenWhenSettled: false,
  })
  // v0.32.0：外层折叠条展开即正文直出；头行由 ProcessFold 承担
  const bodyVisible = forceOpen || showFull
  const emptyKind = block.text.trim() ? null : block.status === 'failed' ? 'failed' : 'noChannel'

  return (
    <div className="react-reason" data-state={isRunning ? 'running' : 'settled'}>
      {!forceOpen && (
        <button
          type="button"
          className="react-reason__head select-none"
          aria-expanded={showFull}
          onClick={() => setUserOpen(!showFull)}
        >
          <span className="react-reason__label">{t('thought.label')}</span>
          {/* 来源徽标（G4：三种来源都有，none 也显式标注）+ 时长 */}
          <span className="react-reason__meta text-2xs text-text-faint select-none">
            {t(`thought.${reasoningSourceKey(block.source)}`)}
            {block.durationMs > 0 &&
              ' · ' + t('thought.summary.thoughtTime', { time: Math.round(block.durationMs / 100) / 10 })}
            {isRunning ? ' · ' + t('thought.status.running') : ''}
          </span>
          <svg
            className={`react-reason__chevron w-3 h-3 text-text-faint transition-transform ${showFull ? 'rotate-180' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {emptyKind ? (
        <span className="react-reason__placeholder text-2xs text-text-faint" data-empty-kind={emptyKind}>
          {t(`thought.${EMPTY_REASON_KEY[emptyKind]}`)}
        </span>
      ) : (
        bodyVisible && (
          <div className="react-reason__body text-xs text-text-tertiary whitespace-pre-wrap select-text">
            {block.text}
            {block.truncated && (
              <span className="ml-1.5 text-2xs text-text-faint select-none">{t('flow.truncatedResult')}</span>
            )}
          </div>
        )
      )}
    </div>
  )
}
