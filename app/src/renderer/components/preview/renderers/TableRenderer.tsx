/* ============================================================
 * ArkWork — TableRenderer (v0.7.0)
 * CSV/TSV 表格预览：解析 → 表头排序 → 单元格点击复制 → 分页（大文件简单分页）
 * - 自动检测分隔符：显式传入 > 首行 Tab 多于逗号则 TSV > 否则 CSV
 * - 支持引号字段（"" 转义、嵌入分隔符与换行）
 * - 排序：表头点击循环 升序 → 降序 → 无；数值列按数值比较
 * - 分页：每页 100 行，避免一次性渲染大文件卡顿
 * ============================================================ */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../../icons'
import { useStore } from '../../../store'

interface TableRendererProps {
  content: string
  /** 显式分隔符；未传则自动检测 */
  delimiter?: string
}

const PAGE_SIZE = 100

/** 解析分隔符文本为二维数组（支持引号字段） */
function parseDelimited(src: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delim) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // 过滤完全空行
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

function detectDelimiter(src: string): string {
  const firstLine = src.split('\n', 1)[0] ?? ''
  const tabs = (firstLine.match(/\t/g) ?? []).length
  const commas = (firstLine.match(/,/g) ?? []).length
  return tabs > commas ? '\t' : ','
}

type SortDir = 'asc' | 'desc' | null

export function TableRenderer({ content, delimiter }: TableRendererProps) {
  const { t } = useTranslation()
  const pushToast = useStore((s) => s.pushToast)
  const delim = delimiter ?? detectDelimiter(content)

  const { header, rows } = useMemo(() => {
    const all = parseDelimited(content, delim)
    if (all.length === 0) return { header: [] as string[], rows: [] as string[][] }
    return { header: all[0], rows: all.slice(1) }
  }, [content, delim])

  const [sortCol, setSortCol] = useState<number | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)
  const [page, setPage] = useState(0)

  const sorted = useMemo(() => {
    if (sortCol == null || sortDir == null) return rows
    const idx = sortCol
    const dir = sortDir === 'asc' ? 1 : -1
    const isNum = rows.every((r) => {
      const v = r[idx]
      return v == null || v === '' || !isNaN(Number(v))
    })
    return [...rows].sort((a, b) => {
      const av = a[idx] ?? ''
      const bv = b[idx] ?? ''
      if (isNum) return (Number(av) - Number(bv)) * dir
      return av.localeCompare(bv, 'zh') * dir
    })
  }, [rows, sortCol, sortDir])

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const curPage = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(curPage * PAGE_SIZE, curPage * PAGE_SIZE + PAGE_SIZE)

  const onHeaderClick = (ci: number) => {
    if (sortCol !== ci) {
      setSortCol(ci)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else if (sortDir === 'desc') {
      setSortCol(null)
      setSortDir(null)
    } else {
      setSortDir('asc')
    }
    setPage(0)
  }

  const copyCell = async (v: string) => {
    try {
      await navigator.clipboard.writeText(v)
      pushToast({ type: 'success', message: t('preview.table.toast.copiedCell'), duration: 1500 })
    } catch {
      pushToast({ type: 'danger', message: t('preview.table.toast.copyFailed'), duration: 1500 })
    }
  }

  if (header.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-text-tertiary">
        {t('preview.table.empty')}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-bg-base min-h-0">
      {/* 迷你工具条 */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border-subtle bg-bg-overlay flex-shrink-0">
        <span className="text-2xs text-text-tertiary uppercase tracking-wider">
          {delim === '\t' ? 'TSV' : 'CSV'}
        </span>
        <span className="text-2xs text-text-tertiary tabular">
          {t('preview.table.colsRows', { cols: header.length, rows: rows.length })}
        </span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(content)
              pushToast({ type: 'success', message: t('preview.table.toast.copiedRaw'), duration: 1500 })
            } catch {
              pushToast({ type: 'danger', message: t('preview.table.toast.copyFailed'), duration: 1500 })
            }
          }}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors"
        >
          <Icon.Copy width={16} height={16} />
          {t('preview.table.copyRaw')}
        </button>
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-auto min-h-0">
        <table className="border-collapse text-xs">
          <thead className="sticky top-0 z-10">
            <tr>
              {header.map((h, ci) => (
                <th
                  key={ci}
                  onClick={() => onHeaderClick(ci)}
                  className="px-2.5 py-1.5 text-left font-medium text-text-secondary bg-bg-surface border-b border-r border-border-subtle cursor-pointer hover:bg-bg-hover hover:text-text-primary transition-colors whitespace-nowrap select-none"
                  title={t('preview.table.sortHint', { column: h })}
                >
                  <span className="inline-flex items-center gap-1">
                    {h || t('preview.table.columnIndex', { n: ci + 1 })}
                    {sortCol === ci && (
                      <span className="text-text-tertiary">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, ri) => (
              <tr key={ri} className="hover:bg-bg-hover transition-colors">
                {header.map((_, ci) => (
                  <td
                    key={ci}
                    onClick={() => copyCell(r[ci] ?? '')}
                    className="px-2.5 py-1 text-text-primary border-b border-r border-border-subtle cursor-pointer whitespace-nowrap tabular max-w-[320px] truncate"
                    title={r[ci] ?? ''}
                  >
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {pageCount > 1 && (
        <div className="flex items-center gap-2 px-2 py-1 border-t border-border-subtle bg-bg-overlay flex-shrink-0">
          <button
            type="button"
            onClick={() => setPage(Math.max(0, curPage - 1))}
            disabled={curPage === 0}
            className="px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {t('preview.table.prevPage')}
          </button>
          <span className="text-2xs text-text-secondary tabular">
            {curPage + 1} / {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(Math.min(pageCount - 1, curPage + 1))}
            disabled={curPage >= pageCount - 1}
            className="px-1.5 py-0.5 text-2xs text-text-tertiary hover:bg-bg-hover hover:text-text-primary rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {t('preview.table.nextPage')}
          </button>
          <span className="ml-auto text-2xs text-text-tertiary">{t('preview.table.cellHint')}</span>
        </div>
      )}
    </div>
  )
}
