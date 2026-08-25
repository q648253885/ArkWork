/* ============================================================
 * ArkWork — ConfirmDialog (v0.5.0, B6)
 * 模态确认框，替代全部 window.confirm。store 单例驱动。
 *
 * 无 Props（纯 store 驱动）。
 * 行为：
 *   - Esc / 点击按钮 → 取消（resolve false）
 *   - 确认键 → onConfirm 回调（resolve true）
 *   - role="dialog" + aria-modal + 焦点陷阱（确认/取消两键）
 *
 * Phase A Task 3：点击背景不再关闭 —— 避免误触误关确认弹窗；
 *   仅保留 Esc 与按钮作为显式关闭路径，并在底部新增提示文案。
 *
 * 设计文档 §3.1.3 / §6.3
 * ============================================================ */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'

export function ConfirmDialog() {
  const { t } = useTranslation()
  const dialog = useStore((s) => s.confirmDialog)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)

  // 打开时聚焦确认键（焦点陷阱）；v0.28.0：focusCancel 时改聚焦取消键
  // （高危二次确认——如 bypassPermissions —— 防止用户直接回车误启）。
  useEffect(() => {
    if (dialog.open) {
      // 延迟聚焦以等待 DOM 渲染
      requestAnimationFrame(() => {
        if (dialog.focusCancel) cancelBtnRef.current?.focus()
        else confirmBtnRef.current?.focus()
      })
    }
  }, [dialog.open, dialog.focusCancel])

  // Esc 取消
  useEffect(() => {
    if (!dialog.open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        useStore.setState((s) => ({ confirmDialog: { ...s.confirmDialog, open: false } }))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dialog.open])

  if (!dialog.open) return null

  const handleCancel = () => {
    useStore.setState((s) => ({ confirmDialog: { ...s.confirmDialog, open: false } }))
  }

  // Phase A Task 3：点击背景不再关闭（防止误触）；
  // 仍保留 onClick 以避免 React 警告，但实际只 stopPropagation 不做任何状态变更。
  const swallowBackdrop = (e: React.MouseEvent) => {
    e.stopPropagation()
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={swallowBackdrop}
      role="presentation"
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div id="confirm-dialog-title" className="dialog__title">
          {dialog.title}
        </div>
        <div className="dialog__body">{dialog.body}</div>
        <div className="dialog__actions">
          <button
            ref={cancelBtnRef}
            onClick={handleCancel}
            className="btn-ghost"
          >
            {dialog.cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={dialog.onConfirm}
            className={dialog.danger ? 'btn-danger' : 'btn-primary'}
          >
            {dialog.confirmLabel}
          </button>
        </div>
        {/* Phase A Task 3：明确告知用户关闭方式，避免误以为背景点击可关 */}
        <div className="text-2xs text-text-tertiary text-center mt-2">
          {t('confirmdialog.closeHint')}
        </div>
      </div>
    </div>
  )
}
