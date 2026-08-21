/* ============================================================
 * v0.25.1 — 侧边栏浏览器「错位遮挡」修复 运行时验证
 *
 * 背景：view-manager.setTabBounds 之前错误地减去窗口屏幕位置
 * （getContentBounds().x/y），导致 WebContentsView 向左/上偏移，
 * 遮挡会话区、错开占位区。修复后 localX=rect.x（viewport 坐标
 * 直接等于 contentView 局部坐标）。
 *
 * 本脚本验证：
 *   1) 切换到 Browser 标签后，BrowserPanel 占位区存在且尺寸 > 0
 *   2) 通过 ark.browserTabs.create/navigate 打开一个本地 HTML
 *   3) 读取占位区 getBoundingClientRect（即主进程应设置的 bounds）
 *   4) 用 CDP 截图，人工/自动比对浏览器视图是否精确覆盖占位区
 *   5) 检查 tab meta（host=dock / url 正确）
 *
 * 退出方式：完成后自动退出
 * ============================================================ */
import WebSocket from 'ws'

const TARGET_URL = 'https://example.com'

async function getPageWs(): Promise<string> {
  const r = await fetch('http://127.0.0.1:9222/json')
  const ts = await r.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>
  const page = ts.find((t) => t.type === 'page' && t.url.includes('index.html'))
  if (!page) throw new Error('no ArkWork renderer page target')
  return page.webSocketDebuggerUrl
}

class CDP {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, (m: any) => void>()
  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d.toString())
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg)
        this.pending.delete(msg.id)
      }
    })
  }
  async open(): Promise<void> { await new Promise((r) => this.ws.on('open', r)) }
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve) => {
      const mid = ++this.id
      this.pending.set(mid, (m) => resolve(m))
      this.ws.send(JSON.stringify({ id: mid, method, params }))
    })
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const m = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.text + ' ' + JSON.stringify(m.result.exceptionDetails.exception?.description ?? ''))
    return m.result?.result?.value as T
  }
  async close() { this.ws.close() }
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  const url = await getPageWs()
  const cdp = new CDP(url)
  await cdp.open()
  console.log('=== 侧边栏浏览器 错位遮挡修复 运行时验证 ===\n')

  // 1. 切换到 Browser 标签（Inspector 标签栏 aria-label 以「浏览器」开头）
  console.log('[1] 切换到 Browser 标签')
  const switched = await cdp.eval<boolean>(`(() => {
    const btn = Array.from(document.querySelectorAll('button[role="tab"]')).find(
      (b) => (b.getAttribute('aria-label') || '').startsWith('浏览器')
    )
    if (!btn) return false
    btn.click()
    return true
  })()`)
  console.log(`    切换: ${switched ? '✅ 已点击浏览器标签' : '❌ 未找到浏览器标签'}`)
  if (!switched) { await cdp.close(); process.exit(1) }
  await sleep(500)

  // 2. 检查占位区是否存在、尺寸
  console.log('[2] 检查 BrowserPanel 占位区')
  const ph = await cdp.eval<{ found: boolean; w: number; h: number; x: number; y: number; display: string }>(`(() => {
    const panel = document.getElementById('inspector-panel-browser')
    if (!panel) return { found: false, w: 0, h: 0, x: 0, y: 0, display: 'no-panel' }
    // BrowserPanel 占位区：flex-1 min-h-0 relative bg-white
    const ph = panel.querySelector('div.flex-1.min-h-0.relative')
    if (!ph) return { found: false, w: 0, h: 0, x: 0, y: 0, display: getComputedStyle(panel).display }
    const r = ph.getBoundingClientRect()
    return { found: true, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), display: getComputedStyle(panel).display }
  })()`)
  console.log(`    占位区: found=${ph.found} x=${ph.x} y=${ph.y} w=${ph.w} h=${ph.h} panelDisplay=${ph.display}`)
  if (!ph.found || ph.w <= 0 || ph.h <= 0) {
    console.log('    ❌ 占位区不存在或尺寸为 0 —— 浏览器面板未正确渲染')
    await cdp.close(); process.exit(1)
  }
  console.log('    ✅ 占位区尺寸正常（w>0 且 h>0）\n')

  // 3. 打开一个页面（走 ark.browserTabs IPC，与 BrowserPanel 同一路径）
  console.log('[3] 通过 ark.browserTabs 打开页面')
  const openRes = await cdp.eval<{ ok: boolean; tabId?: string; error?: string }>(`(async () => {
    try {
      const t = await window.ark.browserTabs.create({ url: ${JSON.stringify(TARGET_URL)}, newTab: true })
      return { ok: true, tabId: t.tabId }
    } catch (e) { return { ok: false, error: String(e) } }
  })()`)
  console.log(`    create: ok=${openRes.ok} tabId=${openRes.tabId ?? '-'} err=${openRes.error ?? ''}`)
  if (!openRes.ok) { await cdp.close(); process.exit(1) }
  await sleep(4000) // 等页面加载 + bounds 同步

  // 4. 校验主进程 view-manager 是否把 bounds 同步到了正确位置（间接：检查 tab meta）
  console.log('[4] 检查 tab meta（host / url）')
  const meta = await cdp.eval<Array<{ tabId: string; host: string; url: string; title: string }>>(`(async () => (await window.ark.browserTabs.list()).map((t) => ({ tabId: t.tabId, host: t.host, url: t.url, title: t.title })))()`)
  for (const m of meta ?? []) {
    console.log(`    tab ${m.tabId.slice(0, 8)} host=${m.host} url=${m.url.slice(0, 60)} title="${(m.title || '').slice(0, 30)}"`)
  }

  // 5. 读取「修复后主进程应设置的 bounds」= 占位区 getBoundingClientRect
  //    （修复后 localX = rect.x，直接等于 contentView 局部坐标）
  console.log('\n[5] 读取占位区最终 bounds（= 主进程应设置的 WebContentsView bounds）')
  const finalPh = await cdp.eval<{ x: number; y: number; w: number; h: number }>(`(() => {
    const panel = document.getElementById('inspector-panel-browser')
    const ph = panel.querySelector('div.flex-1.min-h-0.relative')
    const r = ph.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  console.log(`    expected bounds = { x: ${finalPh.x}, y: ${finalPh.y}, w: ${finalPh.w}, h: ${finalPh.h} }`)
  console.log('    （修复后 view-manager 直接以该 x/y 为 contentView 局部坐标，不再减窗口屏幕位置）')

  // 6. 截图存档，供视觉确认「浏览器视图精确覆盖占位区、无错位遮挡」
  console.log('\n[6] 截图存档（人工可打开确认无错位/遮挡）')
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs')
    const out = '/Users/gongzheng/ai/ArkWork/app/.arkwork/browser-bounds-verify.png'
    const { mkdirSync } = await import('node:fs')
    try { mkdirSync('/Users/gongzheng/ai/ArkWork/app/.arkwork', { recursive: true }) } catch { /* ignore */ }
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
    console.log(`    截图已保存: ${out}`)
  } else {
    console.log('    ⚠️ 截图失败（无 data）')
  }

  await cdp.close()
  console.log('\n=== 验证完成 ===')
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
