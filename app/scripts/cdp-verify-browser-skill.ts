/* ============================================================
 * v0.24.1 — 浏览器侧边栏 + 技能自动加载 联动验证
 *
 * 目标：
 *   1) BrowserPanel 渲染了 webview 元素（不是 iframe / 占位）
 *   2) 切换到 browser tab 后，页面里有 webview 标签
 *   3) @coder 任务带 browser skillIds 跑起来后：
 *        a) 首轮出现「自动加载技能「browser」指令」步骤
 *        b) 后续 act 步骤出现 tool=browser 类型（如 eval / open）
 *
 * 退出方式：轮询 60s 后自动结束
 * ============================================================ */
import WebSocket from 'ws'

async function getWs(): Promise<string> {
  const r = await fetch('http://127.0.0.1:9222/json')
  const ts = await r.json() as Array<{ type: string; webSocketDebuggerUrl: string }>
  const page = ts.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  return page.webSocketDebuggerUrl
}

class CDP {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, (m: { result?: { result?: { value?: unknown } } }) => void>()
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
  async eval<T = unknown>(expr: string): Promise<T> {
    return new Promise((resolve) => {
      const mid = ++this.id
      this.pending.set(mid, (m) => {
        const v = (m.result?.result as { value?: unknown } | undefined)?.value
        resolve(v as T)
      })
      this.ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    })
  }
  async close() { this.ws.close() }
}

async function main() {
  const url = await getWs()
  const cdp = new CDP(url)
  await cdp.open()
  console.log('=== 浏览器侧边栏 + 技能自动加载 联动验证 ===\n')

  // 1. DOM 探查：找到 webview 元素，确认侧边栏 webview 渲染
  console.log('[1] DOM 探查：查找 webview / iframe')
  const domInfo = await cdp.eval<{ hasWebview: boolean; webviewCount: number; hasIframe: boolean; iframeCount: number; webviewSrc?: string }>(`(() => {
    const wvs = Array.from(document.querySelectorAll('webview'))
    const ifs = Array.from(document.querySelectorAll('iframe'))
    return {
      hasWebview: wvs.length > 0,
      webviewCount: wvs.length,
      hasIframe: ifs.length > 0,
      iframeCount: ifs.length,
      webviewSrc: wvs[0]?.getAttribute('src') ?? wvs[0]?.src ?? '',
    }
  })()`)
  console.log(`    webview: ${domInfo.webviewCount} 个（has=${domInfo.hasWebview}）`)
  console.log(`    iframe:  ${domInfo.iframeCount} 个（has=${domInfo.hasIframe}）`)
  console.log(`    webview src: ${domInfo.webviewSrc || '(空)'}`)
  console.log('')

  // 2. 检查 BrowserPanel store 中是否注册了 browserLoad
  console.log('[2] store 探查：ark.browser 通道注册')
  const browserApi = await cdp.eval<{ hasOnLoadRequest: boolean; hasLoadDone: boolean; hasResolve: boolean; keys: string[] }>(`(() => {
    const b = window.ark?.browser
    if (!b) return { hasOnLoadRequest: false, hasLoadDone: false, hasResolve: false, keys: [] }
    return {
      hasOnLoadRequest: typeof b.onLoadRequest === 'function',
      hasLoadDone: typeof b.loadDone === 'function' || typeof b.onLoadDone === 'function',
      hasResolve: typeof b.resolve === 'function',
      keys: Object.keys(b),
    }
  })()`)
  console.log(`    ark.browser keys: ${browserApi.keys.join(', ')}`)
  console.log(`    onLoadRequest=${browserApi.hasOnLoadRequest} loadDone=${browserApi.hasLoadDone} resolve=${browserApi.hasResolve}`)
  console.log('')

  // 3. 创建任务：Use Skill: browser（让 S-core.browser 被显式要求）
  console.log('[3] 创建任务：Use Skill: browser')
  const r = await cdp.eval<{ ok: boolean; task?: { id: string; title: string; skillIds?: string[] }; error?: string }>(`(async () => {
    try {
      const t = await window.ark.task.create({
        title: 'browser 技能自动加载验证',
        text: 'Use Skill: browser 打开 https://example.com 并截图保存',
        agentId: '@coder',
        skillIds: ['S-core.browser'],
        modelId: 'deepseek-v4-flash',
      })
      return { ok: true, task: t }
    } catch (e) { return { ok: false, error: String(e) } }
  })()`)
  if (!r.ok || !r.task) {
    console.log('    ❌ 失败：', r.error)
    process.exit(1)
  }
  const taskId = r.task.id
  console.log(`    ✅ ${taskId} skillIds=${JSON.stringify(r.task.skillIds)}\n`)

  // 4. 订阅 step 事件
  await cdp.eval<void>(`(() => { window.__stepLog2 = []; window.ark.task.onStep((s) => { window.__stepLog2.push({ type: s.type, tool: s.toolName ?? '', intent: s.intent ?? '', status: s.status }) }); return 'ok' })()`)

  // 5. 跑任务
  console.log('[4] 启动 runTask')
  await cdp.eval(`window.ark.task.run(${JSON.stringify(taskId)})`)

  console.log('[5] 轮询 step（每 3s，最长 60s）')
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const stepN = await cdp.eval<number>('window.__stepLog2.length')
    const browserActs = await cdp.eval<number>(`window.__stepLog2.filter(s => s.tool === 'browser' || /自动加载技能「browser」/.test(s.intent)).length`)
    console.log(`    ${(i + 1) * 3}s · step=${stepN} browser相关=${browserActs}`)
    if (stepN >= 3 && browserActs >= 1) break
  }
  console.log('')

  // 6. 列出关键事件
  console.log('[6] 步骤历史（按时间顺序）')
  const steps = await cdp.eval<Array<{ type: string; tool: string; intent: string; status: string }>>('window.__stepLog2')
  for (const s of steps ?? []) {
    const flag = /自动加载技能/.test(s.intent) ? '⭐' : s.type === 'act' && s.tool === 'browser' ? '🌐' : '·'
    console.log(`    ${flag} [${s.type}] tool=${s.tool || '-'} intent="${(s.intent || '').slice(0, 70)}" status=${s.status}`)
  }
  console.log('')

  // 7. 检查浏览器 tab 是否被触发（webview src 是否被设置成 example.com）
  console.log('[7] 浏览器侧边栏是否被打开？')
  const wv2 = await cdp.eval<{ src: string; url: string }>(`(() => {
    const w = document.querySelector('webview')
    return { src: w?.getAttribute('src') ?? '', url: w?.src ?? w?.getURL?.() ?? '' }
  })()`)
  console.log(`    webview src=${wv2.src || '(空)'}`)
  console.log(`    webview url=${wv2.url || '(空)'}`)
  console.log('')

  await cdp.close()
  console.log('=== 验证完成 ===')
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
