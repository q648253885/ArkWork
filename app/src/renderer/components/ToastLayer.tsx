/* ============================================================
 * ArkWork — ToastLayer (v0.5.0, B2)
 * 全局 Toast 浮层：右上角滑入，store.toasts[] 驱动。
 *
 * 行为：
 *   - success / warning 默认 4000ms 自动消失
 *   - danger 不自动消失，需手动关闭或点 action
 *   - z-index: var(--z-toast)
 *
 * Phase A Task 4：toast level（critical / info / silent）分级路由
 *   - silent：已被 store.pushToast 过滤（不进入 toasts 队列）；这里二次防御
 *   - critical / info：按原行为渲染；critical 在视觉上使用更醒目的强调色
 *
 * 设计文档 §3.1.2 / §6.2
 * 无 Props，纯 store 驱动。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import type { Toast } from '../store'
import { Icon } from '../icons'

export function ToastLayer() {
  const toasts = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)

  // Phase A Task 4：过滤 silent —— store.pushToast 已不写入；这里防御性兜底
  const visible = toasts.filter((t) => t.level !== 'silent')

  if (visible.length === 0) return null

  return (
    <div
      className="toast-layer"
      role="status"
      aria-live={visible.some((t) => t.type === 'danger' || t.level === 'critical') ? 'assertive' : 'polite'}
    >
      {visible.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useTranslation()
  const icon = toast.type === 'success' ? '✓' : toast.type === 'warning' ? '⚠' : '✕'
  // Phase A Task 4：critical 增加视觉强调（ring / shadow）
  const levelCls = toast.level === 'critical' ? ' toast--critical' : ''
  const cls = `toast toast--${toast.type}${levelCls}`

  return (
    <div className={cls}>
      <span className="toast__icon">{icon}</span>
      <span className="toast__message">{toast.message}</span>
      {toast.action && (
        <button className="toast__action" onClick={toast.action.onClick}>
          {toast.action.label}
        </button>
      )}
      <button className="toast__close" onClick={onDismiss} aria-label={t('toastlayer.close')}>
        <Icon.X width={16} height={16} />
      </button>
    </div>
  )
}
