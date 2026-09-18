/* ============================================================
 * ArkWork — 面板数据拉取（v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §8.2
 *
 * 四种数据源（`PanelData.kind`）：
 *  · `static` —— manifest 内联直出，**同步**可渲染（无 loading 态）；
 *  · `file`   —— 读工作区内文本；走编辑器同一条 `ark.fs.readText`，
 *                因此享受同一套「编码探测 / 大小上限 / 工作区守卫」，
 *                插件无法借此读任意路径；
 *  · `http`   —— v0.34.1：宿主主进程取数（无同源策略 → 天然规避 CORS），
 *                按声明式规格映射成 rows，可按 `pollMs` 轮询刷新。
 *                轮询由宿主夹到 [3s, 600s]（防插件把行情接口当 DDoS 打）；
 *  · `mcp`    —— **诚实报「未接线」**（遗留 L-33-01）。绝不回落 static 假数据 ——
 *                「永不静默半死」是本版的第一纪律。
 *
 * 四态由 `PanelHost` 消费：loading / ready / empty / error。
 * ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import { ark } from '../../ipc/client'
import { applyTemplate, clampPollMs, type PanelData } from '@shared/types/vlib'
import { validatePanelData } from '@shared/utils/vlib-data'
import { mapHttpResponse } from '@shared/utils/panel-http'

export type PanelDataStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface PanelDataState {
  status: PanelDataStatus
  /** 已就绪的数据（ready/empty 时非空；loading/error 时为 null） */
  data: PanelData | null
  /** error 态的人话原因（含「未接线」这类诚实说明） */
  error?: string
  /** file 源实际读到的路径（诊断展示用） */
  resolvedPath?: string
}

const MCP_NOT_WIRED =
  '该面板声明了 MCP 数据源，但本版尚未接线（遗留 L-33-01）。请在 manifest 中先改用 static 数据源。'

/** `file` 源：把文本按 `format` 解析为面板可消费的形状 */
function parseFileContent(content: string, format: PanelData['format']): Partial<PanelData> {
  const fmt = format ?? 'text'
  if (fmt === 'json') {
    const parsed = JSON.parse(content) as unknown
    if (Array.isArray(parsed)) return { rows: parsed as Array<Record<string, unknown>> }
    if (typeof parsed === 'object' && parsed !== null) {
      const rec = parsed as Record<string, unknown>
      if (Array.isArray(rec.rows)) return { rows: rec.rows as Array<Record<string, unknown>> }
      if (Array.isArray(rec.metrics)) return { metrics: rec.metrics as PanelData['metrics'] }
      if (Array.isArray(rec.points)) return { points: rec.points as number[] }
      if (typeof rec.text === 'string') return { text: rec.text }
      return { value: parsed }
    }
    return { value: parsed }
  }
  if (fmt === 'csv') {
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length === 0) return { rows: [] }
    const headers = lines[0].split(',').map((h) => h.trim())
    const rows = lines.slice(1).map((line) => {
      const cells = line.split(',')
      const row: Record<string, unknown> = {}
      headers.forEach((h, i) => {
        row[h || `col${i + 1}`] = (cells[i] ?? '').trim()
      })
      return row
    })
    return { rows, columns: headers.map((h) => ({ key: h, label: h })) }
  }
  return { text: content }
}

/**
 * 拉取一份面板数据。
 *
 * `component` 只用于**形状校验**（`validatePanelData`）—— 在渲染前就判定
 * 「这份数据到底喂不喂得进这个组件」，而不是等组件渲染出空白。
 *
 * `vars` 是面板打开参数（行点击传下来的 `{{secid}}` 之类）—— 它参与 URL
 * 模板替换，因此必须进依赖数组，否则「点第二只股票还显示第一只」。
 */
export function usePanelData(
  component: string,
  data: PanelData | undefined,
  vars?: Record<string, unknown>,
): PanelDataState {
  const kind = data?.kind
  const path = data?.path
  const spec = data?.http
  const pollMs = clampPollMs(spec?.pollMs)
  // 依赖收敛到「数据形状」，避免每次渲染都新造对象触发重读
  const dataKey = useMemo(() => JSON.stringify(data ?? null), [data])
  // 打开参数同上：对象字面量每次渲染都是新引用，必须先序列化
  const varsKey = useMemo(() => JSON.stringify(vars ?? {}), [vars])

  const [state, setState] = useState<PanelDataState>(() => {
    if (!data) return { status: 'error', data: null, error: '面板未声明数据源' }
    return { status: kind === 'static' ? 'ready' : 'loading', data: kind === 'static' ? data : null }
  })

  useEffect(() => {
    if (!data) return
    if (data.kind === 'static') {
      setState({ status: 'ready', data })
      return
    }
    if (data.kind === 'mcp') {
      setState({ status: 'error', data: null, error: MCP_NOT_WIRED })
      return
    }
    // v0.34.1 http：主进程取数 → 声明式映射 →（可选）轮询
    if (data.kind === 'http') {
      if (!spec || !spec.url) {
        setState({ status: 'error', data: null, error: 'http 数据源必须声明 data.http.url' })
        return
      }
      let alive = true
      let timer: ReturnType<typeof setInterval> | undefined
      const varsObj = (JSON.parse(varsKey) ?? {}) as Record<string, unknown>
      const runOnce = async (isRefresh: boolean) => {
        if (!isRefresh) setState({ status: 'loading', data: null })
        try {
          const res = await ark.panel.fetch({
            url: applyTemplate(spec.url, varsObj),
            method: spec.method ?? 'GET',
            headers: spec.headers ?? {},
            response: spec.response ?? 'json',
          })
          if (!alive) return
          if (!res.ok) {
            setState({ status: 'error', data: null, error: res.error ?? `取数失败（HTTP ${res.status ?? '?'}）` })
            return
          }
          const mapped = mapHttpResponse(res.json ?? res.text, spec, varsObj)
          const merged: PanelData = {
            ...data,
            rows: mapped.rows,
            ...(mapped.columns ? { columns: mapped.columns } : {}),
          }
          const check = validatePanelData(component, merged)
          if (!check.ok) {
            setState({ status: 'error', data: null, error: `${check.reason}（${mapped.note ?? '映射后'}）` })
            return
          }
          setState({ status: 'ready', data: merged, resolvedPath: spec.url })
        } catch (err) {
          if (!alive) return
          setState({ status: 'error', data: null, error: err instanceof Error ? err.message : String(err) })
        }
      }
      void runOnce(false)
      if (pollMs) timer = setInterval(() => void runOnce(true), pollMs)
      return () => {
        alive = false
        if (timer) clearInterval(timer)
      }
    }
    // file
    if (!path) {
      setState({ status: 'error', data: null, error: 'file 数据源必须声明 path（绝对路径）' })
      return
    }
    let alive = true
    setState({ status: 'loading', data: null })
    void (async () => {
      try {
        const res = await ark.fs.readText(path)
        if (!alive) return
        if (res.content === null) {
          setState({ status: 'error', data: null, error: `无法以文本读取：${path}（可能是二进制或文件过大）` })
          return
        }
        const parsed = parseFileContent(res.content, data.format)
        const merged: PanelData = { ...data, ...parsed }
        const check = validatePanelData(component, merged)
        if (!check.ok) {
          setState({ status: 'error', data: null, error: `${check.reason}（来自 ${path}）` })
          return
        }
        setState({ status: 'ready', data: merged, resolvedPath: path })
      } catch (err) {
        if (!alive) return
        setState({
          status: 'error',
          data: null,
          resolvedPath: path,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      alive = false
    }
    // dataKey 已覆盖 data 的全部内容；kind/path 是它的派生读取，列入仅为可读性。
    // v0.34.1：varsKey / pollMs 必须进依赖 —— 少了 varsKey 会出现「点第二只股票
    // 仍显示第一只」（参数变了但没重取），少了 pollMs 则改不动轮询节奏。
  }, [component, kind, path, dataKey, data, varsKey, pollMs])

  return state
}
