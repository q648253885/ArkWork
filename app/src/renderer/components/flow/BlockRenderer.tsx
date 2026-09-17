/* ============================================================
 * ArkWork — BlockRenderer（v0.31.0 B4）
 * 判别联合分发（唯一 kind switch，正本 07 §三）。
 * B4：各分支替换为 blocks/*.tsx 独立组件（9 个）；
 * 工具卡内部的 card 分发在 tools/ 注册表（唯一 card switch）。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'
import { UserBlock, SayBlock, ReasoningBlock, AnswerBlock, ToolBlock, PlanBlock, ApprovalBlock, NoticeBlock, ErrorBlock } from './blocks'

export function BlockRenderer({ block }: { block: FlowBlock }) {
  switch (block.kind) {
    case 'user':
      return <UserBlock block={block} />
    case 'say':
      return <SayBlock block={block} />
    case 'reasoning':
      return <ReasoningBlock block={block} />
    case 'answer':
      return <AnswerBlock block={block} />
    case 'tool':
      return <ToolBlock block={block} />
    case 'plan':
      return <PlanBlock block={block} />
    case 'approval':
      return <ApprovalBlock block={block} />
    case 'notice':
      return <NoticeBlock block={block} />
    case 'error':
      return <ErrorBlock block={block} />
  }
}
