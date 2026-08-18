/* ============================================================
 * v0.24.1 — 验证「Use Skill: 文档驱动开发」触发
 *   1) 任务不再退化为"未命名任务"
 *   2) 首轮出现"自动加载技能「文档驱动开发」指令"步骤
 *
 * 用模型 deepseek-v4-flash（思考型）模拟原症状
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
  console.log('=== Use Skill: 文档驱动开发 修复验证 ===\n')

  // 1. 订阅 step + plan-list 事件
  console.log('[1] 监听 task:step + plan-list-snapshot')
  await cdp.eval<void>(`(() => {
    window.__stepLog = []
    window.__snapLog = []
    window.ark.task.onStep((s) => { window.__stepLog.push({ type: s.type, tool: s.toolName ?? '', intent: s.intent ?? '', status: s.status, args: (s.toolArgs ?? '').slice(0, 80) }) })
    window.ark.task.onPlanItemListSnapshot((p) => { window.__snapLog.push({ ver: p.version, count: p.planItems.length, items: p.planItems.map(x => x.text.slice(0, 60)) }) })
    return 'ok'
  })()`)
  console.log('    已订阅\n')

  // 2. 创建任务
  console.log('[2] 创建任务：Use Skill: 文档驱动开发 ……')
  const r = await cdp.eval<{ ok: boolean; task?: { id: string; title: string; skillIds?: string[] }; error?: string }>(`(async () => {
    try {
      const t = await window.ark.task.create({
        title: '文档驱动开发 · 演示',
        text: 'Use Skill: 文档驱动开发 帮我在现有项目做一个新增功能：让任务标题支持 emoji 前缀。',
        agentId: '@coder',
        skillIds: ['S-imported.skill'],
        modelId: 'deepseek-v4-flash',
      })
      return { ok: true, task: t }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })()`)
  if (!r.ok || !r.task) {
    console.log('    ❌ 失败：', r.error)
    process.exit(1)
  }
  const taskId = r.task.id
  console.log(`    ✅ 任务 ${taskId} skillIds=${JSON.stringify(r.task.skillIds)}\n`)

  // 3. 跑任务
  console.log('[3] 启动 runTask')
  await cdp.eval(`window.ark.task.run(${JSON.stringify(taskId)})`)

  // 4. 轮询 step / planItems
  console.log('[4] 轮询 step + planItems（每 3s，最长 60s）')
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const stepN = await cdp.eval<number>('window.__stepLog.length')
    const snapN = await cdp.eval<number>('window.__snapLog.length')
    const items = await cdp.eval<unknown[]>(`window.ark.task.fetchPlanItemList(${JSON.stringify(taskId)})`)
    const n = Array.isArray(items) ? items.length : 0
    console.log(`    ${(i + 1) * 3}s · step=${stepN} snapshot=${snapN} planItems=${n}`)
    if (stepN > 5 && snapN > 0 && n >= 3) break
  }
  console.log('')

  // 5. 列出关键事件
  console.log('[5] 步骤历史（过滤 type=act/intent 含技能加载的）')
  const steps = await cdp.eval<Array<{ type: string; tool: string; intent: string; status: string }>>('window.__stepLog')
  const skillAutoLoadedSteps = (steps ?? []).filter((s) => /自动加载技能/.test(s.intent))
  console.log(`    总步骤数: ${(steps ?? []).length}`)
  console.log(`    自动加载技能步骤数: ${skillAutoLoadedSteps.length}`)
  for (const s of skillAutoLoadedSteps) {
    console.log(`    · [${s.type}] tool=${s.tool} intent="${s.intent}" status=${s.status}`)
  }
  console.log('')

  console.log('[6] 计划项（planItems）')
  const finalItems = await cdp.eval<unknown[]>(`window.ark.task.fetchPlanItemList(${JSON.stringify(taskId)})`)
  if (Array.isArray(finalItems)) {
    for (const p of finalItems) {
      const x = p as { status: string; text: string }
      console.log(`    · [${x.status}] ${x.text.slice(0, 80)}`)
    }
    const allUnnamed = finalItems.length > 0 && finalItems.every((x) => /未命名/.test((x as { text: string }).text))
    console.log(`    全部为"未命名任务"?: ${allUnnamed ? '❌ 是' : '✅ 否'}`)
    console.log(`    计划项数量: ${finalItems.length}`)
  } else {
    console.log('    ❌ planItems 为空')
  }
  console.log('')

  console.log('[7] snapshot 历史')
  const snaps = await cdp.eval<Array<{ ver: number; count: number; items: string[] }>>('window.__snapLog')
  console.log(`    共 ${(snaps ?? []).length} 条`)
  for (const s of snaps ?? []) {
    console.log(`    ver=${s.ver} count=${s.count} items=[${s.items.join(' | ').slice(0, 100)}]`)
  }

  await cdp.close()
  console.log('\n=== 验证完成 ===')
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
