/* ============================================================
 * v0.25.1 — 侧边栏浏览器 错位遮挡修复 确定性验证
 *
 * 直接对 setTabBounds 的坐标逻辑做黑盒断言（不依赖 BrowserPanel UI 状态）：
 *  1) renderer 创建红色 tab（newTab:true → activateTab → activeDockTabId 已设）
 *  2) renderer 调 ark.browserTabs.setBounds(tabId, 占位区真实 rect)
 *  3) main(9230) 读 WebContentsView.getBounds()（contentView 局部坐标）
 *  4) 断言 view bounds ≈ 占位区 rect（容差 2px）
 *  5) 把窗口移到 (320,180) 再测一遍 —— 修复前会偏移 (-320,-180)，修复后不变
 * ============================================================ */
import WebSocket from 'ws'

const RED_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="color:#fff;font-family:sans-serif;font-size:32px">ARK-RED-VERIFY</h1></body></html>'
)

async function getTarget(port: number, urlFilter?: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/json`)
  const ts = await r.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>
  const t = urlFilter ? ts.find((x) => x.type === 'page' && x.url.includes(urlFilter)) : ts[0]
  if (!t) throw new Error(`no target on :${port}${urlFilter ? ' filter=' + urlFilter : ''}`)
  return t.webSocketDebuggerUrl
}
class CDP {
  private ws: WebSocket; private id = 0; private pending = new Map<number, (m: any) => void>()
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.on('message', (d) => { const msg = JSON.parse(d.toString()); if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id) } }) }
  async open(): Promise<void> { await new Promise((r) => this.ws.on('open', r)) }
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> { return new Promise((resolve) => { const mid = ++this.id; this.pending.set(mid, resolve); this.ws.send(JSON.stringify({ id: mid, method, params })) }) }
  async eval<T = unknown>(expr: string): Promise<T> {
    const m = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (m.result?.exceptionDetails) throw new Error('EVAL: ' + String(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text))
    return m.result?.result?.value as T
  }
  async close() { this.ws.close() }
}
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

async function mainBoundsCheck(renderer: CDP, mainCdp: CDP, phase: string) {
  // 读占位区真实 rect
  const ph = await renderer.eval<{ x: number; y: number; w: number; h: number }>(`(() => {
    const panel = document.getElementById('inspector-panel-browser')
    if (!panel) return { x: -1, y: -1, w: -1, h: -1 }
    const el = panel.querySelector('div.flex-1.min-h-0.relative')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)

  // 创建 red tab（若还没有）
  let tabId = await renderer.eval<string>(`(async () => {
    const list = await window.ark.browserTabs.list()
    const red = list.find((t) => (t.url || '').startsWith('data:text/html'))
    if (red) return red.tabId
    const t = await window.ark.browserTabs.create({ url: ${JSON.stringify(RED_URL)}, newTab: true })
    return t.tabId
  })()`)

  // 显式 setBounds = 占位区 rect（模拟 BrowserPanel forceSyncBounds 的输入）
  await renderer.eval<void>(`(async () => {
    await window.ark.browserTabs.setBounds({ tabId: ${JSON.stringify(tabId)}, rect: ${JSON.stringify({ x: ph.x, y: ph.y, width: ph.w, height: ph.h })} })
  })()`)
  await sleep(600)

  // main 读真实 view bounds
  const views = await mainCdp.eval<Array<{ bounds: { x: number; y: number; width: number; height: number }; url: string }>>(`(() => {
    const { createRequire } = process.getBuiltinModule('module')
    const req = createRequire('/tmp/ark-cdp-probe.cjs')
    const { BrowserWindow } = req('electron')
    const all = []
    for (const w of BrowserWindow.getAllWindows()) {
      for (const v of w.contentView.children) {
        let url = ''
        try { url = v.webContents.getURL() } catch (e) {}
        all.push({ bounds: v.getBounds(), url })
      }
    }
    return all
  })()`)
  const redView = (views ?? []).find((v) => (v.url || '').startsWith('data:text/html'))
  console.log(`\n[${phase}]`)
  console.log(`  占位区 rect      = (${ph.x}, ${ph.y}) ${ph.w}x${ph.h}`)
  if (!redView) {
    console.log(`  ❌ 未找到 red WebContentsView（全部: ${JSON.stringify(views)}）`)
    return false
  }
  const b = redView.bounds
  console.log(`  实际 view bounds = (${b.x}, ${b.y}) ${b.width}x${b.height}`)
  const okX = Math.abs(b.x - ph.x) <= 2
  const okY = Math.abs(b.y - ph.y) <= 2
  const okW = Math.abs(b.width - ph.w) <= 2
  const okH = Math.abs(b.height - ph.h) <= 2
  console.log(`  X=${okX ? '✅' : '❌'} Y=${okY ? '✅' : '❌'} W=${okW ? '✅' : '❌'} H=${okH ? '✅' : '❌'}`)
  return okX && okY && okW && okH
}

async function main() {
  const renderer = new CDP(await getTarget(9222, 'index.html')); await renderer.open()
  const mainCdp = new CDP(await getTarget(9230)); await mainCdp.open()

  // 切到浏览器标签（确保 inspector-panel-browser 存在）
  await renderer.eval<void>(`(() => {
    const btn = Array.from(document.querySelectorAll('button[role="tab"]')).find((b) => (b.getAttribute('aria-label') || '').startsWith('浏览器'))
    if (btn) btn.click()
  })()`)
  await sleep(500)

  // 测试 1：窗口位于 (0,25)
  const ok1 = await mainBoundsCheck(renderer, mainCdp, '窗口 @ 原点附近 (0,25)')

  // 测试 2：移动窗口到 (320,180) 后重测 —— 修复前会偏移 (-320,-180)
  await mainCdp.eval<void>(`(() => {
    const { createRequire } = process.getBuiltinModule('module')
    const req = createRequire('/tmp/ark-cdp-probe.cjs')
    const { BrowserWindow } = req('electron')
    BrowserWindow.getAllWindows()[0].setPosition(320, 180)
  })()`)
  await sleep(800)
  const geo = await renderer.eval<{ screenX: number; screenY: number }>(`({ screenX: window.screenX, screenY: window.screenY })`)
  const ok2 = await mainBoundsCheck(renderer, mainCdp, `窗口 @ (${geo.screenX},${geo.screenY})（非原点 —— 关键验证）`)

  console.log(`\n=== 结果：${ok1 && ok2 ? '✅✅ 全部通过：view 精确覆盖占位区，窗口移动后依然对齐，无错位遮挡' : '❌ 存在失败，请检查'} ===`)
  await renderer.close(); await mainCdp.close()
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
