/* ============================================================
 * ArkWork — 宿主垂直组件库契约（v0.33.0）
 * 设计文档：docs/versions/v0.33.0/04-system-design.md §2.4 / §8
 *           正本 `workbench-profile-v1.0/04-宿主插槽与UI扩展体系.md` §4（判断 J3）
 *
 * 一句话：**插件的表达力边界 = 宿主组件库白名单**。
 *
 * 硬约束（D4）：插件只能引用组件名 + 声明数据形状，**不允许注入任意 React 代码**。
 * 因此这里的联合类型是**闭集**，`VLIB_COMPONENTS` 与组件实现同源（新增组件必须
 * 同时改本文件与 `renderer/components/vlib/index.tsx`，缺一即编译期报错）。
 *
 * 本文件只放类型与常量（shared 层硬规则：零 electron / 零 renderer / 零 main）。
 * ============================================================ */

/**
 * v0.34.1：`http` 数据源的声明式映射规格。
 *
 * 为什么必须声明式：插件是**磁盘上的 JSON**，宿主的安全边界就是「只认数据形状、
 * 不接受任意代码」。所以取数后怎么变成 rows，只能用声明描述。
 *
 * 取数在**主进程**执行（Electron 主进程无同源策略，天然规避 CORS），
 * 因此插件能读任意公开行情接口，而无需宿主为其开放网络权限。
 */
export interface HttpSourceSpec {
  /** 完整 URL；可含 `{{param}}` 占位符（由面板打开参数替换） */
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** 轮询刷新间隔（ms）；缺省/0 = 只拉一次。宿主会夹到 [3000, 600000] */
  pollMs?: number
  /** 响应解析方式，缺省 json */
  response?: 'json' | 'text'
  /** 取数组/对象的路径（点号分隔，如 `data.klines`）；对象会被包成单行数组 */
  path?: string
  /** 数组元素是字符串时，按此分隔符切成多列（K 线接口就是逗号分隔） */
  split?: string
  /** 列定义：`split` 模式下按**位置**对应；对象模式下 `key` 即源字段名 */
  columns?: Array<{ key: string; label: string; align?: 'left' | 'right' }>
  /** 派生列：目标键 → 模板（如 `secid: '{{f13}}.{{f12}}'`） */
  derive?: Record<string, string>
  /** 只保留最后 N 条（K 线只要最近 N 根） */
  limit?: number
}

/** 面板交互（v0.34.1：行点击 → 浮窗承载面板） */
export interface PanelRowClick {
  /** 点击行后要打开的面板；多个即作为浮窗的多个 Tab 一次性打开 */
  panelRefs: string[]
  /**
   * 打开参数：值取自**当前行的字段名**（如 `{ secid: 'secid' }`）。
   * 目标面板 URL 里的 `{{secid}}` 会替换成该字段的值 —— 这就是「点哪只股票
   * 就看哪只股票」的通路，不需要插件写代码。
   */
  params?: Record<string, string>
}

export interface PanelInteract {
  onRowClick?: PanelRowClick
}

/** 面板数据形状（唯一形状，组件各取所需；缺必需形状由 validatePanelData 拦在宿主侧） */
export interface PanelData {
  /** 数据来源：static 直出 / file 读文件 / http 拉网络 / mcp 走 MCP（未接线，诚实报错） */
  kind: 'static' | 'file' | 'http' | 'mcp'
  /** 表格类组件的行数据 */
  rows?: Array<Record<string, unknown>>
  /** 表格类组件的列定义（缺省则从首行键推导） */
  columns?: Array<{ key: string; label: string; align?: 'left' | 'right' }>
  /** MetricCard 的指标卡 */
  metrics?: Array<{ label: string; value: string; delta?: number; hint?: string }>
  /** Sparkline 的数值序列 */
  points?: number[]
  /** 文本类组件的正文 */
  text?: string
  /** JsonView 的任意值 */
  value?: unknown
  /** file 源：绝对路径 */
  path?: string
  /** file 源：解析格式 */
  format?: 'json' | 'text' | 'csv'
  /** http 源：声明式取数 + 映射规格 */
  http?: HttpSourceSpec
  /** mcp 源：server / 方法 / 参数（本版只登记不接线） */
  server?: string
  method?: string
  params?: Record<string, unknown>
}

/**
 * 宿主组件白名单（闭集）。
 * ⚠️ 新增成员必须同步：① `renderer/components/vlib/index.tsx` 的 `VLIB_IMPL`
 *    ② `VLIB_DATA_REQUIREMENT` ③ `validatePanelData` 的分支（有测试把守穷尽性）。
 */
export const VLIB_COMPONENTS = [
  'DataTable',
  'MetricCard',
  'Sparkline',
  'CandleChart',
  'TimelineBoard',
  'MediaGrid',
  'KeyValueList',
  'LogStream',
  'MarkdownView',
  'JsonView',
] as const

export type VLibComponentName = (typeof VLIB_COMPONENTS)[number]

/** 每个组件「必需」的数据字段 —— 宿主侧形状校验的唯一真源 */
export const VLIB_DATA_REQUIREMENT: Record<
  VLibComponentName,
  'rows' | 'metrics' | 'points' | 'text' | 'value'
> = {
  DataTable: 'rows',
  CandleChart: 'rows',
  TimelineBoard: 'rows',
  MediaGrid: 'rows',
  KeyValueList: 'rows',
  MetricCard: 'metrics',
  Sparkline: 'points',
  LogStream: 'text',
  MarkdownView: 'text',
  JsonView: 'value',
}

/** 值级白名单（运行期用：manifest / plugin.json 来自磁盘，不能只靠类型） */
export function isVLibComponent(v: unknown): v is VLibComponentName {
  return typeof v === 'string' && (VLIB_COMPONENTS as readonly string[]).includes(v)
}

/* ============================================================
 * 渲染器类型白名单（预览窗口的 RendererKind）
 *
 * 为什么放在 shared（而不是 `renderer/store/types.ts`）：
 * 插件清单校验（VP4）与 profile 校验（V2 的 ui.previewRenderers）都在
 * **纯函数层**判定 rendererKind 合法性，而纯函数层不能 import renderer 类型。
 * 因此这里成为**唯一真源**，renderer 侧的 `RendererKind` 由它派生
 * （`renderer/store/types.ts` 里是一行 re-export）—— 单一真源，永不漂移。
 * ============================================================ */
export const RENDERER_KIND_WHITELIST = [
  'markdown',
  'browser',
  'code',
  'image',
  'svg',
  'table',
  'fallback',
  'editor',
] as const

export type RendererKindName = (typeof RENDERER_KIND_WHITELIST)[number]

export function isRendererKind(v: unknown): v is RendererKindName {
  return typeof v === 'string' && (RENDERER_KIND_WHITELIST as readonly string[]).includes(v)
}

/** 内置面板条目载荷（六个固定面板：`panel:files` 等）—— 由 Inspector 的既有分支渲染 */
export interface BuiltinPanelSlotPayload {
  panelRef: string
  title: string
  builtin: true
}

/** 运行期守卫：内置面板载荷 */
export function isBuiltinPanelPayload(v: unknown): v is BuiltinPanelSlotPayload {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>).builtin === true &&
    typeof (v as Record<string, unknown>).panelRef === 'string'
  )
}

/** 面板条目载荷（插件/开放面板；由宿主垂直组件库渲染） */
export interface PanelSlotPayload {
  /** 'panel:<name>' */
  panelRef: string
  title: string
  /** 判别位：`true` 是内置面板（见 BuiltinPanelSlotPayload）；此处恒 false/缺省 */
  builtin?: false
  /** 宿主组件白名单成员 */
  component: VLibComponentName
  data: PanelData
  /** 宿主 Icon 名（非法则回落 Icon.Dot） */
  icon?: string
  /** 贡献该面板的插件 id（诊断归属用；内置/直申面板为空） */
  pluginId?: string
  /** 引用该面板的 profile id */
  profileId?: string
  /** v0.34.1：交互声明（行点击 → 浮窗打开另一批面板） */
  interact?: PanelInteract
}

export type AnyPanelSlotPayload = BuiltinPanelSlotPayload | PanelSlotPayload

/**
 * 运行期守卫：`unknown` → `PanelSlotPayload`。
 * 用途：插槽条目可能来自用户手改的磁盘文件，消费前必须过这道关；
 * 不合格的条目**跳过而不抛错**（诊断页会显示条目数差异）。
 */
export function isPanelSlotPayload(v: unknown): v is PanelSlotPayload {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const p = v as Record<string, unknown>
  if (p.builtin === true) return false
  if (typeof p.panelRef !== 'string' || !/^panel:[a-z0-9][\w.-]*$/.test(p.panelRef)) return false
  if (typeof p.title !== 'string' || p.title.length === 0) return false
  if (!isVLibComponent(p.component)) return false
  if (typeof p.data !== 'object' || p.data === null || Array.isArray(p.data)) return false
  const kind = (p.data as Record<string, unknown>).kind
  if (kind !== 'static' && kind !== 'file' && kind !== 'http' && kind !== 'mcp') return false
  return true
}

/* ============================================================
 * v0.34.1：http 源的轮询间隔夹取
 * 防的是插件作者手抖写 100ms —— 那会把行情接口当 DDoS 打，
 * 而且用户看不出是谁在打。宿主必须夹，不能只靠作者自觉。
 * ============================================================ */
export const PANEL_POLL_MIN_MS = 3000
export const PANEL_POLL_MAX_MS = 600000

export function clampPollMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined
  return Math.min(PANEL_POLL_MAX_MS, Math.max(PANEL_POLL_MIN_MS, Math.round(v)))
}

/** `{{key}}` 模板替换（URL 参数化与派生列共用同一套语义） */
export function applyTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key: string) => {
    const v = vars[key]
    return v === undefined || v === null ? m : String(v)
  })
}
