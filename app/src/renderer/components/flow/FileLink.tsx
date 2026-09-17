/* ============================================================
 * ArkWork — FileLink（v0.31.0 D21）
 * 可点击的文件路径。契约：
 *  - 点击 → useOpenPath → fsSlice.openDoc（唯一门面，不直连 openPreview）；
 *  - 悬停提示走 HoverCard（C-20：交互区禁用原生 title）；
 *  - 语义上是 <button> 而非 <span>，键盘可达、焦点环统一。
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

export function FileLink({ path, line, className = '' }: FileLinkProps) {
  const { t } = useTranslation()
  const open = useOpenPath()

  return (
    <HoverCard tip={<span>{t('flow.openFile')}</span>}>
      <button
        type="button"
        onClick={() => open(path)}
        className={`font-mono truncate text-left text-text-secondary hover:text-business-primary hover:underline focus-ring ${className}`}
      >
        {path}
        {line != null ? `:${line}` : ''}
      </button>
    </HoverCard>
  )
}
