/* ============================================================
 * ArkWork — 宿主垂直组件库（v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §8.1
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §4（判断 J3）
 *
 * 一句话：**插件的表达力边界 = 这张白名单**。
 *
 * 硬约束（D4）：插件**不能注入任意 React 代码**，只能引用组件名 + 声明数据形状。
 * 因此这里是个**闭集实现**，与 `shared/types/vlib.ts` 的 `VLIB_COMPONENTS` 同源
 * （`VLIB_IMPL satisfies Record<VLibComponentName, ...>` 让「新增组件漏实现」
 * 变成编译期错误 —— 这是本文件唯一的编译期契约，请勿删）。
 *
 * 包体纪律（TC-PKG-001）：本文件**不得**静态引入 `@codemirror/*` 或 `chokidar`，
 * `CandleChart` 一律用**原生 Canvas**，不引第三方图表库（纪律 9/10）。
 * ============================================================ */
import type { ComponentType } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons'
import { EmptyState } from '../ui'
import { Markdown } from '../Markdown'
import { useStore } from '../../store'
import { VLIB_COMPONENTS, type PanelData, type PanelInteract, type VLibComponentName } from '@shared/types/vlib'

export interface VLibProps {
  data: PanelData
  /** 面板标题（无障碍标签 / 空态文案用） */
  title: string
  /**
   * v0.34.1：交互声明（行点击 → 浮窗打开面板）。
   * 只有声明了它的组件才会把行变成可点击 —— 没有声明就不该给用户「能点」的错觉。
   */
  interact?: PanelInteract
}

/* ============================================================
 * DataTable — 表格 + 行窗口化（虚拟滚动）
 *
 * 为什么自己写窗口化而不引库：包体纪律 + 逻辑只有十几行。
 * 固定行高 28px 才能用纯算术定位，这也是它不需要测量的原因。
 * ============================================================ */
const ROW_H = 28

export function DataTable({ data, title, interact }: VLibProps) {
  const { t } = useTranslation()
  const openPanelPreview = useStore((s) => s.openPanelPreview)
  const rows = data.rows ?? []
  // v0.34.1：行点击 → 浮窗。参数取自**当前行**的字段（插件声明哪个字段就是哪个）
  const rowClick = interact?.onRowClick
  const handleRowClick = rowClick
    ? (row: Record<string, unknown>) => {
        const params: Record<string, unknown> = {}
        for (const [k, field] of Object.entries(rowClick.params ?? {})) {
          params[k] = row[field]
        }
        openPanelPreview(rowClick.panelRefs, params)
      }
    : undefined
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(320)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setViewportH(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const columns = useMemo(() => {
    if (data.columns && data.columns.length > 0) return data.columns
    const first = rows[0] ?? {}
    return Object.keys(first).map((k) => ({ key: k, label: k, align: 'left' as const }))
  }, [data.columns, rows])

  if (rows.length === 0) return null

  const total = rows.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4)
  const visibleCount = Math.ceil(viewportH / ROW_H) + 8
  const end = Math.min(total, start + visibleCount)
  const slice = rows.slice(start, end)

  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }

  return (
    <div className="flex flex-col h-full min-h-0" aria-label={title}>
      <div role="row" className="flex items-center gap-2 px-2.5 h-7 flex-shrink-0 border-b border-border-subtle bg-bg-surface">
        {columns.map((c) => (
          <div
            key={c.key}
            role="columnheader"
            className="text-2xs uppercase tracking-wider font-medium text-text-tertiary truncate"
            style={{ flex: 1, textAlign: c.align === 'right' ? 'right' : 'left' }}
          >
            {c.label}
          </div>
        ))}
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        className="flex-1 min-h-0 overflow-auto"
        role="rowgroup"
      >
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
            {slice.map((r, i) => (
              <div
                key={start + i}
                role="row"
                onClick={handleRowClick ? () => handleRowClick(r) : undefined}
                className={
                  'flex items-center gap-2 px-2.5 text-xs text-text-secondary border-b border-border-subtle' +
                  (handleRowClick ? ' cursor-pointer hover:bg-bg-hover' : '')
                }
                style={{ height: ROW_H }}
              >
                {columns.map((c) => (
                  <div
                    key={c.key}
                    role="cell"
                    className="truncate"
                    title={cell(r[c.key])}
                    style={{ flex: 1, textAlign: c.align === 'right' ? 'right' : 'left' }}
                  >
                    {cell(r[c.key])}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between px-2.5 h-6 flex-shrink-0 border-t border-border-subtle text-2xs text-text-faint">
        <span>{t('vlib.rowsTotal', { count: total })}</span>
        <span>{t('vlib.rowsWindow', { from: start + 1, to: end })}</span>
      </div>
    </div>
  )
}

/* ============================================================
 * MetricCard — 指标卡组
 * ============================================================ */
export function MetricCard({ data, title }: VLibProps) {
  const metrics = data.metrics ?? []
  if (metrics.length === 0) return null
  return (
    <div className="flex flex-col gap-2 p-2.5 overflow-auto h-full" aria-label={title}>
      {metrics.map((m, i) => {
        const delta = m.delta
        // 涨红跌绿（项目硬规范：中国市场约定）
        const deltaColor = delta === undefined || delta === 0 ? 'text-text-tertiary' : delta > 0 ? 'text-danger' : 'text-success'
        return (
          <div key={`${m.label}-${i}`} className="rounded-md border border-border-subtle bg-bg-surface px-3 py-2">
            <div className="text-2xs text-text-tertiary truncate">{m.label}</div>
            <div className="flex items-baseline gap-2">
              <div className="text-lg font-medium text-text-primary tabular-nums">{m.value}</div>
              {delta !== undefined && (
                <div className={`text-xs tabular-nums ${deltaColor}`}>
                  {delta > 0 ? '+' : ''}
                  {delta}
                </div>
              )}
            </div>
            {m.hint && <div className="text-2xs text-text-faint mt-0.5 truncate" title={m.hint}>{m.hint}</div>}
          </div>
        )
      })}
    </div>
  )
}

/* ============================================================
 * Sparkline — 迷你折线（纯 SVG，无依赖）
 * ============================================================ */
export function Sparkline({ data, title }: VLibProps) {
  const points = data.points ?? []
  if (points.length < 2) return null
  const W = 100
  const H = 32
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const step = W / (points.length - 1)
  const coords = points.map((p, i) => `${(i * step).toFixed(2)},${(H - ((p - min) / span) * H).toFixed(2)}`)
  const rising = points[points.length - 1] >= points[0]
  const stroke = rising ? 'var(--danger)' : 'var(--success)'
  return (
    <div className="p-3 h-full flex flex-col justify-center" aria-label={title}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: 56 }} role="img">
        <title>{title}</title>
        <polyline points={coords.join(' ')} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-2xs text-text-faint tabular-nums mt-1">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

/* ============================================================
 * CandleChart — K 线（原生 Canvas，无第三方图表库）
 *
 * rows 形状：`{ date|time, open, high, low, close }`（缺字段的行被跳过）。
 * 涨红跌绿（中国约定）。
 * ============================================================ */
interface CandleRow {
  time: string
  open: number
  high: number
  low: number
  close: number
}

function toCandles(rows: Array<Record<string, unknown>>): CandleRow[] {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : null
  }
  const out: CandleRow[] = []
  for (const r of rows) {
    const open = num(r.open)
    const high = num(r.high)
    const low = num(r.low)
    const close = num(r.close)
    if (open === null || high === null || low === null || close === null) continue
    const t = r.date ?? r.time ?? ''
    out.push({ time: String(t), open, high, low, close })
  }
  return out
}

export function CandleChart({ data, title }: VLibProps) {
  const candles = useMemo(() => toCandles(data.rows ?? []), [data.rows])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 300, h: 200 })

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || candles.length === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(size.w * dpr))
    canvas.height = Math.max(1, Math.round(size.h * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const css = getComputedStyle(document.documentElement)
    const up = css.getPropertyValue('--danger').trim() || '#d4483b'
    const down = css.getPropertyValue('--success').trim() || '#2f9e63'
    const gridColor = css.getPropertyValue('--border-subtle').trim() || '#e5e5e5'
    const faintColor = css.getPropertyValue('--text-faint').trim() || '#999'

    const padT = 8
    const padB = 16
    const padX = 4
    const innerH = Math.max(1, size.h - padT - padB)
    const highs = candles.map((c) => c.high)
    const lows = candles.map((c) => c.low)
    const max = Math.max(...highs)
    const min = Math.min(...lows)
    const span = max - min || 1
    const yOf = (v: number) => padT + (1 - (v - min) / span) * innerH
    const slot = (size.w - padX * 2) / candles.length
    const bodyW = Math.max(1, Math.min(12, slot * 0.62))

    // 网格
    ctx.strokeStyle = gridColor
    ctx.lineWidth = 1
    for (let i = 0; i <= 3; i++) {
      const y = padT + (innerH / 3) * i
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(size.w, y)
      ctx.stroke()
    }

    candles.forEach((c, i) => {
      const cx = padX + slot * i + slot / 2
      const rising = c.close >= c.open
      ctx.strokeStyle = rising ? up : down
      ctx.fillStyle = rising ? up : down
      // 影线
      ctx.beginPath()
      ctx.moveTo(cx, yOf(c.high))
      ctx.lineTo(cx, yOf(c.low))
      ctx.stroke()
      // 实体
      const yOpen = yOf(c.open)
      const yClose = yOf(c.close)
      const top = Math.min(yOpen, yClose)
      const h = Math.max(1, Math.abs(yClose - yOpen))
      ctx.fillRect(cx - bodyW / 2, top, bodyW, h)
    })

    // 极值标注（只标两个，避免在小卡片里糊成一团）
    ctx.fillStyle = faintColor
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.fillText(String(max), 2, padT + 9)
    ctx.fillText(String(min), 2, padT + innerH)
  }, [candles, size])

  if (candles.length === 0) return null
  return (
    <div ref={wrapRef} className="h-full w-full" aria-label={title}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} role="img">
        {title}
      </canvas>
    </div>
  )
}

/* ============================================================
 * TimelineBoard — 时间线（rows：`{ time, title, detail?, status? }`）
 * ============================================================ */
export function TimelineBoard({ data, title }: VLibProps) {
  const rows = data.rows ?? []
  if (rows.length === 0) return null
  const statusColor = (s: unknown): string => {
    if (s === 'error' || s === 'failed') return 'var(--danger)'
    if (s === 'running' || s === 'active') return 'var(--accent)'
    if (s === 'done' || s === 'success') return 'var(--success)'
    return 'var(--border-strong)'
  }
  return (
    <ol className="p-2.5 h-full overflow-auto flex flex-col gap-0" aria-label={title}>
      {rows.map((r, i) => (
        <li key={i} className="flex gap-2.5">
          <div className="flex flex-col items-center flex-shrink-0 pt-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor(r.status) }} aria-hidden="true" />
            {i < rows.length - 1 && <span className="w-px flex-1 bg-border-subtle my-0.5" aria-hidden="true" />}
          </div>
          <div className="pb-3 min-w-0">
            <div className="text-2xs text-text-faint tabular-nums">{String(r.time ?? '')}</div>
            <div className="text-xs text-text-primary truncate" title={String(r.title ?? '')}>
              {String(r.title ?? '')}
            </div>
            {r.detail !== undefined && (
              <div className="text-2xs text-text-tertiary mt-0.5 break-words">{String(r.detail)}</div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

/* ============================================================
 * MediaGrid — 媒体墙（rows：`{ src|path, title?, kind? }`）
 *
 * `file` 源的相对路径无意义（协议要求绝对路径），因此这里只渲染
 * 能直接给 `<img src>` 用的值（http(s) / data: / file:）；其余显示为链接卡片。
 * ============================================================ */
function mediaSrcOf(r: Record<string, unknown>): string {
  const raw = r.src ?? r.path ?? r.url ?? ''
  return typeof raw === 'string' ? raw : ''
}

export function MediaGrid({ data, title }: VLibProps) {
  const { t } = useTranslation()
  const rows = data.rows ?? []
  const [failed, setFailed] = useState<Record<number, true>>({})
  if (rows.length === 0) return null
  return (
    <div className="p-2.5 h-full overflow-auto grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))' }} aria-label={title}>
      {rows.map((r, i) => {
        const src = mediaSrcOf(r)
        const label = String(r.title ?? r.name ?? src)
        const isImage = /^(https?:|data:image|file:)/.test(src) && failed[i] !== true
        return (
          <a
            key={i}
            href={src || undefined}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-border-subtle bg-bg-surface overflow-hidden focus-ring"
            title={label}
          >
            <div className="aspect-square flex items-center justify-center bg-bg-hover">
              {isImage ? (
                <img
                  src={src}
                  alt={label}
                  className="w-full h-full object-cover"
                  onError={() => setFailed((p) => ({ ...p, [i]: true }))}
                />
              ) : (
                <Icon.File width={20} height={20} className="text-text-faint" />
              )}
            </div>
            <div className="px-1.5 py-1 text-2xs text-text-tertiary truncate">
              {failed[i] ? t('vlib.mediaUnavailable') : label}
            </div>
          </a>
        )
      })}
    </div>
  )
}

/* ============================================================
 * KeyValueList — 键值表（rows 或单对象 value 都可）
 * ============================================================ */
export function KeyValueList({ data, title }: VLibProps) {
  const pairs = useMemo<Array<[string, unknown]>>(() => {
    const rows = data.rows
    if (rows && rows.length > 0) {
      return rows.map((r, i) => [String(r.key ?? r.name ?? `#${i + 1}`), r.value ?? r.val ?? r])
    }
    if (data.value && typeof data.value === 'object' && !Array.isArray(data.value)) {
      return Object.entries(data.value as Record<string, unknown>)
    }
    return []
  }, [data.rows, data.value])

  if (pairs.length === 0) return null
  const text = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  return (
    <dl className="p-2.5 h-full overflow-auto" aria-label={title}>
      {pairs.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="flex gap-3 py-1.5 border-b border-border-subtle last:border-b-0">
          <dt className="text-xs text-text-tertiary flex-shrink-0 w-[38%] truncate" title={k}>{k}</dt>
          <dd className="text-xs text-text-primary min-w-0 break-words flex-1">{text(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ============================================================
 * LogStream — 日志流（text，等宽、自动滚底、按级别着色）
 * ============================================================ */
export function LogStream({ data, title }: VLibProps) {
  const text = typeof data.text === 'string' ? data.text : ''
  const lines = useMemo(() => (text.length === 0 ? [] : text.split(/\r?\n/)), [text])
  const ref = useRef<HTMLDivElement>(null)
  const [pin, setPin] = useState(true)

  useEffect(() => {
    if (!pin) return
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines, pin])

  if (lines.length === 0) return null
  const levelOf = (l: string): string => {
    if (/\b(error|fatal|失败|错误)\b/i.test(l)) return 'text-danger'
    if (/\b(warn|warning|警告)\b/i.test(l)) return 'text-warning'
    if (/\b(debug|trace)\b/i.test(l)) return 'text-text-faint'
    return 'text-text-secondary'
  }
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.target as HTMLDivElement
        setPin(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
      }}
      className="h-full overflow-auto bg-shell-bg font-mono text-2xs leading-[18px] py-1.5"
      aria-label={title}
      role="log"
    >
      {lines.map((l, i) => (
        <div key={i} className="flex gap-2 px-2.5">
          <span className="text-text-faint select-none flex-shrink-0 tabular-nums w-7 text-right">{i + 1}</span>
          <span className={`whitespace-pre-wrap break-all ${levelOf(l)}`}>{l || ' '}</span>
        </div>
      ))}
    </div>
  )
}

/* ============================================================
 * MarkdownView — 正文渲染（复用宿主既有 Markdown 实现）
 * ============================================================ */
export function MarkdownView({ data }: VLibProps) {
  const text = typeof data.text === 'string' ? data.text : ''
  if (text.trim().length === 0) return null
  return (
    <div className="p-3 h-full overflow-auto text-sm">
      <Markdown content={text} />
    </div>
  )
}

/* ============================================================
 * JsonView — 结构化展示（超长自动折叠展示，避免卡顿）
 * ============================================================ */
const JSON_MAX_CHARS = 40000

export function JsonView({ data, title }: VLibProps) {
  const { t } = useTranslation()
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(data.value, null, 2) ?? ''
    } catch {
      return String(data.value)
    }
  }, [data.value])
  if (pretty.length === 0) return null
  const truncated = pretty.length > JSON_MAX_CHARS
  return (
    <div className="h-full flex flex-col min-h-0" aria-label={title}>
      <pre className="flex-1 min-h-0 overflow-auto p-3 font-mono text-2xs leading-[18px] text-text-secondary whitespace-pre">
        {truncated ? pretty.slice(0, JSON_MAX_CHARS) : pretty}
      </pre>
      {truncated && (
        <div className="flex-shrink-0 px-3 py-1 border-t border-border-subtle text-2xs text-text-faint">
          {t('vlib.jsonTruncated', { count: pretty.length })}
        </div>
      )}
    </div>
  )
}

/* ============================================================
 * 注册表 —— 与 `VLIB_COMPONENTS` 同源（漏实现即编译期报错）
 * ============================================================ */
export const VLIB_IMPL = {
  DataTable,
  MetricCard,
  Sparkline,
  CandleChart,
  TimelineBoard,
  MediaGrid,
  KeyValueList,
  LogStream,
  MarkdownView,
  JsonView,
} satisfies Record<VLibComponentName, ComponentType<VLibProps>>

/** 值级取实现（`name` 来自磁盘 manifest，运行期必须过白名单） */
export function resolveVLib(name: unknown): ComponentType<VLibProps> | null {
  if (typeof name !== 'string') return null
  if (!(VLIB_COMPONENTS as readonly string[]).includes(name)) return null
  return VLIB_IMPL[name as VLibComponentName] ?? null
}

export { EmptyState }
