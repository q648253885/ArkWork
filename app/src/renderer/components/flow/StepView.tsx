/* ============================================================
 * ArkWork — StepView（v0.31.0 C1）
 * 单步：StateRail 轨段（唯一竖线 + 节点）+ 步块序列。
 * 步块（reasoning / say / tool）来自投影层已拍平的 FlowBlock[]。
 * v0.31.0 C1：删除步级淡显摘要行 —— reason 步的 summary 是思考首句、
 * act 步的 summary 是工具 intent，两者都已在下方块头（「思考」标签 /
 * 工具卡标题）出现，整行属于重复展示（Trae Work 无此行）。
 * ============================================================ */
import type { FlowBlock, FlowTurn } from '@shared/types/flow'
import { StateRail } from './StateRail'
import { BlockRenderer } from './BlockRenderer'

interface StepViewProps {
  turn: FlowTurn
  blocks: FlowBlock[]
}

export function StepView({ blocks }: StepViewProps) {
  // 步状态 = 块内最"重"的状态（running > failed > settled）
  const hasRunning = blocks.some(
    (b) => (b.kind === 'tool' || b.kind === 'reasoning') && b.status === 'running',
  )
  const hasFailed = blocks.some((b) => b.kind === 'tool' && b.status === 'failed')

  return (
    <div className="flex gap-2.5">
      <StateRail status={hasRunning ? 'running' : hasFailed ? 'failed' : 'settled'} />
      <div className="flex-1 min-w-0 space-y-1.5">
        {blocks.map((b) => (
          <BlockRenderer key={b.id} block={b} />
        ))}
      </div>
    </div>
  )
}
