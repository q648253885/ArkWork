/* ============================================================
 * ArkWork — ActivityLine（v0.31.0 B3 层级骨架）
 * 唯一活动指示器（06 §二 L1）：运行中轮尾的「正在做什么」行。
 * 迁移 ConversationFlow :289-325 语义：主行（描述 + shimmer）
 * + 副行（最近 2 步动作流）。流式思考预览已上移进投影层（streaming
 * ReasoningBlock），主行仅在其不存在时显示，避免双份进度感。
 * ============================================================ */
import { useTranslation } from 'react-i18next'
import type { FlowTurn, ToolBlock } from '@shared/types/flow'

export function ActivityLine({ turn }: { turn: FlowTurn }) {
  const { t } = useTranslation()

  // 工具步序列（步骤内最近工具优先）
  const toolBlocks = turn.steps.flatMap((s) => s.blocks).filter((b): b is ToolBlock => b.kind === 'tool')
  const last = toolBlocks[toolBlocks.length - 1]

  const mainText = last ? (last.intent || last.call.title) : t('conversationflow.executing')

  return (
    <div className="fade-in-up space-y-1 select-none" aria-live="polite">
      {/* 主活动行：shimmer 渐变文本 */}
      <div className="flex items-center gap-2 text-sm font-medium turn-status" style={{ lineHeight: '26px' }}>
        <span className="turn-status__text">{mainText.slice(0, 80)}</span>
        <span className="turn-status__clock" />
      </div>
      {/* 副活动行：最近 2 个工具步的简短动作流 */}
      {toolBlocks.length > 0 && (
        <div className="flex items-center gap-1.5 text-2xs text-text-tertiary">
          {toolBlocks.slice(-2).map((b, i, arr) => {
            // D21：已落定的步骤是常态，统一中性点；只有 running / failed 上语义色
            const color =
              b.status === 'running'
                ? 'var(--business-primary)'
                : b.status === 'failed'
                  ? 'var(--danger)'
                  : 'var(--text-faint)'
            return (
              <span key={b.id} className="inline-flex items-center gap-1">
                <span className="inline-block w-1 h-1 rounded-full" style={{ background: color }} />
                <span>{(b.intent || b.call.title).slice(0, 24)}</span>
                {i === arr.length - 1 && arr.length > 1 && <span className="text-text-tertiary">·</span>}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
