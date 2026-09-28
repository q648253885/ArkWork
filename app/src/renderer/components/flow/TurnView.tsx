/* ============================================================
 * ArkWork — TurnView（v0.31.0 B3 层级骨架 · v0.36.1 过程组）
 * 单轮渲染：TurnHeader + 渲染序列（turnRenderSequence 唯一合并规则）
 * + TurnFooter。
 *
 * v0.36.1 过程组（TraeWork 展示逻辑）：整轮 `turnRenderSequence` 后直接
 * `segmentFlow()` 一体化分段 —— 连续进程块（思考 + 工具混排、**跨 step**）
 * 收成一个 `<ProcessFold>` 过程组（StateRail 视觉锚点保留），主展示块
 * （user / say / answer / plan / notice / error…）原样高亮渲染，天然是
 * 分隔符。v0.31.0 的「按 step 分组 + StepView」退役（相关联的思考与工具
 * 调用不再被迭代边界与 kind 边界切成一长串折叠行）。
 * 折叠态 = turn.collapsed（投影层已并入 flow.turnUiState）。
 * ============================================================ */
import { useMemo } from 'react'
import { turnRenderSequence } from '../../flow/project'
import { runHasFailure, runHasRunning, segmentFlow } from '@shared/utils/flow-fold'
import type { FlowTurn } from '@shared/types/flow'
import { TurnHeader } from './TurnHeader'
import { TurnFooter } from './TurnFooter'
import { StateRail } from './StateRail'
import { BlockRenderer } from './BlockRenderer'
import { ProcessFold } from './ProcessFold'

interface TurnViewProps {
  turn: FlowTurn
  isLast: boolean
  /** 仅最后一轮 + 任务运行中为 true（ActivityLine 唯一活动指示器） */
  showActivity: boolean
}

export function TurnView({ turn, isLast, showActivity }: TurnViewProps) {
  // 整轮渲染序列（outerBlocks + steps 按 ts 归并）→ 一体化分段（过程组 / 主块交替）
  const segments = useMemo(() => segmentFlow(turnRenderSequence(turn)), [turn])

  if (turn.collapsed) {
    return <TurnFooter turn={turn} showActivity={showActivity} />
  }

  return (
    <div className="space-y-2">
      <TurnHeader turn={turn} />
      {segments.map((seg) =>
        seg.type === 'fold' ? (
          <div key={seg.key} className="flex gap-2.5">
            <StateRail
              status={seg.run.hasRunning ? 'running' : seg.run.hasFailure ? 'failed' : 'settled'}
            />
            <div className="flex-1 min-w-0">
              <ProcessFold run={seg.run} />
            </div>
          </div>
        ) : (
          <BlockRenderer key={seg.key} block={seg.block} />
        ),
      )}
      {isLast && <TurnFooter turn={turn} showActivity={showActivity} />}
    </div>
  )
}
