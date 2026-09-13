/**
 * ArkWork — 任务面板 · 11 态视觉映射（单一真源）
 *
 * 依据：docs/versions/v0.30.0/03-interaction.md §0.5「11 态视觉映射表」
 *       docs/versions/v0.30.0/prototype/（已冻结的视觉基准）
 *
 * ★ 这个文件是「状态 → 视觉」的**唯一映射点**。
 *   任何组件都不允许自己判断 `status === 'verifying' ? 'text-warning' : ...`
 *   —— 状态颜色一旦散落多处，就会出现"面板里琥珀色、对话卡里绿色"这类漂移，
 *   而本版最核心的一条视觉要求恰恰是：**verifying 必须与 completed 一眼可分**。
 *
 * 两条硬性视觉优先级（定义 03-interaction.md §0.5 的"附加表现"列）：
 *  1. needs_human 必须是整个面板最显眼的元素 —— 唯一红主色 / 唯一数字角标 /
 *     唯一 600 字重 / 强制置顶 / 永不自动折叠。它是唯一"必须由人打破僵局"的状态。
 *  2. verifying 用琥珀区别于 completed 的绿 —— 让"自称完成"无处遁形。
 */
import type { NodeStatus, NodeLayer, AcceptanceStatus, EvidenceKind } from '@shared/types/ipc'

/** 单个状态的视觉定义 */
export interface StatusMeta {
  /** 形状符号（11 态两两不同 —— 不单靠颜色区分，满足色盲可达） */
  glyph: string
  /** 文字色 class（Tailwind，引用 CSS 变量） */
  text: string
  /** 行底色 class（无底色时为 ''） */
  bg: string
  /** 左侧竖条色 class（无竖条时为 ''） */
  bar: string
  /** 字号/字重（needs_human 唯一使用 font-semibold） */
  weight: string
  /** 是否有脉冲/旋转动效 */
  animate: '' | 'pulse' | 'spin'
  /** ARIA 标签（无障碍：图标必须同时有形状差异与文字标签） */
  aria: string
}

/**
 * 11 态 → 视觉。顺序与 `NODE_STATUSES` 一致，便于对照检查。
 *
 * 颜色全部走既有语义 token（`--accent` / `--success` / `--warning` / `--danger` / `--info`
 * 及其 `-soft` 变体），**本版零新增颜色**（见 01-research.md 新增结论 N1）。
 */
export const STATUS_META: Record<NodeStatus, StatusMeta> = {
  draft: {
    glyph: '○',
    text: 'text-text-tertiary',
    bg: '',
    bar: '',
    weight: '',
    animate: '',
    aria: '还在想',
  },
  proposed: {
    glyph: '◐',
    text: 'text-info',
    bg: 'bg-info-soft',
    bar: '',
    weight: '',
    animate: '',
    aria: '等待批准',
  },
  approved: {
    glyph: '○',
    text: 'text-text-primary',
    bg: '',
    bar: '',
    weight: '',
    animate: '',
    aria: '已批准',
  },
  ready: {
    glyph: '○',
    text: 'text-text-primary',
    bg: '',
    bar: '',
    weight: '',
    animate: '',
    aria: '排队中',
  },
  in_progress: {
    glyph: '●',
    text: 'text-accent',
    bg: 'bg-accent-soft',
    bar: 'bg-accent',
    weight: '',
    animate: 'pulse',
    aria: '正在做',
  },
  // ★ 本版新增的第一个一等状态：做完了但没验证
  verifying: {
    glyph: '◑',
    text: 'text-warning',
    bg: 'bg-warning-soft',
    bar: 'bg-warning',
    weight: '',
    animate: 'spin',
    aria: '做完，验证中',
  },
  blocked: {
    glyph: '⊘',
    text: 'text-text-tertiary',
    bg: '',
    bar: '',
    weight: '',
    animate: '',
    aria: '被依赖卡住',
  },
  // ★ 本版新增的第二个一等状态：阻塞在等人（面板最高视觉优先级）
  needs_human: {
    glyph: '⊗',
    text: 'text-danger',
    bg: 'bg-danger-soft',
    bar: 'bg-danger',
    weight: 'font-semibold',
    animate: '',
    aria: '等待你的回答',
  },
  completed: {
    glyph: '✓',
    text: 'text-success',
    bg: '',
    bar: '',
    weight: '',
    animate: '',
    aria: '验证通过',
  },
  cancelled: {
    glyph: '—',
    text: 'text-text-tertiary',
    bg: '',
    bar: '',
    weight: '',
    animate: '',
    aria: '已取消',
  },
  failed: {
    glyph: '✗',
    text: 'text-danger',
    bg: 'bg-danger-soft',
    bar: 'bg-danger',
    weight: '',
    animate: '',
    aria: '失败',
  },
}

/** 取状态的视觉定义（未知状态兜底为 draft，避免渲染崩溃） */
export function statusMeta(status: NodeStatus): StatusMeta {
  return STATUS_META[status] ?? STATUS_META.draft
}

/** 层徽章文案（与设计稿一致，UI 上是大写短标签） */
export const LAYER_LABEL: Record<NodeLayer, string> = {
  goal: 'GOAL',
  milestone: 'MILESTONE',
  task: 'TASK',
  step: 'STEP',
}

/** 层缩进步长（px）—— 与 03-interaction.md §0.4 一致，超过 4 层不再增加 */
export const LAYER_INDENT_PX: Record<NodeLayer, number> = {
  goal: 0,
  milestone: 14,
  task: 28,
  step: 42,
}

/** AC 状态的视觉 */
export const AC_META: Record<AcceptanceStatus, { glyph: string; text: string; aria: string }> = {
  pending: { glyph: '○', text: 'text-text-tertiary', aria: '待验证' },
  passing: { glyph: '✓', text: 'text-success', aria: '已通过' },
  failing: { glyph: '✗', text: 'text-danger', aria: '未通过' },
  waived: { glyph: '—', text: 'text-text-tertiary', aria: '已豁免' },
}

/** 证据类型图标 + 中文名（可信度分级见 shared/types/graph.ts 的 EVIDENCE_TRUST） */
export const EVIDENCE_META: Record<EvidenceKind, { icon: string; label: string; trust: string }> = {
  human: { icon: '👤', label: '人工确认', trust: '最高' },
  test: { icon: '🧪', label: '测试', trust: '高' },
  command: { icon: '⌘', label: '命令', trust: '中高' },
  lsp: { icon: '🔧', label: '诊断', trust: '中高' },
  diff: { icon: '📝', label: '代码变更', trust: '中' },
  artifact: { icon: '📦', label: '产物', trust: '中' },
  screenshot: { icon: '🖼', label: '截图', trust: '中' },
}

/** 证据类型 → 动画 class（行内复用） */
export function stateRowClass(status: NodeStatus): string {
  const m = statusMeta(status)
  return [m.bg, m.weight].filter(Boolean).join(' ')
}

/** 等待时长格式化：2m14s / 45s / 1h2m */
export function formatWaiting(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 > 0 ? `${s % 60}s` : ''}`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

/** token 数格式化：12.4k / 980 */
export function formatTokens(n: number | undefined): string {
  if (!n) return ''
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`
}

/** 耗时格式化：2m18s */
export function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return ''
  return formatWaiting(ms)
}
