/* ============================================================
 * ArkWork — WebCard（v0.31.0 B4）
 * web-search / fetch-url 的 web 结果卡：来源清单（search）/ 页面摘要（fetch）。
 * ============================================================ */
import type { ToolResultView } from '@shared/types/tool-present'

type WebSearch = Extract<ToolResultView, { card: 'web'; kind: 'search' }>
type WebFetch = Extract<ToolResultView, { card: 'web'; kind: 'fetch' }>

export function WebSearchView({ result }: { result: WebSearch }) {
  return (
    <div className="mt-1 space-y-1.5 select-text">
      {result.answer && (
        <div className="text-xs text-text-secondary whitespace-pre-wrap select-text">{result.answer}</div>
      )}
      {result.sources.map((s, i) => (
        <div key={`${s.url}:${i}`} className="text-2xs leading-4 select-text">
          {/* D21：来源标题 → 可点击外链（主进程已统一 openExternal） */}
          {s.url ? (
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block text-text-secondary truncate hover:text-business-primary hover:underline"
            >
              {s.title || s.url}
            </a>
          ) : (
            <div className="text-text-secondary truncate">{s.title}</div>
          )}
          {s.title && s.url && (
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block text-text-faint truncate font-mono hover:text-business-primary"
            >
              {s.url}
            </a>
          )}
          {s.snippet && <div className="text-text-faint line-clamp-2">{s.snippet}</div>}
        </div>
      ))}
    </div>
  )
}

export function WebFetchView({ result }: { result: WebFetch }) {
  return (
    <div className="mt-1 flex items-center gap-2 text-2xs select-text">
      {/* D21：状态码徽标去彩（2xx 是常态，常态不上色）；4xx/5xx 才是异常 */}
      <span
        className={`text-2xs font-mono px-1.5 py-0.5 rounded border border-border-default bg-fill-secondary select-none ${
          result.statusCode >= 200 && result.statusCode < 400 ? 'text-text-secondary' : 'text-danger'
        }`}
      >
        {result.statusCode || '—'}
      </span>
      {/* D21：链接可点击。target=_blank 由主进程 setWindowOpenHandler
          统一转 shell.openExternal（window.ts），不会在应用内开新窗。 */}
      <a
        href={result.url}
        target="_blank"
        rel="noreferrer noopener"
        className="font-mono text-text-faint truncate hover:text-business-primary hover:underline"
      >
        {result.url}
      </a>
    </div>
  )
}
