/* ============================================================
 * ArkWork — TurnFooter（v0.31.0 B3 层级骨架 · v0.32.0 i18n + 分列摘要）
 * 轮尾（唯一）：折叠态时是整轮的摘要行（点击展开），展开态时承载
 * ActivityLine（06 §2.1：唯一活动指示器共用容器）。
 *
 * v0.32.0：
 *  - 硬编码中文 → i18n（`flow.turn.*` / `flow.fold.*`）；
 *  - 折叠摘要的「N 次工具调用」升级为**分类计数**（读取 ×3 · 搜索 ×2），
 *    对齐 J9「每轮唯一摘要」+ 本版 D32-4「摘要必须有信息量」；
 *  - 移除原生 `title`（C-20）。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import { useStore } from '../../store'
import type { FlowTurn } from '@shared/types/flow'
import { TOOL_FOLD_I18N_KEY, toolRunParts } from '@shared/utils/flow-fold'
import { ActivityLine } from './ActivityLine'

interface TurnFooterProps {
  turn: FlowTurn
  showActivity: boolean
}

export function TurnFooter({ turn, showActivity }: TurnFooterProps) {
  const { t } = useTranslation()
  const setTurnCollapsed = useStore((s) => s.setTurnCollapsed)

  if (turn.collapsed) {
    // 分类计数（读/写/搜/执行…），全空时退化总数
    const parts = toolRunParts(turn.summary.toolCounts)
    const detail =
      parts.length > 0
        ? parts.map((p) => t(TOOL_FOLD_I18N_KEY[p.kind], { n: p.count })).join(t('flow.fold.sep'))
        : ''
    const primary = turn.header.errorMessage || detail || t('flow.turn.toolsCount', { n: turn.summary.toolTotal })

    // 折叠态：整轮摘要行（点击展开）
    return (
      <button
        className="group flex items-center gap-2 w-full text-left select-none cursor-pointer py-0.5"
        onClick={() => setTurnCollapsed(turn.id, false)}
        aria-label={t('flow.turn.expand')}
      >
        <span className="text-2xs font-medium text-text-tertiary">#{turn.header.index}</span>
        <span className="text-2xs text-text-tertiary truncate">{primary}</span>
        {turn.summary.thinkingMs > 0 && (
          <span className="text-2xs text-text-faint shrink-0">
            {t('thought.summary.thoughtTime', { time: Math.round(turn.summary.thinkingMs / 100) / 10 })}
          </span>
        )}
        {turn.summary.toolTotal > 0 && detail && (
          <span className="text-2xs text-text-faint shrink-0">
            {t('flow.turn.toolsCount', { n: turn.summary.toolTotal })}
          </span>
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
        <span className="text-2xs text-text-faint shrink-0">{t('flow.turn.expand')}</span>
      </button>
    )
  }

  // 展开态：轮尾 = ActivityLine 容器（仅运行中的最后一轮显示）
  if (!showActivity) return null
  return <ActivityLine turn={turn} />
}
