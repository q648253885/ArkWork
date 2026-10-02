/* ============================================================
 * ArkWork — FileLink（v0.31.0 D21 / v0.42.0 chip 化 / v0.45.0 D220）
 * 可点击的文件路径。契约：
 *  - 点击 → useOpenPath → fsSlice.openDoc（唯一门面，不直连 openPreview）；
 *  - 悬停提示走 HoverCard（C-20：交互区禁用原生 title）；
 *  - 语义上是 <button> 而非 <span>，键盘可达、焦点环统一；
 *  - 展示即全路径（D112：路径的唯一展示位，不做 basename 化）。
 * v0.42.0（对标 WorkBuddy 卡片处理）：纯文本 → inline chip ——
 * 文件图标 + mono 全路径 + 中性圆角底；hover 主色 + 下划线。
 * 只动呈现，不动任何契约。
 * v0.45.0（D220 · 用户反馈）：**文件夹不可点击** —— 点击目录本就无法预览
 *  （openDoc 走 readText 对目录必然失败）。判据两路：
 *   ① 调用方已知 kind 时直传 `dirKind`（产物卡的 artifact.kind，零开销）；
 *   ② 否则异步 `fs:pathKind` 轻探测（模块级缓存，路径为键；stat 完成前保持
 *     可点形态，完成后 isDir → 降级为非交互 chip）。目录态渲染为文件夹图标 +
 *     muted chip（无 hover 主色 / 无下划线 / 非按钮语义），提示「文件夹」。
 * ============================================================ */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HoverCard } from './HoverCard'
import { useOpenPath } from './useOpenPath'

export interface FileLinkProps {
  path: string
  /** 行号（有值时渲染 `path:line`，但仍整块打开该文件） */
  line?: number | null
  /**
   * v0.45.0（D220）：调用方已知的目录标记（如产物卡 `artifact.kind === 'dir'`）。
   * 传入时跳过异步探测：true → 直接非交互；false / undefined → 走 fs:pathKind 探测。
   */
  dirKind?: boolean
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

/** 14px 文件夹线性图标（目录态 chip 用，D220） */
function DirGlyph() {
  const stroke = { stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-70" aria-hidden="true">
      <path d="M1.5 3.5h4.2l1.6 1.8h7.2v8.2h-13z" {...stroke} />
    </svg>
  )
}

/* D220：pathKind 探测缓存（模块级，路径为键）。同一路径在整个应用生命周期内
   只探测一次 —— 目录/文件身份在一次会话内极少变化，缓存过期不做（诚实取舍：
   新建同名目录的窗口由「stat 完成前的可点形态」兜底，openDoc 对目录本就失败）。 */
const kindCache = new Map<string, boolean>()

function useIsDir(path: string, dirKind: boolean | undefined): boolean {
  const [isDir, setIsDir] = useState<boolean | null>(dirKind === true ? true : null)
  useEffect(() => {
    if (dirKind !== undefined) {
      setIsDir(dirKind)
      return
    }
    const cached = kindCache.get(path)
    if (cached !== undefined) {
      setIsDir(cached)
      return
    }
    let cancelled = false
    void window.ark.fs
      .pathKind(path)
      .then((k) => {
        kindCache.set(path, k.isDir)
        if (!cancelled) setIsDir(k.isDir)
      })
      .catch(() => {
        /* 探测失败（通道异常等）：保持可点形态，点击由 openDoc 兜底失败 —— 不阻塞渲染 */
      })
    return () => {
      cancelled = true
    }
  }, [path, dirKind])
  return isDir === true
}

export function FileLink({ path, line, dirKind, className = '' }: FileLinkProps) {
  const { t } = useTranslation()
  const open = useOpenPath()
  const isDir = useIsDir(path, dirKind)
  const display = `${path}${line != null ? `:${line}` : ''}`

  // v0.45.0（D220）：目录态 —— 非交互 chip（span 非 button，无 hover 主色 /
  // 下划线 / 焦点环），图标换文件夹形，提示「文件夹（不可预览）」。
  if (isDir) {
    return (
      <HoverCard tip={<span>{t('flow.pathIsDir')}</span>}>
        <span
          data-dir-link="true"
          className={`inline-flex max-w-full items-center gap-1 rounded bg-fill-secondary px-1.5 py-px font-mono text-left text-text-tertiary ${className}`}
        >
          <DirGlyph />
          <span className="truncate">{display}</span>
        </span>
      </HoverCard>
    )
  }

  return (
    <HoverCard tip={<span>{t('flow.openFile')}</span>}>
      <button
        type="button"
        onClick={() => open(path)}
        className={`inline-flex max-w-full items-center gap-1 rounded bg-fill-secondary px-1.5 py-px font-mono text-left text-text-secondary transition-colors hover:text-business-primary hover:underline focus-ring ${className}`}
      >
        <FileGlyph />
        <span className="truncate">{display}</span>
      </button>
    </HoverCard>
  )
}
