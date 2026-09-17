/* ============================================================
 * ArkWork — CodeLines（v0.31.0 B4 · C-18）
 * 代码行渲染（read 结果 / 终端输出共用）：行号列 + 等宽正文，
 * 截断场景必须显示「仅前 N 行 · 共 M 行」上限提示（C-18）。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { CodeLine } from '@shared/types/tool-present'

export interface CodeLinesProps {
  lines: CodeLine[]
  /** 总行数（有值且 > lines.length 时显示截断提示） */
  totalLines?: number
  lang?: string
}

export function CodeLines({ lines, totalLines, lang }: CodeLinesProps) {
  const { t } = useTranslation()
  const truncated = totalLines != null && totalLines > lines.length
  return (
    <div className="rounded-md border border-border-default bg-fill-secondary overflow-hidden">
      {lang && (
        <div className="text-2xs text-text-faint px-2 py-0.5 border-b border-border-default select-none">
          {lang}
        </div>
      )}
      <pre className="text-2xs leading-5 font-mono overflow-x-auto p-2 m-0 select-text">
        {lines.map((l) => (
          <div key={l.number} className="flex">
            <span className="w-10 shrink-0 text-right pr-2 text-text-faint select-none">{l.number}</span>
            <span className="whitespace-pre">{l.text}</span>
          </div>
        ))}
      </pre>
      {truncated && (
        <div className="text-2xs text-text-faint px-2 py-1 border-t border-border-default select-none">
          {t('flow.truncatedLines', { shown: lines.length, total: totalLines })}
        </div>
      )}
    </div>
  )
}
