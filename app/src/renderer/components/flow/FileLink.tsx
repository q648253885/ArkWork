/* ============================================================
 * ArkWork — FileLink（v0.31.0 D21 / v0.42.0 chip 化）
 * 可点击的文件路径。契约：
 *  - 点击 → useOpenPath → fsSlice.openDoc（唯一门面，不直连 openPreview）；
 *  - 悬停提示走 HoverCard（C-20：交互区禁用原生 title）；
 *  - 语义上是 <button> 而非 <span>，键盘可达、焦点环统一；
 *  - 展示即全路径（D112：路径的唯一展示位，不做 basename 化）。
 * v0.42.0（对标 WorkBuddy 卡片处理）：纯文本 → inline chip ——
 * 文件图标 + mono 全路径 + 中性圆角底；hover 主色 + 下划线。
 * 只动呈现，不动任何契约。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { HoverCard } from './HoverCard'
import { useOpenPath } from './useOpenPath'

export interface FileLinkProps {
  path: string
  /** 行号（有值时渲染 `path:line`，但仍整块打开该文件） */
  line?: number | null
  className?: string
}

/** 14px 文档线性图标（与 ToolBlock KindIcon 'read' 同形，避免引入新依赖） */
function FileGlyph() {
  const stroke = { stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-70" aria-hidden="true">
      <path d="M4 1.5h5.5L12.5 4.5V14.5H4z" {...stroke} />
      <path d="M9.5 1.5v3h3" {...stroke} />
    </svg>
  )
}

export function FileLink({ path, line, className = '' }: FileLinkProps) {
  const { t } = useTranslation()
  const open = useOpenPath()

  return (
    <HoverCard tip={<span>{t('flow.openFile')}</span>}>
      <button
        type="button"
        onClick={() => open(path)}
        className={`inline-flex max-w-full items-center gap-1 rounded bg-fill-secondary px-1.5 py-px font-mono text-left text-text-secondary transition-colors hover:text-business-primary hover:underline focus-ring ${className}`}
      >
        <FileGlyph />
        <span className="truncate">{path}{line != null ? `:${line}` : ''}</span>
      </button>
    </HoverCard>
  )
}
