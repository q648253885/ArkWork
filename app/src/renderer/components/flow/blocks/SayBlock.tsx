/* ============================================================
 * ArkWork — SayBlock（v0.31.0 B4）
 * 模型显式产出的「结论 + 下一步」。文本容器 select-text（TC-COPY-001
 * 转写载体：整块禁选已在 v0.30.1 根除，不得回退）。
 * v0.31.0 D21（层次）：与 AnswerBlock 同为「主内容」层，字号 base(14px)。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'

export function SayBlock({ block }: { block: Extract<FlowBlock, { kind: 'say' }> }) {
  return (
    <div className="text-base text-text-primary leading-relaxed select-text whitespace-pre-wrap">
      {block.text}
    </div>
  )
}
