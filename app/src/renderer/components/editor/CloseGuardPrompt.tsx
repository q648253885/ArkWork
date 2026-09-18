/* ============================================================
 * ArkWork — Editor: 关闭保护三选一（B2 · A5 / A6 禁止静默丢弃）
 * 设计文档 docs/versions/v0.31.0/04-system-design.md §6.3 · 原型 07-conflict §二
 *
 * 为什么不复用全局 `confirm()`：那是**二值**接口（confirm / cancel），
 * 而这里必须三选一——「保存并关闭 / 丢弃改动 / 取消」。
 * 把丢弃塞进 cancel 会让「取消关闭」变得不可表达（用户被迫在保存与丢弃间二选一）。
 * 因此本对话框自带三按钮，只在 PreviewWindow 内挂载。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { baseNameOf } from '@shared/utils/path-display'

export interface CloseGuardPromptProps {
  /** 有未保存改动的文件路径列表 */
  paths: string[]
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function CloseGuardPrompt({ paths, onSave, onDiscard, onCancel }: CloseGuardPromptProps) {
  const { t } = useTranslation()
  const first = paths[0] ?? ''
  const name = baseNameOf(first)

  return (
    <div
      className="absolute inset-0 z-[70] flex items-center justify-center bg-black/40"
      data-close-guard=""
      role="dialog"
      aria-modal="true"
    >
      <div className="w-[380px] max-w-[92%] bg-bg-overlay border border-border-default rounded-xl shadow-panel overflow-hidden scale-in">
        <div className="flex items-start gap-2 px-4 pt-4">
          <Icon.Warning width={16} height={16} className="text-warning mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-xs text-text-primary font-medium">{t('editor.close.title')}</div>
            <div className="text-2xs text-text-secondary mt-1">
              {t('editor.close.desc', { name })}
            </div>
          </div>
        </div>

        {paths.length > 1 && (
          <ul className="mx-4 mt-2 max-h-[120px] overflow-auto text-2xs text-text-tertiary font-mono">
            {paths.map((p) => (
              <li key={p} className="truncate" title={p}>
                {p}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1 text-2xs text-text-secondary border border-border-default rounded-md hover:bg-bg-hover transition-colors"
          >
            {t('editor.close.cancel')}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="px-2.5 py-1 text-2xs text-danger border border-danger rounded-md hover:bg-danger hover:text-white transition-colors"
          >
            {t('editor.close.discard')}
          </button>
          <button
            type="button"
            onClick={onSave}
            className="px-2.5 py-1 text-2xs text-inverse bg-business-primary rounded-md hover:bg-business-primary-hover transition-colors"
          >
            {t('editor.close.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
