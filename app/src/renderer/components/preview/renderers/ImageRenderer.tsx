/* ============================================================
 * ArkWork — ImageRenderer (v0.7.0)
 * 图片预览：适应窗口 / 实际尺寸切换 + 缩放 25%–400%
 * 本地文件通过 ark.fs.readFile 读取（后端对图片返回 base64 dataURL，见 ContentView 既有实现）。
 * 缩放与适应状态为本渲染器内部状态，故内置一行迷你工具条。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ark } from '../../../ipc/client'
import { Icon } from '../../../icons'
import { useStore } from '../../../store'

interface ImageRendererProps {
  path: string
}

const ZOOM_LEVELS = [25, 50, 75, 100, 150, 200, 300, 400]

export function ImageRenderer({ path }: ImageRendererProps) {
  const { t } = useTranslation()
  const pushToast = useStore((s) => s.pushToast)
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [zoom, setZoom] = useState(100)
  const [fit, setFit] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    setSrc(null)
    ark.fs
      .readFile(path)
      .then((fc) => {
        if (cancelled) return
        // 后端对图片返回 dataURL（content）；若非 dataURL 则尝试 file:// 兜底
        if (fc.content.startsWith('data:')) setSrc(fc.content)
        else setSrc(`file://${encodeURIComponent(fc.content)}`)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const stepZoom = (dir: 1 | -1) => {
    setFit(false)
    setZoom((cur) => {
      const idx = ZOOM_LEVELS.indexOf(cur)
      if (idx < 0) return Math.max(25, Math.min(400, cur + dir * 25))
      const next = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + dir))]
      return next
    })
  }

  return (
    <div className="h-full flex flex-col bg-bg-surface">
      {/* 迷你工具条 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border-subtle bg-bg-overlay flex-shrink-0">
        <button
          type="button"
          onClick={() => setFit((f) => !f)}
          className={`px-2 py-0.5 text-2xs rounded-md transition-colors ${
            fit ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
          }`}
        >
          {fit ? t('preview.image.fit') : t('preview.image.actual')}
        </button>
        <div className="w-px h-3 bg-border-subtle mx-0.5" />
        <button
          type="button"
          onClick={() => stepZoom(-1)}
          disabled={fit || zoom <= 25}
          className="px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        >
          −
        </button>
        <span className="text-2xs text-text-secondary tabular w-9 text-center">
          {fit ? t('preview.image.fitShort') : `${zoom}%`}
        </span>
        <button
          type="button"
          onClick={() => stepZoom(1)}
          disabled={fit || zoom >= 400}
          className="px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setFit(false)
            setZoom(100)
          }}
          className="ml-1 px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors"
        >
          1:1
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!src) return
            try {
              await navigator.clipboard.writeText(path)
              pushToast({ type: 'success', message: t('preview.image.toast.copiedPath'), duration: 2000 })
            } catch {
              pushToast({ type: 'danger', message: t('preview.image.toast.copyFailed'), duration: 2000 })
            }
          }}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors"
        >
          <Icon.Copy width={16} height={16} />
          {t('preview.image.copyPath')}
        </button>
      </div>

      {/* 画布 */}
      <div className="flex-1 overflow-auto flex items-center justify-center min-h-0 p-4">
        {loading ? (
          <span className="text-xs text-text-tertiary">{t('preview.image.loading')}</span>
        ) : err ? (
          <span className="text-xs text-danger">{t('preview.image.error', { err })}</span>
        ) : src ? (
          fit ? (
            <img
              src={src}
              alt={path.split('/').pop() ?? t('preview.image.alt')}
              className="max-w-full max-h-full object-contain rounded-lg shadow-panel"
            />
          ) : (
            <img
              src={src}
              alt={path.split('/').pop() ?? t('preview.image.alt')}
              style={{ width: `${zoom}%`, height: 'auto', imageRendering: zoom >= 200 ? 'pixelated' : 'auto' }}
              className="rounded-lg shadow-panel"
            />
          )
        ) : null}
      </div>
    </div>
  )
}
