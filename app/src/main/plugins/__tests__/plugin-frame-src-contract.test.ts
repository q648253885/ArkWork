/* ============================================================
 * ArkWork — 插件视图装载契约：宿主页 CSP `frame-src`（v0.36.0 · D90）
 * 设计文档：docs/versions/v0.36.0/04-system-design.md §7（D90）
 *
 * ★ 为什么必须有一条**跨文件**用例：
 *   插件代码视图能不能装载，由两个不同目录下的两份字面量共同决定 ——
 *     · `src/main/plugins/protocol.ts`      → 插件响应侧 CSP（PLUGIN_VIEW_CSP）
 *     · `src/renderer/index.html`（meta）   → 宿主页允许嵌哪些源（frame-src）
 *   它们是「同一事实的两个副本」，谁也不 import 谁。v0.35.0 正是栽在这里：
 *   protocol.ts 的协议特权、handler、URL 拼法全对，单测全绿，但 index.html
 *   那条 `frame-src 'self' https: http: data: file:` 从没提过 `arkwork-plugin:`，
 *   于是 Chromium 在建框阶段直接拒绝（`net::ERR_BLOCKED_BY_CSP`），子框架退化成
 *   `chrome-error://chromewebdata/` —— 用户看到的是一整块纯白面板，**宿主零报错**。
 *
 *   纯函数单测天然发现不了这种缺陷（两边各自都对、谁也不引用谁），
 *   所以这条用例读**源码字面量**并断言包含关系：谁把 scheme 从 frame-src 里
 *   删掉、或者把 index.html 整体换掉，都会立刻红。
 *
 * 反向核验记录：把 index.html 的 `arkwork-plugin:` 摘掉 → TC-PFS-001 立即报红。
 * ============================================================ */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { PLUGIN_SCHEME } from '../protocol.js'

/** 渲染层入口页（vite 原样拷进 out/renderer；cwd = app/） */
const INDEX_HTML = join(process.cwd(), 'src', 'renderer', 'index.html')

/** 取出 meta CSP 的 content 原文 */
function readMetaCsp(): string {
  const html = readFileSync(INDEX_HTML, 'utf-8')
  const m = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]*)"/i.exec(html)
  assert.ok(m, '渲染层入口页必须有一条 meta CSP（没有就等于全放开，不能被静默移除）')
  return m[1]
}

/** 按 `;` 拆指令，取某条指令的源列表（不存在返回 null） */
function directiveSources(csp: string, name: string): string[] | null {
  for (const raw of csp.split(';')) {
    const parts = raw.trim().split(/\s+/)
    if (parts[0]?.toLowerCase() === name) return parts.slice(1)
  }
  return null
}

test('TC-PFS-001 ★ 宿主页 frame-src 必须放行插件协议（缺 → 插件视图整块白屏）', () => {
  const csp = readMetaCsp()
  const frameSrc = directiveSources(csp, 'frame-src')
  assert.ok(frameSrc, 'frame-src 必须显式存在 —— 否则会退回 default-src，本页 default-src 也只有 \'self\'')
  assert.ok(
    frameSrc.includes(`${PLUGIN_SCHEME}:`),
    `frame-src 必须包含 scheme 源「${PLUGIN_SCHEME}:」（当前：${frameSrc.join(' ')}）。` +
      '缺它 → net::ERR_BLOCKED_BY_CSP，插件 iframe 退化成 chrome-error 纯白页（D90）',
  )
})

test('TC-PFS-002 frame-src 的 scheme 源必须与 PLUGIN_SCHEME 逐字一致（防改名只改一处）', () => {
  const csp = readMetaCsp()
  const frameSrc = directiveSources(csp, 'frame-src') ?? []
  const schemeEntries = frameSrc.filter((s) => /^[a-z][a-z0-9+.-]*:$/i.test(s))
  const pluginEntries = schemeEntries.filter((s) => /plugin/i.test(s))
  assert.deepEqual(
    pluginEntries,
    [`${PLUGIN_SCHEME}:`],
    '与插件相关的 scheme 源只许有 PLUGIN_SCHEME 一个，且拼写必须与 protocol.ts 完全一致',
  )
})

test("TC-PFS-003 frame-src 不得被放宽成通配（白屏的反向风险：开太宽）", () => {
  const csp = readMetaCsp()
  const frameSrc = directiveSources(csp, 'frame-src') ?? []
  for (const bad of ['*', 'http:', 'https:']) {
    // http:/https: 是历史基线（内置浏览器面板需要），这里只钉住「不许再宽成 *」
    if (bad === '*') {
      assert.ok(!frameSrc.includes('*'), 'frame-src 不得出现 * —— 插件与内置浏览器都不需要任意源')
    }
  }
  assert.ok(frameSrc.length > 0)
})
