/* ============================================================
 * ArkWork — StepView（v0.31.0 C1 · v0.32.0 进程折叠）
 * 单步：StateRail 轨段（唯一竖线 + 节点）+ 渲染段序列。
 *
 * v0.31.0 C1：删除步级淡显摘要行 —— reason 步的 summary 是思考首句、
 * act 步的 summary 是工具 intent，两者都已在块头出现，整行属于重复展示。
 *
 * v0.32.0：块序列不再平铺，改走 `segmentFlow()`（纯函数，04 §1.3）：
 *   主展示块（user / say / answer / plan / approval / notice / error）原样渲染；
 *   连续的同类进程块（reasoning / tool）收成一个 `<ProcessFold>` 折叠条。
 * **保序**：折叠条出现在它原本所占据的时间位置上，块之间相对顺序不变。
 *
 * 状态轨口径（03 §2.4）：失败含被折叠的进程块（折叠不能藏掉异常）；
 * 运行中含进程块（工具跑动时轨道应保持活动色）。
 * ============================================================ */
import { useMemo } from 'react'
import type { FlowBlock, FlowTurn } from '@shared/types/flow'
import { runHasFailure, runHasRunning, segmentFlow } from '@shared/utils/flow-fold'
import { StateRail } from './StateRail'
import { BlockRenderer } from './BlockRenderer'
import { ProcessFold } from './ProcessFold'

interface StepViewProps {
  turn: FlowTurn
  blocks: FlowBlock[]
}

export function StepView({ blocks }: StepViewProps) {
  const segments = useMemo(() => segmentFlow(blocks), [blocks])

  // 步状态 = 块内最"重"的状态（running > failed > settled）
  const hasRunning = runHasRunning(blocks)
  const hasFailed = runHasFailure(blocks) || blocks.some((b) => b.kind === 'error')

  return (
    <div className="flex gap-2.5">
      <StateRail status={hasRunning ? 'running' : hasFailed ? 'failed' : 'settled'} />
      <div className="flex-1 min-w-0 space-y-1.5">
        {segments.map((seg) =>
          seg.type === 'fold' ? (
            <ProcessFold key={seg.key} run={seg.run} />
          ) : (
            <BlockRenderer key={seg.key} block={seg.block} />
          ),
        )}
      </div>
    </div>
  )
}
