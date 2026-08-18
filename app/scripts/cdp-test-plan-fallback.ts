/* ============================================================
 * v0.24.x — CDP 端到端验证：完整 plan-fallback 链路
 *
 * 步骤：
 *   1. 监听 plan-list-snapshot
 *   2. 创建任务 + 立即 runTask
 *   3. 等 5s 看引擎是否写出 planItems（generatePlan 成功或 fallback）
 *   4. 验证 planItems 长度 ≥ 1
 *
 * ============================================================ */
import WebSocket from 'ws'

async function getWs(): Promise<string> {
  const r = await fetch('http://127.0.0.1:9222/json')
  const ts = await r.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>
  const page = ts.find((t) => t.type === 'page' && /localhost|app\.asar/.test(t.url))
  if (!page) throw new Error('no page target')
  return page.webSocketDebuggerUrl
}

class CDP {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
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
    return new Promise((resolve, reject) => {
      const mid = ++this.id
      this.pending.set(mid, (m) => {
        if (m.error) reject(new Error(m.error.message))
        else {
          const r = (m.result as { result?: { value?: unknown }; exceptionDetails?: unknown }).result
          resolve(r?.value as T)
        }
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
  console.log('=== Plan-fallback 端到端验证 ===\n')

  // 1. 订阅（先订阅，再创建）
  console.log('[1] 监听 task:plan-list-snapshot + plan-item-status-changed 通道')
  await cdp.eval<void>(`(() => { window.__snapLog = []; window.__patchLog = []; window.__arkTask.onPlanItemListSnapshot((p) => { window.__snapLog.push({ ver: p.version, count: p.planItems.length, items: p.planItems.map(x => ({ text: x.text.slice(0,30), status: x.status })) }); }); window.__arkTask.onPlanItemStatusChanged((p) => { window.__patchLog.push({ ver: p.version, status: p.status, source: p.source, reason: p.reason ?? '', itemIdx: p.index }); }); return 'subscribed'; })()`)
  console.log('    订阅完成\n')

  // 2. 创建任务 + 立即 runTask
  console.log('[2] 创建任务 + 跑引擎')
  const r = await cdp.eval<{ ok: boolean; task?: { id: string }; error?: string }>(`(async () => { try { const t = await window.ark.task.create({ title: 'plan-fallback 验证', text: '你好', agentId: '@default', skillIds: [], modelId: 'MiniMax-M3' }); await window.ark.task.run(t.id); return { ok: true, task: t }; } catch (e) { return { ok: false, error: String(e) }; } })()`)
  if (!r.ok || !r.task) {
    console.log('    ❌ 失败：', r.error)
    process.exit(1)
  }
  const taskId = r.task.id
  console.log(`    ✅ 任务：${taskId}\n`)

  // 4. 轮询 planItems 直到稳定
  console.log('[4] 轮询 planItems（每 2s 一次，最多 30s）')
  let lastCount = -1
  let stableRounds = 0
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const items = await cdp.eval<unknown[]>(`window.ark.task.fetchPlanItemList(${JSON.stringify(taskId)})`)
    const n = Array.isArray(items) ? items.length : 0
    const ver = await cdp.eval<number>(`window.__snapLog.length`)
    const patchN = await cdp.eval<number>(`window.__patchLog.length`)
    const status = (Array.isArray(items) && items.length > 0) ? (items[0] as { status: string }).status : 'no-items'
    console.log(`    ${(i + 1) * 2}s · planItems=${n} status=${status} snapshot数=${ver} patch数=${patchN}`)
    if (n === lastCount) stableRounds++
    else { stableRounds = 0; lastCount = n }
    if (stableRounds >= 2 && n > 0) break
  }
  console.log('')

  // 5. 最终状态
  const finalItems = await cdp.eval<unknown[]>(`window.ark.task.fetchPlanItemList(${JSON.stringify(taskId)})`)
  console.log(`[5] 最终 planItems（${Array.isArray(finalItems) ? finalItems.length : '?'} 项）`)
  if (Array.isArray(finalItems)) {
    for (const p of finalItems) {
      console.log(`    · [${(p as { status: string }).status}] ${(p as { text: string }).text.slice(0, 60)}`)
    }
  }
  console.log('')

  // 6. Snapshot 历史
  const snaps = await cdp.eval<Array<{ ver: number; count: number; items: unknown[] }>>(`window.__snapLog`)
  console.log(`[6] plan-list-snapshot 历史（共 ${Array.isArray(snaps) ? snaps.length : 0} 条）`)
  if (Array.isArray(snaps)) {
    for (const s of snaps) {
      console.log(`    ver=${s.ver} count=${s.count} items=[${(s.items as Array<{ text: string }>).map(i => i.text.slice(0,20)).join(' | ')}]`)
    }
  }
  console.log('')

  // 7. Patch 历史
  const patches = await cdp.eval<Array<{ status: string; source: string; reason?: string }>>(`window.__patchLog`)
  console.log(`[7] plan-item-status-changed 历史（共 ${Array.isArray(patches) ? patches.length : 0} 条）`)
  if (Array.isArray(patches)) {
    for (const p of patches) {
      console.log(`    [${p.status}] source=${p.source} reason=${p.reason ?? ''}`)
    }
  }

  await cdp.close()
  console.log('\n=== 验证完成 ===')
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })