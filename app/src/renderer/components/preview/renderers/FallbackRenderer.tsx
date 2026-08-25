/* ============================================================
 * ArkWork — FallbackRenderer (v0.7.0)
 * 兜底文件信息卡：展示路径 / 大小 / 行数 / 类型 / 编码，
 * 提供「在文件夹中显示」「复制路径」操作。
 * 文件元数据通过 ark.fs.readFile 获取（FileContent 含 size/lines/language）；
 * 修改时间不在 ArkApi 暴露范围内，故不展示。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ark } from '../../../ipc/client'
import { Icon } from '../../../icons'
import { useStore } from '../../../store'
import type { FileContent } from '@shared/types/ipc'

interface FallbackRendererProps {
  path: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function extOf(path: string): string {
  const base = path.split('/').pop() ?? path
  const i = base.lastIndexOf('.')
  return i >= 0 ? base.slice(i + 1).toUpperCase() : '—'
}

export function FallbackRenderer({ path }: FallbackRendererProps) {
  const { t } = useTranslation()
  const pushToast = useStore((s) => s.pushToast)
  const [meta, setMeta] = useState<FileContent | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setMeta(null)
    setErr(null)
    ark.fs
      .readFile(path)
      .then((fc) => {
        if (!cancelled) setMeta(fc)
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const fileName = path.split('/').pop() ?? path

  return (
    <div className="h-full overflow-auto flex items-center justify-center p-6 bg-bg-surface">
      <div className="w-full max-w-md rounded-xl border border-border-subtle bg-bg-overlay shadow-sm p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-shrink-0 w-11 h-11 rounded-lg bg-bg-hover flex items-center justify-center text-text-tertiary">
            <Icon.File width={20} height={20} />
          </div>
          <div className="min-w-0">
            <div className="text-sm text-text-primary font-medium truncate" title={fileName}>
              {fileName}
            </div>
            <div className="text-2xs text-text-tertiary">
              {err ? t('preview.fallback.metaError') : t('preview.fallback.unsupported')}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs mb-4">
          <MetaRow label={t('preview.fallback.meta.type')} value={extOf(path)} />
          <MetaRow label={t('preview.fallback.meta.size')} value={meta ? formatSize(meta.size) : '—'} />
          <MetaRow label={t('preview.fallback.meta.lines')} value={meta && meta.lines > 0 ? t('preview.fallback.lines', { count: meta.lines }) : '—'} />
          <MetaRow label={t('preview.fallback.meta.encoding')} value="UTF-8" />
          <MetaRow label={t('preview.fallback.meta.language')} value={meta?.language ?? '—'} />
          <MetaRow label={t('preview.fallback.meta.modified')} value={t('preview.fallback.notAvailable')} />
        </dl>

        <div className="text-2xs text-text-tertiary font-mono break-all bg-bg-base border border-border-subtle rounded-md px-2.5 py-2 mb-4 max-h-20 overflow-auto">
          {path}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void ark.fs.revealInFolder(path)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-primary bg-bg-hover hover:bg-bg-active rounded-md transition-colors"
          >
            <Icon.ExternalLink width={16} height={16} />
            {t('preview.fallback.reveal')}
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(path)
                pushToast({ type: 'success', message: t('preview.fallback.toast.copiedPath'), duration: 2000 })
              } catch {
                pushToast({ type: 'danger', message: t('preview.fallback.toast.copyFailed'), duration: 2000 })
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors"
          >
            <Icon.Copy width={16} height={16} />
            {t('preview.fallback.copyPath')}
          </button>
        </div>
      </div>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <dt className="text-2xs text-text-tertiary uppercase tracking-wider">{label}</dt>
      <dd className="text-xs text-text-secondary truncate tabular">{value}</dd>
    </div>
  )
}
