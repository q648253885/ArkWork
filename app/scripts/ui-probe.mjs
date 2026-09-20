/* ============================================================
 * ArkWork — 实机 UI 探针（CDP over localhost）
 *
 * 为什么需要它：契约用例（TC-MENU 组）只能断言「弹层被挂到了 document.body
 * 且用 position:fixed」这类**结构等价物**，无法断言「像素上真的看得见」
 * —— 这正是 v0.34.2「更多点不开」逃过 1374 条用例的原因（欠账 L-34-08）。
 * 本脚本用 Chrome DevTools Protocol 直连**真实运行中的应用**：
 *   · 截图 ⇒ 肉眼/多模态复核可见性；
 *   · eval ⇒ 读取真实布局几何（getBoundingClientRect / clientHeight）。
 *
 * 前提：应用以 `--remote-debugging-port=<PORT>` 启动。
 * CDP 走 127.0.0.1，因此**沙箱内的 shell 也能连**（局域网才是被隔离的）。
 *
 * 用法（cwd=app）：
 *   NODE_PATH=$PWD/node_modules node <此脚本> list
 *   NODE_PATH=$PWD/node_modules node <此脚本> shot /tmp/a.png
 *   NODE_PATH=$PWD/node_modules node <此脚本> eval "document.title"
 *   NODE_PATH=$PWD/node_modules node <此脚本> click "[data-testid=x]"
 *   NODE_PATH=$PWD/node_modules node <此脚本> clickxy 1217 114
 *   NODE_PATH=$PWD/node_modules node <此脚本> key Escape
 * ============================================================ */
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT || 9222)

class CDP {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      const p = msg.id && this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`))
      }, 15000)
    })
  }
}

async function connect() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const targets = await res.json()
  const page =
    targets.find((t) => t.type === 'page' && /index\.html|localhost|file:/.test(t.url || '')) ??
    targets.find((t) => t.type === 'page')
  if (!page) throw new Error(`未找到 page 目标：${JSON.stringify(targets.map((t) => t.type))}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return { cdp: new CDP(ws), ws, target: page }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { cdp, ws, target } = await connect()
  try {
    if (cmd === 'list') {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      console.log(JSON.stringify(await res.json(), null, 1))
      return
    }
    if (cmd === 'shot') {
      const out = rest[0] || '/tmp/arkwork-shot.png'
      // 可选裁剪：shot <out> <x> <y> <w> <h>（配合 2x dsf 可当放大镜用）
      const clip =
        rest.length >= 5
          ? {
              x: Number(rest[1]),
              y: Number(rest[2]),
              width: Number(rest[3]),
              height: Number(rest[4]),
              scale: Number(process.env.SHOT_SCALE || 1),
            }
          : undefined
      await cdp.send('Page.enable')
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip })
      writeFileSync(out, Buffer.from(data, 'base64'))
      console.log(`saved ${out}${clip ? ` clip=${JSON.stringify(clip)}` : ''}`)
      return
    }
    if (cmd === 'resize') {
      const w = Number(rest[0])
      const h = Number(rest[1])
      // Electron 不支持 Browser.getWindowForTarget / setWindowBounds；
      // 顶层窗口可以走渲染层的 window.resizeTo（会真正改窗口 → 触发 ResizeObserver）
      await cdp.send('Runtime.evaluate', {
        expression: `window.resizeTo(${w}, ${h})`,
        returnByValue: true,
      })
      await new Promise((r) => setTimeout(r, 800))
      const now = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ w: innerWidth, h: innerHeight })',
        returnByValue: true,
      })
      console.log(`resized → ${now.result?.value}`)
      return
    }
    if (cmd === 'click') {
      const selector = rest.join(' ')
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          if (!el) return null
          const b = el.getBoundingClientRect()
          return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height })
        })()`,
        returnByValue: true,
        awaitPromise: true,
      })
      const raw = r.result?.value
      if (!raw) throw new Error(`未找到元素：${selector}`)
      const { x, y } = JSON.parse(raw)
      // 真实鼠标序列（不是 el.click()）：这样才能走到 mousedown 那条关闭监听
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1,
        })
      }
      console.log(`clicked ${selector} @ (${x.toFixed(1)}, ${y.toFixed(1)})`)
      return
    }
    if (cmd === 'clickxy') {
      // 按视口坐标真实点一下（用于「第 N 行」这类没有稳定选择器的目标）
      const x = Number(rest[0])
      const y = Number(rest[1])
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('用法：clickxy <x> <y>')
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
      console.log(`clicked xy (${x}, ${y})`)
      return
    }
    if (cmd === 'key') {
      const key = rest[0]
      // Chromium 对非字符键要求 rawKeyDown + 正确的 virtualKeyCode，否则键盘处理拿不到
      const VK = {
        Escape: 27,
        Tab: 9,
        ArrowDown: 40,
        ArrowUp: 38,
        Home: 36,
        End: 35,
        Enter: 13,
      }
      const vk = VK[key]
      if (vk === undefined) throw new Error(`未登记虚拟键码：${key}`)
      for (const type of ['rawKeyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', {
          type,
          key,
          code: key,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        })
      }
      console.log(`pressed ${key}`)
      return
    }
    if (cmd === 'eval') {
      const expr = rest.join(' ')
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      })
      if (r.exceptionDetails) {
        console.error('EXCEPTION', JSON.stringify(r.exceptionDetails, null, 1))
        process.exitCode = 1
        return
      }
      console.log(JSON.stringify(r.result?.value, null, 1))
      return
    }
    console.error(`未知命令：${String(cmd)}（可用：list / shot / eval）`)
    process.exitCode = 2
  } finally {
    ws.close()
    void target
  }
}

main().catch((err) => {
  console.error('探针失败：', err?.message || err)
  process.exitCode = 1
})
