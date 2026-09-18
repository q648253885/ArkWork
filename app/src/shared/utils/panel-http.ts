/* ============================================================
 * ArkWork — `http` 数据源的声明式映射（纯函数 · v0.34.1）
 * 设计文档：docs/versions/v0.34.1/04-system-design.md §5.3
 *
 * 插件是**磁盘上的 JSON**，宿主不允许它执行代码 —— 所以「接口返回什么形状、
 * 怎么变成组件的 rows」只能用声明描述。本文件就是这份声明的解释器。
 *
 * 三条纪律：
 *  ① **永不抛错** —— 响应来自第三方接口，形状随时可能变；坏输入只能是
 *     「行少几列 / 整表为空」，绝不能让面板崩成白屏（有测试把守）。
 *  ② **不静默造假** —— 取不到行就返回空数组，由 PanelHost 走 empty 态，
 *     绝不补一行「暂无数据」当数据。
 *  ③ **模板唯一语义** —— URL 参数与派生列共用 `applyTemplate`（shared/types/vlib）。
 * ============================================================ */
import { applyTemplate, type HttpSourceSpec } from '@shared/types/vlib'

/** 按点号路径取值（任一层缺失即 undefined，永不抛错） */
export function resolvePath(input: unknown, path: string | undefined): unknown {
  if (!path) return input
  let cur: unknown = input
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export interface HttpMappingResult {
  rows: Array<Record<string, unknown>>
  columns?: Array<{ key: string; label: string; align?: 'left' | 'right' }>
  /** 取数链路的人话诊断（行数 / 是否走了 path / 是否被 limit 截断） */
  note?: string
}

/**
 * 把一次 http 响应按规格映射成面板行。
 *
 * 支持的三种元素形态：
 *  1. 对象数组（字段直取）      → 行情列表
 *  2. 单个对象（自动包成一行）  → 个股详情
 *  3. 分隔符字符串数组（按位置）→ K 线（`"2026-09-18,开,收,高,低,…"`）
 */
export function mapHttpResponse(
  payload: unknown,
  spec: HttpSourceSpec,
  vars: Record<string, unknown> = {},
): HttpMappingResult {
  const picked = resolvePath(payload, spec.path)
  let arr: unknown[]
  if (Array.isArray(picked)) {
    arr = picked
  } else if (picked !== null && picked !== undefined && typeof picked === 'object') {
    arr = [picked]
  } else {
    return { rows: [], note: `路径 ${spec.path ?? '(root)'} 未取到数组或对象` }
  }

  const cols = spec.columns
  const rows: Array<Record<string, unknown>> = []
  for (const item of arr) {
    const row: Record<string, unknown> = {}
    if (spec.split && typeof item === 'string') {
      const parts = item.split(spec.split)
      if (cols && cols.length > 0) {
        cols.forEach((c, i) => {
          row[c.key] = (parts[i] ?? '').trim()
        })
      } else {
        parts.forEach((p, i) => {
          row[`col${i}`] = p.trim()
        })
      }
    } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>
      if (cols && cols.length > 0) {
        for (const c of cols) row[c.key] = rec[c.key]
      } else {
        Object.assign(row, rec)
      }
    } else {
      continue
    }
    // 派生列：模板里的 {{字段}} 取的是**本行**的值
    if (spec.derive) {
      for (const [key, tpl] of Object.entries(spec.derive)) {
        row[key] = applyTemplate(tpl, row)
      }
    }
    rows.push(row)
  }

  const limited = spec.limit && spec.limit > 0 && rows.length > spec.limit
    ? rows.slice(-spec.limit)
    : rows

  const note = `${limited.length} 行${spec.limit && rows.length > spec.limit ? `（原 ${rows.length} 行，按 limit=${spec.limit} 取最近）` : ''}`
  return { rows: limited, columns: cols, note }
}
