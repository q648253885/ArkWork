/* ============================================================
 * ArkWork — GenericCard（v0.31.0 B4）
 * generic 卡（call + result 两形态）：缺省回落形态（C-21 无能力回落时
 * 内容仍可读）；内容类参数（content/oldStr/newStr）按 60 字符摘要显示
 * （v018 契约，转写自 ThoughtStream ToolCard）。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { ToolCallView, ToolResultView } from '@shared/types/tool-present'
import { FileLink } from '../FileLink'

/** 内容类参数键：这些值可能是长文本，预览时截断到 60 字符并标注总字符数 */
export const CONTENT_ARG_KEYS = ['content', 'oldStr', 'newStr'] as const

/** 60 字符截断 + 总字符数标注（与旧 ToolCard 同口径） */
export function truncate(s: string, max = 60): string {
  const v = String(s ?? '')
  return v.length > max ? `${v.slice(0, max)}…（共 ${v.length} 字符）` : v
}

type GenericCall = Extract<ToolCallView, { card: 'generic' }>

export function GenericCallView({ call }: { call: GenericCall }) {
  const raw = call.rawInput
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  return (
    <div className="mt-1 space-y-1 select-text">
      {call.locations && call.locations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {call.locations.map((loc, i) => (
            <span
              key={`${loc.path}:${i}`}
              className="inline-flex max-w-full text-2xs px-1.5 py-0.5 rounded bg-fill-secondary border border-border-default"
            >
              {/* D21：文件路径可点击 —— 此前是死文本，用户点不了 */}
              <FileLink path={loc.path} line={loc.line} className="text-2xs" />
            </span>
          ))}
        </div>
      )}
      {rec &&
        CONTENT_ARG_KEYS.filter((k) => typeof rec[k] === 'string' && (rec[k] as string).length > 0).map((k) => (
          <div key={k} className="text-2xs font-mono text-text-faint break-all select-text">
            {k}: {truncate(rec[k] as string, 60)}
          </div>
        ))}
    </div>
  )
}

type GenericResult = Extract<ToolResultView, { card: 'generic' }>

export function GenericResultView({ result }: { result: GenericResult }) {
  return (
    <div className="mt-1 select-text">
      <div className={`text-xs whitespace-pre-wrap break-words ${result.isError ? 'text-danger' : 'text-text-tertiary'}`}>
        {result.summary}
      </div>
      {result.content && (
        <pre className="mt-1 text-2xs font-mono text-text-faint bg-fill-secondary rounded-md border border-border-default p-2 overflow-x-auto max-h-48 whitespace-pre-wrap m-0 select-text">
          {result.content}
        </pre>
      )}
    </div>
  )
}

/** 结果摘要行（折叠态默认可见 —— C-11 结果摘要默认可见零点击） */
export function ResultSummaryLine({ result }: { result: ToolResultView }) {
  const { t } = useTranslation()
  const isError = 'isError' in result && result.isError === true
  return (
    <div className={`mt-1 text-xs truncate select-text ${isError ? 'text-danger' : 'text-text-tertiary'}`}>
      {result.summary}
      {'truncated' in result && result.truncated === true && (
        <span className="ml-1.5 text-2xs text-text-faint select-none">{t('flow.truncatedResult')}</span>
      )}
    </div>
  )
}
