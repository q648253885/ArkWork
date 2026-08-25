/* ============================================================
 * ArkWork — Builtin Skill: fetch-url
 * v0.6.0 设计文档 §10.5
 *
 * 抓取指定 URL 的页面正文，HTML 转纯文本（去标签、保留段落/换行）。
 * 适用场景：web-search 拿到 URL 后深入读取页面内容。
 *
 * 限制：
 *  - 仅 http/https
 *  - 最大 20000 字符（由 args.maxChars 覆盖，上限 100000）
 *  - 12s 超时（v0.16.x：从 15s 收紧到 12s，参考 opencode 默认 30s 但用户场景多为轻抓取）
 *  - 5 MiB 响应体硬限制（v0.16.x：参考 opencode WebFetch 防内存爆）
 *  - 用户中止信号贯通（ctx.signal abort 立即终止）
 *  - 跟随 5 次重定向
 * ============================================================ */
import { logger } from '../../system/logger.js'
import type { SkillContext } from '../registry.js'
import { abortAfterAny, fetchWithLimits } from './abort.js'

export interface FetchUrlArgs {
  url: string
  maxChars?: number
}

export interface FetchUrlResult {
  url: string
  finalUrl: string
  title: string
  text: string
  chars: number
  truncated: boolean
  contentType: string
  status: number
}

const DEFAULT_MAX_CHARS = 20_000
const MAX_MAX_CHARS = 100_000
const FETCH_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024  // 5 MiB

export async function fetchUrl(
  args: FetchUrlArgs,
  ctx: SkillContext,
): Promise<FetchUrlResult> {
  const url = (args.url ?? '').trim()
  if (!url) {
    throw new Error('fetch-url: url 不能为空')
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`fetch-url: 仅支持 http/https URL（收到 ${url}）`)
  }

  const maxChars = Math.min(args.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS)
  logger.info('Tool', `fetch-url: ${url} (maxChars=${maxChars})`, ctx.taskId)

  // v0.16.x：用 abortAfterAny 合并超时 + 用户中止 + 5 MiB 响应体硬限制
  let handle: ReturnType<typeof abortAfterAny> | null = null
  try {
    const out = await fetchWithLimits(
      url,
      {
        redirect: 'follow',
      },
      {
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        userSignal: ctx.signal,
        defaultHeaders: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      },
    )
    handle = out.handle
    return await processResponse(out.response, url, maxChars)
  } finally {
    handle?.clear()
  }
}

async function processResponse(
  res: Response,
  url: string,
  maxChars: number,
): Promise<FetchUrlResult> {
  if (!res.ok) {
    return {
      url,
      finalUrl: res.url || url,
      title: '',
      text: '',
      chars: 0,
      truncated: false,
      contentType: res.headers.get('content-type') ?? '',
      status: res.status,
    }
  }

  const contentType = res.headers.get('content-type') ?? ''
  const finalUrl = res.url || url
  const raw = await res.text()

  // 非 HTML 直接返回原文（如 JSON / 纯文本）
  if (!contentType.includes('html')) {
    const truncated = raw.length > maxChars
    const text = truncated ? raw.slice(0, maxChars) + '\n\n… (truncated)' : raw
    return {
      url,
      finalUrl,
      title: '',
      text,
      chars: text.length,
      truncated,
      contentType,
      status: res.status,
    }
  }

  // HTML → 提取 title + 正文
  const title = extractTitle(raw)
  const text = htmlToText(raw, maxChars)

  return {
    url,
    finalUrl,
    title,
    text,
    chars: text.length,
    truncated: text.length >= maxChars,
    contentType,
    status: res.status,
  }
}

/** 从 HTML 提取 <title> 内容 */
function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return stripTags(m[1]).trim().slice(0, 200)
}

/**
 * 极简 HTML → 纯文本：
 *  - 删除 script/style/noscript 标签及内容
 *  - 删除其余标签
 *  - block 标签后补换行
 *  - 解码常见 HTML 实体
 *  - 压缩多余空白
 *  - 截断到 maxChars
 */
function htmlToText(html: string, maxChars: number): string {
  let s = html
  // 去 script/style/svg/noscript/template 内容
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
  // block 标签 → 换行
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|pre|blockquote)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // 去 标签
  s = s.replace(/<[^>]+>/g, '')
  // 实体解码
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
  // 压缩空白
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()
  if (s.length > maxChars) {
    s = s.slice(0, maxChars) + '\n\n… (truncated)'
  }
  return s
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}
