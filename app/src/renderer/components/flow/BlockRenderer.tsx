/* ============================================================
 * ArkWork — BlockRenderer（v0.31.0 B4）
 * 判别联合分发（唯一 kind switch，正本 07 §三）。
 * B4：各分支替换为 blocks/*.tsx 独立组件（9 个）；
 * 工具卡内部的 card 分发在 tools/ 注册表（唯一 card switch）。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'
import { UserBlock, SayBlock, ReasoningBlock, AnswerBlock, ToolBlock, PlanBlock, ApprovalBlock, NoticeBlock, ErrorBlock, SubagentGroupCard, NoteBlock, TaskArtifactCard } from './blocks'

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
    // v0.36.0（F4.1）：并行子 agent 组卡（第十个块；live-only 数据源）
    case 'subagent-group':
      return <SubagentGroupCard block={block} />
    // v0.38.0（D156）：阶段结论（第十一个块）—— 让"思考了几轮得出的结论"
    // 在交互区可见，而不是等最终答复一次性出现。
    case 'note':
      return <NoteBlock block={block} />
    // v0.44.0（R-B）：产物卡（第十二个块）—— 成果产物一等公民，
    // 点击打开预览，不再是答复正文里的一段纯文本。
    case 'artifact':
      return <TaskArtifactCard block={block} />
  }
}
