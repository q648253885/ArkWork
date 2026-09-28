/* ============================================================
 * ArkWork — 计划差异比对（v0.38.0 / D154）
 * 设计文档：docs/versions/v0.38.0/04-system-design.md §6.1 / §6.2
 *
 * 为什么要有这个文件：
 *   收敛前，模型侧有 11 个清单工具、两套定位语义（图工具按 node_id、账本工具按
 *   item_index），且语义重叠（都能新增）—— 模型没有唯一正确答案可选，现场表现为
 *   「判断摇摆 / 用一个工具冒充另一个」（D154）。
 *   收敛方案：模型只提交**完整计划**（"我现在的计划是什么"），差异由本模块计算。
 *
 * 硬规则：
 *   · **必须是纯函数** —— 无 IO、无 Date.now()、无随机；同一输入必得同一输出（幂等）。
 *   · **叶子模块** —— 只依赖 ledger/types（纯类型与常量），不得 import engine 内部。
 *   · 不变量强制在**这里**（而非存储层）：I8 终态不可回退、I1 最多一项 doing。
 * ============================================================ */
import type { LedgerArtifact, LedgerItem, LedgerItemStatus } from './types.js'
import { canLedgerTransition, isLedgerTerminal } from './types.js'

/* ---------------- 对外词表（模型侧 5 态） ---------------- */

/**
 * 模型侧状态词表 —— **对外 5 态**。
 * 为什么比内部少 4 态：模型的认知负担只与对外词表成正比；
 * `paused` / `verifying` / `failed` / `cancelled` 是引擎内部语义，
 * 在快照里降级呈现（见 toDraftSnapshot），模型无需知道。
 */
export const DRAFT_STATUSES = ['todo', 'doing', 'done', 'skipped', 'blocked'] as const

export type DraftStatus = (typeof DRAFT_STATUSES)[number]

export function isDraftStatus(v: unknown): v is DraftStatus {
  return typeof v === 'string' && (DRAFT_STATUSES as readonly string[]).includes(v)
}

/** 对外 5 态 → 对内 9 态 */
export const DRAFT_TO_LEDGER: Readonly<Record<DraftStatus, LedgerItemStatus>> = {
  todo: 'pending',
  doing: 'running',
  done: 'done',
  skipped: 'skipped',
  blocked: 'blocked',
}

/** 模型提交的单条计划 */
export interface PlanDraftItem {
  text: string
  status: DraftStatus
  note?: string
  /** v0.38.1（D176）：成果产物声明 —— done 项必须可核对（完成门禁 ARTIFACT 判据） */
  artifact?: LedgerArtifact
  /**
   * v0.39.0（D185）：父项引用 —— 让「子任务」从数据模型走进模型的手写面。
   * 三种形态都收（id / `#序号` / 父项文本前若干字），由 plan-commit 统一解析。
   * 未命中父项时按顶级处理并记录 warning，**不整体拒绝清单**（面向弱模型）。
   */
  parentRef?: string
}

/* ---------------- 快照（对内 9 态 → 对外 5 态） ---------------- */

export interface DraftSnapshotItem {
  text: string
  status: DraftStatus
  note?: string
}

/**
 * 把内部清单投影为模型可读快照。
 * `paused / verifying / failed / cancelled` 降级为最接近的对外态，并在 note 里补人话
 * —— 模型看到的是"事实 + 标注"，而不是被静默抹平（纪律⑨）。
 */
export function toDraftSnapshot(items: readonly LedgerItem[]): DraftSnapshotItem[] {
  return items.map((it) => {
    const n = it.note ? `${it.note}｜` : ''
    switch (it.status) {
      case 'paused':
        return { text: it.text, status: 'blocked', note: `${n}已暂停` }
      case 'verifying':
        return { text: it.text, status: 'doing', note: `${n}待验证` }
      case 'failed':
        return { text: it.text, status: 'skipped', note: `${n}失败` }
      case 'cancelled':
        return { text: it.text, status: 'skipped', note: `${n}已取消` }
      default:
        return { text: it.text, status: toDraftStatus(it.status), note: it.note }
    }
  })
}

/** 对内 9 态 → 对外 5 态（无降级标注，仅映射） */
export function toDraftStatus(s: LedgerItemStatus): DraftStatus {
  switch (s) {
    case 'pending':
      return 'todo'
    case 'running':
      return 'doing'
    case 'done':
      return 'done'
    case 'skipped':
    case 'failed':
    case 'cancelled':
      return 'skipped'
    case 'blocked':
    case 'paused':
      return 'blocked'
    case 'verifying':
      return 'doing'
  }
}

/* ---------------- 差异算子 ---------------- */

export type PlanDiffOp =
  | { kind: 'create'; text: string; to: LedgerItemStatus }
  | { kind: 'status'; itemId: string; text: string; from: LedgerItemStatus; to: LedgerItemStatus }
  | { kind: 'note'; itemId: string; text: string; note: string }
  /**
   * v0.38.1（D175）：配对成功但文本不同 → 文本按 draft 更新。
   * 此前 plan-commit 对 existing 项**只写状态与 note、绝不写 text**，于是
   * 「顺序兜底配对」把完全不同的新计划与旧项按位置配对后，新文本被**静默丢弃**
   * （现场：坦克大战重制清单，8 条新文本蒸发，面板永远是旧 FPS 条目）。
   */
  | { kind: 'retext'; itemId: string; text: string; from: string; to: string }
  | { kind: 'drop'; itemId: string; text: string }

/**
 * 提交后的目标排列。`plan-commit` 按本数组顺序**重建** items
 * —— 顺序语义由此表达，不需要单独的 `reorder` 算子。
 *
 * `existing` 带 `status` / `note`：commit 依据它恢复状态（受保护项此处已是原状态）。
 */
export type PlanLayoutEntry =
  | {
      kind: 'existing'
      id: string
      status: LedgerItemStatus
      note?: string
      /** v0.38.1（D175）：配对后按 draft 更新的文本（仅在与当前文本不同时携带） */
      text?: string
      /** v0.38.1（D176）：模型声明的成果产物（仅在本条提交里给出时覆盖） */
      artifact?: LedgerArtifact
      /**
       * v0.39.0（D185）：父项引用键 —— `id:<itemId>`（既有项）或 `k<n>`（同一份
       * layout 里新建的第 n 项）。由 `ops.plan-commit` 解析为 `parentId`。
       */
      parentKey?: string
    }
  | {
      kind: 'new'
      text: string
      status: LedgerItemStatus
      note?: string
      artifact?: LedgerArtifact
      /** 本次提交内的唯一键，供同批其它项的 parentKey 引用（`k<n>`） */
      key?: string
      parentKey?: string
    }

export interface PlanDiffResult {
  /** 变更集（不含无变化项）；`length === 0` 即"模型判断清单无需变化" */
  ops: PlanDiffOp[]
  /** 目标排列（含被保护的终态项，按原顺序追加在末尾） */
  layout: PlanLayoutEntry[]
  /** 真实变更数（0 是合法结果，表示"已检视，无需变化"） */
  changed: number
  /** 被引擎强制保留的项（模型试图把终态项改回非终态）—— I8 保护 */
  protectedIds: string[]
  /** 自动纠正的告警（会写入 observation 告知模型） */
  warnings: string[]
  /** 人话摘要，供 UI / turn_note 直接消费；无变化时为 '' */
  summary: string
}

const MAX_TEXT = 80

function clip(s: string): string {
  const t = s.trim()
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t
}

/* ---------------- 文本相似度（D175 配对门控；纯函数） ---------------- */

/**
 * 字符 bigram Jaccard 相似度 —— 判定「两条文本是不是同一件工作」。
 *
 * 为什么需要它（D175）：②顺序兜底配对此前**不看内容**，模型整体重制计划
 * （旧 FPS 清单 → 新坦克清单）时，新旧项被按位置强行配对。配对本身不丢数据，
 * 但 plan-commit 不更新既有项文本 → 新文本整体蒸发。给兜底配对加上
 * 「文本足够像才配」的门控后：措辞微调（读代码→读一遍代码）仍配对，
 * 整体重制（相似度≈0）则走 create + 终态保护，语义各归其位。
 *
 * 阈值取 0.2 的依据：契约用例 TC-PDIFF-006 的最弱配对（读代码↔读一遍代码，J=1/5=0.2、
 * 写测试↔补测试，J=1/3）必须放行；而「实现 A…」↔「实现 B…」这类共享开头短语的长文本对
 * J≈0.1，必须拆开。宁可少配（多出的项走 create/保护，不丢数据），
 * 不可错配（错配 = 静默改写别人的文本）。
 */
export const PAIR_SIMILARITY_MIN = 0.2

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

export function textSimilarity(a: string, b: string): number {
  const ta = a.trim()
  const tb = b.trim()
  if (ta === tb) return 1
  const A = bigrams(ta)
  const B = bigrams(tb)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * 把"模型提交的完整计划"与"当前清单"做差异比对。
 *
 * 匹配算法（三步）：
 *   ① 文本精确匹配：draft.text（trim 后）=== current.text 且双方均未被占用 → 配对
 *   ② 顺序兜底配对：剩余 draft 与剩余 current 按顺序一一配对，且**文本相似度
 *      ≥ PAIR_SIMILARITY_MIN 才配**（D175）—— 保证模型重排 / 微调措辞时不被误判为
 *      "全删全增"，同时防止整体重制计划（完全不同的工作）被按位置错配。
 *   ③ 仍剩余：draft 侧 → create；current 侧 → 终态保护或 drop
 *
 * 不变量强制：
 *   · I8：current 为终态（done/failed/cancelled/skipped）而 draft 给非终态
 *         → 状态不动，itemId 记入 protectedIds（仍允许更新 note）
 *   · 状态转换表不允许的组合（如 verifying → pending）→ 同样保护并留 warning
 *   · I1：draft 中多个 doing → 只保留第一个，其余降为 todo 并留 warning
 */
export function diffPlan(args: {
  current: readonly LedgerItem[]
  draft: readonly PlanDraftItem[]
}): PlanDiffResult {
  const { current, draft } = args
  const ops: PlanDiffOp[] = []
  const layout: PlanLayoutEntry[] = []
  const protectedIds: string[] = []
  const warnings: string[] = []

  const usedCurrent = new Set<number>()
  const pairedDraft = new Set<number>()
  /** ci → di */
  const pairs = new Map<number, number>()

  /* --- ① 文本精确匹配 --- */
  for (let di = 0; di < draft.length; di++) {
    const text = clip(draft[di]!.text)
    const ci = current.findIndex((c, i) => !usedCurrent.has(i) && c.text.trim() === text)
    if (ci >= 0) {
      usedCurrent.add(ci)
      pairedDraft.add(di)
      pairs.set(ci, di)
    }
  }

  /* --- ② 顺序兜底配对（D175：文本足够像才配，防「整体重制计划」被错配） --- */
  const freeCurrent = current.map((_, i) => i).filter((i) => !usedCurrent.has(i))
  const freeDraft = draft.map((_, i) => i).filter((i) => !pairedDraft.has(i))
  const pairCount = Math.min(freeCurrent.length, freeDraft.length)
  for (let k = 0; k < pairCount; k++) {
    const ci = freeCurrent[k]!
    const di = freeDraft[k]!
    if (textSimilarity(current[ci]!.text, draft[di]!.text) < PAIR_SIMILARITY_MIN) continue
    usedCurrent.add(ci)
    pairedDraft.add(di)
    pairs.set(ci, di)
  }

  /* --- I1：多个 doing → 只留第一个 --- */
  const doingIdx: number[] = []
  draft.forEach((d, i) => {
    if (d.status === 'doing') doingIdx.push(i)
  })
  const demoted = new Set(doingIdx.slice(1))
  if (doingIdx.length > 1) {
    warnings.push(`一次只能有一项 doing，已将后 ${doingIdx.length - 1} 项降为 todo`)
  }

  /* ---------------- v0.39.0（D185）：父项引用解析 ----------------
   * 模型手写面只给一个字符串引用（`parent`），三种形态都收：
   *   · `#序号` —— 本次提交的序号（1-based，对模型最直观）
   *   · `<id>`  —— 既有清单项 id（模型从快照里能读到）
   *   · `<文本前若干字>` —— 弱模型最可能给出的形态，按前缀/包含匹配
   * 未命中 → 按顶级项处理并留 warning，**不整体拒绝清单**（面向弱模型）。
   *
   * ⚠️ 层级上限（最多两层）**不在这里判**：这里只把引用解析成 key，判据唯一交给
   * `ops.ts` 的 plan-commit（②b）。原因有两个：
   *   ① 唯一事实源 —— 两处各写一份"父项是否已是子任务"必然漂移（纪律⑧）；
   *   ② 这里判不准 —— draft 阶段父项的 parentId 还没落定，只能看 `parentRef` 字符串，
   *      一旦 layout 顺序把孙项排在子项前面，孙项看到的父项"当时还是顶级" → 三层静默通过。
   *      此前这里提前 `continue`（降级为顶级 + warning），恰恰让 ops 层永远看不到这条边。
   */
  const pairOfDraft = new Map<number, number>() // di → ci
  for (const [ci, di] of pairs) pairOfDraft.set(di, ci)
  const newKeys = new Map<number, string>() // di → 本次提交内的新建键
  let keySeq = 0
  for (let di = 0; di < draft.length; di++) {
    if (!pairOfDraft.has(di)) newKeys.set(di, `k${keySeq++}`)
  }
  const parentKeys = new Map<number, string>()
  for (let di = 0; di < draft.length; di++) {
    const ref = draft[di]!.parentRef?.trim()
    if (!ref) continue
    const label = clip(draft[di]!.text).slice(0, 20)
    const target = resolveParentTarget(ref, di, draft, current)
    if (!target) {
      warnings.push(`「${label}」的父项引用「${ref}」未匹配到任何任务，已按顶级项处理`)
      continue
    }
    if (target.kind === 'draft') {
      const key = newKeys.get(target.index)
      const ci = pairOfDraft.get(target.index)
      if (key) parentKeys.set(di, key)
      else if (ci !== undefined) parentKeys.set(di, `id:${current[ci]!.id}`)
    } else {
      parentKeys.set(di, `id:${target.id}`)
    }
  }

  /* --- 按 draft 顺序生成算子与排列 --- */
  for (let di = 0; di < draft.length; di++) {
    const d = draft[di]!
    const text = clip(d.text)
    const wanted: LedgerItemStatus = demoted.has(di) ? 'pending' : DRAFT_TO_LEDGER[d.status]

    // 找本 draft 项配到的 current 下标
    let ci = -1
    for (const [k, v] of pairs) if (v === di) ci = k

    if (ci < 0) {
      // ③ draft 侧剩余 → 新建（D176：artifact 随项携带）
      layout.push({
        kind: 'new',
        text,
        status: wanted,
        note: d.note,
        ...(d.artifact ? { artifact: d.artifact } : {}),
        ...(newKeys.get(di) ? { key: newKeys.get(di) } : {}),
        ...(parentKeys.get(di) ? { parentKey: parentKeys.get(di) } : {}),
      })
      ops.push({ kind: 'create', text, to: wanted })
      continue
    }

    const cur = current[ci]!

    // I8 + 转换表保护：命中则状态保持原值
    let protectedHere = false
    if (isLedgerTerminal(cur.status) && !isLedgerTerminal(wanted)) {
      protectedHere = true
    } else if (cur.status !== wanted && !canLedgerTransition(cur.status, wanted)) {
      protectedHere = true
      warnings.push(`「${cur.text.slice(0, 20)}」当前为 ${cur.status}，不能直接转为 ${wanted}，已保持原状`)
    }

    const resident: LedgerItemStatus = protectedHere ? cur.status : wanted
    // D175：配对成功但文本不同 → 按 draft 更新文本（措辞微调是模型的合法意图，
    // 此前被 plan-commit 静默丢弃）。终态项同样允许改写文本 —— 状态受 I8 保护，
    // 文本只是「这件事的描述」，不承载历史真伪。
    const retextTo = clip(d.text) !== cur.text.trim() ? clip(d.text) : undefined
    layout.push({
      kind: 'existing',
      id: cur.id,
      status: resident,
      note: d.note,
      ...(retextTo !== undefined ? { text: retextTo } : {}),
      // D176：本条提交里给出了 artifact 才覆盖 —— 不给则保留既有声明，
      // 模型不必在每次全量提交里重复携带。
      ...(d.artifact ? { artifact: d.artifact } : {}),
      // D185：给了 parent 才改挂父；不给 = 保持既有层级（清单重建不应丢失结构）
      ...(parentKeys.get(di) ? { parentKey: parentKeys.get(di) } : {}),
    })
    if (protectedHere) protectedIds.push(cur.id)

    if (cur.status !== resident) {
      ops.push({ kind: 'status', itemId: cur.id, text: cur.text, from: cur.status, to: resident })
    }
    if (retextTo !== undefined) {
      ops.push({ kind: 'retext', itemId: cur.id, text: cur.text, from: cur.text, to: retextTo })
    }
    if (d.note && d.note !== cur.note) {
      ops.push({ kind: 'note', itemId: cur.id, text: cur.text, note: d.note })
    }
  }

  /* --- ③ current 侧剩余：终态保护，其余 drop --- */
  for (const ci of current.map((_, i) => i).filter((i) => !usedCurrent.has(i))) {
    const cur = current[ci]!
    if (isLedgerTerminal(cur.status)) {
      // 已完成的项不允许从清单里消失（否则用户会以为它没做过）
      layout.push({ kind: 'existing', id: cur.id, status: cur.status })
      protectedIds.push(cur.id)
      continue
    }
    ops.push({ kind: 'drop', itemId: cur.id, text: cur.text })
  }

  const changed = ops.length
  return {
    ops,
    layout,
    changed,
    protectedIds,
    warnings,
    summary: changed === 0 ? '' : buildSummary(ops),
  }
}

/* ---------------- 父项引用解析（D185；纯函数，导出以便穷举单测） ---------------- */

export type ParentTarget =
  | { kind: 'draft'; index: number }
  | { kind: 'current'; id: string }

/**
 * 把一个 `parent` 字符串引用解析到「本次提交的某一项」或「既有清单项」。
 * 匹配顺序：`#序号` → 既有 id → draft 文本 → current 文本。
 */
export function resolveParentTarget(
  ref: string,
  selfIndex: number,
  draft: readonly PlanDraftItem[],
  current: readonly LedgerItem[],
): ParentTarget | null {
  const r = ref.trim()
  if (!r) return null
  const byIndex = r.match(/^#\s*(\d{1,2})$/)
  if (byIndex) {
    const idx = Number(byIndex[1]) - 1
    if (idx >= 0 && idx < draft.length && idx !== selfIndex) return { kind: 'draft', index: idx }
  }
  const byId = current.find((c) => c.id === r)
  if (byId) return { kind: 'current', id: byId.id }
  // 精确同名：一个字也算"明确指认"（中文任务名常短到只剩一个字，如「甲」）。
  // 前缀 / 包含：至少两字才允许 —— 单字用「包含」去匹配极易误伤（"做"能命中一半项），
  // 宁可判为未命中（调用方会给出人话提示），也不要挂错父项这种静默错误。
  const exactDi = draft.findIndex((d, i) => i !== selfIndex && d.text === r)
  if (exactDi >= 0) return { kind: 'draft', index: exactDi }
  const exactCur = current.find((c) => c.text === r)
  if (exactCur) return { kind: 'current', id: exactCur.id }
  if (r.length >= 2) {
    const di = draft.findIndex((d, i) => i !== selfIndex && (d.text.startsWith(r) || d.text.includes(r)))
    if (di >= 0) return { kind: 'draft', index: di }
    const cj = current.find((c) => c.text.startsWith(r) || c.text.includes(r))
    if (cj) return { kind: 'current', id: cj.id }
  }
  return null
}

/** 人话摘要（供 UI / turn_note；不含内部术语） */
function buildSummary(ops: readonly PlanDiffOp[]): string {
  const created = ops.filter((o) => o.kind === 'create').length
  const done = ops.filter((o) => o.kind === 'status' && o.to === 'done')
  const moved = ops.filter((o) => o.kind === 'status' && o.to !== 'done').length
  const retexed = ops.filter((o) => o.kind === 'retext').length
  const dropped = ops.filter((o) => o.kind === 'drop').length
  const parts: string[] = []
  if (created > 0) parts.push(`新增 ${created} 项`)
  if (done.length > 0) parts.push(`完成：${done.map((o) => `「${o.text.slice(0, 24)}」`).join('、')}`)
  if (moved > 0) parts.push(`状态更新 ${moved} 项`)
  if (retexed > 0) parts.push(`更新描述 ${retexed} 项`)
  if (dropped > 0) parts.push(`移除 ${dropped} 项`)
  return parts.join('，')
}
