/* ============================================================
 * ArkWork — ArtifactCard (v0.14.x)
 * 助手消息内联产物：紧凑行式卡片（无固定宽度、无 emoji）。
 * - 语义化图标按类型映射（项目 Icon 组件）+ 类型标签 + 文件名 + 大小
 * - 预览：openPreview(path, { pinned: true })
 * - 复制路径：写入剪贴板
 * - 插入为上下文：暂以 Toast 提示（后续接入 Composer @file 引用）
 * - 图片产物显示缩略图（通过 ark.fs.readFile 读取 dataURL）
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { ark } from '../ipc/client'
import { Icon } from '../icons'

export interface Artifact {
  path: string
  kind: string
  size: number
  step?: number
}

interface ArtifactCardProps {
  artifacts: Artifact[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

/* 类型 → 图标/标签（对齐 RendererKind 语义；label 为 i18n key，全部使用项目 Icon 组件，无 emoji） */
const KIND_META: Record<string, { label: string; icon: typeof Icon.File }> = {
  markdown: { label: 'artifactcard.kindMarkdown', icon: Icon.Note },
  browser: { label: 'artifactcard.kindBrowser', icon: Icon.ExternalLink },
  image: { label: 'artifactcard.kindImage', icon: Icon.File },
  svg: { label: 'artifactcard.kindSvg', icon: Icon.Sparkle },
  table: { label: 'artifactcard.kindTable', icon: Icon.List },
  code: { label: 'artifactcard.kindCode', icon: Icon.Terminal },
  fallback: { label: 'artifactcard.kindFallback', icon: Icon.File },
}

export function ArtifactCard({ artifacts }: ArtifactCardProps) {
  if (artifacts.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      {artifacts.map((a, i) => (
        <ArtifactCardItem key={`${a.path}-${i}`} artifact={a} />
      ))}
    </div>
  )
}

function ArtifactCardItem({ artifact }: { artifact: Artifact }) {
  const { t } = useTranslation()
  const pushToast = useStore((s) => s.pushToast)
  const { path, kind, size } = artifact
  const name = basename(path)
  const isImage = kind === 'image'
  const meta = KIND_META[kind] ?? KIND_META.fallback
  const MetaIcon = meta.icon

  const handlePreview = () => {
    void useStore.getState().openPreview(path, { pinned: true })
  }

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(path)
      pushToast({ type: 'success', message: t('artifactcard.copiedPath'), duration: 2000 })
    } catch {
      pushToast({ type: 'danger', message: t('artifactcard.copyFailed'), duration: 2000 })
    }
  }

  const handleInsertContext = () => {
    pushToast({
      type: 'success',
      message: t('artifactcard.addedToContext', { name }),
      duration: 2500,
      action: { label: t('artifactcard.previewAction'), onClick: handlePreview },
    })
  }

  const baseBtn = 'px-1.5 py-0.5 rounded text-2xs transition-colors focus-ring'
  const subtleBtn = `${baseBtn} text-text-tertiary hover:text-accent`

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-surface px-2.5 py-1.5 hover:border-border-default transition-colors">
      {/* 语义化图标 / 图片缩略图 */}
      <span className="flex-shrink-0 w-6 h-6 rounded-md bg-bg-hover flex items-center justify-center text-text-tertiary">
        {isImage ? <Thumbnail path={path} /> : <MetaIcon width={14} height={14} />}
      </span>
      {/* 文件名（truncate + title） */}
      <span className="min-w-0 flex-1 text-xs text-text-primary font-medium truncate" title={path}>
        {name}
      </span>
      {/* 类型标签 · 大小 */}
      <span className="flex-shrink-0 text-2xs text-text-tertiary tabular">
        {t(meta.label)} · {formatSize(size)}
      </span>
      {/* 操作按钮（text-2xs 克制样式） */}
      <span className="flex-shrink-0 flex items-center gap-0.5">
        <button type="button" onClick={handlePreview} className={`${baseBtn} text-accent`}>
          {t('artifactcard.preview')}
        </button>
        <button type="button" onClick={handleCopyPath} className={subtleBtn}>
          {t('artifactcard.copyPath')}
        </button>
        <button type="button" onClick={handleInsertContext} className={subtleBtn}>
          {t('artifactcard.insertContext')}
        </button>
      </span>
    </div>
  )
}

/* ============================================================
 * Thumbnail — 图片产物缩略图（通过 IPC 读取 dataURL）
 * ============================================================ */
function Thumbnail({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ark.fs
      .readFile(path)
      .then((fc) => {
        if (!cancelled && fc.content.startsWith('data:')) setSrc(fc.content)
      })
      .catch(() => {
        /* 缩略图加载失败时降级为占位 */
      })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!src) {
    return (
      <span className="w-6 h-6 rounded-md flex items-center justify-center">
        <Icon.File width={14} height={14} />
      </span>
    )
  }
  return <img src={src} alt={basename(path)} className="w-6 h-6 rounded-md object-cover" />
}
