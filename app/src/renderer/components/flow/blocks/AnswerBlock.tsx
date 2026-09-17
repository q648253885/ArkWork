/* ============================================================
 * ArkWork — AnswerBlock（v0.31.0 B4）
 * 最终答复（唯一来源 = assistant ConversationItem，§11 L23）。
 * K1 裁决（doc §8 L2）：流式不解析、落定再解析 ——
 *   streaming 期 <pre> 原样（防裸 <<<SAY>>> 残帧被当 markdown 渲染），
 *   落定后转 <Markdown>。
 * v0.31.0 D21（层次）：主内容 = 交互区最高权重，字号升到 base(14px)。
 *   旧值 sm(13px) 与思考正文(13px)同级 → 主内容被过程信息淹没，层次倒置。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'
import { Markdown } from '../../Markdown'

export function AnswerBlock({ block }: { block: Extract<FlowBlock, { kind: 'answer' }> }) {
  return (
    <div className="text-base text-text-primary leading-relaxed select-text">
      {block.streaming ? (
        <pre className="whitespace-pre-wrap font-sans m-0">{block.text}</pre>
      ) : (
        <Markdown content={block.text} />
      )}
    </div>
  )
}
