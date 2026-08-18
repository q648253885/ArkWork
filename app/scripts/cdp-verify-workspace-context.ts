/* ============================================================
 * v0.24.x — CDP 端到端验证：workspace-context 系统提示词顺序 + 重写 t2 小游戏
 *
 * 前提（外部准备）：
 *   1. ArkWork.app 已启动，渲染进程 CDP 在 9222
 *   2. 主进程 Node inspector 已开启（kill -USR1 <pid>）在 9229
 *
 * 流程：
 *   1. 主进程(9229)：挂 globalThis.fetch 钩子，捕获 LLM chat/completions 请求的 system
 *   2. 渲染进程(9222)：探测 settings/models/agents → 激活工作区 /Users/gongzheng/ai/t2
 *   3. 创建任务「重写 t2 小游戏」并 run
 *   4. 轮询：首包到达后解析 system 前 1500 字符，验证
 *      workspace-context(## 环境信息 / <project>) 在 core-rules(## 核心规则) 之前
 *   5. 持续监控任务状态/迭代数，直至完成或超时
 *
 * 运行（cwd=app）：
 *   npx tsx scripts/cdp-verify-workspace-context.ts
 * ============================================================ */
import WebSocket from 'ws'

const RENDERER_HTTP = 'http://127.0.0.1:9222'
const MAIN_HTTP = 'http://127.0.0.1:9229'
const WORKSPACE = '/Users/gongzheng/ai/t2'
const MAX_POLL_SECONDS = 25 * 60 // 最长等 25 分钟

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
          const rr = m.result as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
          const v = rr?.result?.value
          if (v !== undefined) resolve(v as T)
          else if (rr?.exceptionDetails) resolve(`EXCEPTION: ${rr.exceptionDetails.text ?? rr.exceptionDetails.exception?.description ?? '?'}` as T)
          else resolve(undefined as T)
        }
      })
      this.ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
    })
  }
  async close() { this.ws.close() }
}

async function getTargetWs(base: string, want: 'page' | 'node'): Promise<string> {
  const r = await fetch(base + '/json')
  const ts = await r.json() as Array<{ type: string; webSocketDebuggerUrl: string; url: string; description?: string }>
  const t = want === 'page'
    ? ts.find((x) => x.type === 'page' && /app\.asar|localhost|file:/.test(x.url))
    : ts.find((x) => x.type === 'node' || /node\.js instance/.test(x.description ?? ''))
  if (!t) throw new Error(`no ${want} target at ${base}`)
  return t.webSocketDebuggerUrl
}

/** 带重试的求值：偶发竞态（页面初始化/上下文切换）时重试 */
async function probe<T = unknown>(cdp: CDP, expr: string, tries = 3): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await cdp.eval<T>(expr)
    if (v !== undefined && v !== null && v !== '' && !String(v).startsWith('EXCEPTION:')) return v
    await new Promise((r) => setTimeout(r, 800))
  }
  return undefined as T
}

const FETCH_HOOK = `
(() => {
  globalThis.__llmCap = { count: 0, first: null, lastSystemLen: 0, lastUrl: '' };
  const orig = globalThis.fetch;
  if (!orig) return 'no-global-fetch';
  globalThis.__origFetch = orig;
  globalThis.fetch = async function (...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const init = args[1] || {};
      let bodyText = '';
      if (typeof init.body === 'string') bodyText = init.body;
      else if (init.body) { try { bodyText = JSON.stringify(init.body); } catch {} }
      const isLlm = /chat\\/completions/i.test(url) || /\\/messages/.test(url) || /api\\.anthropic/i.test(url);
      if (isLlm && bodyText) {
        globalThis.__llmCap.count++;
        let sys = '', model = '';
        try {
          const p = JSON.parse(bodyText);
          model = p.model || '';
          // OpenAI 兼容：system 是 messages[0]；Anthropic 兼容：system 是顶层字段
          if (Array.isArray(p.messages) && p.messages[0] && p.messages[0].role === 'system') {
            sys = typeof p.messages[0].content === 'string' ? p.messages[0].content : JSON.stringify(p.messages[0].content);
          } else if (typeof p.system === 'string') {
            sys = p.system;
          } else if (p.system && Array.isArray(p.system)) {
            sys = p.system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\\n');
          }
        } catch {}
        if (!globalThis.__llmCap.first) {
          globalThis.__llmCap.first = { url, model, systemLen: sys.length, sys };
        }
        globalThis.__llmCap.lastSystemLen = sys.length;
        globalThis.__llmCap.lastUrl = url;
      }
    } catch {}
    return orig.apply(this, args);
  };
  return 'fetch-hooked';
})()
`

const CAPTURE_READ = `
(() => {
  const c = globalThis.__llmCap;
  if (!c) return { installed: false };
  const f = c.first;
  const marks = f ? (() => {
    const s = f.sys;
    const idx = (k) => s.indexOf(k);
    return {
      env: idx('## 环境信息'),
      project: idx('## 项目结构'),
      stack: idx('## 技术栈'),
      coreRules: idx('## 核心规则'),
      personality: idx('## 人格设定'),
      workspace: idx('## 当前工作区'),
      envTag: idx('<env>'),
      projectTag: idx('<project>'),
    };
  })() : null;
  return {
    installed: true,
    count: c.count,
    first: f ? { url: f.url, model: f.model, systemLen: f.systemLen, head: f.sys.slice(0, 1500) } : null,
    marks,
    lastSystemLen: c.lastSystemLen,
    lastUrl: c.lastUrl,
  };
})()
`

async function main() {
  // ---- Phase 1: 主进程挂 fetch 钩子 ----
  console.log('[1] 连接主进程 inspector(9229) 并挂 fetch 钩子')
  const mainWs = await getTargetWs(MAIN_HTTP, 'node')
  const main = new CDP(mainWs)
  await main.open()
  const hook = await main.eval<string>(FETCH_HOOK)
  console.log(`    钩子安装：${hook}\n`)
  if (hook !== 'fetch-hooked') {
    // 兜底：可能 SDK 在构造时已捕获 fetch 引用，改用临时提示
    console.log('    ⚠️ 未拿到全局 fetch —— 仍将运行任务，稍后检查捕获。')
  }

  // ---- Phase 2: 渲染进程探测 + 激活工作区 ----
  console.log('[2] 连接渲染进程 CDP(9222)')
  const pageTargets = await (await fetch(RENDERER_HTTP + '/json')).json() as Array<{ type: string; url: string; title?: string }>
  console.log('    目标列表：', JSON.stringify(pageTargets.map((t) => ({ type: t.type, url: (t.url || '').slice(0, 70) })), null, 0), '\n')
  const pageWs = await getTargetWs(RENDERER_HTTP, 'page')
  const page = new CDP(pageWs)
  await page.open()

  const settingsTry1 = await page.eval<string>(`(async () => { try { return JSON.stringify(await window.ark.settings.get()); } catch (e) { return 'THROW:' + String(e); } })()`)
  const settingsTry2 = await page.eval<string>(`typeof window.ark + ' | settings fn: ' + typeof (window.ark && window.ark.settings && window.ark.settings.get)`)
  console.log('    settings try1：', JSON.stringify(settingsTry1))
  console.log('    settings try2：', JSON.stringify(settingsTry2), '\n')
  const settings = settingsTry1?.startsWith('{') ? settingsTry1 : undefined

  const models = await probe<string>(page, `(async () => { try { return JSON.stringify((await window.ark.model.list()).map((m) => ({ id: m.id, kind: m.kind }))); } catch (e) { return 'THROW:' + String(e); } })()`)
  const modelArr = JSON.parse(models ?? '[]') as Array<{ id: string; kind: string }>
  console.log('[3] 可用模型：', JSON.stringify(modelArr), '\n')
  // 重写任务用 OpenAI 兼容端点（deepseek-v4-flash），便于捕获验证
  const modelId = modelArr.find((m) => m.id === 'deepseek-v4-flash')?.id
    ?? modelArr.find((m) => m.kind !== 'anthropic')?.id
    ?? modelArr[0]?.id
  if (!modelId) throw new Error('无可用模型')

  const agents = await probe<string>(page, `(async () => { try { return JSON.stringify((await window.ark.agent.list()).map((a) => ({ id: a.id, name: a.name }))); } catch (e) { return 'THROW:' + String(e); } })()`)
  const agentArr = JSON.parse(agents ?? '[]') as Array<{ id: string; name: string }>
  console.log('[4] 可用智能体：', JSON.stringify(agentArr), '\n')
  const agentId = agentArr.find((a) => a.id === '@default')?.id ?? agentArr[0]?.id

  // 激活工作区为 t2（幂等；引擎 getWorkspaceDir 将指向 t2）
  const wsInfo = await probe<string>(page, `(async () => {
    try {
      await window.ark.settings.activateWorkspace(${JSON.stringify(WORKSPACE)});
      return 'activated';
    } catch (e) { return 'ERR:' + String(e); }
  })()`)
  console.log(`[5] 激活工作区 ${WORKSPACE}：`, wsInfo, '\n')

  // ---- Phase 3: 创建任务 + run ----
  const text =
    `请重写 /Users/gongzheng/ai/t2 目录下的小游戏「星途行者：碎镜回响」（Phaser 网页游戏），` +
    `目标是让它可以直接用浏览器打开 index.html 正常运行、无报错、玩法完整可玩。` +
    `工作区结构、环境信息已注入 system prompt，请直接利用，不要反复试探目录。` +
    `改完后请用本地方式验证（如检查语法/依赖引用完整性），并给出如何启动。`
  console.log('[6] 创建任务 + runTask')
  const r = await page.eval<{ ok: boolean; task?: { id: string; title: string }; error?: string }>(`(async () => {
    try {
      const t = await window.ark.task.create({ title: '重写 t2 小游戏（可正常运行）', text: ${JSON.stringify(text)}, agentId: ${JSON.stringify(agentId)}, skillIds: [], modelId: ${JSON.stringify(modelId)} });
      await window.ark.task.run(t.id);
      return { ok: true, task: { id: t.id, title: t.title } };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`)
  if (!r.ok || !r.task) {
    console.log('    ❌ 创建/运行失败：', r.error)
    process.exit(1)
  }
  const taskId = r.task.id
  console.log(`    ✅ 任务：${taskId}（${r.task.title}，模型 ${modelId}）\n`)

  // ---- Phase 4: 轮询捕获 + 任务状态 ----
  console.log('[7] 轮询（每 4s）：等待 LLM 首包 + 任务推进')
  let printedOrder = false
  const start = Date.now()
  while (Date.now() - start < MAX_POLL_SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, 4000))

    const cap = await main.eval<{
      installed: boolean; count: number;
      first?: { url: string; model: string; systemLen: number; head: string } | null;
      marks?: Record<string, number>; lastSystemLen: number; lastUrl: string;
    } | null>(CAPTURE_READ)

    const status = await page.eval<string>(`(async () => { try { const t = await window.ark.task.get(${JSON.stringify(taskId)}); return JSON.stringify({ status: t.status }); } catch (e) { return '{}'; } })()`).catch(() => '{}')
    const statusObj = JSON.parse(status ?? '{}') as { status?: string }

    if (cap?.first && !printedOrder) {
      printedOrder = true
      console.log('\n========== ✅ 捕获到 LLM 首包 ==========')
      console.log(`URL: ${cap.first.url}`)
      console.log(`Model: ${cap.first.model}  |  system 长度: ${cap.first.systemLen} 字符`)
      console.log('--- system 前 1500 字符 ---')
      console.log(cap.first.head)
      console.log('--- 关键段位置（字符偏移）---')
      const m = cap.marks ?? {}
      const rows = [
        ['## 环境信息 (workspace-context/env)', m.env ?? -1],
        ['<env> 标签', m.envTag ?? -1],
        ['## 项目结构 (workspace-context/project)', m.project ?? -1],
        ['<project> 标签', m.projectTag ?? -1],
        ['## 技术栈 (workspace-context/stack)', m.stack ?? -1],
        ['## 核心规则 (coreRules)', m.coreRules ?? -1],
        ['## 人格设定 (personality)', m.personality ?? -1],
        ['## 当前工作区 (workspace)', m.workspace ?? -1],
      ]
      for (const [k, v] of rows) console.log(`  ${k.padEnd(46)} ${v}`)
      const ok = m.env !== undefined && m.env >= 0 && m.coreRules !== undefined && m.coreRules > m.env
      console.log(ok
        ? '\n✅ 验证通过：workspace-context（环境信息）位于 coreRules 之前，ArkWork 系统提示词最先。'
        : '\n❌ 验证失败：workspace-context 不在 coreRules 之前。')
    }

    if (cap) console.log(`  [${Math.round((Date.now() - start) / 1000)}s] 捕获数=${cap.count} lastSystemLen=${cap.lastSystemLen} 任务状态=${statusObj.status ?? '?'}`)

    if (statusObj.status === 'done' || statusObj.status === 'failed' || statusObj.status === 'cancelled') {
      console.log(`\n=== 任务结束：${statusObj.status} ===`)
      break
    }
  }

  // ---- Phase 5: 最终状态 ----
  const fin = await page.eval<string>(`(async () => { try { const t = await window.ark.task.get(${JSON.stringify(taskId)}); return JSON.stringify({ status: t.status, planItems: (t.planItems || []).map((p) => ({ text: p.text, status: p.status })) }); } catch (e) { return '{}'; } })()`).catch(() => '{}')
  const finObj = JSON.parse(fin ?? '{}') as { status?: string; planItems?: Array<{ text: string; status: string }> }
  console.log('\n[8] 最终任务状态：', finObj.status)
  if (Array.isArray(finObj.planItems)) {
    console.log(`    计划清单（${finObj.planItems.length} 项）：`)
    for (const p of finObj.planItems) console.log(`      · [${p.status}] ${p.text.slice(0, 60)}`)
  }
  const cap2 = await main.eval<{ count: number; lastSystemLen: number }>(CAPTURE_READ)
  console.log(`    累计 LLM 请求 ${cap2?.count ?? 0} 次`)

  await page.close()
  await main.close()
  console.log('\n=== 验证完成 ===')
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
