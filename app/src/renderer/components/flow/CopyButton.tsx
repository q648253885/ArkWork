/* ============================================================
 * ArkWork — CopyButton（v0.45.0 · R-F，第十三块共用件）
 *
 * 病：交互区每一段（答复分层段 / 阶段结论 / 过程叙述 / 用户消息）此前
 * 只能手动框选复制（用户实机反馈，对齐 ZCode）。
 *
 * 设计口径：
 *  - **hover 浮出**：宿主块提供 `relative group` 定位上下文，本按钮
 *    `opacity-0 group-hover:opacity-100`，不常驻、不产生视觉噪音
 *    （与 ToolBlock 的 faint 操作按钮、插件面板 `.ops` 同一交互语言）。
 *  - **复制交互复用既有模式**：copied state + 1500ms 复位 + 四语言键
 *    `markdown.copy` / `markdown.copied`（与 Markdown 代码块复制完全同源，
 *    不新增键集 —— 语义同为「复制 / 已复制」）。
 *  - 点击 `stopPropagation`：宿主可能是可点击容器（折叠头 / 计划卡），
 *    复制动作不得触发宿主行为。
 * ============================================================ */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  // 复位计时器挂 ref：快速连点时清掉上一轮的复位，避免「已复制」闪烁回退
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用（权限/非安全上下文）：与 Markdown 代码块复制同口径，静默
    }
  }
  return (
    <button
      type="button"
      aria-label={copied ? t('markdown.copied') : t('markdown.copy')}
      title={copied ? t('markdown.copied') : t('markdown.copy')}
      data-testid="block-copy"
      onClick={(e) => {
        e.stopPropagation()
        void handleCopy()
      }}
      className={`inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-2xs text-text-tertiary hover:text-text-primary hover:bg-bg-active bg-bg-overlay border border-border-subtle shadow-sm transition-opacity duration-150 opacity-0 group-hover:opacity-100 focus:opacity-100 ${className}`}
    >
      {copied ? <Icon.Check width={11} height={11} /> : <Icon.Copy width={11} height={11} />}
      {copied ? t('markdown.copied') : t('markdown.copy')}
    </button>
  )
}
