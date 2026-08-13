/* ============================================================
 * ArkWork — PreviewWindow (v0.7.0)
 * 浮动可拖拽可缩放预览窗，叠加在对话区之上。
 *
 * 结构：标题栏（可拖） / 标签栏（≥2 时） / 工具栏 / 内容区 / 状态栏 + 8 向缩放手柄
 * 交互：
 *   - 拖拽标题栏移动窗口（写入 store.bounds）
 *   - 8 边/角缩放，最小 480×320，最大 90% 视口
 *   - 标签：单击切换、双击钉住（视觉态）、✕ 关闭
 *   - 渲染器选择器：覆盖当前标签的渲染类型（本地 state）
 *   - 工具栏按渲染器配置渲染动作（见 registry.ts）
 *   - Esc 关闭（避开 dialog/palette）
 *   - 最小化：收为底部胶囊；点击胶囊恢复
 * 文本类渲染器的内容由本组件懒加载并缓存（按 tabId）；
 * 图片/兜底/浏览器渲染器自行读取文件，本组件仅透传 path/url。
 * ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import type { PreviewTab, RendererKind } from '../../store'
import { ark } from '../../ipc/client'
import { Icon } from '../../icons'
import { RENDERER_REGISTRY, VIEW_MODES, defaultViewMode } from './registry'
import { Tooltip } from '../ui'

/* ---- 常量 ---- */
const MIN_W = 480
const MIN_H = 320
const TEXT_RENDERERS = new Set<RendererKind>(['markdown', 'code', 'svg', 'table'])
type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

type TabContent =
  | { state: 'loading'; path: string }
  | { state: 'loaded'; fc: { content: string; language: string; size: number; lines: number }; path: string }
  | { state: 'error'; err: string; path: string }

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

function extOf(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i >= 0 ? b.slice(i + 1).toUpperCase() : 'FILE'
}

export function PreviewWindow() {
  const previewWindow = useStore((s) => s.previewWindow)
  const minimizedPreviews = useStore((s) => s.minimizedPreviews)

  return (
    <>
      {previewWindow && <FloatingWindow pw={previewWindow} />}
      {minimizedPreviews.length > 0 && <MinimizedCapsules />}
    </>
  )
}

/* ============================================================
 * FloatingWindow — 单个浮窗实例
 * ============================================================ */
function FloatingWindow({ pw }: { pw: NonNullable<ReturnType<typeof useStore.getState>['previewWindow']> }) {
  const closePreview = useStore((s) => s.closePreview)
  const minimizePreview = useStore((s) => s.minimizePreview)
  const closePreviewTab = useStore((s) => s.closePreviewTab)
  const setActivePreviewTab = useStore((s) => s.setActivePreviewTab)
  const updatePreviewBounds = useStore((s) => s.updatePreviewBounds)
  const pushToast = useStore((s) => s.pushToast)

  const { bounds, pinned, tabs, activeTabId } = pw

  /* ---- 本地 UI 状态 ---- */
  const [maximized, setMaximized] = useState(false)
  const prevBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const [rendererOverrides, setRendererOverrides] = useState<Record<string, RendererKind>>({})
  const [viewModes, setViewModes] = useState<Record<string, string>>({})
  const [pinnedTabs, setPinnedTabs] = useState<Set<string>>(new Set())
  const [selectorOpen, setSelectorOpen] = useState(false)

  /* ---- 内容缓存（ref + state 双写，避免闭包失效） ---- */
  const contentsRef = useRef<Record<string, TabContent>>({})
  const [contents, setContents] = useState<Record<string, TabContent>>({})
  const updateContent = useCallback((tabId: string, c: TabContent) => {
    contentsRef.current = { ...contentsRef.current, [tabId]: c }
    setContents(contentsRef.current)
  }, [])

  /* ---- 当前激活标签 ---- */
  const activeTab = useMemo<PreviewTab | null>(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId],
  )
  const activeRenderer: RendererKind =
    (activeTab && rendererOverrides[activeTab.id]) ?? activeTab?.renderer ?? 'fallback'
  const viewMode =
    viewModes[activeTabId] ?? defaultViewMode(activeRenderer) ?? 'render'

  /* ---- 文本类内容懒加载 ---- */
  const loadContent = useCallback(
    (tab: PreviewTab, force: boolean) => {
      if (tab.target.kind === 'url') return
      const kind = rendererOverrides[tab.id] ?? tab.renderer
      if (!TEXT_RENDERERS.has(kind)) return
      const path = tab.target.path
      const existing = contentsRef.current[tab.id]
      if (
        !force &&
        existing &&
        (existing.state === 'loaded' || existing.state === 'loading') &&
        existing.path === path
      ) {
        return
      }
      let cancelled = false
      updateContent(tab.id, { state: 'loading', path })
      ark.fs
        .readFile(path)
        .then((fc) => {
          if (!cancelled) {
            updateContent(tab.id, {
              state: 'loaded',
              fc: { content: fc.content, language: fc.language, size: fc.size, lines: fc.lines },
              path,
            })
          }
        })
        .catch((e) => {
          if (!cancelled) {
            updateContent(tab.id, {
              state: 'error',
              err: e instanceof Error ? e.message : String(e),
              path,
            })
          }
        })
    },
    [rendererOverrides, updateContent],
  )

  useEffect(() => {
    if (activeTab) loadContent(activeTab, false)
  }, [activeTab, loadContent])

  /* ---- 拖拽（标题栏） ---- */
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; w: number; h: number } | null>(null)
  const onTitleMouseDown = (e: React.MouseEvent) => {
    if (maximized || e.button !== 0) return
    const cur = useStore.getState().previewWindow
    if (!cur) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: cur.bounds.x,
      origY: cur.bounds.y,
      w: cur.bounds.w,
      h: cur.bounds.h,
    }
    e.preventDefault()
  }

  /* ---- 缩放（8 向） ---- */
  const resizeRef = useRef<{ dir: ResizeDir; startX: number; startY: number; orig: typeof bounds } | null>(null)
  const startResize = (dir: ResizeDir) => (e: React.MouseEvent) => {
    if (maximized || e.button !== 0) return
    const cur = useStore.getState().previewWindow
    if (!cur) return
    resizeRef.current = { dir, startX: e.clientX, startY: e.clientY, orig: { ...cur.bounds } }
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      const r = resizeRef.current
      const cur = useStore.getState().previewWindow
      if (!cur) return
      if (d) {
        const vw = window.innerWidth
        const vh = window.innerHeight
        let nx = d.origX + (e.clientX - d.startX)
        let ny = d.origY + (e.clientY - d.startY)
        // 保证标题栏始终可达
        nx = Math.max(-d.w + 120, Math.min(vw - 120, nx))
        ny = Math.max(0, Math.min(vh - 40, ny))
        updatePreviewBounds({ ...cur.bounds, x: nx, y: ny })
      } else if (r) {
        const dx = e.clientX - r.startX
        const dy = e.clientY - r.startY
        const maxW = window.innerWidth * 0.9
        const maxH = window.innerHeight * 0.9
        let { x, y, w, h } = r.orig
        if (r.dir.includes('e')) w = Math.min(maxW, Math.max(MIN_W, r.orig.w + dx))
        if (r.dir.includes('s')) h = Math.min(maxH, Math.max(MIN_H, r.orig.h + dy))
        if (r.dir.includes('w')) {
          w = Math.min(maxW, Math.max(MIN_W, r.orig.w - dx))
          x = r.orig.x + (r.orig.w - w)
        }
        if (r.dir.includes('n')) {
          h = Math.min(maxH, Math.max(MIN_H, r.orig.h - dy))
          y = r.orig.y + (r.orig.h - h)
        }
        updatePreviewBounds({ x, y, w, h })
      }
    }
    const onUp = () => {
      const active = dragRef.current || resizeRef.current
      dragRef.current = null
      resizeRef.current = null
      if (active) document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [updatePreviewBounds])

  /* ---- Esc 关闭（避开 dialog/palette/settings） ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = useStore.getState()
      if (!s.previewWindow) return
      if (s.confirmDialog.open || s.cmdPaletteOpen || s.modulePage || s.quickOpenOpen) return
      s.closePreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---- 最大化 ---- */
  const toggleMaximize = () => {
    const cur = useStore.getState().previewWindow
    if (!cur) return
    if (!maximized) {
      prevBoundsRef.current = { ...cur.bounds }
      const vw = window.innerWidth
      const vh = window.innerHeight
      updatePreviewBounds({ x: Math.round(vw * 0.05), y: Math.round(vh * 0.05), w: Math.round(vw * 0.9), h: Math.round(vh * 0.9) })
      setMaximized(true)
    } else {
      if (prevBoundsRef.current) updatePreviewBounds(prevBoundsRef.current)
      setMaximized(false)
    }
  }

  /* ---- 渲染器切换 ---- */
  const setRenderer = (kind: RendererKind) => {
    if (!activeTab) return
    setRendererOverrides((prev) => ({ ...prev, [activeTab.id]: kind }))
    const dm = defaultViewMode(kind)
    if (dm) setViewModes((prev) => ({ ...prev, [activeTab.id]: dm }))
    setSelectorOpen(false)
    if (activeTab.target.kind === 'file') loadContent({ ...activeTab, renderer: kind }, false)
  }

  const setViewMode = (m: string) => {
    setViewModes((prev) => ({ ...prev, [activeTabId]: m }))
  }

  /* ---- 工具栏动作 ---- */
  const activePath = activeTab?.target.kind === 'file' ? activeTab.target.path : null
  const activeUrl = activeTab?.target.kind === 'url' ? activeTab.target.url : null
  const activeContent =
    activeTab && contents[activeTab.id]?.state === 'loaded'
      ? (contents[activeTab.id] as { state: 'loaded'; fc: { content: string } }).fc.content
      : null

  const handleCopy = async () => {
    try {
      if (activeContent != null) await navigator.clipboard.writeText(activeContent)
      else if (activePath) await navigator.clipboard.writeText(activePath)
      else if (activeUrl) await navigator.clipboard.writeText(activeUrl)
      pushToast({ type: 'success', message: '已复制', duration: 1500 })
    } catch {
      pushToast({ type: 'danger', message: '复制失败', duration: 1500 })
    }
  }

  const handleExport = () => {
    if (!activeContent && !activePath) return
    const name = activePath ? basename(activePath) : 'preview.txt'
    const blob = new Blob([activeContent ?? ''], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleReveal = () => {
    if (activePath) void ark.fs.revealInFolder(activePath)
  }

  const handleRefresh = () => {
    if (!activeTab) return
    // 清缓存后重载
    const next = { ...contentsRef.current }
    delete next[activeTab.id]
    contentsRef.current = next
    setContents(next)
    loadContent(activeTab, true)
  }

  const handleNewTab = () => {
    if (!activeTab) {
      pushToast({ type: 'warning', message: '请从文件树打开文件以新建标签页', duration: 3000 })
      return
    }
    if (activeTab.target.kind === 'file') {
      void useStore.getState().openPreview(activeTab.target.path)
    } else {
      // v0.9.1：URL 标签支持复制新建（走 openPreviewUrl 同一管线）
      useStore.getState().openPreviewUrl(activeTab.target.url)
    }
  }

  const toggleTabPin = (id: string) => {
    setPinnedTabs((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  /* ---- 渲染内容 ---- */
  const renderContent = () => {
    if (!activeTab) {
      return (
        <div className="h-full flex flex-col items-center justify-center text-text-tertiary">
          <Icon.Eye width={22} height={22} />
          <div className="text-xs mt-2">无标签页</div>
          <div className="text-2xs mt-1">从文件树打开文件，或使用标题栏 + 复制当前标签</div>
        </div>
      )
    }

    // URL 标签：强制浏览器渲染
    if (activeTab.target.kind === 'url') {
      const Comp = RENDERER_REGISTRY.browser.component
      return <Comp url={activeTab.target.url} viewMode={viewMode} />
    }

    const path = activeTab.target.path
    const Comp = RENDERER_REGISTRY[activeRenderer].component

    // 非文本类渲染器：直接传 path
    if (activeRenderer === 'image') return <Comp path={path} />
    if (activeRenderer === 'fallback') return <Comp path={path} />
    if (activeRenderer === 'browser') return <Comp path={path} viewMode={viewMode} />

    // 文本类：读取缓存内容
    const tc = contents[activeTab.id]
    if (!tc || tc.state === 'loading') {
      return (
        <div className="h-full flex items-center justify-center text-text-tertiary text-xs">
          加载中…
        </div>
      )
    }
    if (tc.state === 'error') {
      return (
        <div className="h-full flex flex-col items-center justify-center text-text-tertiary">
          <Icon.X width={20} height={20} className="text-danger mb-2" />
          <div className="text-xs text-danger">加载失败</div>
          <div className="text-2xs mt-1 max-w-[80%] text-center break-all">{tc.err}</div>
          <button
            type="button"
            onClick={handleRefresh}
            className="mt-3 px-3 py-1 text-2xs text-text-secondary border border-border-default rounded-md hover:bg-bg-hover transition-colors"
          >
            重试
          </button>
        </div>
      )
    }
    const fc = tc.fc
    if (activeRenderer === 'markdown') return <Comp content={fc.content} viewMode={viewMode} />
    if (activeRenderer === 'code') return <Comp content={fc.content} language={fc.language} />
    if (activeRenderer === 'svg') return <Comp content={fc.content} viewMode={viewMode} />
    if (activeRenderer === 'table') return <Comp content={fc.content} />
    return <Comp path={path} />
  }

  /* ---- 状态栏信息 ---- */
  const tc = activeTab ? contents[activeTab.id] : undefined
  const statusInfo = useMemo(() => {
    if (!activeTab) return { left: '无文件', saved: '' }
    if (activeTab.target.kind === 'url') {
      return { left: activeTab.target.url, saved: '已就绪' }
    }
    const path = activeTab.target.path
    const typeLabel = RENDERER_REGISTRY[activeRenderer].label
    if (tc?.state === 'loaded') {
      return {
        left: `${formatSize(tc.fc.size)} · ${tc.fc.lines} 行 · UTF-8 · ${typeLabel}`,
        saved: '已加载',
      }
    }
    if (tc?.state === 'loading') return { left: `${extOf(path)} · ${typeLabel}`, saved: '加载中…' }
    if (tc?.state === 'error') return { left: `${extOf(path)} · ${typeLabel}`, saved: '加载失败' }
    return { left: `${extOf(path)} · ${typeLabel}`, saved: '已就绪' }
  }, [activeTab, activeRenderer, tc])

  const title = activeTab
    ? activeTab.target.kind === 'file'
      ? basename(activeTab.target.path)
      : activeTab.target.url
    : '预览'

  const entry = RENDERER_REGISTRY[activeRenderer]
  const showTabBar = tabs.length >= 2

  return (
    <div
      className={`absolute ${pinned ? 'z-[60]' : 'z-[50]'}`}
      style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }}
    >
      <div className="absolute inset-0 flex flex-col bg-bg-overlay border border-border-default rounded-xl shadow-panel overflow-hidden scale-in">
      {/* ===== 标题栏（可拖拽） ===== */}
      <div
        onMouseDown={onTitleMouseDown}
        onDoubleClick={toggleMaximize}
        className="flex items-center gap-2 h-9 px-3 flex-shrink-0 bg-bg-surface border-b border-border-subtle cursor-grab active:cursor-grabbing select-none"
      >
        {/* 文件名 */}
        <Icon.File width={16} height={16} className="text-text-tertiary flex-shrink-0" />
        <span className="text-xs text-text-primary font-medium truncate flex-1 min-w-0" title={title}>
          {title}
        </span>

        {/* 渲染器选择器 */}
        <div className="relative flex-shrink-0">
          <button
            type="button"
            onClick={() => setSelectorOpen((o) => !o)}
            className="flex items-center gap-1 px-1.5 py-0.5 text-2xs text-text-secondary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors"
          >
            {entry.label}
            <Icon.ChevronDown width={16} height={16} />
          </button>
          {selectorOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setSelectorOpen(false)} />
              <div className="absolute right-0 top-full mt-0.5 z-20 bg-bg-overlay border border-border-default rounded-md shadow-panel py-1 min-w-[120px] scale-in">
                {(Object.keys(RENDERER_REGISTRY) as RendererKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setRenderer(k)}
                    className={`w-full flex items-center px-2.5 py-1 text-xs transition-colors ${
                      k === activeRenderer
                        ? 'text-accent bg-accent-soft'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    }`}
                  >
                    {RENDERER_REGISTRY[k].label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 窗口控制 */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <TitleBtn label="新标签页（复制当前）" onClick={handleNewTab}>
            <Icon.Plus width={16} height={16} />
          </TitleBtn>
          <TitleBtn label="最小化" onClick={minimizePreview}>
            <span className="text-[11px] leading-none">_</span>
          </TitleBtn>
          <TitleBtn label={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
            <span className="text-[10px] leading-none">▢</span>
          </TitleBtn>
          <TitleBtn label="关闭 (Esc)" onClick={closePreview} danger>
            <Icon.X width={16} height={16} />
          </TitleBtn>
        </div>
      </div>

      {/* ===== 标签栏 ===== */}
      {showTabBar && (
        <div className="flex items-center gap-0.5 px-2 h-8 flex-shrink-0 bg-bg-surface border-b border-border-subtle overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const isPinned = tab.mode === 'pinned' || pinnedTabs.has(tab.id)
            const name =
              tab.target.kind === 'file' ? basename(tab.target.path) : tab.target.url
            return (
              <Tooltip label={name} desc="点击激活，双击固定/取消固定">
                <div
                  key={tab.id}
                  onClick={() => setActivePreviewTab(tab.id)}
                  onDoubleClick={() => toggleTabPin(tab.id)}
                  className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 h-6 rounded-md text-2xs cursor-pointer transition-colors flex-shrink-0 ${
                    isActive
                      ? 'bg-bg-overlay text-text-primary border border-border-subtle'
                      : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  {isPinned && <Icon.Star width={16} height={16} className="text-accent flex-shrink-0" />}
                  <span className={`truncate max-w-[140px] ${!isPinned ? 'italic' : ''}`}>{name}</span>
                  <Tooltip label="关闭标签" desc="关闭当前预览标签">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        closePreviewTab(tab.id)
                      }}
                      className="p-0.5 rounded hover:bg-bg-active text-text-tertiary hover:text-text-primary transition-colors"
                    >
                      <Icon.X width={16} height={16} />
                    </button>
                  </Tooltip>
                </div>
              </Tooltip>
            )
          })}

        </div>
      )}

      {/* ===== 工具栏 ===== */}
      <Toolbar
        actions={entry.toolbarActions}
        renderer={activeRenderer}
        viewMode={viewMode}
        onViewMode={setViewMode}
        onCopy={handleCopy}
        onExport={handleExport}
        onReveal={handleReveal}
        onRefresh={handleRefresh}
        canExport={activeContent != null}
      />

      {/* ===== 内容区 ===== */}
      <div className="flex-1 min-h-0 overflow-hidden bg-bg-base">{renderContent()}</div>

      {/* ===== 状态栏 ===== */}
      <div className="flex items-center gap-2 h-6 px-3 flex-shrink-0 bg-bg-surface border-t border-border-subtle">
        <span className="text-2xs text-text-tertiary truncate flex-1 min-w-0 font-mono" title={statusInfo.left}>
          {statusInfo.left}
        </span>
        <span
          className={`text-2xs flex items-center gap-1 flex-shrink-0 ${
            statusInfo.saved === '加载失败'
              ? 'text-danger'
              : statusInfo.saved === '已加载' || statusInfo.saved === '已就绪'
                ? 'text-success'
                : 'text-text-tertiary'
          }`}
        >
          {statusInfo.saved === '已加载' && <Icon.Check width={16} height={16} />}
          {statusInfo.saved}
        </span>
      </div>

      </div>
      {/* ===== 缩放手柄（外层，避免被 overflow-hidden 裁剪） ===== */}
      {!maximized && <ResizeHandles onResize={startResize} />}
    </div>
  )
}

/* ============================================================
 * TitleBtn — 标题栏图标按钮
 * ============================================================ */
function TitleBtn({
  label,
  onClick,
  children,
  danger,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors ${
        danger
          ? 'text-text-tertiary hover:bg-danger hover:text-white'
          : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  )
}

/* ============================================================
 * Toolbar — 上下文敏感工具栏
 * ============================================================ */
function Toolbar({
  actions,
  renderer,
  viewMode,
  onViewMode,
  onCopy,
  onExport,
  onReveal,
  onRefresh,
  canExport,
}: {
  actions: string[]
  renderer: RendererKind
  viewMode: string
  onViewMode: (m: string) => void
  onCopy: () => void
  onExport: () => void
  onReveal: () => void
  onRefresh: () => void
  canExport: boolean
}) {
  const modes = VIEW_MODES[renderer]
  return (
    <div className="flex items-center gap-1 px-2 h-8 flex-shrink-0 bg-bg-overlay border-b border-border-subtle">
      {actions.map((act) => {
        if (act === 'mode-switch' || act === 'viewport') {
          if (!modes) return null
          return (
            <div key={act} className="flex items-center gap-0.5 bg-bg-surface rounded-md p-0.5">
              {modes.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => onViewMode(m.value)}
                  className={`px-1.5 py-0.5 text-2xs rounded transition-colors ${
                    viewMode === m.value
                      ? 'bg-bg-active text-text-primary'
                      : 'text-text-tertiary hover:text-text-primary'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )
        }
        if (act === 'copy') {
          return (
            <ToolBtn key={act} label="复制" onClick={onCopy}>
              <Icon.Copy width={16} height={16} />
            </ToolBtn>
          )
        }
        if (act === 'export') {
          return (
            <ToolBtn key={act} label="导出" onClick={onExport} disabled={!canExport}>
              <Icon.Download width={16} height={16} />
            </ToolBtn>
          )
        }
        if (act === 'reveal') {
          return (
            <ToolBtn key={act} label="在文件夹中显示" onClick={onReveal}>
              <Icon.ExternalLink width={16} height={16} />
            </ToolBtn>
          )
        }
        if (act === 'refresh') {
          return (
            <ToolBtn key={act} label="刷新" onClick={onRefresh}>
              <Icon.Refresh width={16} height={16} />
            </ToolBtn>
          )
        }
        return null
      })}
    </div>
  )
}

function ToolBtn({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="w-7 h-6 flex items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
    >
      {children}
    </button>
  )
}

/* ============================================================
 * ResizeHandles — 8 向缩放手柄
 * ============================================================ */
function ResizeHandles({ onResize }: { onResize: (dir: ResizeDir) => (e: React.MouseEvent) => void }) {
  const edge = 'absolute z-[5]'
  const handles: { dir: ResizeDir; style: React.CSSProperties; cursor: string }[] = [
    { dir: 'n', style: { top: -3, left: 10, right: 10, height: 6 }, cursor: 'ns-resize' },
    { dir: 's', style: { bottom: -3, left: 10, right: 10, height: 6 }, cursor: 'ns-resize' },
    { dir: 'e', style: { right: -3, top: 10, bottom: 10, width: 6 }, cursor: 'ew-resize' },
    { dir: 'w', style: { left: -3, top: 10, bottom: 10, width: 6 }, cursor: 'ew-resize' },
    { dir: 'ne', style: { top: -3, right: -3, width: 12, height: 12 }, cursor: 'nesw-resize' },
    { dir: 'nw', style: { top: -3, left: -3, width: 12, height: 12 }, cursor: 'nwse-resize' },
    { dir: 'se', style: { bottom: -3, right: -3, width: 12, height: 12 }, cursor: 'nwse-resize' },
    { dir: 'sw', style: { bottom: -3, left: -3, width: 12, height: 12 }, cursor: 'nesw-resize' },
  ]
  return (
    <>
      {handles.map((h) => (
        <div
          key={h.dir}
          onMouseDown={onResize(h.dir)}
          className={edge}
          style={{ ...h.style, cursor: h.cursor }}
        />
      ))}
    </>
  )
}

/* ============================================================
 * MinimizedCapsules — 底部最小化胶囊条
 * ============================================================ */
function MinimizedCapsules() {
  const minimizedPreviews = useStore((s) => s.minimizedPreviews)
  const restoreMinimized = useStore((s) => s.restoreMinimized)
  const closePreview = useStore((s) => s.closePreview)

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[55] flex items-center gap-1.5 px-2 py-1.5 bg-bg-overlay border border-border-default rounded-xl shadow-panel scale-in">
      {minimizedPreviews.map((c) => (
        <Tooltip label={`复：${c.title}`} desc="点击恢复最小化的预览窗口">
          <div
            key={c.id}
            className="group flex items-center gap-1.5 pl-2 pr-1 h-7 rounded-lg bg-bg-surface border border-border-subtle hover:bg-bg-hover transition-colors cursor-pointer"
            onClick={() => restoreMinimized(c.id)}
          >
            <span className="text-sm leading-none">{c.icon}</span>
            <span className="text-2xs text-text-secondary truncate max-w-[160px]">{c.title}</span>
            {c.tabCount > 1 && (
              <span className="text-2xs text-text-tertiary tabular">{c.tabCount}</span>
            )}
            <Tooltip label="关闭" desc="恢复后立即关闭">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  // 恢复后立即关闭 → 等效于从最小化列表移除该胶囊
                  restoreMinimized(c.id)
                  closePreview()
                }}
                className="ml-0.5 w-4 h-4 flex items-center justify-center rounded text-text-tertiary hover:bg-danger hover:text-white transition-colors"
              >
                <Icon.X width={16} height={16} />
              </button>
            </Tooltip>
          </div>
        </Tooltip>
      ))}
    </div>
  )
}
