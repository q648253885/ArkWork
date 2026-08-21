/* ============================================================
 * v0.25.1 — 侧边栏浏览器「错位遮挡」修复 最终运行时验证
 *
 * 方法：
 *   1) 切换到 Browser 标签，打开一个纯红色 data:URL 页面
 *      （红色背景独一无二，便于像素级定位原生 WebContentsView）
 *   2) 读取 renderer 的 window.screenX/screenY/devicePixelRatio +
 *      占位区 getBoundingClientRect → 计算「修复后浏览器视图应在屏幕
 *      (physical px) 上的矩形」
 *   3) screencapture 全屏截图（含原生层 WebContentsView）
 *   4) 用 pngjs 找出红色像素的包围盒，与期望矩形对比：
 *        - 实际包围盒 ≈ 期望矩形 → 不错位 ✅
 *        - 红色像素出现在会话区（浏览器区域左侧）→ 有遮挡 ❌
 *
 * 退出方式：完成后自动退出
 * ============================================================ */
import WebSocket from 'ws'
import { execFileSync } from 'node:child_process'
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'

const RED_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><html><body style="margin:0;background:#ff0000;height:100vh"><h1 style="color:#fff;font-family:sans-serif">ARK-RED-VERIFY</h1></body></html>'
)

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
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)!(msg); this.pending.delete(msg.id) }
    })
  }
  async open(): Promise<void> { await new Promise((r) => this.ws.on('open', r)) }
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve) => { const mid = ++this.id; this.pending.set(mid, resolve); this.ws.send(JSON.stringify({ id: mid, method, params })) })
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const m = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (m.result?.exceptionDetails) throw new Error(String(m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text))
    return m.result?.result?.value as T
  }
  async close() { this.ws.close() }
}
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

function findRedBBox(png: PNG): { x1: number; y1: number; x2: number; y2: number; count: number } {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, count = 0
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) << 2
      const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2]
      if (r > 200 && g < 90 && b < 90) { // 纯红
        count++
        if (x < x1) x1 = x; if (x > x2) x2 = x
        if (y < y1) y1 = y; if (y > y2) y2 = y
      }
    }
  }
  return count === 0 ? { x1: -1, y1: -1, x2: -1, y2: -1, count: 0 } : { x1, y1, x2, y2, count }
}

async function main() {
  const url = await getPageWs()
  const cdp = new CDP(url)
  await cdp.open()
  console.log('=== 侧边栏浏览器 错位遮挡修复 最终验证（像素级）===\n')

  // 1. 切换到 Browser 标签 + 打开纯红页面
  await cdp.eval<void>(`(() => {
    const btn = Array.from(document.querySelectorAll('button[role="tab"]')).find((b) => (b.getAttribute('aria-label') || '').startsWith('浏览器'))
    if (btn) btn.click()
  })()`)
  await sleep(400)
  const r = await cdp.eval<{ ok: boolean; tabId?: string; error?: string }>(`(async () => {
    try {
      const t = await window.ark.browserTabs.create({ url: ${JSON.stringify(RED_URL)}, newTab: true })
      return { ok: true, tabId: t.tabId }
    } catch (e) { return { ok: false, error: String(e) } }
  })()`)
  console.log(`[1] 打开纯红页面: ${r.ok ? '✅' : '❌ ' + r.error}`)
  if (!r.ok) { await cdp.close(); process.exit(1) }
  await sleep(4000) // 等页面加载 + bounds 同步完成

  // 2. 读取窗口屏幕位置 / DPR / 占位区 bounds
  const geo = await cdp.eval<{ screenX: number; screenY: number; dpr: number; phX: number; phY: number; phW: number; phH: number; winW: number; winH: number }>(`(() => {
    const panel = document.getElementById('inspector-panel-browser')
    const ph = panel.querySelector('div.flex-1.min-h-0.relative')
    const rr = ph.getBoundingClientRect()
    return {
      screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio,
      phX: Math.round(rr.x), phY: Math.round(rr.y), phW: Math.round(rr.width), phH: Math.round(rr.height),
      winW: window.outerWidth, winH: window.outerHeight,
    }
  })()`)
  console.log(`[2] 窗口 screen=(${geo.screenX},${geo.screenY}) dpr=${geo.dpr} window=${geo.winW}x${geo.winH}`)
  console.log(`    占位区 bounds = (${geo.phX},${geo.phY}) ${geo.phW}x${geo.phH}`)

  // 修复后浏览器视图应在屏幕(physical px)上的矩形：
  //   contentView 原点屏幕坐标 = (screenX, screenY)（无框窗口），占位区在 contentView 局部 (phX, phY)
  const expX1 = Math.round((geo.screenX + geo.phX) * geo.dpr)
  const expY1 = Math.round((geo.screenY + geo.phY) * geo.dpr)
  const expX2 = Math.round((geo.screenX + geo.phX + geo.phW) * geo.dpr)
  const expY2 = Math.round((geo.screenY + geo.phY + geo.phH) * geo.dpr)
  console.log(`    期望浏览器矩形(屏幕px) = [${expX1},${expY1}] → [${expX2},${expY2}]（w=${expX2 - expX1}, h=${expY2 - expY1}）\n`)

  // 3. 全屏截图（含原生 WebContentsView）
  const shotPath = '/tmp/ark-browser-bounds-shot.png'
  console.log('[3] screencapture 全屏截图…')
  execFileSync('screencapture', ['-x', shotPath])
  const png = PNG.sync.read(readFileSync(shotPath))
  console.log(`    截图 ${png.width}x${png.height}\n`)

  // 4. 定位红色像素包围盒
  const box = findRedBBox(png)
  console.log(`[4] 红色像素包围盒 = ${box.count === 0 ? '(无红色)' : `[${box.x1},${box.y1}] → [${box.x2},${box.y2}]（w=${box.x2 - box.x1}, h=${box.y2 - box.y1}, 像素数=${box.count}）`}`)

  if (box.count === 0) {
    console.log('    ❌ 未检测到红色 —— 浏览器视图可能未显示 / 位置完全错误')
    await cdp.close(); process.exit(1)
  }

  // 5. 校验：位置（x/y 原点）与尺寸
  const tolX = 4, tolY = 4
  const posOk = Math.abs(box.x1 - expX1) <= tolX && Math.abs(box.y1 - expY1) <= tolY
  const sizeOk = Math.abs((box.x2 - box.x1) - (expX2 - expX1)) <= 4 && Math.abs((box.y2 - box.y1) - (expY2 - expY1)) <= 4
  console.log(`    位置匹配: ${posOk ? '✅' : '❌'}（实际 x1,y1=${box.x1},${box.y1} vs 期望 ${expX1},${expY1}）`)
  console.log(`    尺寸匹配: ${sizeOk ? '✅' : '❌'}（实际 ${box.x2 - box.x1}x${box.y2 - box.y1} vs 期望 ${expX2 - expX1}x${expY2 - expY1}）`)

  // 6. 校验：无遮挡 —— 浏览器区域左侧（会话区）不应出现红色
  const sessionX2 = expX1 - 8 // 浏览器区域左边一段留空
  let sessionRed = 0
  for (let y = expY1; y <= expY2 && y < png.height; y++) {
    for (let x = 0; x <= sessionX2 && x < png.width; x++) {
      const idx = (png.width * y + x) << 2
      if (png.data[idx] > 200 && png.data[idx + 1] < 90 && png.data[idx + 2] < 90) sessionRed++
    }
  }
  const noOcclusion = sessionRed === 0
  console.log(`    会话区红色像素: ${sessionRed} → ${noOcclusion ? '✅ 无遮挡' : '❌ 浏览器内容覆盖到会话区！'}`)

  console.log('')
  if (posOk && sizeOk && noOcclusion) {
    console.log('=== ✅ 全部通过：浏览器视图精确覆盖占位区，无错位、无遮挡 ===')
  } else {
    console.log('=== ❌ 存在失败项，请检查 ===')
    process.exitCode = 1
  }
  await cdp.close()
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
