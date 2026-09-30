/**
 * ArkWork — 「本轮任务 / 全部任务」分区判据（v0.43.0 · R4）
 *
 * 依据：docs/versions/v0.43.0/03-interaction.md §四 / 04-system-design.md §二
 *
 * 为什么需要单独的纯函数（而不是在 TaskPanel 里直接 `planItem.round`）：
 *
 *  1. **轮次的唯一真相源是账本**（`ledger.json` 的 `file.round` / `item.round`），
 *     而不是 `Task.planItems` —— v0.37.0 起 `planItems` 降级为**派生镜像**，
 *     其来源 `graph/store.ts:mirrorPlanItems()` 由图节点生成，**不带 round**
 *     （图节点没有该字段），于是 `p.round ?? 1` 恒为 1 → 所有行都被判成「本轮」。
 *  2. **`行 id ↔ 账本项 id` 不是稳定不变量**：`plan-sync.ts:reconcileLocked()`
 *     的结构对账会「剩余项按序对位」并**保留节点原 id**，因此在账本重排（replan）
 *     之后，图节点 id 与账本项 id 会断链 —— 对位必须回落到既有兜底口径
 *     `key = T-{index+1}`（与 `applyPlanItemStatusesRobust` 同一约定）：图里
 *     `key` 由对账按账本顺序重排，故 `T-NN → 账本第 NN 项` 恒成立。
 *
 * 判据优先级：**id 直查 → key 序号 → 归为历史（null）**。
 * 第三档（无法归属）**不进「本轮任务」**，只在「全部任务」里出现 ——
 * 这正是用户诉求「下一轮时，以前的任务应该在全部中，不应该在本轮任务中」
 * 在「图镜像滞后于账本」时的正确落点。
 */

/** 行的最小投影：图节点 id + 面板 key（`T-NN`） */
export interface RoundRowRef {
  id: string
  key?: string
}

/** 轮次来源项的最小投影（账本快照项 / planItems 均可满足） */
export interface RoundSourceItem {
  id: string
  round?: number
}

/** `T-{index+1}` 零填充定宽（与 plan-sync 的对账 key 同口径） */
const KEY_RE = /^T-(\d+)$/

export interface RoundIndex {
  /** 当前任务轮次（账本 `file.round`；无账本时退化为来源项最大轮次，至少 1） */
  current: number
  /**
   * 行所属轮次。
   *  - 命中 → 该行的轮次（`item.round`，缺省归一 1）
   *  - 未命中 → `null`（历史行：只进「全部任务」）
   */
  roundOf(row: RoundRowRef): number | null
}

export function buildRoundIndex(args: {
  /** 账本快照（唯一真相源）；未拉到 / 任务无账本时为 undefined */
  ledger?: { round?: number; items?: readonly RoundSourceItem[] } | null
  /** 派生镜像清单（仅作无账本时的兜底来源） */
  planItems?: readonly RoundSourceItem[]
}): RoundIndex {
  const ledgerItems = args.ledger?.items ?? []
  const source: readonly RoundSourceItem[] | null =
    ledgerItems.length > 0 ? ledgerItems : (args.planItems?.length ?? 0) > 0 ? args.planItems! : null

  // 无任何轮次来源（账本未就绪 / 空账本）：保持宽松旧行为 —— 全部行都算本轮，
  // 避免首帧闪出空列表；有账本之后立刻按真实轮次收敛。
  if (!source) {
    const current = args.ledger?.round ?? 1
    return { current, roundOf: () => current }
  }

  const byId = new Map<string, number>()
  for (const it of source) byId.set(it.id, it.round ?? 1)

  let maxRound = 1
  for (const r of byId.values()) if (r > maxRound) maxRound = r
  const current = args.ledger?.round ?? maxRound

  // key 序号兜底只在「来源是账本」时启用：账本项顺序即 key 顺序（对账按账本顺序重排 key）；
  // planItems 兜底来源的顺序契约不成立，故只在 id 命中时判定。
  const keyFallback = ledgerItems.length > 0

  return {
    current,
    roundOf(row) {
      const hit = byId.get(row.id)
      if (hit !== undefined) return hit
      if (!keyFallback || !row.key) return null
      const m = KEY_RE.exec(row.key)
      if (!m) return null
      const idx = Number(m[1]) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= source.length) return null
      return source[idx]?.round ?? 1
    },
  }
}