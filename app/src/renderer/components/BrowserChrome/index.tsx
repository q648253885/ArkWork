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
import { useTranslation } from 'react-i18next'
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

export function BrowserChrome({
  mode = 'float',
  onActiveTabChange,
}: {
  mode?: 'float' | 'dock'
  /** v0.27.0 F11：活动 Tab 变化回调 —— BrowserPanel 借此拿到 activeTabId 做占位 bounds 同步 */
  onActiveTabChange?: (tab: BrowserTabMeta | null) => void
}) {
  const { t } = useTranslation()
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

  /* v0.27.0 F11：活动 Tab 变化外抛。轮询每 800ms 生成新 list（引用全变），
     以 tabId:host 签名去重，仅真实变化时回调 —— 避免 BrowserPanel 无效重渲染 */
  const emittedSigRef = useRef<string>('__init__')
  useEffect(() => {
    const sig = current ? `${current.tabId}:${current.host}` : ''
    if (sig === emittedSigRef.current) return
    emittedSigRef.current = sig
    onActiveTabChange?.(current)
  }, [current, onActiveTabChange])

  /* 导航：非直连 URL 先经主进程 resolve（本地路径 → file:// 等） */
  const navSeqRef = useRef(0)
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
      const tabId = currentIdRef.current
      const seq = ++navSeqRef.current
      // v0.27.0 F12-B2：乐观发起导航，不等待主进程 loadURL 完成 —— loadURL 要等整页
      // 加载且可能 reject（ERR_ABORTED / ERR_CONNECTION_*），阻塞会冻结 UI 状态；
      // 连续两次导航时前者被打断后以 !ok 返回，旧逻辑会误入「新建 Tab」兜底凭空开页。
      // 结算交由轮询的 pending 机制（提交即清 / 超时兜底并对齐地址栏真实 URL）。
      pendingRef.current = { url: target, since: Date.now() }
      lastMetaUrlRef.current = target
      setLoading(true)
      setStatusText(t('browserchrome.status.loading', { url: target }))
      applyAddress(target)
      if (push) {
        setHist((h) => ({ items: [...h.items.slice(0, h.idx + 1), target], idx: h.idx + 1 }))
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
          setStatusText(t('browserchrome.status.openedNewWindow'))
          return
        }
        void browserTabs.activate({ tabId: created.tabId })
        applyCurrentId(created.tabId)
        return
      }
      try {
        const res = await browserTabs.navigate({ tabId, url: target })
        if (seq !== navSeqRef.current) return // 已被更新的导航取代，过期结果直接丢弃
        if (!res.ok) {
          pendingRef.current = null
          setLoading(false)
          setStatusText(
            t('browserchrome.status.loadFailed', {
              error: res.error ?? t('browserchrome.status.unknownError'),
            }),
          )
        }
      } catch (err) {
        if (seq !== navSeqRef.current) return
        pendingRef.current = null
        setLoading(false)
        setStatusText(t('browserchrome.status.loadFailed', { error: (err as Error).message }))
      }
    },
    [mode, applyCurrentId, applyAddress, t],
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
        setStatusText(t('browserchrome.status.openedNewWindow'))
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
  }, [mode, applyCurrentId, applyAddress, t])

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
        setStatusText(mode === 'float' ? t('browserchrome.status.browserClosedFloat') : '')
      }
    },
    [mode, applyCurrentId, applyAddress, t],
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
            // v0.27.0 F12-B1：结算兜底时地址栏对齐真实 URL —— 导航失败/超时（如重定向链）
            // 提交的乐观地址已失真；成功提交时 cur.url 与乐观地址一致，此分支自然跳过
            if (cur && !addrFocusedRef.current && cur.url !== lastMetaUrlRef.current) {
              lastMetaUrlRef.current = cur.url
              applyAddress(cur.url)
            }
          }
        }
        // 外部（agent/其他窗口）改了 URL 且输入框未聚焦 → 同步地址栏；聚焦时保护用户草稿。
        // v0.27.0 F12-B1：导航进行中（pending 未结算）不得覆盖 —— 否则轮询采样到提交前的
        // 旧 URL 会打回乐观地址，且新 URL 落地后因 lastMeta 预设相等而永不纠正（地址栏陈旧）
        if (cur && !pendingRef.current && !addrFocusedRef.current && cur.url !== lastMetaUrlRef.current) {
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
        setStatusText(t('browserchrome.status.restoredToDock'))
      } else if (mode === 'dock' && host === 'window') {
        setStatusText(t('browserchrome.status.poppedOut'))
      }
    })
    return off
  }, [mode, t])

  /* v0.27.0 F11/F12：dock 模式直听 agent 的 browser.open（'browser:load' 推送）——
     有当前 Tab 就地导航；无则新建并激活接管。float 不订阅（浮窗保持被动展示）。 */
  useEffect(() => {
    if (mode !== 'dock') return
    const off = window.ark.browser.onLoadRequest((req) => {
      void (async () => {
        const { browserTabs, browser } = window.ark
        let target = req.url ?? ''
        if (target && !DIRECT_URL_RE.test(target)) {
          try {
            target = await browser.resolve(target)
          } catch {
            /* resolve 失败按原文尝试 */
          }
        }
        let tabId = currentIdRef.current
        const exists = tabId ? tabsRef.current.some((t) => t.tabId === tabId) : false
        if (!tabId || !exists) {
          const created = await browserTabs.create({ url: target || undefined, newTab: true })
          await browserTabs.activate({ tabId: created.tabId })
          tabId = created.tabId
          applyCurrentId(tabId)
          setHist({ items: target ? [target] : [], idx: target ? 0 : -1 })
        } else {
          await browserTabs.navigate({ tabId, url: target })
          setHist((h) => ({ items: [...h.items.slice(0, h.idx + 1), target], idx: h.idx + 1 }))
        }
        // 标记 agent 接管 → NavRow/StatusBar/TabStrip 显示接管态
        try {
          await browserTabs.setAgentDriven({ tabId, agentDriven: true })
        } catch {
          /* ignore */
        }
        pendingRef.current = { url: target, since: Date.now() }
        lastMetaUrlRef.current = target
        setLoading(true)
        setStatusText(t('browserchrome.status.loading', { url: target }))
        applyAddress(target)
      })()
    })
    return off
  }, [mode, applyCurrentId, applyAddress, t])

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
      hostActionTitle={mode === 'float' ? t('browserchrome.host.attach') : t('browserchrome.host.detach')}
      hostActionIcon={mode === 'float' ? 'attach' : 'detach'}
    />
  )

  if (mode === 'dock') {
    return (
      // v0.27.0 F11：根节点不再撑满父容器高度（w-full flex-shrink-0），高度由内容行决定 ——
      // 单 Tab 无 Tab 条时占位区自动获得全部剩余空间（R-dock-1 / 检查单 4：高度不抖动）
      <div
        className="browser-chrome browser-chrome--dock relative flex w-full flex-shrink-0 flex-col bg-bg-surface"
        data-browser-chrome=""
      >
        {/* R-dock-1：Tab 条仅 >1 个标签时渲染（32px 预算，--browser-tabbar-h 已计入占位实测） */}
        {tabs.length >= 2 && (
          <TabStrip
            tabs={tabs}
            currentId={currentId}
            onSelect={(id) => void switchTab(id)}
            onClose={(id) => void closeTab(id)}
            onNew={() => void newTab()}
          />
        )}
        {navRow}
        <StatusBar statusText={statusText} loading={loading} title={current?.title} agentDriven={agentDriven} />
      </div>
    )
  }

  return (
    <div className="browser-chrome browser-chrome--float fixed inset-0 flex flex-col bg-bg-surface" data-browser-chrome="">
      {navRow}
      {loading && <div className="bc-progress-line" aria-hidden="true" />}
      {!current && <div className="bc-empty-hint">{statusText || t('browserchrome.float.waitingLoad')}</div>}
    </div>
  )
}
