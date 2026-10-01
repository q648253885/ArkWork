/* ============================================================
 * ArkWork — SayBlock（v0.31.0 B4）
 * 模型显式产出的「结论 + 下一步」。文本容器 select-text（TC-COPY-001
 * 转写载体：整块禁选已在 v0.30.1 根除，不得回退）。
 * v0.31.0 D21（层次）：与 AnswerBlock 同为「主内容」层，字号 base(14px)。
 * v0.41.0（D210 P4-1 · 对齐 ZCode）：过程叙述**降调** —— 非末个 say 用
 * 小字次级文本（text-sm/text-secondary），不再与答复同级抢占主视线；
 * 每轮**最后一个** say（isSummarySource，投影层后置 pass 标记）保持
 * 主内容层级，作为该轮的阶段结论行。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'
import { LinkifiedText } from '../LinkifiedText'

export function SayBlock({ block }: { block: Extract<FlowBlock, { kind: 'say' }> }) {
  if (block.isSummarySource) {
    return (
      <div className="text-base text-text-primary leading-relaxed select-text whitespace-pre-wrap">
        {/* v0.44.0（R-C）：路径链接化（分段渲染无损，无路径时等同直出） */}
        <LinkifiedText text={block.text} />
      </div>
    )
  }
  return (
    <div className="text-sm text-text-secondary leading-relaxed select-text whitespace-pre-wrap">
      <LinkifiedText text={block.text} />
    </div>
  )
}
