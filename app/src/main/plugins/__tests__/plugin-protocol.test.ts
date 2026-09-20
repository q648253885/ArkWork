/* ============================================================
 * ArkWork — 插件资源协议用例库（v0.35.0 · B5 / M9）
 * 设计文档：docs/versions/v0.35.0/04-system-design.md §1 · §5.2 · §9
 *
 * 这套用例守的是**目录收口**：`arkwork-plugin://<id>/<rel>` 只允许读到
 * 「该插件自己目录内」的文件。用真实临时目录 + 真实 symlink 来验，
 * 不只断言字符串前缀（字符串前缀挡不住 symlink 逃逸 —— 这正是要防的那件事）。
 * ============================================================ */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  PLUGIN_SCHEME,
  PLUGIN_VIEW_CSP,
  createPluginAssetHandler,
  isSafeRelPath,
  mimeOf,
  parsePluginAssetUrl,
  pluginAssetUrl,
  resolveInsidePlugin,
} from '../protocol.js'

/* ---------- 真实临时插件目录 ---------- */
function makeSandbox(): { root: string; pluginDir: string; outside: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'arkwork-plugin-proto-'))
  const pluginDir = join(root, 'plugins', 'ark.plugin.demo')
  const outside = join(root, 'outside')
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(pluginDir, 'renderer.js'), 'console.log("hi")', 'utf-8')
  writeFileSync(join(pluginDir, 'index.html'), '<!doctype html><p>hi</p>', 'utf-8')
  writeFileSync(join(pluginDir, 'data.json'), '{"a":1}', 'utf-8')
  writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET', 'utf-8')
  // ★ 逃逸把手：插件目录里放一个指向目录外的软链
  symlinkSync(outside, join(pluginDir, 'escape'), 'dir')
  mkdirSync(join(pluginDir, 'assets'), { recursive: true }) // 目录（不是文件）
  return {
    root,
    pluginDir,
    outside,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/* ============================================================
 * 一、URL 解析
 * ============================================================ */

test('TC-PLG4-001 合法 URL 解析：host 是 pluginId、path 是相对路径', () => {
  assert.deepEqual(parsePluginAssetUrl('arkwork-plugin://ark.plugin.demo/renderer.js'), {
    pluginId: 'ark.plugin.demo',
    rel: 'renderer.js',
  })
  assert.deepEqual(parsePluginAssetUrl('arkwork-plugin://a.b/ui/index.html'), { pluginId: 'a.b', rel: 'ui/index.html' })
  // 前导斜杠归一化
  assert.deepEqual(parsePluginAssetUrl('arkwork-plugin://a.b//x.js'), { pluginId: 'a.b', rel: 'x.js' })
})

test('TC-PLG4-002 非法 URL 一律 null（不抛、也不猜）', () => {
  assert.equal(parsePluginAssetUrl('https://example.com/x'), null, '别的协议不是我们的')
  assert.equal(parsePluginAssetUrl('file:///etc/passwd'), null)
  assert.equal(parsePluginAssetUrl('arkwork-plugin://'), null, '缺 pluginId')
  assert.equal(parsePluginAssetUrl('arkwork-plugin://a.b/'), null, '缺路径')
  assert.equal(parsePluginAssetUrl('not a url'), null)
  assert.equal(parsePluginAssetUrl(''), null)
})

test('TC-PLG4-003 pluginAssetUrl 与 parsePluginAssetUrl 必须互逆（两处漂移会白屏且无错）', () => {
  for (const id of ['ark.plugin.demo', 'a.b.c', 'my-calc']) {
    for (const rel of ['renderer.js', 'ui/index.html']) {
      const url = pluginAssetUrl(id, rel)
      assert.ok(url.startsWith(`arkwork-plugin://`))
      assert.deepEqual(parsePluginAssetUrl(url), { pluginId: id, rel })
    }
  }
})

/* ============================================================
 * 二、路径形状
 * ============================================================ */

test('TC-PLG4-004 isSafeRelPath：挡 `..` / 绝对路径 / 反斜杠 / 空段', () => {
  assert.equal(isSafeRelPath('a.js'), true)
  assert.equal(isSafeRelPath('ui/a.js'), true)
  assert.equal(isSafeRelPath('../a.js'), false)
  assert.equal(isSafeRelPath('ui/../../a.js'), false)
  assert.equal(isSafeRelPath('/etc/passwd'), false)
  assert.equal(isSafeRelPath('a\\b.js'), false)
  assert.equal(isSafeRelPath('a//b.js'), false)
  assert.equal(isSafeRelPath('./a.js'), false)
  assert.equal(isSafeRelPath(''), false)
})

/* ============================================================
 * 三、目录收口（真实磁盘 + 真实 symlink）
 * ============================================================ */

test('TC-PLG4-010 目录内文件可解析；目录本身与不存在的文件不可', () => {
  const sb = makeSandbox()
  try {
    assert.ok(resolveInsidePlugin(sb.pluginDir, 'renderer.js'))
    assert.equal(resolveInsidePlugin(sb.pluginDir, 'missing.js'), null)
    assert.equal(resolveInsidePlugin(sb.pluginDir, 'assets'), null, '目录不是可读资源')
    assert.equal(resolveInsidePlugin(sb.pluginDir, '../outside/secret.txt'), null)
  } finally {
    sb.cleanup()
  }
})

test('TC-PLG4-011 ★ symlink 逃逸必须被 realpath 挡住（只查字符串前缀就漏了）', () => {
  const sb = makeSandbox()
  try {
    // `escape` 是插件目录内一个指向目录外的**真实软链**：
    // 字符串前缀检查会认为「escape/secret.txt 在插件目录内」→ 放行 → 越权读。
    assert.equal(resolveInsidePlugin(sb.pluginDir, 'escape/secret.txt'), null)
  } finally {
    sb.cleanup()
  }
})

/* ============================================================
 * 四、handler
 * ============================================================ */

const request = (url: string): { url: string } => ({ url })

test('TC-PLG4-020 正常资源：200 + 正确 MIME + CORS 放行 + 不缓存', async () => {
  const sb = makeSandbox()
  try {
    const h = createPluginAssetHandler({ dirOf: () => sb.pluginDir })
    const res = await h(request('arkwork-plugin://ark.plugin.demo/renderer.js'))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'opaque origin 的沙箱 iframe 取自己的资源也是跨域')
    assert.equal(res.headers.get('cache-control'), 'no-store', '插件改完即可重载，不能被缓存卡住')
    assert.match(await res.text(), /console\.log/)
  } finally {
    sb.cleanup()
  }
})

test('TC-PLG4-021 HTML 响应必须带 CSP，且 connect-src 为 none（网络的唯一出口在网关）', async () => {
  const sb = makeSandbox()
  try {
    const h = createPluginAssetHandler({ dirOf: () => sb.pluginDir })
    const res = await h(request('arkwork-plugin://ark.plugin.demo/index.html'))
    assert.equal(res.status, 200)
    const csp = res.headers.get('content-security-policy')
    assert.ok(csp, 'HTML 必须带 CSP')
    assert.equal(csp, PLUGIN_VIEW_CSP)
    assert.match(csp!, /connect-src 'none'/, 'Client 半不得直连网络 —— 要联网必须回 Host 半走带闸门的网关')
    assert.match(csp!, /frame-ancestors 'self'/)
  } finally {
    sb.cleanup()
  }
})

test('TC-PLG4-022 JS 响应不带 CSP（只有文档需要），但 MIME 正确', async () => {
  const sb = makeSandbox()
  try {
    const h = createPluginAssetHandler({ dirOf: () => sb.pluginDir })
    const res = await h(request('arkwork-plugin://ark.plugin.demo/data.json'))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(res.headers.get('content-security-policy'), null)
  } finally {
    sb.cleanup()
  }
})

test('TC-PLG4-023 不在册的插件 → 404（不是 403，避免把「有什么」变成可探测信息）', async () => {
  const sb = makeSandbox()
  try {
    const h = createPluginAssetHandler({ dirOf: () => undefined })
    const res = await h(request('arkwork-plugin://ghost/renderer.js'))
    assert.equal(res.status, 404)
  } finally {
    sb.cleanup()
  }
})

test('TC-PLG4-024 越界（含 symlink 逃逸）→ 404 且记 warn', async () => {
  const sb = makeSandbox()
  const warns: string[] = []
  try {
    const h = createPluginAssetHandler({
      dirOf: () => sb.pluginDir,
      logger: { warn: (_s, m) => warns.push(m) },
    })
    for (const rel of ['../outside/secret.txt', 'escape/secret.txt', '%2e%2e/outside/secret.txt']) {
      const res = await h(request(`arkwork-plugin://ark.plugin.demo/${rel}`))
      assert.equal(res.status, 404, `${rel} 必须被拒`)
      assert.ok(!(await res.text()).includes('TOP SECRET'), '绝不能把目录外内容泄漏出去')
    }
    assert.ok(warns.length >= 1, '越界尝试值得留一条 warn（静默拒绝会让安全问题无从发现）')
  } finally {
    sb.cleanup()
  }
})

test('TC-PLG4-025 坏 URL → 400（与「不存在」区分开：这是调用方的编程错误）', async () => {
  const sb = makeSandbox()
  try {
    const h = createPluginAssetHandler({ dirOf: () => sb.pluginDir })
    assert.equal((await h(request('https://example.com/x'))).status, 400)
    assert.equal((await h(request('arkwork-plugin://a.b/'))).status, 400)
  } finally {
    sb.cleanup()
  }
})

test('TC-PLG4-026 MIME 表：覆盖插件会用到的类型，其余一律 octet-stream（不猜）', () => {
  assert.equal(mimeOf('a.html'), 'text/html; charset=utf-8')
  assert.equal(mimeOf('a.mjs'), 'text/javascript; charset=utf-8')
  assert.equal(mimeOf('a.css'), 'text/css; charset=utf-8')
  assert.equal(mimeOf('a.svg'), 'image/svg+xml')
  assert.equal(mimeOf('a.woff2'), 'font/woff2')
  assert.equal(mimeOf('a.wasm'), 'application/wasm')
  assert.equal(mimeOf('a.xyz'), 'application/octet-stream')
  assert.equal(mimeOf('noext'), 'application/octet-stream')
})

test('TC-PLG4-027 协议名与特权登记的形状（standard 缺了会白屏且没有任何报错）', async () => {
  const mod = await import('../protocol.js')
  assert.equal(PLUGIN_SCHEME, 'arkwork-plugin')
  assert.equal(mod.PLUGIN_SCHEME_PRIVILEGES.scheme, 'arkwork-plugin')
  assert.equal(mod.PLUGIN_SCHEME_PRIVILEGES.privileges.standard, true, 'standard:false 会让相对路径解析失效')
  assert.equal(mod.PLUGIN_SCHEME_PRIVILEGES.privileges.secure, true, 'secure:false 会让沙箱 iframe 判定为不安全上下文')
})
