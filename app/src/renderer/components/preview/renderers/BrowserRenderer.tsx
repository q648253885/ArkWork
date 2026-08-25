/* ============================================================
 * ArkWork — BrowserRenderer (v0.7.0)
 * HTML/URL 预览：iframe 沙箱渲染 + 视口尺寸切换（桌面 / 平板 / 手机）
 * - 本地 HTML 文件：通过 ark.fs.readFile 读取后以 srcDoc 注入（sandbox 禁脚本）
 * - URL 标签：直接以 src 加载（sandbox 保留同源限制）
 * 视口模式由 PreviewWindow 通过 viewMode 传入（desktop/tablet/mobile）。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ark } from '../../../ipc/client'
import { Icon } from '../../../icons'

interface BrowserRendererProps {
  /** URL 标签的地址（与 content 二选一） */
  url?: string
  /** 文件路径：本地 HTML 文件，读取后以 srcDoc 注入 */
  path?: string
  /** 视口模式：'desktop' | 'tablet' | 'mobile'，默认 'desktop' */
  viewMode?: string
}

const VIEWPORTS: Record<string, number> = {
  desktop: 0, // 0 表示 100% 宽
  tablet: 768,
  mobile: 375,
}

export function BrowserRenderer({ url, path, viewMode = 'desktop' }: BrowserRendererProps) {
  const { t } = useTranslation()
  const mode = viewMode === 'tablet' || viewMode === 'mobile' ? viewMode : 'desktop'
  const [html, setHtml] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (url || !path) return
    let cancelled = false
    setHtml(null)
    setErr(null)
    ark.fs
      .readFile(path)
      .then((fc) => {
        if (!cancelled) setHtml(fc.content)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [url, path])

  const targetWidth = VIEWPORTS[mode]
  const addrLabel = url ?? path ?? ''

  return (
    <div className="h-full flex flex-col bg-bg-surface">
      {/* 地址栏 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border-subtle bg-bg-overlay flex-shrink-0">
        <Icon.ExternalLink width={16} height={16} className="text-text-tertiary flex-shrink-0" />
        <span className="text-2xs text-text-secondary font-mono truncate flex-1" title={addrLabel}>
          {addrLabel || t('preview.browser.emptyAddress')}
        </span>
        <span className="text-2xs text-text-tertiary">
          {mode === 'desktop' ? t('preview.browser.mode.desktop') : mode === 'tablet' ? t('preview.browser.mode.tablet') : t('preview.browser.mode.mobile')}
        </span>
      </div>

      {/* 画布 */}
      <div className="flex-1 overflow-auto flex justify-center min-h-0 p-3">
        {err ? (
          <span className="text-xs text-danger self-center">{t('preview.browser.error', { err })}</span>
        ) : (
          <iframe
            key={mode}
            sandbox="allow-same-origin"
            src={url}
            srcDoc={url ? undefined : html ?? ''}
            title={t('preview.browser.title')}
            style={{
              width: targetWidth > 0 ? `${targetWidth}px` : '100%',
              height: '100%',
              maxWidth: '100%',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              background: '#fff',
            }}
          />
        )}
      </div>
    </div>
  )
}
