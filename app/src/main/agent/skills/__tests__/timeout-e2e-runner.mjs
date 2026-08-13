// Direct runner to print detailed timing info (bypasses node:test reporter)
// Note: pure .mjs (no TS syntax) because electron-mock-loader only transforms TS

import { webSearch } from '../web-search.ts'
import { fetchUrl } from '../fetch-url.ts'
import { abortAfterAny, fetchWithLimits } from '../abort.ts'

const log = (...args) => console.log(...args)
const elapsed = (start) => `${Date.now() - start}ms`

log('=== abortAfterAny basic checks ===')

const h1 = abortAfterAny(80)
await new Promise((r) => setTimeout(r, 150))
log(`  timeout test: aborted=${h1.signal.aborted}, reason=${h1.reason}`)
h1.clear()

const ctrl2 = new AbortController()
const h2 = abortAfterAny(10_000, ctrl2.signal)
ctrl2.abort()
log(`  user-abort test: aborted=${h2.signal.aborted}, reason=${h2.reason}`)
h2.clear()

log('\n=== abortAfterAny + userSignal merged: timeout still works when userSignal alive ===')
{
  const ctrl = new AbortController()
  const handle = abortAfterAny(150, ctrl.signal)
  await new Promise((r) => setTimeout(r, 300))
  log(`  merged timeout: aborted=${handle.signal.aborted}, reason=${handle.reason}`)
  handle.clear()
  ctrl.abort()
}

log('\n=== web-search real network call ===')

const t1 = Date.now()
const r1 = await webSearch({ query: 'ArkWork AI', limit: 3 }, { taskId: 'runner' })
log(`  single query: elapsed=${elapsed(t1)}, source=${r1.source ?? 'none'}, total=${r1.total}`)
if (r1.error) log(`    error: ${r1.error.slice(0, 100)}`)

const queries = ['React 18', 'TypeScript 5', 'OpenCode']
const tAll = Date.now()
for (const q of queries) {
  const tq = Date.now()
  const r = await webSearch({ query: q, limit: 2 }, { taskId: 'runner' })
  log(`  query="${q}" elapsed=${elapsed(tq)} total=${r.total} source=${r.source ?? 'none'}`)
}
log(`  total 3 queries elapsed: ${elapsed(tAll)}`)

log('\n=== fetch-url real network call ===')

const tf1 = Date.now()
try {
  const r = await fetchUrl({ url: 'https://www.baidu.com', maxChars: 1000 }, { taskId: 'runner' })
  log(`  single fetch: elapsed=${elapsed(tf1)}, status=${r.status}, chars=${r.chars}`)
} catch (e) {
  log(`  single fetch: failed elapsed=${elapsed(tf1)} err=${e.message.slice(0, 100)}`)
}

log('\n=== fetch-url user-abort (robust: abort early + slower URL) ===')
// 用更短的超时窗口确保 abort 真的能截断 fetch
{
  const ctrl = new AbortController()
  // 用一个会挂的 URL：127.0.0.1:1 → connect refused 很快，但 timeout window 足够宽
  setTimeout(() => ctrl.abort(), 30)
  const tStart = Date.now()
  try {
    await fetchUrl(
      { url: 'http://127.0.0.1:1/__test__' },
      { taskId: 'runner', signal: ctrl.signal },
    )
    log(`  user-abort fetch: unexpectedly succeeded`)
  } catch (e) {
    const ms = Date.now() - tStart
    log(`  user-abort fetch: aborted at ${ms}ms, err=${e.message.slice(0, 80)}`)
  }
}

log('\n=== fetchWithLimits Content-Length 超限（用本地 mock server）===')
{
  // 起一个本地 HTTP server，返回 10 MiB 响应 + Content-Length 头，验证预检
  const http = await import('node:http')
  const bigBody = Buffer.alloc(10 * 1024 * 1024, 'A')
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bigBody.length),
    })
    res.end(bigBody)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/big.bin`
  const tStart = Date.now()
  let succeeded = false
  try {
    await fetchWithLimits(
      url,
      {},
      { timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024, userSignal: undefined, defaultHeaders: {} },
    )
    succeeded = true
  } catch (e) {
    const ms = Date.now() - tStart
    log(`  big response (10 MiB > 5 MiB limit): rejected at ${ms}ms, err=${e.message.slice(0, 80)}`)
  }
  if (succeeded) log(`  big response: unexpectedly succeeded (Content-Length 预检未生效)`)
  server.close()
}

log('\n=== fetchWithLimits Content-Length 合规（应成功）===')
{
  const http = await import('node:http')
  const smallBody = Buffer.alloc(1024, 'B')  // 1 KiB
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(smallBody.length),
    })
    res.end(smallBody)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/small.bin`
  const tStart = Date.now()
  try {
    const out = await fetchWithLimits(
      url,
      {},
      { timeoutMs: 30_000, maxBytes: 5 * 1024 * 1024, userSignal: undefined, defaultHeaders: {} },
    )
    const ms = Date.now() - tStart
    const text = await out.response.text()
    log(`  small response (1 KiB ≤ 5 MiB limit): ok at ${ms}ms, status=${out.response.status}, bodyLen=${text.length}`)
    out.handle.clear()
  } catch (e) {
    log(`  small response: unexpected error ${e.message.slice(0, 80)}`)
  }
  server.close()
}

log('\n=== ALL DONE ===')
process.exit(0)