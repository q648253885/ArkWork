/* ============================================================
 * ArkWork — Editor: 只读卡片（B2）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §4.3.1 · 03-interaction §4.8
 *
 * 只读是**正常态**，不是错误态：因此这里给的是「原因 + 出口」，
 * 不是红色报错视图。七原因各自的出口见下表（文案走 i18n，仅出口逻辑在此）。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { READONLY_REASON_KEY } from '../../services/editorDoc'
import type { EditorDocMeta } from '@shared/types/fs'

export interface ReadonlyCardProps {
  doc: EditorDocMeta
  /** 「在文件夹中显示」（仅文件存在时有意义） */
  onReveal?: () => void
  /** 「重新探测」（权限 / agent-writing 等临时原因） */
  onRetry?: () => void
  /** 「另存恢复」（deleted 专用出口） */
  onSaveAs?: () => void
  onClose?: () => void
  className?: string
}

export function ReadonlyCard({ doc, onReveal, onRetry, onSaveAs, onClose, className }: ReadonlyCardProps) {
  const { t } = useTranslation()
  const reason = doc.readonlyReason
  const reasonLabel = reason ? t(READONLY_REASON_KEY[reason]) : t('editor.readonly.title')

  return (
    <div
      className={`h-full flex flex-col items-center justify-center gap-2 px-6 text-center ${className ?? ''}`}
      data-readonly-card={doc.path}
      data-readonly-reason={reason ?? 'none'}
    >
      <Icon.File width={22} height={22} className="text-text-tertiary" />
      <div className="text-xs text-text-secondary">{t('editor.readonly.title')}</div>
      <div className="text-xs text-text-primary font-medium">{reasonLabel}</div>
      {doc.readonlyDetail && (
        <div className="text-2xs text-text-tertiary font-mono break-all max-w-[420px]">
          {doc.readonlyDetail}
        </div>
      )}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap justify-center">
        {reason === 'deleted' && onSaveAs && (
          <CardBtn onClick={onSaveAs} primary>
            {t('editor.readonly.action.saveAs')}
          </CardBtn>
        )}
        {(reason === 'permission' || reason === 'agent-writing') && onRetry && (
          <CardBtn onClick={onRetry} primary>
            {t('editor.readonly.action.retry')}
          </CardBtn>
        )}
        {reason === 'outside-workspace' && onClose && (
          <CardBtn onClick={onClose} primary>
            {t('editor.readonly.action.close')}
          </CardBtn>
        )}
        {reason !== 'deleted' && onReveal && (
          <CardBtn onClick={onReveal}>{t('editor.readonly.action.reveal')}</CardBtn>
        )}
      </div>
      <div className="text-2xs text-text-disabled font-mono truncate max-w-[90%]" title={doc.path}>
        {doc.path}
      </div>
    </div>
  )
}

function CardBtn({
  onClick,
  children,
  primary,
}: {
  onClick: () => void
  children: React.ReactNode
  primary?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 text-2xs rounded-md border transition-colors ${
        primary
          ? 'border-business-primary text-inverse bg-business-primary hover:bg-business-primary-hover'
          : 'border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}
