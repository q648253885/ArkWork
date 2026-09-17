/* ============================================================
 * ArkWork — SearchCard（v0.31.0 B4）
 * grep-search / glob-search 的 search 结果卡：
 *   shape 'matches' → 按文件分组的命中行；
 *   shape 'paths'   → 扁平路径清单。
 * 截断场景显示 total + 截断提示（C-18）。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { ToolResultView } from '@shared/types/tool-present'
import { FileLink } from '../FileLink'

type SearchMatches = Extract<ToolResultView, { card: 'search'; shape: 'matches' }>
type SearchPaths = Extract<ToolResultView, { card: 'search'; shape: 'paths' }>

export function SearchMatchesView({ result }: { result: SearchMatches }) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 space-y-2 select-text">
      {result.files.map((f) => (
        <div key={f.path}>
          {/* D21：命中文件可点击（此前是死文本） */}
          <FileLink path={f.path} className="text-2xs" />
          <pre className="mt-0.5 text-2xs font-mono text-text-tertiary bg-fill-secondary rounded-md border border-border-default px-2 py-1 overflow-x-auto max-h-40 whitespace-pre-wrap m-0 select-text">
            {f.matches.map((m) => `${m.lineNumber}: ${m.line}`).join('\n')}
          </pre>
        </div>
      ))}
      {result.truncated && (
        <div className="text-2xs text-text-faint select-none">
          {t('flow.truncatedResult')} · {t('flow.searchTotal', { total: result.total })}
        </div>
      )}
    </div>
  )
}

export function SearchPathsView({ result }: { result: SearchPaths }) {
  const { t } = useTranslation()
  return (
    <div className="mt-1 select-text">
      <div className="text-2xs font-mono text-text-tertiary bg-fill-secondary rounded-md border border-border-default px-2 py-1.5 max-h-40 overflow-y-auto space-y-0.5 select-text">
        {result.paths.map((p) => (
          <div key={p} className="truncate">
            <FileLink path={p} className="text-2xs" />
          </div>
        ))}
      </div>
      {result.truncated && (
        <div className="mt-0.5 text-2xs text-text-faint select-none">
          {t('flow.truncatedResult')} · {t('flow.searchTotal', { total: result.total })}
        </div>
      )}
    </div>
  )
}
