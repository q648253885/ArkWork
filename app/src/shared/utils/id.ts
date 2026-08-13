/**
 * Simple ID generator — uses crypto.randomUUID when available, falls back to Math.random.
 * Format: 8-char hex suffix prefixed by namespace.
 */
export function genId(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(16).slice(2) + Date.now().toString(16)
  return `${prefix}-${uuid.slice(0, 12)}`
}

/** 生成时间戳字符串 HH:MM:SS.mmm */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

/** 相对时间（"2m", "1h", "1d"） */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  return `${day}d`
}

/** 简单的 token 估算：英文 ~4 字符/token，中文 ~1.5 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}
