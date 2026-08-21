/* ============================================================
 * ArkWork — Dock/BrowserPanel (v0.25.0 F2 P1 重构)
 *
 * 历史：
 *  v0.24.1：用 <webview>；切换侧栏标签会卸载组件 → webContents 销毁 → 内容清空 + agent CDP 句柄丢失
 *  v0.25.0 F2 P1：webContents 由主进程 view-manager 持有；BrowserPanel 仅做"占位 + bounds 同步"
 *    - 始终被 Inspector 挂载（display:none 隐藏）→ 切走不销毁
 *    - 浮窗按钮：调 ark.browserTabs.detach(tabId) 把同一 webContents 迁到独立 BrowserWindow
 *    - dock 与浮窗共享同一 webContents，两边只留一个可见
 *
 * 地址栏 / 前进后退 / agent 驱动 UI 沿用 v0.24.1 的本地 state（与 webview 无关）
 * webview 事件 → 通过主进程 push 的 meta 同步（agentDriven / url / title 由主进程维护）
 * ============================================================ */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import { Tooltip, EmptyState } from '../ui'
import type { BrowserTabMeta } from '@shared/types/ipc'

export function BrowserPanel() {
  const openPreviewUrl = useStore((s) => s.openPreviewUrl)
  const browserLoad = useStore((s) => s.browserLoad)
  const setBrowserLoad = useStore((s) => s.setBrowserLoad)
  const pushToast = useStore((s) => s.pushToast)

  const [tabId, setTabId] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [agentDriven, setAgentDriven] = useState(false)
  const [floating, setFloating] = useState(false) // 当前 Tab 是否已 detach 到独立窗口
  const placeholderRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** 正在等待回传的 agent 请求 id（null = 用户手动导航） */
  const pendingReqRef = useRef<string | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  /* ---- 启动时尝试认领已有 dock Tab（避免主进程 view-manager 已建好 Tab 被孤立） ---- */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await ark.browserTabs.list().catch(() => [])
      if (cancelled) return
      const dockTab = list.find((t) => t.host === 'dock' && t.url)
      if (dockTab) {
        setTabId(dockTab.tabId)
        setAddress(dockTab.url)
        setHistory([dockTab.url])
        setHistoryIdx(0)
        setAgentDriven(!!dockTab.agentDriven)
      }
    })()
    return () => { cancelled = true }
  }, [])

  /* ---- 占位区 ResizeObserver → 把 bounds 同步给主进程 view-manager ----
 * v0.25.1 bug-fix：传 viewport-relative 坐标（rect.x, rect.y）。renderer 视口原点
 * 与 contentView 局部坐标原点一致，主进程直接使用（不再减窗口屏幕位置）。修复
 * "侧栏浏览器错位遮挡（向左上偏移）"和旧版的"漂浮 (0,0)"。 */
  const forceSyncBounds = useCallback(() => {
    if (!tabId) return
    const el = placeholderRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    void ark.browserTabs.setBounds({
      tabId,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }).catch((err) => {
      console.warn('[BrowserPanel] setBounds failed', err)
    })
  }, [tabId])

  useEffect(() => {
    if (!tabId) return
    const el = placeholderRef.current
    if (!el) return
    const ro = new ResizeObserver(() => forceSyncBounds())
    ro.observe(el)
    forceSyncBounds()
    return () => ro.disconnect()
  }, [tabId, forceSyncBounds])

  /* ---- v0.25.0 F2 P1：宿主变化（关闭浮窗 / detach）后强制触发 setBounds，
     不依赖 ResizeObserver（折叠态 placeholder width:0 不会自动触发尺寸变化） ---- */
  useEffect(() => {
    if (!tabId) return
    const off = ark.browserTabs.onHostChanged(({ tabId: changedId, host }) => {
      if (changedId !== tabId) return
      setFloating(host === 'window')
      // 浮窗 → dock：立刻把当前占位区 bounds 推到主进程，主进程 attachTab 内已设 activeDockTabId，
      // setTabBounds 看到 w/h > 0 即 setVisible(true)
      if (host === 'dock') {
        // 下一帧再同步（React 已经把占位区尺寸恢复正常宽度）
        requestAnimationFrame(() => forceSyncBounds())
      }
    })
    return off
  }, [tabId, forceSyncBounds])

  /* ---- Tab 元数据变更监听（list 拉取：url / title / floating 状态） ---- */
  useEffect(() => {
    if (!tabId) return
    let cancelled = false
    const refresh = async () => {
      const list = await ark.browserTabs.list().catch(() => [])
      if (cancelled) return
      const meta = list.find((t) => t.tabId === tabId)
      if (!meta) return
      setFloating(meta.host === 'window')
      setAgentDriven(!!meta.agentDriven)
    }
    void refresh()
    const t = setInterval(refresh, 800)
    return () => { cancelled = true; clearInterval(t) }
  }, [tabId])

  /* ---- 向主进程回传加载结果（仅 agent 请求需要） ---- */
  const reportDone = (error?: string) => {
    const rid = pendingReqRef.current
    if (!rid) return
    pendingReqRef.current = null
    void ark.browser.loadDone(rid, error)
  }

  /** 创建 Tab 并加载 URL（首次进入浏览器时） */
  const ensureTabAndLoad = useCallback(async (url: string, agentRequestId?: string) => {
    let id = tabId
    if (!id) {
      const res = await ark.browserTabs.create({ url, newTab: true })
      id = res.tabId
      setTabId(id)
    } else {
      await ark.browserTabs.navigate({ tabId: id, url })
    }
    if (agentRequestId) await ark.browserTabs.setAgentDriven({ tabId: id, agentDriven: true })
    return id
  }, [tabId])

  const load = async (input: string, pushHistory = true, agentRequestId?: string) => {
    const trimmed = (input ?? '').trim()
    if (!trimmed) return
    let url = trimmed
    if (!/^(https?:\/\/|file:\/\/)/i.test(trimmed)) {
      const resolved = await ark.browser.resolve(trimmed).catch(() => '')
      if (!resolved) return
      url = resolved
    }
    pendingReqRef.current = agentRequestId ?? null
    setLoading(true)
    setAddress(input)
    setAgentDriven(!!agentRequestId)
    try {
      await ensureTabAndLoad(url, agentRequestId)
    } catch (err) {
      setLoading(false)
      reportDone((err as Error).message)
      pushToast({ type: 'danger', message: `加载失败：${(err as Error).message}`, duration: 3000 })
      return
    }
    if (pushHistory) {
      const next = [...history.slice(0, historyIdx + 1), url]
      setHistory(next)
      setHistoryIdx(next.length - 1)
    }
    // 兜底：10s 后无论是否 did-finish-load 都回传
    if (agentRequestId) {
      setTimeout(() => reportDone(), 10_000)
    } else {
      // 用户手动导航 → 加载完成由 did-finish-load 处理（由 store 的 browserLoad 流触发）
      setLoading(false)
    }
  }

  /* ---- agent 驱动：主进程 browser.open → 切到 Browser 标签 + 加载 ---- */
  useEffect(() => {
    if (!browserLoad) return
    const req = browserLoad
    setBrowserLoad(null)
    void load(req.url, true, req.requestId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserLoad])

  /* ---- 通过主进程 did-finish-load 事件清 loading（v0.25.0 F2 P1：主进程 webContents.send 推到 renderer） ---- */
  useEffect(() => {
    const off = ark.browser.onDidFinishLoad(() => setLoading(false))
    return off
  }, [])
  useEffect(() => {
    const off = ark.browser.onDidFailLoad(({ code, desc }) => {
      setLoading(false)
      pushToast({ type: 'danger', message: `加载失败（${code}）：${desc}`, duration: 3000 })
    })
    return off
  }, [pushToast])

  /* ---- v0.25.0 F2 P1：关闭当前 Tab（销毁 webContents，回到空态） ---- */
  const handleCloseTab = async () => {
    if (!tabId) return
    try {
      await ark.browserTabs.close({ tabId })
      setTabId(null)
      setAddress('')
      setHistory([])
      setHistoryIdx(-1)
      setAgentDriven(false)
      setFloating(false)
    } catch (err) {
      pushToast({ type: 'danger', message: `关闭失败：${(err as Error).message}`, duration: 3000 })
    }
  }
  /* ---- 清空当前内容：导航到 about:blank（保留 Tab 与 webContents，仅清页面） ---- */
  const handleClearContent = async () => {
    if (!tabId) return
    try {
      await ark.browserTabs.navigate({ tabId, url: 'about:blank' })
      setAddress('about:blank')
      setHistory([])
      setHistoryIdx(-1)
    } catch (err) {
      pushToast({ type: 'danger', message: `清空失败：${(err as Error).message}`, duration: 3000 })
    }
  }
  /* ---- 新建 Tab（导航到 about:blank，新 webContents） ---- */
  const handleNewTab = async () => {
    try {
      const res = await ark.browserTabs.create({ newTab: true })
      setTabId(res.tabId)
      setAddress('')
      setHistory([])
      setHistoryIdx(-1)
      setAgentDriven(false)
      setFloating(false)
    } catch (err) {
      pushToast({ type: 'danger', message: `新建失败：${(err as Error).message}`, duration: 3000 })
    }
  }

  const navigate = (idx: number) => {
    const key = history[idx]
    if (!key) return
    setHistoryIdx(idx)
    void load(key, false)
  }
  const canGoBack = historyIdx > 0
  const canGoForward = historyIdx >= 0 && historyIdx < history.length - 1

  /* ---- 浮窗按钮：toggle —— dock ↔ window 切换。
   当前 floating=true 时点浮窗按钮 → 主动 attach 回 dock（不等用户关浮窗） */
  const handleOpenFloating = async () => {
    if (!tabId) return
    try {
      if (floating) {
        await ark.browserTabs.attach({ tabId })
        pushToast({ type: 'success', message: '已把浮窗浏览器收回侧栏', duration: 2000 })
      } else {
        await ark.browserTabs.detach({ tabId })
        pushToast({ type: 'success', message: '已在浮窗打开浏览器，关闭浮窗可自动回到侧栏', duration: 2500 })
      }
    } catch (err) {
      pushToast({ type: 'danger', message: `浮窗切换失败：${(err as Error).message}`, duration: 3000 })
    }
  }
  /* ---- 兼容旧 openPreviewUrl：URL 标签走原 PreviewWindow 浮窗（不影响 view-manager dock 浏览器） ---- */
  const handlePreviewUrl = () => {
    if (!address) return
    openPreviewUrl(address)
  }

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏：地址栏 + 前进后退 + agent 状态 + 浮窗 */}
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
            if (e.key === 'Enter') void load(address)
          }}
          placeholder="输入 URL 或本地 HTML 路径 ⏎"
          className="flex-1 min-w-0 h-7 px-2.5 rounded-md bg-bg-input border border-border-subtle text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
        />
        {agentDriven && (
          <span className="flex-shrink-0 flex items-center gap-1 px-1.5 h-5 rounded bg-accent/15 text-accent text-[10px] font-medium">
            <Icon.Bolt width={11} height={11} /> agent 驱动
          </span>
        )}
        <Tooltip label="前往">
          <button
            onClick={() => void load(address)}
            className="w-7 h-7 flex items-center justify-center rounded-md bg-accent hover:bg-accent-hover text-text-inverse transition-colors"
          >
            <Icon.Send width={16} height={16} />
          </button>
        </Tooltip>
        <Tooltip label={floating ? '已在浮窗打开（关闭浮窗自动回到侧栏）' : '在浮窗打开（同一浏览器，关闭浮窗自动回到侧栏）'}>
          <button
            onClick={handleOpenFloating}
            disabled={!tabId}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Icon.ExternalLink width={16} height={16} />
          </button>
        </Tooltip>
        {/* v0.25.0 F2 P1：浏览器管理操作 —— 新建 / 清空 / 关闭 */}
        <Tooltip label="新建浏览器（about:blank，新 webContents）">
          <button
            onClick={handleNewTab}
            disabled={!tabId}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Icon.Plus width={14} height={14} />
          </button>
        </Tooltip>
        <Tooltip label="清空当前内容（导航到 about:blank，保留浏览器）">
          <button
            onClick={handleClearContent}
            disabled={!tabId}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Icon.Refresh width={14} height={14} />
          </button>
        </Tooltip>
        <Tooltip label="关闭浏览器（销毁 webContents）">
          <button
            onClick={handleCloseTab}
            disabled={!tabId}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-danger disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Icon.X width={14} height={14} />
          </button>
        </Tooltip>
      </div>

      {/* 内容区：占位 + 状态提示。
          v0.25.0 F2 P1：webContents 由主进程 view-manager 持有，dock 只负责 bounds 同步；
          切走时不卸载 → 切回来原页面/状态保留，agent CDP 句柄不丢。 */}
      <div
        ref={placeholderRef}
        className="flex-1 min-h-0 relative bg-white dark:bg-[#16181d]"
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-base/60 z-10 pointer-events-none">
            <span className="text-xs text-text-tertiary">加载中…</span>
          </div>
        )}
        {floating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-base/85 text-text-secondary gap-2">
            <Icon.ExternalLink width={28} height={28} className="text-accent" />
            <div className="text-xs">浏览器已在独立浮窗打开</div>
            <div className="text-2xs text-text-tertiary">关闭浮窗可自动回到此处；或重新点击浮窗按钮撤销</div>
          </div>
        )}
        {!tabId && !floating && (
          <EmptyState
            icon={<Icon.Bolt width={22} height={22} />}
            title="内嵌浏览器"
            hint="输入网址核实搜索结果，或打开任务产物 HTML 对照着聊；agent 也可自主在此测试网页"
          />
        )}
      </div>
    </div>
  )
}

/** 兼容默认导出（部分调用方可能用 default import） */
export default BrowserPanel
// 旧 API 调用占位：openPreviewUrl 仍由浮窗按钮通过 handlePreviewUrl 触发
export { BrowserPanel as BrowserPanelLegacy }
export type { BrowserTabMeta }