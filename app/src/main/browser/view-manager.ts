/* ============================================================
 * ArkWork — Browser View Manager (v0.25.0 F2 / 设计文档 §4.2)
 *
 * 目标：让 WebContentsView 由主进程全权持有；renderer 只渲染 Tab 条/工具栏/占位区。
 * 可见性 = view.setVisible(bool) + setBounds；除关闭 Tab 外不销毁 webContents。
 *
 * 数据模型（与设计文档 §4.3 对齐）：
 *  - BrowserTab.tabId: string
 *  - BrowserTab.view: WebContentsView（不通过 IPC 暴露）
 *  - BrowserTabMeta（IPC 镜像）：tabId / url / title / favicon / host / agentDriven
 *
 * 多 Tab 设计文档 §4.2 标记的扩展点都已实现：
 *  - attachTo / setBounds / activate / navigate / detach / attach
 *  - 主窗口关闭 → 全部 view 随窗口销毁（不主动管理生命周期）
 * ============================================================ */
import { BrowserWindow, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { logger } from '../system/logger.js'
import type { BrowserTabMeta } from '@shared/types/ipc'

/** Tab 完整状态（含 view，main 进程私有）。 */
export interface BrowserTab {
  tabId: string
  view: WebContentsView
  url: string
  title: string
  favicon?: string
  /** dock = 主窗口占位区；window = 独立窗口 */
  host: { kind: 'dock' } | { kind: 'window'; windowId: number }
  agentDriven: boolean
  createdAt: number
}

/** IPC 镜像（不含 view）。类型定义在 @shared/types/ipc，便于 renderer 共享。 */
export type { BrowserTabMeta } from '@shared/types/ipc'

const tabs = new Map<string, BrowserTab>()
/** 当前激活的 dock tabId（用于 activate 逻辑：dock 内互斥显示）。 */
let activeDockTabId: string | null = null

function toMeta(tab: BrowserTab): BrowserTabMeta {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    favicon: tab.favicon,
    host: tab.host.kind,
    agentDriven: tab.agentDriven,
  }
}

function getOwnerWindow(host: BrowserTab['host']): BrowserWindow | null {
  if (host.kind === 'dock') {
    const wins = BrowserWindow.getAllWindows()
    return wins[0] ?? null
  }
  // 通过 windowId 查找（Electron 30+ 提供 fromId）
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (BrowserWindow as any).fromId(host.windowId) as BrowserWindow | null
  } catch {
    return null
  }
}

/** 创建新 Tab（不激活；不挂载到窗口 —— 等首次 setBounds 时再挂，避免漂浮）。
 * v0.25.0 F2 P1 修复：原 createTab 立即 addChildView + setVisible(false) 会让 view 在
 * contentView 默认位置 (0,0,fullW,fullH)；后 setBounds 时需立刻修正，但若 setBounds 跨帧
 * 触发，view 会先瞬间在错误位置显示。改为：先建 view + 记录 tab，**不调 addChildView**
 * —— 等 setTabBounds 首次调用时再 addChildView + setBounds + setVisible(true)。 */
export function createTab(opts?: { url?: string }): BrowserTab {
  const tabId = randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  view.setVisible(false)
  const tab: BrowserTab = {
    tabId,
    view,
    url: opts?.url ?? '',
    title: 'New Tab',
    host: { kind: 'dock' },
    agentDriven: false,
    createdAt: Date.now(),
    /** v0.25.0 F2 P1：是否已挂载到 contentView（首次 setBounds 时挂载） */
    _attached: false,
  } as BrowserTab & { _attached: boolean }
  // 监听元数据更新
  view.webContents.on('page-title-updated', (_e, title) => {
    tab.title = title || tab.title
  })
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    if (favicons.length > 0) tab.favicon = favicons[0]
  })
  view.webContents.on('did-navigate', (_e, url) => {
    tab.url = url
  })
  view.webContents.on('did-navigate-in-page', (_e, url) => {
    tab.url = url
  })
  if (opts?.url) {
    void view.webContents.loadURL(opts.url)
    tab.url = opts.url
  }
  tabs.set(tabId, tab)
  logger.info('Tool', `view-manager: created tab ${tabId}${opts?.url ? ` (${opts.url})` : ''}`)
  return tab
}

/** 关闭并销毁 Tab。 */
export function closeTab(tabId: string): void {
  const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
  if (!tab) return
  try {
    const win = getOwnerWindow(tab.host)
    if (win && tab._attached) {
      win.contentView.removeChildView(tab.view)
    }
  } catch (err) {
    logger.warn('Tool', `view-manager: removeChildView failed for ${tabId}: ${(err as Error).message}`)
  }
  try {
    tab.view.webContents.close()
  } catch (err) {
    logger.warn('Tool', `view-manager: webContents.close failed for ${tabId}: ${(err as Error).message}`)
  }
  tabs.delete(tabId)
  if (activeDockTabId === tabId) activeDockTabId = null
  logger.info('Tool', `view-manager: closed tab ${tabId}`)
}

/** 激活 dock Tab（互斥：dock 内只显示一个）。host = window 时只打开可见性。
 * v0.25.0 F2 P1 简化：所有可见性由 setTabBounds / detachTab 显式管理；
 * activateTab 仅记录 activeDockTabId，不再触发 setVisible（避免 bounds 未同步就显示）。 */
export function activateTab(tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab) throw new Error(`view-manager: tab not found: ${tabId}`)
  if (tab.host.kind === 'dock') {
    // dock 互斥：其他 dock Tab 全部隐藏
    for (const [otherId, other] of tabs) {
      if (otherId === tabId) continue
      if (other.host.kind !== 'dock') continue
      try {
        other.view.setVisible(false)
      } catch { /* ignore */ }
    }
    activeDockTabId = tabId
    // v0.25.0 F2 P1 简化：activate 不再 setVisible(true)。
    // 显式可见性规则：
    //  - dock 显示：setTabBounds 在 activeDockTabId 匹配 + w/h > 0 时 setVisible(true)
    //  - dock 隐藏：setTabBounds w/h = 0 时 setVisible(false)；activate 其他 dock Tab 时也 setVisible(false)
    //  - window 显示：detachTab 内 setVisible(true)
    // 此处不主动调 setVisible —— view 已经被 addChildView，bounds 默认 (0,0)，
    // 若立即 setVisible 会瞬间漂浮在窗口左上角。
  } else {
    // window 模式：bounds 由窗口 resize 同步，可见性在 detachTab 内设过
    try {
      tab.view.setVisible(true)
    } catch (err) {
      logger.warn('Tool', `view-manager: setVisible failed for ${tabId}: ${(err as Error).message}`)
    }
  }
}

/** 检查指定 Tab 是否 dock 上当前激活。 */
export function isDockTabActive(tabId: string): boolean {
  return activeDockTabId === tabId
}

/** 同步占位区 DOMRect 到指定 Tab（host=dock 时有效）。
 * rect.x/y 由 renderer 传入的是 viewport-relative 坐标（DOMRect.getBoundingClientRect）；
 * WebContentsView.setBounds 要求的是 BrowserWindow contentView 局部坐标，
 * 因此需要减去主窗口 contentView 在 viewport 中的偏移。 */
  export function setTabBounds(
    tabId: string,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
    if (!tab) return
    if (tab.host.kind !== 'dock') return // host=window 时 view 恒铺满窗口
    // 过滤：width/height = 0 不调 setBounds（panel 折叠中 → 避免 Electron 抛错或显示残影）
    const w = Math.max(0, Math.round(rect.width))
    const h = Math.max(0, Math.round(rect.height))
    if (w === 0 || h === 0) {
      // 折叠中：setVisible(false) 隐藏即可，不更新 bounds
      try { tab.view.setVisible(false) } catch { /* ignore */ }
      return
    }
    // v0.25.0 F2 P1 bug-fix：renderer 的 getBoundingClientRect 返回的是 viewport 坐标，
    // 其原点（视口左上角）与 BrowserWindow.contentView 局部坐标原点一致（都是"主内容区左上角"）。
    // 因此直接使用即可，无需再减 getContentBounds（那是"屏幕绝对坐标"，减了反而错位，导致
    // 浏览器视图向左/向上偏移遮挡中间会话区）。修复"侧栏浏览器遮挡内容"。
    const mainWin = BrowserWindow.getAllWindows()[0]
    const localX = Math.round(rect.x)
    const localY = Math.round(rect.y)
    try {
      // v0.25.0 F2 P1：首次 setBounds 时挂载到 contentView（先 setBounds 再 addChildView，
      // 避免 view 在 contentView 默认 (0,0,fullW,fullH) 位置瞬间显示）
      if (!tab._attached) {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.contentView.addChildView(tab.view)
          tab._attached = true
        }
      }
      tab.view.setBounds({
        x: localX,
        y: localY,
        width: w,
        height: h,
      })
      // active dock tab 才显示
      if (activeDockTabId === tabId) {
        try { tab.view.setVisible(true) } catch { /* ignore */ }
      }
    } catch (err) {
      logger.warn('Tool', `view-manager: setBounds failed for ${tabId}: ${(err as Error).message}`)
    }
  }

/** 在指定 Tab 加载 URL。 */
export async function navigateTab(tabId: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const tab = tabs.get(tabId)
  if (!tab) return { ok: false, error: `tab not found: ${tabId}` }
  try {
    await tab.view.webContents.loadURL(url)
    tab.url = url
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** 列出全部 Tab 元数据。 */
export function listTabs(): BrowserTabMeta[] {
  return Array.from(tabs.values()).map(toMeta)
}

/** 取指定 Tab 的 WebContentsView（供 controller 等需要 CDP 的模块）。 */
export function getTabView(tabId: string): WebContentsView | null {
  return tabs.get(tabId)?.view ?? null
}

/** 取当前激活的 dock Tab；无则返回 null。 */
export function getActiveDockTab(): BrowserTab | null {
  if (!activeDockTabId) return null
  return tabs.get(activeDockTabId) ?? null
}

/** 标记 agent 驱动状态（影响 UI 标签徽标）。 */
export function setAgentDriven(tabId: string, agentDriven: boolean): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.agentDriven = agentDriven
}

/** 关闭全部 Tab（主窗口关闭时由主进程调用，兜底）。 */
export function closeAllTabs(): void {
  for (const tabId of [...tabs.keys()]) closeTab(tabId)
}

/* ============================================================
 * v0.25.0 F2 P1：dock ↔ window Tab 迁移（设计文档 §4.2 §4.5）
 *
 * 背景：当前 BrowserPanel 切走即丢 webContents，浮窗 PreviewWindow 浏览器是另一套
 * `<webview>`，与 dock 完全无共享。两边要支持切换互斥：把 Tab 从 dock 迁到独立窗口、
 * 或从独立窗口迁回 dock。webContents 在迁移过程中**保持存活**，state/history 完整保留。
 *
 * detachTab(tabId, bounds?)：dock → window
 *   - 创建 BrowserWindow（独立、与 dock 同宽比例）
 *   - 把 view 从主窗口 contentView 移除，挂在新窗口
 *   - 新窗口的 contentView.addChildView(view) + view.setBounds(0, 0, w, h)
 *   - 关闭时（用户关浮窗或程序触发）→ 自动 attach 回 dock（如 dock 已不存在则保留为 orphan）
 *
 * attachTab(tabId)：window → dock
 *   - 把 view 从浮窗 contentView 移除，挂回主窗口
 *   - 关闭浮窗（已没有 view）
 *   - 标记 host 为 dock
 *
 * 注意：view 迁移通过 webContentsView.reparent...Electron 没有原生 reparent API，
 * 但 contentView.removeChildView + addChildView 即可在同一 WebContentsView 实例上
 * 完成切换（WebContentsView 的 webContents 是稳定的，跨窗口持有）。
 * ============================================================ */

/** 创建独立浮窗（承载 BrowserTab 的 WebContentsView）。bounds 缺省按主窗口 60% 居中。 */
/** v0.25.0 F2 P1：浮窗加载一个独立 HTML（不走完整 renderer —— 避免 React hash router 重叠）。
 * 内含：
 *  - 地址栏 / 前进后退 / 刷新 / 关闭 / 回 dock 按钮（与 BrowserPanel 一致）
 *  - 占位 div，由主进程 view-manager 通过 webContents.send('browser:floating:set-bounds') 同步
 *  - 工具栏动作通过 ark.browserTabs.* IPC 触发
 * 这样浮窗与 dock 共享同一 webContents（view-manager 持有），只是 UI 容器不同。
 */
const FLOATING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>ArkWork Browser</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  body { display: flex; flex-direction: column; background: #fff; color: #111; font-size: 13px; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e6e8eb; } }
  .toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid rgba(0,0,0,0.08); flex-shrink: 0; background: rgba(0,0,0,0.02); }
  @media (prefers-color-scheme: dark) { .toolbar { border-bottom-color: rgba(255,255,255,0.08); background: rgba(255,255,255,0.02); } }
  .toolbar button { width: 26px; height: 26px; border: none; background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: inherit; }
  .toolbar button:hover:not(:disabled) { background: rgba(0,0,0,0.06); }
  @media (prefers-color-scheme: dark) { .toolbar button:hover:not(:disabled) { background: rgba(255,255,255,0.06); } }
  .toolbar button:disabled { opacity: 0.3; cursor: not-allowed; }
  .toolbar input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid rgba(0,0,0,0.1); border-radius: 4px; background: transparent; color: inherit; font-size: 12px; font-family: ui-monospace, monospace; }
  @media (prefers-color-scheme: dark) { .toolbar input { border-color: rgba(255,255,255,0.1); } }
  .toolbar input:focus { outline: none; border-color: #3976e6; }
  .placeholder { flex: 1; position: relative; background: transparent; overflow: hidden; }
  .placeholder .status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(0,0,0,0.4); font-size: 13px; }
  .agent-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(57,118,230,0.15); color: #3976e6; flex-shrink: 0; }
  .host-mode { font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.5); flex-shrink: 0; cursor: pointer; }
  @media (prefers-color-scheme: dark) { .host-mode { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.5); } }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="back" title="后退">‹</button>
    <button id="forward" title="前进">›</button>
    <input id="addr" type="text" placeholder="输入 URL ⏎" />
    <span id="agentBadge" class="agent-badge" style="display:none">agent 驱动</span>
    <button id="go" title="前往" style="background:#3976e6;color:#fff">→</button>
    <button id="refresh" title="刷新">↻</button>
    <button id="new-tab" title="新建浏览器（about:blank，新 webContents）">＋</button>
    <button id="clear" title="清空当前内容（导航到 about:blank，保留浏览器）">⌫</button>
    <button id="close-tab" title="关闭浏览器" style="color:#d33">×</button>
    <button id="back-to-dock" class="host-mode" title="收回侧栏">⤺ 收回侧栏</button>
  </div>
  <div id="placeholder" class="placeholder">
    <div class="status" id="status">加载中…</div>
  </div>
<script>
const { ark } = window;
const $ = (id) => document.getElementById(id);
const placeholder = $('placeholder');
const status = $('status');
const addr = $('addr');
let tabId = null;
let history = [];
let historyIdx = -1;

async function refreshMeta() {
  if (!tabId) return;
  const meta = (await ark.browserTabs.list()).find(t => t.tabId === tabId);
  if (!meta) return;
  $('agentBadge').style.display = meta.agentDriven ? '' : 'none';
  if (!addr.value || addr.value === 'about:blank') addr.value = meta.url;
}

function setStatus(t) {
  if (t) status.textContent = t;
  else status.style.display = 'none';
}

$('back').onclick = () => { if (historyIdx > 0) { historyIdx--; addr.value = history[historyIdx]; go(addr.value); } };
$('forward').onclick = () => { if (historyIdx < history.length - 1) { historyIdx++; addr.value = history[historyIdx]; go(addr.value); } };

async function go(raw) {
  if (!tabId) {
    const r = await ark.browserTabs.create({ url: raw, newTab: true });
    tabId = r.tabId;
  } else {
    await ark.browserTabs.navigate({ tabId, url: raw });
  }
  history = history.slice(0, historyIdx + 1).concat([raw]);
  historyIdx = history.length - 1;
  addr.value = raw;
  setStatus('加载中…');
}

$('addr').onkeydown = (e) => { if (e.key === 'Enter') go(addr.value); };
$('go').onclick = () => go(addr.value);
$('refresh').onclick = () => tabId && ark.browserTabs.navigate({ tabId, url: addr.value });
$('close-tab').onclick = () => tabId && ark.browserTabs.close({ tabId });
$('new-tab').onclick = async () => {
  // v0.25.1：新建 Tab（约:blank，新 webContents），接管为新当前 Tab
  const res = await ark.browserTabs.create({ newTab: true });
  tabId = res.tabId;
  history = []; historyIdx = -1; addr.value = '';
  setStatus('');
};
$('clear').onclick = async () => {
  // v0.25.1：清空当前内容（导航到 about:blank，保留 Tab 与 webContents）
  if (!tabId) return;
  await ark.browserTabs.navigate({ tabId, url: 'about:blank' });
  history = []; historyIdx = -1; addr.value = '';
  setStatus('');
};
$('back-to-dock').onclick = () => tabId && ark.browserTabs.attach({ tabId });

ark.browser.onDidFinishLoad(({ url }) => {
  setStatus('');
  addr.value = url;
  refreshMeta();
});
ark.browser.onDidFailLoad(({ code, desc }) => {
  setStatus('加载失败: ' + code + ' ' + desc);
});

ark.browserTabs.onHostChanged(({ tabId: changedId, host }) => {
  if (changedId !== tabId) return;
  if (host === 'dock') {
    // 已被收回 dock → 浮窗本身失去意义；提示用户后浮窗可关
    setStatus('已收回侧栏浏览器，请关闭此窗口');
  } else {
    setStatus('');
  }
});

(async () => {
  // 找首个 dock → window 的 tab（自己接管）
  const list = await ark.browserTabs.list();
  const floating = list.find(t => t.host === 'window');
  if (floating) {
    tabId = floating.tabId;
    history = [floating.url];
    historyIdx = 0;
    addr.value = floating.url;
    setStatus('');
  } else {
    setStatus('等待浏览器加载…');
  }
})();
</script>
</body>
</html>`)}`

function createFloatingWindow(bounds?: { x: number; y: number; width: number; height: number }): BrowserWindow {
  const mainWin = BrowserWindow.getAllWindows()[0]
  const defaultBounds = mainWin
    ? {
        x: Math.round(mainWin.getBounds().x + mainWin.getBounds().width * 0.2),
        y: Math.round(mainWin.getBounds().y + mainWin.getBounds().height * 0.15),
        width: Math.round(mainWin.getBounds().width * 0.6),
        height: Math.round(mainWin.getBounds().height * 0.7),
      }
    : { x: 100, y: 100, width: 1024, height: 720 }
  const finalBounds = bounds ?? defaultBounds
  // v0.25.0 F2 P1：浮窗复用主窗口的 preload 脚本（共享 ark.* IPC + 监听器）。
  // dist 产物：out/main/browser/view-manager.js → out/main/preload/index.mjs（相对 ../preload/index.mjs）
  const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url))
  const win = new BrowserWindow({
    x: finalBounds.x,
    y: finalBounds.y,
    width: Math.max(480, finalBounds.width),
    height: Math.max(320, finalBounds.height),
    minWidth: 480,
    minHeight: 320,
    title: 'ArkWork Browser',
    autoHideMenuBar: true,
    webPreferences: {
      // 浮窗 sandbox 必须关闭（preload 需访问 ipcRenderer）
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
    },
  })
  void win.loadURL(FLOATING_HTML).catch((err) => {
    logger.warn('Tool', `view-manager: floating HTML load failed: ${(err as Error).message}`)
  })
  return win
}

/** dock → window：把指定 Tab 从主窗口迁到新建 BrowserWindow。已是 window 则幂等返回。 */
export function detachTab(tabId: string, bounds?: { x: number; y: number; width: number; height: number }): { windowId: number } {
  const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
  if (!tab) throw new Error(`view-manager: tab not found: ${tabId}`)
  if (tab.host.kind === 'window') return { windowId: tab.host.windowId }

  // 从主窗口移除（仅在已挂载时）
  const mainWin = BrowserWindow.getAllWindows()[0]
  if (mainWin && tab._attached) {
    try {
      mainWin.contentView.removeChildView(tab.view)
    } catch (err) {
      logger.warn('Tool', `view-manager: removeChildView (dock) failed: ${(err as Error).message}`)
    }
  }

  // 新建浮窗 + 挂载
  const win = createFloatingWindow(bounds)
  tab.host = { kind: 'window', windowId: win.id }
  win.contentView.addChildView(tab.view)
  tab._attached = true // window 上已挂载
  tab.view.setBounds({
    x: 0,
    y: 0,
    width: Math.max(0, win.getBounds().width),
    height: Math.max(0, win.getBounds().height),
  })
  tab.view.setVisible(true)
  activeDockTabId = null

  // 浮窗 resize/move 时主动同步 bounds
  const syncBounds = () => {
    if (tab.host.kind !== 'window') return
    if (tab.host.windowId !== win.id) return
    if (win.isDestroyed()) return
    try {
      tab.view.setBounds({
        x: 0,
        y: 0,
        width: Math.max(0, win.getBounds().width),
        height: Math.max(0, win.getBounds().height),
      })
    } catch (err) {
      logger.debug('Tool', `view-manager: window resize sync failed: ${(err as Error).message}`)
    }
  }
  win.on('resize', syncBounds)
  win.on('move', syncBounds)

  // 浮窗关闭 → 自动 attach 回 dock（如 dock 仍存在）
  win.on('closed', () => {
    if (!tabs.has(tabId)) return
    const cur = tabs.get(tabId)
    if (!cur || cur.host.kind !== 'window') return
    if (cur.host.windowId !== win.id) return
    // 尝试 attach 回 dock
    try {
      const mainWinNow = BrowserWindow.getAllWindows()[0]
      if (mainWinNow && !mainWinNow.isDestroyed()) {
        attachTab(tabId)
      } else {
        // 主窗口已关 → 销毁 view 兜底
        closeTab(tabId)
      }
    } catch (err) {
      logger.warn('Tool', `view-manager: window closed attach failed: ${(err as Error).message}`)
    }
  })

  logger.info('Tool', `view-manager: detached ${tabId} to window ${win.id}`)
  return { windowId: win.id }
}

/** window → dock：把指定 Tab 从浮窗迁回主窗口 dock。已是 dock 则幂等返回。 */
export function attachTab(tabId: string): void {
  const tab = tabs.get(tabId) as (BrowserTab & { _attached?: boolean }) | undefined
  if (!tab) throw new Error(`view-manager: tab not found: ${tabId}`)
  if (tab.host.kind === 'dock') return

  const win = getOwnerWindow(tab.host)
  if (win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(tab.view)
    } catch (err) {
      logger.warn('Tool', `view-manager: removeChildView (window) failed: ${(err as Error).message}`)
    }
  }

  const mainWin = BrowserWindow.getAllWindows()[0]
  if (!mainWin || mainWin.isDestroyed()) {
    throw new Error('view-manager: no main window to attach to')
  }
  mainWin.contentView.addChildView(tab.view)
  tab._attached = true
  tab.host = { kind: 'dock' }
  // 关闭浮窗（view 已迁走，安全关）—— 异步；closed 回调里可能再触发 attachTab，
  // 但 tab.host 已改为 dock，二次调会被守卫拦截
  if (win && !win.isDestroyed()) {
    try {
      win.close()
    } catch (err) {
      logger.warn('Tool', `view-manager: close floating window failed: ${(err as Error).message}`)
    }
  }
  // attach 完成后立即把此 Tab 标为 activeDock —— BrowserPanel 收到事件
  // 重新计算 placeholder bounds 推给主进程，触发 view 显示
  activeDockTabId = tabId
  try { tab.view.setVisible(false) } catch { /* ignore */ }
  pushHostChanged(tabId, 'dock')
  logger.info('Tool', `view-manager: attached ${tabId} back to dock`)
}

/** v0.25.0 F2 P1：Tab host 变化后 push 事件给 renderer（让 BrowserPanel 主动 setBounds） */
function pushHostChanged(tabId: string, host: 'dock' | 'window'): void {
  const wins = BrowserWindow.getAllWindows()
  for (const w of wins) {
    if (w.isDestroyed()) continue
    w.webContents.send('browser:tab-host-changed', { tabId, host })
  }
}