/* ============================================================
 * ArkWork — Dock/BrowserPanel (v0.9.0 F903)
 * 浏览器面板：内嵌浏览器视图（右栏内嵌适合「对照着聊」）
 * - 地址栏 + 前进/后退 + 「在浮窗打开」（沉浸看 → PreviewWindow 浮窗）
 * - 本地 HTML 文件 → 读取内容以 srcdoc 渲染（避免 file:// 直载）
 * - 与 PreviewWindow 同一渲染器生态：默认右栏内嵌，浮窗是唯一交叉点（doc 01 §4.3）
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import { Tooltip, EmptyState } from '../ui'
/** 判断输入是 URL 还是本地文件路径 */
function normalizeTarget(input: string): { kind: 'url'; url: string } | { kind: 'file'; path: string } {
  const trimmed = input.trim()
  if (!trimmed) return { kind: 'url', url: '' }
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'url', url: trimmed }
  // 带 / 或 .html 后缀视为本地路径
  if (trimmed.includes('/') || /\.html?$/i.test(trimmed)) return { kind: 'file', path: trimmed }
  return { kind: 'url', url: `https://${trimmed}` }
}

export function BrowserPanel() {
  const openPreviewUrl = useStore((s) => s.openPreviewUrl)
  const [address, setAddress] = useState('')
  const [current, setCurrent] = useState<{ kind: 'url'; url: string } | { kind: 'file'; path: string } | null>(null)
  const [doc, setDoc] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const load = async (target: { kind: 'url'; url: string } | { kind: 'file'; path: string }, pushHistory = true) => {
    setLoading(true)
    setDoc('')
    setCurrent(target)
    if (target.kind === 'file') {
      try {
        const res = await ark.fs.readFile(target.path)
        setDoc(res.content)
      } catch {
        setDoc(`<div style="font-family:system-ui;padding:24px;color:#c0392b">无法读取文件：${target.path}</div>`)
      }
    } else {
      setDoc('')
    }
    setLoading(false)
    if (pushHistory) {
      const key = target.kind === 'url' ? target.url : target.path
      const next = [...history.slice(0, historyIdx + 1), key]
      setHistory(next)
      setHistoryIdx(next.length - 1)
    }
  }

  const navigate = (idx: number) => {
    const key = history[idx]
    if (!key) return
    setHistoryIdx(idx)
    void load(/^https?:\/\//i.test(key) ? { kind: 'url', url: key } : { kind: 'file', path: key }, false)
  }

  const canGoBack = historyIdx > 0
  const canGoForward = historyIdx >= 0 && historyIdx < history.length - 1

  const iframeSrc = current?.kind === 'url' ? current.url : undefined

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏：地址栏 + 前进后退 + 浮窗 */}
      <div className="flex items-center gap-1.5 px-2.5 py-2 flex-shrink-0 border-b border-border-subtle">
<Tooltip label="后退">
        <button
          onClick={() => navigate(historyIdx - 1)}
          disabled={!canGoBack}
          className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"

        >
          <Icon.ChevronLeft width={16} height={16} />
        </button>
</Tooltip>
<Tooltip label="前进">
        <button
          onClick={() => navigate(historyIdx + 1)}
          disabled={!canGoForward}
          className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"

        >
          <Icon.ChevronRight width={16} height={16} />
        </button>
</Tooltip>
        <input
          ref={inputRef}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(normalizeTarget(address))
          }}
          placeholder="输入 URL 或本地 HTML 路径 ⏎"
          className="flex-1 min-w-0 h-7 px-2.5 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
        />
<Tooltip label="前往">
        <button
          onClick={() => void load(normalizeTarget(address))}
          className="w-7 h-7 flex items-center justify-center rounded-md bg-accent hover:bg-accent-hover text-text-inverse transition-colors"

        >
          <Icon.Send width={16} height={16} />
        </button>
</Tooltip>
<Tooltip label="在浮窗打开（沉浸看）">
        <button
          onClick={() => {
            if (!current) return
            const key = current.kind === 'url' ? current.url : current.path
            if (/^https?:\/\//i.test(key)) openPreviewUrl(key)
            else void load({ kind: 'file', path: key })
          }}
          disabled={!current}
          className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"

        >
          <Icon.ExternalLink width={16} height={16} />
        </button>
</Tooltip>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 relative bg-white dark:bg-[#16181d]">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-base/60 z-10">
            <span className="text-xs text-text-tertiary">加载中…</span>
          </div>
        )}
        {!current ? (
          <EmptyState
            icon={<Icon.Bolt width={22} height={22} />}
            title="内嵌浏览器"
            hint="输入网址核实搜索结果，或打开任务产物 HTML 对照着聊"
          />
        ) : current.kind === 'file' ? (
          <iframe
            title="本地 HTML 预览"
            srcDoc={doc}
            sandbox="allow-scripts allow-same-origin allow-forms"
            className="w-full h-full border-0"
          />
        ) : (
          <iframe
            title="内嵌浏览器"
            src={iframeSrc}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            className="w-full h-full border-0"
          />
        )}
      </div>
    </div>
  )
}
