/* ============================================================
 * ArkWork — TurnHeader（v0.31.0 B3 层级骨架）
 * 轮头：#N / @agent / 起始时间 / 状态 / 计量（工具数 · token）。
 * 点击折叠整轮（投影层 turn.collapsed ← flow.turnUiState）。
 * 溢出菜单（导出/跳转）归 B4/B6。
 * ============================================================ */
import { useStore } from '../../store'
import type { FlowTurn } from '@shared/types/flow'

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  paused: '已暂停',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--business-primary)',
  done: 'var(--success)',
  failed: 'var(--danger)',
  paused: 'var(--warning, #e6a23c)',
  cancelled: 'var(--text-faint)',
}

const fmtTime = (ts: number) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function TurnHeader({ turn }: { turn: FlowTurn }) {
  const setTurnCollapsed = useStore((s) => s.setTurnCollapsed)
  const h = turn.header

  const metrics: string[] = []
  if (turn.summary.toolTotal > 0) metrics.push(`${turn.summary.toolTotal} 次工具`)
  if (turn.summary.metrics.tokensOut > 0) {
    metrics.push(`↑${fmtTokens(turn.summary.metrics.tokensIn)} ↓${fmtTokens(turn.summary.metrics.tokensOut)}`)
  }

  return (
    <button
      className="group flex items-center gap-2 w-full text-left select-none cursor-pointer"
      onClick={() => setTurnCollapsed(turn.id, true)}
      title="点击折叠本轮"
    >
      <span className="text-2xs font-medium text-text-tertiary">#{h.index}</span>
      {h.agentName && <span className="text-2xs text-text-tertiary">@{h.agentName}</span>}
      <span className="text-2xs text-text-faint">{fmtTime(h.startedAt)}</span>
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ background: STATUS_COLOR[h.status] ?? 'var(--text-faint)' }}
      />
      <span className="text-2xs text-text-tertiary">{STATUS_LABEL[h.status] ?? h.status}</span>
      {metrics.length > 0 && <span className="text-2xs text-text-faint">{metrics.join(' · ')}</span>}
      <span className="flex-1" />
      <span className="opacity-0 group-hover:opacity-100 transition-opacity text-2xs text-text-faint">
        收起
      </span>
    </button>
  )
}
