/* ============================================================
 * ArkWork — Dock/BrowserPanel (v0.24.1)
 * 浏览器面板：内嵌浏览器视图（右栏内嵌适合「对照着聊」）
 * - 地址栏 + 前进/后退 + 「在浮窗打开」（沉浸看 → PreviewWindow 浮窗）
 * - v0.24.1：由 <iframe> 升级为 <webview>（真实 Chromium 内核）：
 *     * 本地 HTML 直接 file:// 加载，相对资源（vendor/phaser.min.js 等）可正常加载
 *     * 支持 agent 自主驱动：主进程 browser.open → browser:load 请求到达时
 *       自动展开 Browser 标签并加载，加载完成回传 browser:load-done
 * - agent 驱动期间显示「agent 驱动」标识；用户手动导航后自动退出该标识
 * ============================================================ */
import { useEffect, useRef, useState } from 'react'
import React from 'react'
import { Icon } from '../../icons'
import { useStore } from '../../store'
import { ark } from '../../ipc/client'
import { Tooltip, EmptyState } from '../ui'

export function BrowserPanel() {
  const openPreviewUrl = useStore((s) => s.openPreviewUrl)
  const browserLoad = useStore((s) => s.browserLoad)
  const setBrowserLoad = useStore((s) => s.setBrowserLoad)

  const [address, setAddress] = useState('')
  const [src, setSrc] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [agentDriven, setAgentDriven] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const webviewRef = useRef<unknown>(null)
  /** 正在等待回传的 agent 请求 id（null = 用户手动导航） */
  const pendingReqRef = useRef<string | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  /** 向主进程回传加载结果（仅 agent 请求需要） */
  const reportDone = (error?: string) => {
    const rid = pendingReqRef.current
    if (!rid) return
    pendingReqRef.current = null
    void ark.browser.loadDone(rid, error)
  }

  const load = async (input: string, pushHistory = true, agentRequestId?: string) => {
    const trimmed = (input ?? '').trim()
    // 已是完整 URL（http/file://）直接使用；否则交给主进程解析（本地路径 → file://）
    let url = trimmed
    if (!/^(https?:\/\/|file:\/\/)/i.test(trimmed)) {
      url = await ark.browser.resolve(trimmed)
    }
    if (!url) return
    pendingReqRef.current = agentRequestId ?? null
    setLoading(true)
    setSrc(url)
    setAddress(input)
    if (agentRequestId) setAgentDriven(true)
    else setAgentDriven(false)
    if (pushHistory) {
      const next = [...history.slice(0, historyIdx + 1), url]
      setHistory(next)
      setHistoryIdx(next.length - 1)
    }
    // 兜底：webview 若未触发 did-finish-load（如同 URL 重复加载），10s 后仍回传
    if (agentRequestId) {
      setTimeout(() => reportDone(), 10_000)
    }
  }

  // agent 驱动：主进程 browser.open → 记录目标并展开 Browser 标签（store 已切 tab）
  useEffect(() => {
    if (!browserLoad) return
    const req = browserLoad
    setBrowserLoad(null)
    void load(req.url, true, req.requestId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserLoad])

  // webview 生命周期 → 回传加载结果
  useEffect(() => {
    const wv = webviewRef.current as {
      addEventListener?: (name: string, fn: (e: unknown) => void) => void
      removeEventListener?: (name: string, fn: (e: unknown) => void) => void
      getURL?: () => string
    } | null
    if (!wv?.addEventListener) return
    const onFinish = () => { setLoading(false); reportDone() }
    const onFail = (e: unknown) => {
      setLoading(false)
      const code = (e as { errorCode?: number; errorDescription?: string }).errorCode ?? -1
      const desc = (e as { errorDescription?: string }).errorDescription ?? '未知错误'
      reportDone(`加载失败（${code}）：${desc}`)
    }
    wv.addEventListener('did-finish-load', onFinish)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener?.('did-finish-load', onFinish)
      wv.removeEventListener?.('did-fail-load', onFail)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  const navigate = (idx: number) => {
    const key = history[idx]
    if (!key) return
    setHistoryIdx(idx)
    void load(key, false)
  }

  const canGoBack = historyIdx > 0
  const canGoForward = historyIdx >= 0 && historyIdx < history.length - 1

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
        <Tooltip label="在浮窗打开（沉浸看）">
          <button
            onClick={() => {
              if (!src) return
              openPreviewUrl(src)
            }}
            disabled={!src}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Icon.ExternalLink width={16} height={16} />
          </button>
        </Tooltip>
      </div>

      {/* 内容区：webview（真实 Chromium 内核；本地 HTML 相对资源可加载） */}
      <div className="flex-1 min-h-0 relative bg-white dark:bg-[#16181d]">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-base/60 z-10">
            <span className="text-xs text-text-tertiary">加载中…</span>
          </div>
        )}
        {!src ? (
          <EmptyState
            icon={<Icon.Bolt width={22} height={22} />}
            title="内嵌浏览器"
            hint="输入网址核实搜索结果，或打开任务产物 HTML 对照着聊；agent 也可自主在此测试网页"
          />
        ) : (
          React.createElement('webview', {
            ref: webviewRef as never,
            src,
            className: 'w-full h-full border-0',
            style: { display: 'flex' },
          })
        )}
      </div>
    </div>
  )
}
