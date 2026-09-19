/**
 * v0.34.2（D56-a）— 面板取数通道「选栈方向」契约测试
 *
 * 依据：docs/versions/v0.34.2/04-system-design.md §D56-a（选栈修复）
 *       （通道本体建在 v0.34.1：docs/versions/v0.34.1/04-system-design.md §5）
 * 用例：TC-PFCH-001…010
 *
 * **为什么必须补这组用例**（用户实测缺陷的根因层）：
 *   首版 `panel.ts` 用 Node 全局 `fetch`（undici）取数 —— 它**不读系统代理**，
 *   而用户环境（`scutil --proxy` = HTTPProxy 127.0.0.1:7890）下目标接口
 *   `push2.eastmoney.com` 直连必然失败（实测 `curl http=000` / `UND_ERR_SOCKET`，
 *   经代理 `http=200`）→ 面板永远停在「面板数据加载失败」。
 *   本组用例把「必须走 Electron net 栈」这条**选栈方向**钉死在测试里，
 *   使此缺陷不能静默回归（对照 v0.32.2 审计：挂点/选路类代码必须有用例把守）。
 *
 * 运行（cwd=app）：
 *   npx tsx --experimental-loader ./src/test/electron-mock-loader.mjs \
 *     --test src/main/ipc/__tests__/panel-fetch.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pickFetch, humanizeFetchError } from '../panel.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf-8')
const SRC = read('../panel.ts')

/* ============================================================
 * 1. 选栈方向：必须优先 Electron net（Chromium 栈 → 遵循系统代理）
 * ============================================================ */

test('TC-PFCH-001 ★ 有 net.fetch 时选 net 栈（net 栈才遵循系统代理/PAC）', () => {
  const fake = { fetch: (() => Promise.resolve(new Response('{}'))) as unknown as never }
  const picked = pickFetch(fake as never)
  assert.equal(picked.via, 'net', 'Electron net 可用时必须走 net 栈')
  assert.equal(typeof picked.impl, 'function', '应返回可调用实现')
})

test('TC-PFCH-002 net.fetch 缺失时回落全局 fetch（纯 Node / 单测环境）', () => {
  assert.equal(pickFetch({}).via, 'global', 'net 无 fetch 时应回落')
  assert.equal(pickFetch({ fetch: 'not-a-function' } as never).via, 'global', '非函数不得被当成可用实现')
  assert.equal(pickFetch(undefined).via, 'global', '桩环境（net.fetch=undefined）应回落，不抛异常')
})

test('TC-PFCH-003 net.fetch 必须绑定到 net 对象调用（脱离上下文会丢 session）', async () => {
  // 用一个「依赖 this」的假 fetch 证明绑定了
  const holder: { fetch?: unknown; tag?: string } = { tag: 'net' }
  holder.fetch = function (this: { tag?: string }) {
    return Promise.resolve(new Response(JSON.stringify({ thisTag: this?.tag ?? null })))
  }
  const picked = pickFetch(holder as never)
  const res = await picked.impl('https://example.com')
  const body = (await res.json()) as { thisTag: string | null }
  assert.equal(body.thisTag, 'net', 'net.fetch 必须在 net 对象上下文里调用')
})

/* ============================================================
 * 2. 源码契约：panelFetch 不得直接调用裸 fetch
 * ============================================================ */

test('TC-PFCH-004 ★ panel.ts 取数必须经 pickFetch（禁止裸 fetch 直连）', () => {
  // 允许出现的只有 pickFetch 回落分支里的那一处 `fetch(`（无接收者）
  const calls = SRC.match(/(?<![.\w])fetch\s*\(/g) ?? []
  assert.equal(
    calls.length,
    1,
    `panel.ts 只应有一处裸 fetch（pickFetch 的回落分支），实际 ${calls.length} 处 —— ` +
      '新增调用点会让「选栈方向」绕过 pickFetch，重新引入「不认系统代理」缺陷',
  )
  assert.match(SRC, /pickFetch\s*\(/, 'panelFetch 必须通过 pickFetch 选栈')
  assert.match(SRC, /const \{ impl, via \} = pickFetch\(\)/, '必须取到 impl 并真的用它取数')
})

test('TC-PFCH-005 只允许 http/https（不为插件开任意协议探测）', () => {
  assert.match(SRC, /u\.protocol !== 'http:' && u\.protocol !== 'https:'/, '协议白名单必须保留')
})

test('TC-PFCH-006 响应体上限与超时夹取仍在（防内存吃穿 / 面板卡死）', () => {
  assert.match(SRC, /MAX_BYTES\s*=\s*2 \* 1024 \* 1024/, '2MB 上限不得放宽')
  assert.match(SRC, /Math\.min\(MAX_TIMEOUT_MS, Math\.max\(1000,/, '超时必须双向夹取')
})

/* ============================================================
 * 3. 失败必须给人话（四态纪律：降级可见、不许静默半死）
 * ============================================================ */

test('TC-PFCH-007 ★ 底层套接字错误翻译成人话（不再甩 `fetch failed`）', () => {
  const hit = humanizeFetchError('fetch failed')
  assert.match(hit, /代理/, 'UND_ERR_SOCKET/fetch failed 必须提示可能的代理问题')
  assert.doesNotMatch(hit, /^fetch failed$/, '不得原样回吐底层文案')
  assert.match(humanizeFetchError('connect UND_ERR_SOCKET'), /代理/)
  assert.match(humanizeFetchError('net::ERR_CONNECTION_RESET'), /代理/)
})

test('TC-PFCH-008 DNS / 连接拒绝 / 超时 / 证书各有针对性文案', () => {
  assert.match(humanizeFetchError('getaddrinfo ENOTFOUND push2.eastmoney.com'), /域名解析/)
  assert.match(humanizeFetchError('net::ERR_NAME_NOT_RESOLVED'), /域名解析/)
  assert.match(humanizeFetchError('net::ERR_CONNECTION_REFUSED'), /被拒绝/)
  assert.match(humanizeFetchError('net::ERR_CONNECTION_TIMED_OUT'), /超时/)
  assert.match(humanizeFetchError('net::ERR_TUNNEL_CONNECTION_FAILED'), /代理连接失败/)
  assert.match(humanizeFetchError('net::ERR_CERT_DATE_INVALID'), /证书/)
  assert.match(humanizeFetchError('net::ERR_INTERNET_DISCONNECTED'), /已断开/)
})

test('TC-PFCH-009 无法归类的错误原样透出（不吞、不伪装成功）', () => {
  assert.equal(humanizeFetchError('某种没见过的错误'), '某种没见过的错误')
  assert.equal(humanizeFetchError(''), '未知网络错误', '空串要有兜底文案，不能显示空白')
})

test('TC-PFCH-010 失败落 main 日志（用户报障时主进程要留得下证据）', () => {
  assert.match(
    SRC,
    /logger\.warn\('System', `\[panel\] fetch 失败/,
    '取数失败必须写 warn 日志 —— 面板错误只在渲染层可见，主进程不留痕则无从诊断',
  )
  // 选栈留痕：排查「能上网但面板打不开」的第一手信息
  assert.match(SRC, /\[panel\] fetch via \$\{via\}/, '必须记录走的是哪条取数栈')
})
