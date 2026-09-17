/* ============================================================
 * ArkWork — TurnFooter（v0.31.0 B3 层级骨架）
 * 轮尾（唯一）：折叠态时是整轮的摘要行（点击展开），展开态时承载
 * ActivityLine（06 §2.1：唯一活动指示器共用容器）。
 * ============================================================ */
import { useStore } from '../../store'
import type { FlowTurn } from '@shared/types/flow'
import { ActivityLine } from './ActivityLine'

interface TurnFooterProps {
  turn: FlowTurn
  showActivity: boolean
}

export function TurnFooter({ turn, showActivity }: TurnFooterProps) {
  const setTurnCollapsed = useStore((s) => s.setTurnCollapsed)

  if (turn.collapsed) {
    // 折叠态：整轮摘要行（点击展开）
    return (
      <button
        className="flex items-center gap-2 w-full text-left select-none cursor-pointer py-0.5"
        onClick={() => setTurnCollapsed(turn.id, false)}
        title="点击展开本轮"
      >
        <span className="text-2xs font-medium text-text-tertiary">#{turn.header.index}</span>
        <span className="text-2xs text-text-tertiary truncate">
          {turn.header.errorMessage || `${turn.summary.toolTotal} 次工具调用`}
        </span>
        {turn.summary.toolTotal > 0 && (
          <span className="text-2xs text-text-faint shrink-0">{turn.summary.toolTotal} 次工具</span>
        )}
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background:
              turn.header.status === 'running'
                ? 'var(--business-primary)'
                : turn.header.status === 'failed'
                  ? 'var(--danger)'
                  : 'var(--success)',
          }}
        />
        <span className="text-2xs text-text-faint shrink-0">展开</span>
      </button>
    )
  }

  // 展开态：轮尾 = ActivityLine 容器（仅运行中的最后一轮显示）
  if (!showActivity) return null
  return <ActivityLine turn={turn} />
}
