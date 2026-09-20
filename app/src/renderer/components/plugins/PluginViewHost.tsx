/* ============================================================
 * ArkWork — PluginViewHost（插件代码视图容器 · v0.35.0 · M13）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §2（三层架构）· §5.2（桥）· §7（UI 挂点）
 *
 * 它是宿主与插件 Client 半之间**唯一**的接触面，做四件事：
 *  ① 向主进程要一个会话（`plugin:view-open`，主进程按需先激活 Host 半）；
 *  ② 用 `<iframe sandbox="allow-scripts">` 装载插件自己的 HTML/JS
 *     —— **不带 `allow-same-origin`**，因此插件天然拿不到宿主 DOM / storage / cookie；
 *  ③ 双向桥：Client 半的 `postMessage` → 白名单过滤 + 补 sessionId → 主进程；
 *     Host 半的 `renderer.post` → `plugin:view-post` 广播 → 推回本 iframe；
 *  ④ 五态渲染（见下），任何不可用情形都必须有**人话原因**（纪律⑦）。
 *
 * ★ 五态（互斥且穷尽）
 *   opening  正在激活 Host 半 / 签发会话
 *   ready    iframe 已装载，桥已就绪
 *   failed   激活失败 / 无 Client 半 / 权限不足 —— 带原因与「重试」
 *   gone     插件或视图已不存在（被禁用、卸载、换工作区）
 *   ——「插件来源条」在 ready/failed/gone 下都在（用户永远知道这是第三方的界面）
 *
 * ★ 为什么容器自己不做任何内容渲染：iframe 里的东西我们**无权解释**。
 *   容器的职责边界是「装载 + 转发 + 表达状态」，一旦开始猜测插件内容
 *   （比如解析它的 DOM、替它画标题），沙箱的意义就没了。
 * ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ark } from '../../ipc/client'
import { Icon } from '../../icons'
import { Tooltip } from '../ui'
import { useStore } from '../../store'
import {
  createBridgeHost,
  BRIDGE_EVENT_THEME,
  type BridgeHost,
  type BridgeMsg,
} from '@shared/utils/plugin-view-bridge'
import { collectPluginThemeTokens } from '../../utils/plugin-theme'
import { guardLabel } from '../Inspector'
import type { PanelTab } from '@shared/utils/panel-model'

/** 容器状态机（五态穷尽；`idle` 不存在 —— 一挂载就要么 opening 要么 gone） */
type HostState =
  | { status: 'opening' }
  | { status: 'ready'; sessionId: string; url: string }
  | { status: 'failed'; reason: string }
  | { status: 'gone'; reason: string }

export function PluginViewHost({ tab }: { tab: PanelTab }) {
  const { t } = useTranslation()
  const view = tab.view

  // 插件元信息（来源条要显示「谁贡献的」）；取不到就退化为 id，不阻塞渲染
  const plugins = useStore((s) => s.plugins)
  const meta = useMemo(
    () => plugins.find((p) => p.id === (view?.pluginId ?? '')),
    [plugins, view?.pluginId],
  )
  // 主题：宿主深浅色一变就把令牌推给插件（首帧的令牌搭在握手报文里）
  const resolvedTheme = useStore((s) => s.resolvedTheme)

  const [state, setState] = useState<HostState>({ status: 'opening' })
  const [reloadNonce, setReloadNonce] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const hostRef = useRef<BridgeHost | null>(null)

  const pluginId = view?.pluginId ?? ''
  const viewRef = view?.viewRef ?? ''

  const postToFrame = useCallback((msg: BridgeMsg) => {
    // targetOrigin 用 '*'：沙箱 iframe 的源是 opaque（`arkwork-plugin://` 不是 https）
    // 且报文里没有任何宿主秘密 —— 真正的边界是「插件拿不到宿主对象」，
    // 不是「别人听不到这条消息」。把 targetOrigin 收紧到具体值反而写不出来。
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }, [])

  /* ============================================================
   * ① 会话生命周期：要会话 → 装载
   * ============================================================ */
  useEffect(() => {
    if (!pluginId || !viewRef) {
      setState({ status: 'gone', reason: t('pluginView.noTarget') })
      return
    }
    let cancelled = false
    setState({ status: 'opening' })
    void (async () => {
      try {
        const r = await ark.plugin.viewOpen({ pluginId, viewRef })
        if (cancelled) {
          // StrictMode 双调用 / 用户在打开途中切走：把刚签发的会话立刻还回去，
          // 不留孤儿会话（孤儿会话会一直占着「已开视图数」，诊断页看得出来但很难归因）
          if (r.ok && r.sessionId) void ark.plugin.viewClose({ sessionId: r.sessionId })
          return
        }
        if (r.ok && r.sessionId && r.url) {
          setState({ status: 'ready', sessionId: r.sessionId, url: r.url })
          return
        }
        const reason = r.message ?? r.reason ?? 'unknown'
        setState(
          r.reason === 'not-found' || r.reason === 'no-renderer'
            ? { status: 'gone', reason }
            : { status: 'failed', reason },
        )
      } catch (err) {
        if (cancelled) return
        // 纪律⑦：IPC 异常也必须落成人话，不能只留一个空白框
        setState({ status: 'failed', reason: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginId, viewRef, reloadNonce, t])

  const sessionId = state.status === 'ready' ? state.sessionId : null

  /* ============================================================
   * ② 桥：消息监听 + 上行订阅 + 卸载
   *
   * 以 `sessionId` 为依赖（而不是组件挂载）：重载 = 新会话 = 桥重建。
   * 清理时必须**先 deactivate 再 close** —— 顺序反了插件会收到「会话已失效」
   * 之后才收到卸载握手，作者的 cleanup 逻辑就跑在失效会话上（静默失败）。
   * ============================================================ */
  useEffect(() => {
    if (!sessionId) return

    const host = createBridgeHost({
      sessionId,
      post: postToFrame,
      transport: async (sid, method, params) => {
        const r = await ark.plugin.viewCall({ sessionId: sid, method, params })
        return r.ok ? { ok: true, result: r.result } : { ok: false, ...(r.error ? { error: r.error } : {}) }
      },
      onRejected: (reason, msg) => {
        // 不回声给插件（避免被当成探测接口），只落宿主控制台
        console.warn(`[plugin:${pluginId}] 桥调用被拒：${reason}（method=${msg.method}）`)
      },
    })
    hostRef.current = host

    const onWindowMessage = (e: MessageEvent) => {
      // 只接受本 iframe 的消息 —— 窗口里可能同时有别的插件视图与内置浏览器 webview
      if (e.source !== iframeRef.current?.contentWindow) return
      host.onMessage(e.data)
    }
    window.addEventListener('message', onWindowMessage)

    const offPost = ark.plugin.onViewPost((payload) => {
      if (payload.sessionId !== sessionId) return
      host.pushEvent(payload.payload)
    })

    return () => {
      window.removeEventListener('message', onWindowMessage)
      offPost()
      hostRef.current = null
      // 卸载握手（插件据此跑自己的 cleanup）→ 再关会话
      host.handshake('deactivate', { id: pluginId, name: tab.title, version: '' })
      void ark.plugin.viewClose({ sessionId })
    }
  }, [sessionId, postToFrame, pluginId, tab.title])

  /* ============================================================
   * ③ 主题同步：宿主切浅/深 → 推令牌（首帧的令牌在握手报文里）
   * ============================================================ */
  useEffect(() => {
    if (!sessionId) return
    hostRef.current?.pushEvent({ type: BRIDGE_EVENT_THEME, tokens: collectPluginThemeTokens() })
  }, [sessionId, resolvedTheme])

  /* ============================================================
   * 渲染
   * ============================================================ */
  const shell = (children: React.ReactNode) => (
    <div
      className="h-full flex flex-col min-h-0"
      role="tabpanel"
      aria-label={tab.title}
      data-panel-ref={tab.ref}
      data-plugin-id={pluginId}
      data-plugin-view-host=""
    >
      <SourceBar
        name={meta?.name ?? pluginId}
        pluginId={pluginId}
        source={meta?.source ?? 'global'}
        onReload={() => setReloadNonce((n) => n + 1)}
        reloadDisabled={state.status === 'opening'}
      />
      {children}
    </div>
  )

  if (!view) {
    // 不该发生：Inspector 只在 `tab.view` 存在时挂本组件。留显式分支而不是 `!`
    return shell(<Fallback icon="Warning" title={t('pluginView.badShape')} hint={t('pluginView.badShapeHint')} />)
  }

  if (state.status === 'opening') {
    return shell(
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-tertiary">
        <Icon.Refresh width={18} height={18} className="animate-spin" aria-hidden />
        <span className="text-xs">{t('pluginView.opening')}</span>
      </div>,
    )
  }

  if (state.status === 'failed') {
    return shell(
      <Fallback icon="Warning" title={t('pluginView.failed')} hint={state.reason} onRetry={() => setReloadNonce((n) => n + 1)} />,
    )
  }

  if (state.status === 'gone') {
    return shell(<Fallback icon="Plug" title={t('pluginView.gone')} hint={state.reason} />)
  }

  return shell(
    <iframe
      ref={iframeRef}
      // ★ 安全边界：allow-scripts 给脚本，**不给** allow-same-origin
      //   → 无宿主 DOM / storage / cookie，也没有 localStorage；
      //   allow-popups 已刻意省略（插件不该开新窗口）。
      sandbox="allow-scripts"
      title={tab.title}
      src={state.url}
      className="flex-1 w-full min-h-0 border-0 bg-bg-base"
      onLoad={() =>
        hostRef.current?.handshake(
          'activate',
          { id: pluginId, name: meta?.name ?? pluginId, version: meta?.version ?? '' },
          collectPluginThemeTokens(),
        )
      }
    />,
  )
}

/* ============================================================
 * 插件来源条：用户必须一眼看出「这不是宿主的原生界面」
 * ============================================================ */
function SourceBar({
  name,
  pluginId,
  source,
  onReload,
  reloadDisabled,
}: {
  name: string
  pluginId: string
  source: string
  onReload: () => void
  reloadDisabled: boolean
}) {
  const { t } = useTranslation()
  // 插件名是第三方输入：走同一套展示层防御，避免未解析模板串 / 超长名撑破栏
  const label = guardLabel(name)
  const sourceKey = source === 'bundled' ? 'workbench.plugins.sourceBundled' : 'workbench.plugins.sourceLocal'
  return (
    <div
      className="flex items-center gap-1.5 px-2.5 h-6 flex-shrink-0 border-b border-border-subtle text-2xs text-text-faint"
      data-testid="plugin-view-source-bar"
    >
      <Icon.Plug width={11} height={11} aria-hidden />
      <span className="truncate" title={pluginId}>
        {label}
      </span>
      <span className="text-2xs border border-border-subtle rounded px-1 leading-4 flex-shrink-0">
        {t(sourceKey)}
      </span>
      <Tooltip label={t('pluginView.reload')}>
        <button
          type="button"
          onClick={onReload}
          disabled={reloadDisabled}
          aria-label={t('pluginView.reloadAria', { name: label })}
          className="ml-auto w-5 h-5 flex items-center justify-center rounded text-text-faint hover:bg-bg-hover hover:text-text-primary disabled:opacity-30 focus-ring"
        >
          <Icon.RotateCcw width={11} height={11} aria-hidden />
        </button>
      </Tooltip>
    </div>
  )
}

/* ============================================================
 * 降级态（**永不空白**）
 * ============================================================ */
function Fallback({
  icon,
  title,
  hint,
  onRetry,
}: {
  icon: 'Warning' | 'Plug'
  title: string
  hint: string
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const Ico = Icon[icon]
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
      <Ico width={22} height={22} className="text-text-faint" aria-hidden />
      <div className="text-xs text-text-secondary">{title}</div>
      <div className="text-2xs text-text-faint break-words max-w-[36ch]">{hint}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 h-6 px-2 rounded-md border border-border-subtle text-2xs text-text-secondary hover:bg-bg-hover focus-ring"
        >
          {t('pluginView.retry')}
        </button>
      )}
    </div>
  )
}
