/* ============================================================
 * ArkWork — Cron 表达式工具 (v0.9.1)
 * 纯函数，无依赖：标准 5 段 cron（分 时 日 月 周），支持 * , - /
 * 供 scheduler 调度与 store IPC 校验共用
 * ============================================================ */

/** 解析单段 cron 字段为「可取值集合」，如 '1,15' / '*\/5' / '1-5' / '9-18/2' */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/)
    if (!m) return null
    const [, range, stepStr] = m
    const step = stepStr ? parseInt(stepStr, 10) : 1
    if (step < 1) return null
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map((s) => parseInt(s, 10))
      lo = a
      hi = b
    } else {
      lo = hi = parseInt(range, 10)
      // 单值带步进（如 '5/10'）按 cron 语义视为 '5-max/10'
      if (stepStr) hi = max
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? out : null
}

/** 判断给定时刻是否命中 cron 表达式（分 时 日 月 周；周 0/7=周日） */
export function matchesCron(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [minF, hourF, domF, monthF, dowF] = fields
  const mins = parseField(minF, 0, 59)
  const hours = parseField(hourF, 0, 23)
  const doms = parseField(domF, 1, 31)
  const months = parseField(monthF, 1, 12)
  const dows = parseField(dowF, 0, 7)
  if (!mins || !hours || !doms || !months || !dows) return false
  // 周 7 归一为 0（周日）
  const normDows = new Set([...dows].map((d) => (d === 7 ? 0 : d)))
  return (
    mins.has(date.getMinutes()) &&
    hours.has(date.getHours()) &&
    doms.has(date.getDate()) &&
    months.has(date.getMonth() + 1) &&
    normDows.has(date.getDay())
  )
}

/** 校验 cron 表达式合法性（供 IPC 前置校验 / UI 提示） */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return (
    parseField(fields[0], 0, 59) !== null &&
    parseField(fields[1], 0, 23) !== null &&
    parseField(fields[2], 1, 31) !== null &&
    parseField(fields[3], 1, 12) !== null &&
    parseField(fields[4], 0, 7) !== null
  )
}

/** 计算下一次触发时间（从 from 起逐分钟扫描，最多看 366 天；找不到返回 null） */
export function nextCronTime(expr: string, from: Date = new Date()): Date | null {
  if (!isValidCron(expr)) return null
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = 366 * 24 * 60
  for (let i = 0; i < limit; i++) {
    if (matchesCron(expr, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}
