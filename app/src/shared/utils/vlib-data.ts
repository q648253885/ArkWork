/* ============================================================
 * ArkWork — 面板数据形状校验（纯函数 · v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §8.2
 *
 * 为什么独立成纯模块（沿用 `shared/utils/flow-fold.ts` 的先例）：
 * `components/vlib/**` 顶层依赖 React 与 store，node:test 无法密闭覆盖；
 * 而「哪个组件需要哪种形状」恰恰是最容易写错、错了又最难发现的一环
 * （错了 → 面板渲染成空白 → 违反「永不静默空白」纪律）。
 *
 * 纪律：**组件只认数据形状，不认业务**（正本 04 §4）。本模块是这句话的执行者。
 * ============================================================ */
import {
  VLIB_DATA_REQUIREMENT,
  isVLibComponent,
  type PanelData,
  type VLibComponentName,
} from '@shared/types/vlib'

export type PanelDataCheck = { ok: true } | { ok: false; reason: string }

const NEED_LABEL: Record<'rows' | 'metrics' | 'points' | 'text' | 'value', string> = {
  rows: 'rows 数组',
  metrics: 'metrics 数组',
  points: 'points 数字数组',
  text: 'text 字符串',
  value: 'value 字段',
}

/**
 * 校验 `data` 是否满足 `component` 的必需形状。
 *
 * 三条纪律：
 *  ① **不抛错**（数据可能来自用户手改的磁盘文件）；
 *  ② 原因必须**指名道姓**（「本组件需要 rows 数组」而不是「数据不合法」）；
 *  ③ 空数组/空串**不是**形状错（那是 `empty` 态，由 PanelHost 判定）。
 */
export function validatePanelData(component: unknown, data: unknown): PanelDataCheck {
  if (!isVLibComponent(component)) {
    return { ok: false, reason: `未知组件「${String(component)}」` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: '数据必须是对象' }
  }
  const d = data as PanelData
  if (d.kind !== 'static' && d.kind !== 'file' && d.kind !== 'mcp') {
    return { ok: false, reason: `未知数据源 kind「${String(d.kind)}」` }
  }

  const need = VLIB_DATA_REQUIREMENT[component as VLibComponentName]
  switch (need) {
    case 'rows':
      if (!Array.isArray(d.rows)) return { ok: false, reason: `本组件需要 ${NEED_LABEL.rows}` }
      break
    case 'metrics':
      if (!Array.isArray(d.metrics)) return { ok: false, reason: `本组件需要 ${NEED_LABEL.metrics}` }
      break
    case 'points':
      if (!Array.isArray(d.points)) return { ok: false, reason: `本组件需要 ${NEED_LABEL.points}` }
      if (d.points.some((p) => typeof p !== 'number' || !Number.isFinite(p))) {
        return { ok: false, reason: 'points 必须是有限数字（含 NaN / 字符串即不合法）' }
      }
      break
    case 'text':
      if (typeof d.text !== 'string') return { ok: false, reason: `本组件需要 ${NEED_LABEL.text}` }
      break
    case 'value':
      if (d.value === undefined || d.value === null) {
        return { ok: false, reason: `本组件需要 ${NEED_LABEL.value}（null 不算有值）` }
      }
      break
  }
  return { ok: true }
}

/** 数据是否「空」（渲染 `empty` 态而非空白）。形状不合法时不参与判定。 */
export function isPanelDataEmpty(component: unknown, data: unknown): boolean {
  if (!isVLibComponent(component)) return false
  const d = (data ?? {}) as PanelData
  const need = VLIB_DATA_REQUIREMENT[component]
  switch (need) {
    case 'rows':
      return !Array.isArray(d.rows) || d.rows.length === 0
    case 'metrics':
      return !Array.isArray(d.metrics) || d.metrics.length === 0
    case 'points':
      return !Array.isArray(d.points) || d.points.length === 0
    case 'text':
      return typeof d.text !== 'string' || d.text.trim().length === 0
    case 'value':
      return false
    default:
      return false
  }
}

/** 组件名清单（供诊断页与编辑器枚举，避免各处硬编码） */
export function listVLibComponents(): readonly VLibComponentName[] {
  return Object.keys(VLIB_DATA_REQUIREMENT) as VLibComponentName[]
}
