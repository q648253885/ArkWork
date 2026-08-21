/* ============================================================
 * v0.25.1 — 侧边栏浏览器 错位遮挡修复 终极验证（读主进程原生 bounds）
 *
 * 思路：
 *   1) 通过 renderer CDP(9222) 切换到 Browser 标签 + 打开一个纯红 data:URL
 *   2) 读取 renderer 中占位区 getBoundingClientRect（= renderer 发给主进程的 rect）
 *   3) 通过 main inspector CDP(9230) 在主进程里枚举主窗口 contentView 的
 *      WebContentsView，读取其 getBounds()（contentView 局部坐标，DIP）
 *   4) 断言：view 的 bounds 与占位区 rect 一致 → 不错位、不遮挡
 *   5) 额外：读取 view 所在 webContents 的 URL，确认是红色页面
 *
 * 退出方式：完成后自动退出
 * ============================================================ */
import WebSocket from 'ws'

const RED_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="color:#fff;font-family:sans-serif">ARK-RED-VERIFY</h1></body></html>'
)

async function getTarget(port: number, urlFilter?: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/json`)
  const ts = await r.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>
  const t = urlFilter ? ts.find((x) => x.type === 'page' && x.url.includes(urlFilter)) : ts[0]
  if (!t) throw new Error(`no target on :${port}${urlFilter ? ' filter=' + urlFilter : ''}`)
  return t.webSocketDebuggerUrl
}

class CDP {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, (m: any) => void>()
  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', (d) => { const msg = JSON.parse(d.toString()); if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id) } })
  }
  async open(): Promise<void> { await new Promise((r) => this.ws.on('open', r)) }
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve) => { const mid = ++this.id; this.pending.set(mid, resolve); this.ws.send(JSON.stringify({ id: mid, method, params })) })
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const m = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (m.result?.exceptionDetails) throw new Error('MAIN-EVAL: ' + String(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text))
    return m.result?.result?.value as T
  }
  async close() { this.ws.close() }
}
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  // ---- 1. renderer：切到 Browser + 打开红页 ----
  const renderer = new CDP(await getTarget(9222, 'index.html'))
  await renderer.open()
  await renderer.eval<void>(`(() => {
    const btn = Array.from(document.querySelectorAll('button[role="tab"]')).find((b) => (b.getAttribute('aria-label') || '').startsWith('浏览器'))
    if (btn) btn.click()
  })()`)
  await sleep(400)
  const created = await renderer.eval<{ ok: boolean; tabId?: string; error?: string }>(`(async () => {
    try { const t = await window.ark.browserTabs.create({ url: ${JSON.stringify(RED_URL)}, newTab: true }); return { ok: true, tabId: t.tabId } }
    catch (e) { return { ok: false, error: String(e) } }
  })()`)
  console.log(`[renderer] 打开红页: ${created.ok ? '✅' : '❌ ' + created.error}`)
  if (!created.ok) { process.exit(1) }
  await sleep(4000)

  // 占位区 rect（renderer 发给主进程的 rect）
  const ph = await renderer.eval<{ x: number; y: number; w: number; h: number }>(`(() => {
    const panel = document.getElementById('inspector-panel-browser')
    const el = panel.querySelector('div.flex-1.min-h-0.relative')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })()`)
  const winGeo = await renderer.eval<{ screenX: number; screenY: number; dpr: number }>(`({ screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio })`)
  console.log(`[renderer] 占位区 rect = (${ph.x}, ${ph.y}) ${ph.w}x${ph.h}`)
  console.log(`[renderer] 窗口 screen=(${winGeo.screenX},${winGeo.screenY}) dpr=${winGeo.dpr}`)
  await renderer.close()

  // ---- 2. main：读原生 WebContentsView bounds ----
  const mainCdp = new CDP(await getTarget(9230))
  await mainCdp.open()
  const views = await mainCdp.eval<Array<{ id: number; bounds: { x: number; y: number; width: number; height: number }; url: string }>>(`(async () => {
    // main inspector 里没有 require/module/electron 全局，用 process.getBuiltinModule 造 require
    const { createRequire } = process.getBuiltinModule('module')
    const req = createRequire('/tmp/ark-cdp-probe.cjs')
    const { BrowserWindow } = req('electron')
    const wins = BrowserWindow.getAllWindows()
    const all = []
    for (const w of wins) {
      for (const v of w.contentView.children) {
        let url = ''
        try { url = v.webContents.getURL() } catch (e) {}
        all.push({ id: v.webContents.id, bounds: v.getBounds(), url })
      }
    }
    return all
  })()`)
  console.log('\n[main] 主窗口 contentView 下的 WebContentsView 列表：')
  for (const v of views ?? []) {
    const b = v.bounds
    console.log(`  id=${v.id} bounds=(${b.x}, ${b.y}) ${b.width}x${b.height} url=${(v.url || '').slice(0, 50)}`)
  }

  // ---- 3. 断言 ----
  const redView = (views ?? []).find((v) => (v.url || '').startsWith('data:text/html'))
  console.log('\n[断言]')
  if (!redView) {
    console.log('  ❌ 未找到红色页面对应的 WebContentsView')
    process.exitCode = 1
  } else {
    const b = redView.bounds
    const matchX = Math.abs(b.x - ph.x) <= 2
    const matchY = Math.abs(b.y - ph.y) <= 2
    const matchW = Math.abs(b.width - ph.w) <= 2
    const matchH = Math.abs(b.height - ph.h) <= 2
    console.log(`  实际 view bounds = (${b.x}, ${b.y}) ${b.width}x${b.height}`)
    console.log(`  期望(占位区)     = (${ph.x}, ${ph.y}) ${ph.w}x${ph.h}`)
    console.log(`  X: ${matchX ? '✅' : '❌'}  Y: ${matchY ? '✅' : '❌'}  W: ${matchW ? '✅' : '❌'}  H: ${matchH ? '✅' : '❌'}`)
    // 位置正确性：b.x/y 应 ≈ 占位区 rect（viewport==contentView 局部坐标），且远小于窗口屏幕坐标
    const screenShown = `screen=(${winGeo.screenX},${winGeo.screenY})`
    console.log(`  窗口屏幕位置 ${screenShown} —— 若错误地减了窗口屏幕位置，view 会被拉到 ${b.x + winGeo.screenX},${b.y + winGeo.screenY}（错位）`)
    if (matchX && matchY && matchW && matchH) {
      console.log('\n  === ✅ 全部通过：原生 WebContentsView 精确覆盖占位区，无错位、无遮挡 ===')
    } else {
      console.log('\n  === ❌ 存在不匹配，请检查 ===')
      process.exitCode = 1
    }
  }
  await mainCdp.close()
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
