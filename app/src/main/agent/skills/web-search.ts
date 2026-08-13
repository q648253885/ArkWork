/* ============================================================
 * ArkWork — Builtin Skill: web-search
 * 设计文档 §10.5
 *
 * v0.6.1：多源 fallback（无 key、无注册）
 *   1. 百度（www.baidu.com/s）— 国内首选，可达性最好
 *   2. Bing（cn.bing.com）— 国内可达，备源
 *   3. DuckDuckGo HTML（html.duckduckgo.com）— 海外可达，兜底
 *
 * v0.16.x：超时与并发策略重写（参考 anomalyco/opencode abortAfterAny + race）
 *   - 单源超时从 15s → 8s（避免一个挂源拖慢整体）
 *   - 三源 Promise.race 并发（任一源先返回非空即采纳）
 *   - 全局超时 12s（兜底）：即便三源都慢，12s 内必返回
 *   - 用户中止信号贯通（ctx.signal abort 时立即终止）
 *   - 修复 v0.6.0 缺陷：原实现仅用 DDG，国内网络环境下 fetch 超时导致
 *     搜索结果恒为空（用户报"使用技能报错"）。
 * ============================================================ */
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'
import { abortAfterAny } from './abort.js'

export interface WebSearchArgs {
  query: string
  limit?: number
}

export interface WebSearchResult {
  query: string
  results: Array<{
    title: string
    url: string
    snippet: string
  }>
  total: number
  /** v0.6.1：返回实际命中的源（bing / duckduckgo / baidu），便于排查 */
  source?: string
  /** v0.6.1：全部源失败时返回错误原因 */
  error?: string
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 单源超时（v0.16.x：从 15s 收紧到 8s，国内国外一致） */
const PER_SOURCE_TIMEOUT_MS = 8_000
/** 全局超时（兜底，三源 race 时任何一源挂掉不影响整体） */
const OVERALL_TIMEOUT_MS = 12_000

/**
 * v0.16.x：并发多源搜索（Promise.race 任一返回非空即采纳）。
 * 与 v0.6.1 串行 fallback 不同：
 *  - baidu 慢时不再阻塞 bing/DDG
 *  - 任一源非空 → 立即采纳（不等所有源结束）
 *  - 全部失败 → 取最快失败的源 error 返回（避免继续等待）
 *
 * 实现要点：
 *  - 三个搜索 Promise 全部启动，给每个 Promise attach 单源超时 abort
 *  - 整体超时 OVERALL_TIMEOUT_MS 用 abortAfterAny 包装全部
 *  - 用 Promise.race 但保留对未完成的 Promise 引用以便放弃
 */
export async function webSearch(
  args: WebSearchArgs,
  ctx: SkillContext,
): Promise<WebSearchResult> {
  const query = (args.query ?? '').trim()
  if (!query) {
    return { query: '', results: [], total: 0, error: 'query 不能为空' }
  }
  const limit = Math.min(args.limit ?? 5, 10)
  logger.info('Tool', `web-search(${query}, limit=${limit})`, ctx.taskId)

  // 全局超时：超过 OVERALL_TIMEOUT_MS 直接拒绝继续等待
  const overall = abortAfterAny(OVERALL_TIMEOUT_MS, ctx.signal)

  type Attempt = { name: string; promise: Promise<WebSearchResult['results']>; cancel: () => void }
  const attempts: Attempt[] = []

  const wrap = (name: string, fn: (signal: AbortSignal) => Promise<WebSearchResult['results']>): Attempt => {
    const handle = abortAfterAny(PER_SOURCE_TIMEOUT_MS, overall.signal)
    const promise = (async () => {
      try {
        return await fn(handle.signal)
      } finally {
        handle.clear()
      }
    })()
      .catch((err) => {
        // 把 fetch 错误规范化抛出，避免 race 时 undefined 触发后续
        throw new Error(`${name}: ${(err as Error).message}`)
      })
    return {
      name,
      promise,
      cancel: () => handle.clear(),
    }
  }

  attempts.push(
    wrap('baidu', (signal) => searchBaidu(query, limit, signal)),
  )
  attempts.push(
    wrap('bing', (signal) => searchBing(query, limit, signal)),
  )
  attempts.push(
    wrap('duckduckgo', (signal) => searchDuckDuckGo(query, limit, signal)),
  )

  const start = Date.now()
  const errors: string[] = []
  let firstNonEmpty: { name: string; results: WebSearchResult['results'] } | null = null

  try {
    // 用 while + 监听 attempts 完成的方式：任一返回非空即采纳，全部失败则取错误
    while (attempts.length > 0 && !firstNonEmpty && !overall.signal.aborted) {
      // 选出最先 settled 的那个
      const settled = await Promise.race(
        attempts.map(async (a) => {
          try {
            const results = await a.promise
            return { name: a.name, ok: true as const, results }
          } catch (err) {
            return { name: a.name, ok: false as const, error: (err as Error).message }
          }
        }),
      )
      const idx = attempts.findIndex((a) => a.name === settled.name)
      if (idx >= 0) attempts.splice(idx, 1)

      if (settled.ok) {
        if (settled.results.length > 0) {
          firstNonEmpty = { name: settled.name, results: settled.results }
          break
        }
        errors.push(`${settled.name}: 无结果`)
      } else {
        errors.push(settled.error)
        logger.warn('Tool', `web-search ${settled.name} failed: ${settled.error}`, ctx.taskId)
      }
    }
  } finally {
    overall.clear()
    // 取消所有还在跑的 attempt（释放 AbortController + 网络句柄）
    for (const a of attempts) a.cancel()
  }

  const elapsedMs = Date.now() - start

  if (firstNonEmpty) {
    logger.info(
      'Tool',
      `web-search: ${firstNonEmpty.results.length} results from ${firstNonEmpty.name} (${elapsedMs}ms)`,
      ctx.taskId,
    )
    return {
      query,
      results: firstNonEmpty.results,
      total: firstNonEmpty.results.length,
      source: firstNonEmpty.name,
    }
  }

  const reason = overall.signal.aborted
    ? overall.reason === 'timeout'
      ? `全局超时（${OVERALL_TIMEOUT_MS}ms）`
      : overall.reason === 'user-abort'
        ? '用户中止'
        : '已中止'
    : null
  const reasonStr = reason ? `; ${reason}` : ''
  logger.warn(
    'Tool',
    `web-search all sources failed (${elapsedMs}ms): ${errors.join('; ')}${reasonStr}`,
    ctx.taskId,
  )
  return {
    query,
    results: [],
    total: 0,
    error: errors.length > 0 ? `${errors.join('; ')}${reasonStr}` : reasonStr || 'unknown',
  }
}

/* ============ 源 1：Bing ============ */

async function searchBing(
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult['results']> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()

  const results: WebSearchResult['results'] = []
  // Bing 结果条目 <li class="b_algo">…</li>
  const itemRegex = /<li[^>]+class="b_algo"[^>]*>([\s\S]*?)<\/li>/g
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(html)) && results.length < limit) {
    const item = match[1]
    const titleMatch = item.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!titleMatch) continue
    const url = decodeBingUrl(titleMatch[1])
    if (!url) continue
    const title = stripTags(titleMatch[2]).trim()
    const snippetMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : ''
    if (title) results.push({ title, url, snippet })
  }
  return results
}

/** Bing 链接可能是 https://cn.bing.com/ck/a?... 跳转包装，尝试还原真实 URL */
function decodeBingUrl(raw: string): string | null {
  if (raw.startsWith('http')) return raw
  if (raw.startsWith('/')) return `https://cn.bing.com${raw}`
  return null
}

/* ============ 源 2：DuckDuckGo ============ */

async function searchDuckDuckGo(
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult['results']> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()

  const results: WebSearchResult['results'] = []
  const itemRegex =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(html)) && results.length < limit) {
    const rawUrl = match[1]
    const title = stripTags(match[2]).trim()
    const snippet = stripTags(match[3]).trim()
    const url = decodeDdgRedirect(rawUrl)
    if (url && title) {
      results.push({ title, url, snippet })
    }
  }
  return results
}

function decodeDdgRedirect(raw: string): string | null {
  const match = raw.match(/uddg=([^&]+)/)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return null
    }
  }
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('http')) return raw
  return null
}

/* ============ 源 3：百度 ============ */

async function searchBaidu(
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<WebSearchResult['results']> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()

  const results: WebSearchResult['results'] = []
  // 百度结果条目 <div class="result c-container" …>
  const itemRegex = /<div[^>]+class="result[^"]*c-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(html)) && results.length < limit) {
    const item = match[1]
    const titleMatch = item.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!titleMatch) continue
    const url = decodeBaiduUrl(titleMatch[1])
    if (!url) continue
    const title = stripTags(titleMatch[2]).trim()
    // 摘要：百度结构多变，退而求其次抓任意 p 或 span 片段
    const snippetMatch = item.match(/<span[^>]+class="content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/) ||
      item.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim().slice(0, 200) : ''
    if (title) results.push({ title, url, snippet })
  }
  return results
}

function decodeBaiduUrl(raw: string): string | null {
  if (raw.startsWith('http')) return raw
  if (raw.startsWith('/link?url=')) return `https://www.baidu.com${raw}`
  return null
}

/* ============ 通用 HTML 清洗 ============ */

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}
