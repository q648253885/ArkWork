/* ============================================================
 * ArkWork — StateRail（v0.31.0 B3 层级骨架）
 * 状态轨（03 §四 I13）：唯一竖线 + 步节点。B3 用纯 CSS 实现，
 * 节点颜色由步状态决定；B4 接 HoverCard / 计量徽标。
 * ============================================================ */
export type RailStatus = 'running' | 'failed' | 'settled'

const COLOR: Record<RailStatus, string> = {
  running: 'var(--business-primary)',
  failed: 'var(--danger)',
  settled: 'var(--border-strong, var(--text-faint))',
}

export function StateRail({ status }: { status: RailStatus }) {
  return (
    <div className="relative w-2 shrink-0 select-none" aria-hidden>
      {/* 竖线：贯通步高 */}
      <div
        className="absolute left-1/2 top-1 bottom-1 w-px -translate-x-1/2"
        style={{ background: 'var(--border-default, var(--text-faint))', opacity: 0.5 }}
      />
      {/* 节点：步状态点 */}
      <div
        className="absolute left-1/2 top-1.5 w-1.5 h-1.5 rounded-full -translate-x-1/2"
        style={{ background: COLOR[status] }}
      />
    </div>
  )
}
