/* ============================================================
 * ArkWork — 交互区进程折叠（v0.32.0）
 * 设计文档：docs/versions/v0.32.0/04-system-design.md §1.3–1.5
 *           docs/versions/v0.32.0/03-interaction.md §一 / 二 / 三
 *
 * 职责：把 `FlowStep.blocks` 的线性序列切成「主展示块 / 进程折叠 run」
 * 交替的渲染段（**保持时间顺序**），并给出折叠行的计数与默认展开策略。
 *
 * 为什么独立成纯模块：
 *  ① `renderer/store/slices/uiSlice.ts` 顶层读 `import.meta.env`，node:test
 *     无法导入 —— 判定逻辑必须抽出来才可密闭单测（沿用
 *     `store/derive-conversation.ts` / `store/settle.ts` 的先例）；
 *  ② 折叠是「渲染投影」而非「数据投影」：`projectConversation` 的块列表
 *     一字不动（等价性基线冻死），因此本模块只读块、不改块。
 * ============================================================ */
import type {
  FlowBlock,
  FlowFoldRun,
  FlowSegment,
  FlowViewMode,
  FoldScope,
} from '@shared/types/flow'
import type { ToolCallKind } from '@shared/types/tool-present'

/** 主展示块 = 用户消息 / 叙述 / 终答 / 计划 / 审批 / 提示 / 错误 */
export const PRIMARY_KINDS = ['user', 'say', 'answer', 'plan', 'approval', 'notice', 'error'] as const

/** 进程块 = 思考 + 工具（技能 / MCP 调用在投影层已统一为 tool 块） */
export function isProcessBlock(
  b: FlowBlock,
): b is Extract<FlowBlock, { kind: 'reasoning' | 'tool' }> {
  return b.kind === 'reasoning' || b.kind === 'tool'
}

function scopeOf(b: FlowBlock): FoldScope | null {
  if (b.kind === 'reasoning') return 'reasoning'
  if (b.kind === 'tool') return 'tool'
  return null
}

/**
 * 工具块的呈现分类。
 * 优先取 `call.kind`（present.ts 的 8 个已登记工具均显式给出）；
 * 缺省按卡片形态退化 —— terminal → execute、write → edit、其余 other。
 * 与投影层 `classifyToolKind` 口径一致但**不做名称猜测**（present.ts 已是权威）。
 */
export function toolKindOf(b: Extract<FlowBlock, { kind: 'tool' }>): ToolCallKind {
  if (b.call.kind) return b.call.kind
  if (b.call.card === 'terminal') return 'execute'
  if (b.call.card === 'write') return 'edit'
  return 'other'
}

/** run 是否含异常（失败 / 软失败守卫）—— 决定语义色与自动展开 */
export function runHasFailure(blocks: FlowBlock[]): boolean {
  return blocks.some(
    (b) =>
      (b.kind === 'tool' && (b.status === 'failed' || b.status === 'guarded')) ||
      (b.kind === 'reasoning' && b.status === 'failed'),
  )
}

/** run 是否仍在进行 —— 决定折叠行是否追加「进行中」 */
export function runHasRunning(blocks: FlowBlock[]): boolean {
  return blocks.some(
    (b) =>
      (b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')) ||
      (b.kind === 'reasoning' && (b.status === 'streaming' || b.status === 'pending')),
  )
}

function runStartedAt(blocks: FlowBlock[]): number {
  const first = blocks[0]
  if (first && (first.kind === 'reasoning' || first.kind === 'tool')) return first.startedAt
  return 0
}

function runDuration(blocks: FlowBlock[]): number {
  let sum = 0
  for (const b of blocks) {
    if (b.kind === 'reasoning' || b.kind === 'tool') sum += b.durationMs || 0
  }
  return sum
}

/** 由一段连续同类进程块构造 run（导出供测试与 TurnFooter 直接复用） */
export function buildFoldRun(scope: FoldScope, blocks: FlowBlock[]): FlowFoldRun {
  const first = blocks[0]
  return {
    id: first ? first.id : `${scope}:empty`,
    scope,
    blocks,
    startedAt: runStartedAt(blocks),
    durationMs: runDuration(blocks),
    hasFailure: runHasFailure(blocks),
    hasRunning: runHasRunning(blocks),
  }
}

/**
 * 把块序列切成渲染段（**保序**）。
 *
 * 规则（04 §1.3）：
 *  ① 相邻同类进程块合成一个 run；kind 变化即断组；
 *  ② 主展示块永不折叠，且天然是 run 的分隔符；
 *  ③ `notice` / `error` 属主展示块 —— 异常必须可见，即使它夹在两次工具
 *     调用之间（此时得到「两个 run 夹一条提示」，**是期望行为**）。
 */
export function segmentFlow(blocks: FlowBlock[]): FlowSegment[] {
  const out: FlowSegment[] = []
  let bucket: FlowBlock[] = []
  let bucketScope: FoldScope | null = null

  const flush = () => {
    if (bucket.length === 0 || bucketScope === null) return
    const run = buildFoldRun(bucketScope, bucket)
    out.push({ type: 'fold', key: `fold:${run.id}`, run })
    bucket = []
    bucketScope = null
  }

  for (const b of blocks) {
    const scope = scopeOf(b)
    if (scope === null) {
      flush()
      out.push({ type: 'block', key: `b:${b.id}`, block: b })
      continue
    }
    if (bucketScope !== null && scope !== bucketScope) flush()
    bucketScope = scope
    bucket.push(b)
  }
  flush()
  return out
}

/* ---------- 工具 run 的分列计数（折叠行文案的唯一数据源） ---------- */

/** 固定拼接顺序 —— 确定性便于测试，也让用户形成扫读习惯 */
export const TOOL_COUNT_ORDER: ToolCallKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'other',
]

/** 每个 kind 对应的 i18n key（四语言齐备，TC-I18N-005 把守键集一致） */
export const TOOL_FOLD_I18N_KEY: Record<ToolCallKind, string> = {
  read: 'flow.fold.read',
  edit: 'flow.fold.edit',
  delete: 'flow.fold.delete',
  move: 'flow.fold.move',
  search: 'flow.fold.search',
  execute: 'flow.fold.execute',
  fetch: 'flow.fold.fetch',
  other: 'flow.fold.other',
}

export type ToolCounts = Partial<Record<ToolCallKind, number>>

/** 统计 run 内工具块按类别计数（非 tool 块忽略） */
export function countToolRun(blocks: FlowBlock[]): ToolCounts {
  const counts: ToolCounts = {}
  for (const b of blocks) {
    if (b.kind !== 'tool') continue
    const k = toolKindOf(b)
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts
}

/** 过滤出非零项并保持固定顺序 */
export function toolRunParts(counts: ToolCounts): Array<{ kind: ToolCallKind; count: number }> {
  const out: Array<{ kind: ToolCallKind; count: number }> = []
  for (const kind of TOOL_COUNT_ORDER) {
    const count = counts[kind] ?? 0
    if (count > 0) out.push({ kind, count })
  }
  return out
}

/** 计数求和（全为 0 时折叠行退化用） */
export function toolCountTotal(counts: ToolCounts): number {
  let sum = 0
  for (const kind of TOOL_COUNT_ORDER) sum += counts[kind] ?? 0
  return sum
}

/* ---------- 默认展开策略（修复 v0.31.0 viewMode 空壳） ---------- */

/**
 * 三档视图模式下的 run 默认态（03 §三）：
 *  compact  → 全折叠（含异常）
 *  standard → 折叠，**异常自动展开**（失败不静默）
 *  verbose  → 全展开
 */
export function resolveFoldDefault(
  viewMode: FlowViewMode,
  run: Pick<FlowFoldRun, 'hasFailure'>,
): boolean {
  if (viewMode === 'verbose') return true
  if (viewMode === 'standard') return run.hasFailure
  return false
}

/**
 * 折叠行的实际展开态 —— **用户意志最高**（03 §三纪律）。
 *
 * 语义与投影层 `blockOpenOf` 严格一致（这是单一权威口径，勿各自实现）：
 * - `userOpen` 是**三态门闩**：`null` = 用户没碰过 → 走模式策略；
 * - `userOpen !== null` = 用户碰过 → 以 store 里的**应用态 `open`** 为准。
 *
 * ⚠️ v0.32.0 实测缺陷 D33：本函数此前写成「`userOpen !== null` 直接返回
 * `userOpen` 本身」，同时 `uiSlice.setBlockOpen` 恒写 `userOpen: true` ——
 * 两者叠加的后果是「展开后永远收不起来」。修复分两处：本函数改读 `open`，
 * setter 改经 `applyUserFoldToggle` 写入真实意图。**两者必须成对存在。**
 */
export function resolveFoldOpen(input: {
  /** store 里的应用态（用户干预过时以它为准） */
  open: boolean
  /** 用户意图三态：null = 未干预过 */
  userOpen: boolean | null
  viewMode: FlowViewMode
  hasFailure: boolean
}): boolean {
  if (input.userOpen !== null) return input.open
  return resolveFoldDefault(input.viewMode, { hasFailure: input.hasFailure })
}

/**
 * 折叠行的 store UI 状态形状（结构上等价 `store/types.ts` 的 `BlockUiState`，
 * 这里只取折叠所需的两字段 —— 纯函数模块不得反向依赖 store 类型）。
 */
export interface FoldUiState {
  open: boolean
  userOpen: boolean | null
}

/**
 * 用户点击折叠头行 → 下一份 UI 状态。
 *
 * **唯一写入口**。两件事必须同时发生：
 *  ① `open` ← 用户本次要的目标态（应用态）；
 *  ② `userOpen` ← **同一个值**（意图）。**绝不可恒写 `true`** ——
 *     门闩一旦恒为真，`resolveFoldOpen` 就永远返回应用态，
 *     而应用态又被写死成 `true`，用户便再也收不起来（缺陷 D33）。
 */
export function applyUserFoldToggle(prev: FoldUiState | undefined, open: boolean): FoldUiState {
  return { open, userOpen: open }
}

/** 折叠行可交互性：空思考（无正文且无占位）时是静态行，不渲染箭头、不可点击 */
export function isFoldInteractive(run: FlowFoldRun): boolean {
  if (run.scope === 'tool') return true
  // reasoning：只要有块就可点开（占位文案在展开体内也能看到来源说明）
  return run.blocks.length > 0
}
