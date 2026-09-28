/* ============================================================
 * ArkWork — PlanBlock（v0.31.0 B4）
 * 计划卡（outerBlocks，iteration 0）。锚点 id `plan-step-{i+1}` 供
 * react:scroll-to-plan-step 滚动（TurnList 契约）。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'
import type { PlanItemStatus } from '@shared/types/task'
// v0.41.0（D209）：子任务层级缩进 + 复合编号（纯函数层共用，与 TodoPanel 同源）
import { planItemNumbering, type PlanItemHierarchy } from '../../../utils/plan-status'

type PlanBlockT = Extract<FlowBlock, { kind: 'plan' }>

/** v0.37.0：七态（新增 paused = 中断保留，用 ❙❙ 与 cancelled 的 ✕ 明确区分） */
const STATE_MARK: Record<PlanItemStatus, { text: string; cls: string }> = {
  done: { text: '✓', cls: 'text-success' },
  running: { text: '●', cls: 'text-business-primary animate-pulse' },
  paused: { text: '❙❙', cls: 'text-warning' },
  failed: { text: '✗', cls: 'text-danger' },
  pending: { text: '○', cls: 'text-text-faint' },
  cancelled: { text: '✕', cls: 'text-text-faint' },
  skipped: { text: '—', cls: 'text-text-faint' },
}

export function PlanBlock({ block }: { block: PlanBlockT }) {
  const done = block.states.filter((s) => s === 'done').length
  // v0.41.0（D209）：父引用齐全才建树（长度与 items 对齐）；旧数据平铺
  const hasHierarchy =
    !!block.parentIds && block.parentIds.length === block.items.length
  const numbering = hasHierarchy
    ? planItemNumbering(block.items.map((_, i) => ({ id: `i${i}`, parentId: block.parentIds![i] ?? null } as PlanItemHierarchy)))
    : null
  return (
    <div className="rounded-lg border border-border-default px-3 py-2 select-text">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium text-text-primary truncate">{block.goal}</div>
        <span className="flex-1" />
        {block.aggregate && (
          <span className={`text-2xs select-none ${STATE_MARK[block.aggregate].cls}`}>
            {STATE_MARK[block.aggregate].text}
          </span>
        )}
        <span className="text-2xs text-text-tertiary shrink-0 select-none">
          {block.items.length > 0 ? `${done}/${block.items.length}` : ''}
        </span>
      </div>
      {block.items.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {block.items.map((item, i) => {
            const st = block.states[i] ?? 'pending'
            const depth = hasHierarchy
              ? (block.parentIds![i] ? 1 : 0)
              : 0
            return (
              <div
                key={`${i}:${item}`}
                id={`plan-step-${i + 1}`}
                className="flex items-start gap-1.5 text-xs"
                style={depth > 0 ? { paddingLeft: 16 * depth } : undefined}
              >
                <span className={`shrink-0 ${STATE_MARK[st].cls} select-none`}>{STATE_MARK[st].text}</span>
                <span className="text-text-secondary leading-5 select-text">
                  {numbering && <span className="text-text-faint select-none tabular mr-1">{numbering[i]}</span>}
                  {item}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
