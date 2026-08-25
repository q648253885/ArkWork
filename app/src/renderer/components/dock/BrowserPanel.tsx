/* ============================================================
 * ArkWork — Dock/BrowserPanel（v0.27.0 F11 重构：chrome 全权接管）
 *
 * 历史：
 *  v0.24.1：<webview> 渲染层轨道（切标签销毁 webContents）
 *  v0.25.0 F2：主进程 view-manager 持有 webContents，面板做「占位 + bounds 同步」
 *  v0.27.0 F11/R4宿主统一：地址栏 / 导航 / Tab 管理 / agent open 消费全部下沉到
 *    BrowserChrome（dock 形态自治状态机）；本组件只剩三件事——
 *      1) 挂载 <BrowserChrome mode="dock">；
 *      2) 把占位区 viewport-relative bounds 同步给主进程（setBounds）；
 *      3) 当前 Tab 弹出为浮窗时盖提示浮层。
 *  始终被 Inspector 挂载（display:none 隐藏）→ 切走不销毁 webContents。
 * ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { ark } from '../../ipc/client'
import { EmptyState } from '../ui'
import type { BrowserTabMeta } from '@shared/types/ipc'
import { BrowserChrome } from '../BrowserChrome'

export function BrowserPanel() {
  const { t } = useTranslation()
  const [active, setActive] = useState<BrowserTabMeta | null>(null)
  /** ResizeObserver / onHostChanged 回调里读最新活动 Tab（避开 stale closure） */
  const activeIdRef = useRef<string | null>(null)
  const placeholderRef = useRef<HTMLDivElement>(null)

  /* v0.27.0 F11：BrowserChrome 以 tabId:host 签名去重后外抛活动 Tab —— 仅真实变化才到这里 */
  const handleActive = useCallback((tab: BrowserTabMeta | null) => {
    activeIdRef.current = tab?.tabId ?? null
    setActive(tab)
  }, [])

  /* ---- 占位区 bounds 同步：viewport-relative 坐标直传主进程 ----
     v0.25.1 语义保留：renderer 视口原点与 contentView 局部坐标原点一致，
     主进程直接使用（不减窗口屏幕位置）。 */
  const forceSyncBounds = useCallback(() => {
    const id = activeIdRef.current
    const el = placeholderRef.current
    if (!id || !el) return
    const rect = el.getBoundingClientRect()
    void ark.browserTabs
      .setBounds({ tabId: id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
      .catch((err) => console.warn('[BrowserPanel] setBounds failed', err))
  }, [])

  /* 活动 Tab 变化时重跑：切换 Tab 后立即推一次 bounds
     （尺寸未变时 ResizeObserver 不触发，新 Tab 的 view 需要显式落位） */
  useEffect(() => {
    const el = placeholderRef.current
    if (!el) return
    const ro = new ResizeObserver(() => forceSyncBounds())
    ro.observe(el)
    forceSyncBounds()
    return () => ro.disconnect()
  }, [active?.tabId, forceSyncBounds])

  /* 宿主变化广播：浮窗收回 dock 后下一帧强制同步
     （折叠态占位 width:0 → 恢复不会触发 RO 尺寸回调的边界场景） */
  useEffect(() => {
    const off = ark.browserTabs.onHostChanged(({ tabId: changedId, host }) => {
      if (changedId !== activeIdRef.current) return
      if (host === 'dock') requestAnimationFrame(() => forceSyncBounds())
    })
    return off
  }, [forceSyncBounds])

  return (
    <div className="flex flex-col h-full">
      {/* chrome 三行形态（Tab 条 >1 才出现，32px 预算）+ 自治轮询/认领/导航状态机 */}
      <BrowserChrome mode="dock" onActiveTabChange={handleActive} />
      {/* 内容区占位：webContents 由主进程 view-manager 叠加渲染；
          切走 Inspector 不卸载 → 原页面/agent CDP 句柄保留 */}
      <div ref={placeholderRef} className="flex-1 min-h-0 relative bg-white dark:bg-[#16181d]">
        {active?.host === 'window' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-base text-text-secondary gap-2">
            <Icon.ExternalLink width={28} height={28} className="text-accent" />
            <div className="text-xs">{t('dock.browser.open_in_window')}</div>
            <div className="text-2xs text-text-tertiary">{t('dock.browser.return_hint')}</div>
          </div>
        )}
        {!active && (
          <EmptyState
            icon={<Icon.Bolt width={22} height={22} />}
            title={t('dock.browser.title')}
            hint={t('dock.browser.empty_hint')}
          />
        )}
      </div>
    </div>
  )
}

export default BrowserPanel
