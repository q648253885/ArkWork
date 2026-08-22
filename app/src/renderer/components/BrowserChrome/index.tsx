/* ============================================================
 * ArkWork — BrowserChrome（v0.26.0 P0 / 浏览器重设计 §2）
 *
 * 浮窗（float）与 dock 迷你路由（dock）共用的浏览器 chrome：
 *   float：40px 紧凑单行（WebContentsView 从 y=40 起叠加，空间固定）；
 *          标签 >1 时用循环 chip 切换（y>40 区域会被 view 盖住，放不下 popover）。
 *   dock ：标签条 + 导航行 + 状态栏三行完整形态。
 *
 * 状态同步现状（缺口）：主进程无 tab 列表/URL/loading 广播，
 * did-finish-load/did-fail-load 仅推主窗口 —— 采用 800ms 轮询 list() +
 * pendingRef 结算启发式，辅以 onHostChanged 订阅；back/forward 用本地历史栈
 * （browserTabs 无对应 IPC 原语）。
 *
 * 纪律：禁止声明 const ark / let ark（contextBridge 属性不可 shadow，
 * 会 SyntaxError）；一律 window.ark.* 或解构属性。
 * ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserTabMeta } from '@shared/types/ipc'
import { NavRow } from './NavRow'
import { TabStrip } from './TabStrip'
import { StatusBar } from './StatusBar'

const POLL_MS = 800
const NAV_TIMEOUT_MS = 15000
const DIRECT_URL_RE = /^(https?:\/\/|file:\/\/|about:)/i

interface HistState {
  items: string[]
  idx: number
}

export function BrowserChrome({ mode = 'float' }: { mode?: 'float' | 'dock' }) {
  const [tabs, setTabs] = useState<BrowserTabMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [hist, setHist] = useState<HistState>({ items: [], idx: -1 })

  const currentIdRef = useRef<string | null>(null)
  const addressRef = useRef('')
  const addrFocusedRef = useRef(false)
  const tabsRef = useRef<BrowserTabMeta[]>([])
  const pendingRef = useRef<{ url: string; since: number } | null>(null)
  const lastMetaUrlRef = useRef<string | null>(null)

  const applyCurrentId = useCallback((id: string | null) => {
    currentIdRef.current = id
    setCurrentId(id)
  }, [])

  const applyAddress = useCallback((value: string) => {
    addressRef.current = value
    setAddress(value)
  }, [])

  const setAddrFocused = useCallback((focused: boolean) => {
    addrFocusedRef.current = focused
  }, [])

  const current = useMemo(() => tabs.find((t) => t.tabId === currentId) ?? null, [tabs, currentId])

  /* 导航：非直连 URL 先经主进程 resolve（本地路径 → file:// 等） */
  const load = useCallback(
    async (raw: string, push = true) => {
      const input = raw.trim()
      if (!input) return
      const { browserTabs, browser } = window.ark
      let target = input
      if (!DIRECT_URL_RE.test(input)) {
        try {
          target = await browser.resolve(input)
        } catch {
          /* resolve 失败按原文尝试 */
        }
      }
      let tabId = currentIdRef.current
      if (tabId) {
        const res = await browserTabs.navigate({ tabId, url: target })
        if (!res.ok) tabId = null
      }
      if (!tabId) {
        // createTab 固定 host='dock'：float 模式下「无当前标签时导航」的语义 =
        // 弹出一个承载新页面的独立浮窗（本窗口保持提示态）
        const created = await browserTabs.create({ url: target, newTab: true })
        if (mode === 'float') {
          try {
            await browserTabs.detach({ tabId: created.tabId })
          } catch {
            /* 主窗口缺失等场景忽略 */
          }
          setStatusText('已在新窗口打开')
          return
        }
        tabId = created.tabId
        void browserTabs.activate({ tabId })
        applyCurrentId(tabId)
      }
      pendingRef.current = { url: target, since: Date.now() }
      lastMetaUrlRef.current = target
      setLoading(true)
      setStatusText(`正在加载 ${target}`)
      applyAddress(target)
      if (push) {
        setHist((h) => ({ items: [...h.items.slice(0, h.idx + 1), target], idx: h.idx + 1 }))
      }
    },
    [mode, applyCurrentId, applyAddress],
  )

  /* 本地历史栈（browserTabs 无 back/forward 原语） */
  const goHistory = useCallback(
    (delta: number) => {
      const target = hist.items[hist.idx + delta]
      if (target === undefined) return
      setHist((h) => ({ ...h, idx: h.idx + delta }))
      void load(target, false)
    },
    [hist, load],
  )

  const reload = useCallback(() => {
    const tabId = currentIdRef.current
    if (!tabId) return
    const url = addressRef.current || 'about:blank'
    pendingRef.current = { url, since: Date.now() }
    setLoading(true)
    void window.ark.browserTabs.navigate({ tabId, url })
  }, [])

  const newTab = useCallback(async () => {
    const { browserTabs } = window.ark
    const created = await browserTabs.create({ newTab: true })
    if (mode === 'float') {
      // float 新建语义 = 弹出独立浮窗（不改当前选择）
      try {
        await browserTabs.detach({ tabId: created.tabId })
        setStatusText('已在新窗口打开')
      } catch {
        /* ignore */
      }
      return
    }
    await browserTabs.activate({ tabId: created.tabId })
    applyCurrentId(created.tabId)
    setHist({ items: [], idx: -1 })
    lastMetaUrlRef.current = null
    applyAddress('')
    setStatusText('')
  }, [mode, applyCurrentId, applyAddress])

  const closeTab = useCallback(
    async (tabId: string) => {
      const { browserTabs } = window.ark
      await browserTabs.close({ tabId })
      const rest = tabsRef.current.filter((t) => t.tabId !== tabId)
      if (currentIdRef.current !== tabId) return
      const fallback =
        mode === 'float'
          ? rest.find((t) => t.host === 'window') ?? null
          : rest.find((t) => t.url) ?? rest[0] ?? null
      if (fallback) {
        if (mode === 'dock') void browserTabs.activate({ tabId: fallback.tabId })
        applyCurrentId(fallback.tabId)
        lastMetaUrlRef.current = fallback.url
        applyAddress(fallback.url)
        setHist({ items: fallback.url ? [fallback.url] : [], idx: fallback.url ? 0 : -1 })
        setStatusText('')
      } else {
        applyCurrentId(null)
        setHist({ items: [], idx: -1 })
        lastMetaUrlRef.current = null
        applyAddress('')
        setStatusText(mode === 'float' ? '浏览器已关闭，可关闭此窗口' : '')
      }
    },
    [mode, applyCurrentId, applyAddress],
  )

  const switchTab = useCallback(
    async (tabId: string) => {
      await window.ark.browserTabs.activate({ tabId })
      applyCurrentId(tabId)
    },
    [applyCurrentId],
  )

  /* float 模式多标签循环切换（无 popover 空间） */
  const cycleTab = useCallback(() => {
    const list = tabsRef.current
    if (list.length < 2) return
    const idx = list.findIndex((t) => t.tabId === currentIdRef.current)
    const next = list[(idx + 1) % list.length]
    if (next && next.tabId !== currentIdRef.current) void switchTab(next.tabId)
  }, [switchTab])

  /* 宿主动作：float=收回 dock；dock=弹出浮窗 */
  const hostAction = useCallback(async () => {
    const tabId = currentIdRef.current
    if (!tabId) return
    const { browserTabs } = window.ark
    if (mode === 'float') {
      await browserTabs.attach({ tabId })
    } else {
      await browserTabs.detach({ tabId })
    }
  }, [mode])

  /* 轮询 + 初始认领 + pending 结算 + 外部导航同步（主进程无状态广播的兜底） */
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const list = await window.ark.browserTabs.list()
        if (cancelled) return
        tabsRef.current = list
        setTabs(list)
        if (!currentIdRef.current) {
          // 初始认领：float 接管首个 window 宿主标签；dock 取有内容的或首个
          const claim =
            mode === 'float'
              ? list.find((t) => t.host === 'window') ?? null
              : list.find((t) => t.url) ?? list[0] ?? null
          if (claim) {
            applyCurrentId(claim.tabId)
            lastMetaUrlRef.current = claim.url
            if (!addressRef.current) applyAddress(claim.url)
            setHist({ items: claim.url ? [claim.url] : [], idx: claim.url ? 0 : -1 })
          }
        } else if (!list.some((t) => t.tabId === currentIdRef.current)) {
          // 当前标签被外部销毁
          applyCurrentId(null)
        }
        const cur = list.find((t) => t.tabId === currentIdRef.current) ?? null
        const pending = pendingRef.current
        if (pending) {
          // 结算：轮询到目标 URL，或超时兜底
          if (!cur || cur.url === pending.url || Date.now() - pending.since > NAV_TIMEOUT_MS) {
            pendingRef.current = null
            setLoading(false)
            setStatusText('')
          }
        }
        // 外部（agent/其他窗口）改了 URL 且输入框未聚焦 → 同步地址栏；聚焦时保护用户草稿
        if (cur && !addrFocusedRef.current && cur.url !== lastMetaUrlRef.current) {
          lastMetaUrlRef.current = cur.url
          applyAddress(cur.url)
        } else if (cur) {
          lastMetaUrlRef.current = cur.url
        }
      } catch {
        /* IPC 未就绪时静默重试 */
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [mode, applyCurrentId, applyAddress])

  /* 宿主变化广播（唯一的全窗口推送）：attach/detach 后给出提示 */
  useEffect(() => {
    const off = window.ark.browserTabs.onHostChanged(({ tabId, host }) => {
      if (tabId !== currentIdRef.current) return
      if (mode === 'float' && host === 'dock') {
        pendingRef.current = null
        setLoading(false)
        setStatusText('已收回侧栏浏览器，可关闭此窗口')
      } else if (mode === 'dock' && host === 'window') {
        setStatusText('已弹出为独立窗口')
      }
    })
    return off
  }, [mode])

  const agentDriven = current?.agentDriven ?? false
  const canBack = hist.idx > 0
  const canForward = hist.idx >= 0 && hist.idx < hist.items.length - 1

  const navRow = (
    <NavRow
      compact={mode === 'float'}
      address={address}
      onAddressChange={applyAddress}
      onSubmit={() => void load(address)}
      onFocusChange={setAddrFocused}
      canBack={canBack}
      canForward={canForward}
      loading={loading}
      agentDriven={agentDriven}
      tabCount={tabs.length}
      onBack={() => goHistory(-1)}
      onForward={() => goHistory(1)}
      onReload={reload}
      onNewTab={() => void newTab()}
      onCloseTab={() => {
        if (currentId) void closeTab(currentId)
      }}
      onCycleTab={cycleTab}
      onHostAction={() => void hostAction()}
      hostActionTitle={mode === 'float' ? '收回侧栏浏览器' : '弹出为独立窗口'}
      hostActionIcon={mode === 'float' ? 'attach' : 'detach'}
    />
  )

  if (mode === 'dock') {
    return (
      <div
        className="browser-chrome browser-chrome--dock relative flex h-full min-h-0 flex-col bg-bg-surface"
        data-browser-chrome=""
      >
        <TabStrip
          tabs={tabs}
          currentId={currentId}
          onSelect={(id) => void switchTab(id)}
          onClose={(id) => void closeTab(id)}
          onNew={() => void newTab()}
        />
        {navRow}
        <StatusBar statusText={statusText} loading={loading} title={current?.title} agentDriven={agentDriven} />
      </div>
    )
  }

  return (
    <div className="browser-chrome browser-chrome--float fixed inset-0 flex flex-col bg-bg-surface" data-browser-chrome="">
      {navRow}
      {loading && <div className="bc-progress-line" aria-hidden="true" />}
      {!current && <div className="bc-empty-hint">{statusText || '等待浏览器加载…'}</div>}
    </div>
  )
}
