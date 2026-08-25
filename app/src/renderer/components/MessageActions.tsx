/* ============================================================
 * ArkWork — MessageActions (v0.5.0, B3)
 * assistant 消息 hover 操作条：重新生成 / 复制 / 导出。
 *
 * 按钮接线：
 *   - 复制：navigator.clipboard.writeText + pushToast success「已复制」
 *   - 重新生成：store.regenerateMessage(taskId, iteration)
 *   - 导出：store.exportConversation()
 *
 * 诚实 UI：未接线的按钮不上线（不渲染）。
 * 设计文档 §3.1.4
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { Icon } from '../icons'
import { Tooltip } from './ui'

interface MessageActionsProps {
  taskId: string
  messageId: string
  text: string
  /** 对应 react 组的 iteration，用于重新生成定位 */
  iteration?: number
}

export function MessageActions({ taskId, messageId, text, iteration }: MessageActionsProps) {
  const { t } = useTranslation()
  const regenerateMessage = useStore((s) => s.regenerateMessage)
  const exportConversation = useStore((s) => s.exportConversation)
  const pushToast = useStore((s) => s.pushToast)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      pushToast({ type: 'success', message: t('messageactions.copied'), duration: 2000 })
    } catch {
      pushToast({ type: 'warning', message: t('messageactions.copyFailed'), duration: 4000 })
    }
  }

  const handleRegenerate = () => {
    void regenerateMessage(taskId, iteration ?? 0)
  }

  const handleExport = () => {
    exportConversation()
  }

  return (
    /* v0.22.0 — DSH MessageIconActions 风格：
       - 三个图标按钮（复制/重新生成/导出）以 10px 间距水平排列
       - 每个按钮 28×28、6px 内边距、hover 圆形 bg-hover 浅灰底
       - 时间标签由父级 data-time-hover-root 在 hover/focus 时浮现 */
    <div className="message-actions">
      <Tooltip label={t('messageactions.copyLabel')} kbd="⌘C" desc={t('messageactions.copyDesc')} placement="top" delay={150}>
        <button
          className="message-actions__btn"
          onClick={handleCopy}
          aria-label={t('messageactions.copyAria')}
        >
          <Icon.Copy width={14} height={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('messageactions.regenerateLabel')} desc={t('messageactions.regenerateDesc')} placement="top" delay={150}>
        <button
          className="message-actions__btn"
          onClick={handleRegenerate}
          aria-label={t('messageactions.regenerateAria')}
        >
          <Icon.Refresh width={14} height={14} />
        </button>
      </Tooltip>
      <Tooltip label={t('messageactions.exportLabel')} desc={t('messageactions.exportDesc')} placement="top" delay={150}>
        <button
          className="message-actions__btn"
          onClick={handleExport}
          aria-label={t('messageactions.exportAria')}
        >
          <Icon.ArrowDown width={14} height={14} />
        </button>
      </Tooltip>
    </div>
  )
}
