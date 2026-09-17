/* ============================================================
 * ArkWork — TurnView（v0.31.0 B3 层级骨架）
 * 单轮渲染：TurnHeader + 渲染序列（turnRenderSequence 唯一合并规则）
 * + TurnFooter。连续同 step 的块收进 StepView（StateRail 轨段），
 * step=0 的 outerBlock（user / plan / answer / notice / error）独立渲染。
 * 折叠态 = turn.collapsed（投影层已并入 flow.turnUiState）。
 * ============================================================ */
import { useMemo } from 'react'
import { turnRenderSequence } from '../../flow/project'
import type { FlowBlock, FlowTurn } from '@shared/types/flow'
import { TurnHeader } from './TurnHeader'
import { TurnFooter } from './TurnFooter'
import { StepView } from './StepView'
import { BlockRenderer } from './BlockRenderer'

interface TurnViewProps {
  turn: FlowTurn
  isLast: boolean
  /** 仅最后一轮 + 任务运行中为 true（ActivityLine 唯一活动指示器） */
  showActivity: boolean
}

export function TurnView({ turn, isLast, showActivity }: TurnViewProps) {
  // 连续同 step 的块 → 一步一组；step=0 的 outerBlock 自成一组
  const groups = useMemo(() => {
    const seq = turnRenderSequence(turn)
    const out: Array<{ step: number; blocks: FlowBlock[] }> = []
    for (const b of seq) {
      const last = out[out.length - 1]
      if (b.step > 0 && last && last.step === b.step) {
        last.blocks.push(b)
      } else {
        out.push({ step: b.step, blocks: [b] })
      }
    }
    return out
  }, [turn])

  if (turn.collapsed) {
    return <TurnFooter turn={turn} showActivity={showActivity} />
  }

  return (
    <div className="space-y-2">
      <TurnHeader turn={turn} />
      {groups.map((g, i) =>
        g.step > 0 ? (
          <StepView key={`${turn.id}-s${g.step}-${i}`} turn={turn} blocks={g.blocks} />
        ) : (
          <div key={`${turn.id}-o${i}`}>
            {g.blocks.map((b) => (
              <BlockRenderer key={b.id} block={b} />
            ))}
          </div>
        ),
      )}
      {isLast && <TurnFooter turn={turn} showActivity={showActivity} />}
    </div>
  )
}
