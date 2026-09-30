/* ============================================================
 * ArkWork — AnswerBlock（v0.31.0 B4 / v0.37.0 层次化）
 * 最终答复（唯一来源 = assistant ConversationItem，§11 L23）。
 * K1 裁决（doc §8 L2）：流式不解析、落定再解析 ——
 *   streaming 期 <pre> 原样（防裸 <<<SAY>>> 残帧被当 markdown 渲染），
 *   落定后转 <Markdown>。
 * v0.31.0 D21（层次）：主内容 = 交互区最高权重，字号升到 base(14px)。
 *   旧值 sm(13px) 与思考正文(13px)同级 → 主内容被过程信息淹没，层次倒置。
 *
 * ★ v0.37.0（PRD F9 / 设计文档 §6.1）：**输出层次**。
 *   此前最终答复原样丢进 Markdown → 「做完了没有」和十行过程细节摊平在一层，
 *   用户得自己挑。现在落定后先解析四段（结论 / 变更 / 验证 / 下一步），
 *   按**可判断性**决定默认可见性：
 *     · 结论 / 变更 / 下一步 → 默认展开（用户据此做判断）
 *     · 验证结果 → 折叠摘要 + 可展开（命令输出很长，会把结论挤出屏幕）
 *     · 缺段 → 显式占位说明（**不静默**，沿用"失败不静默"纪律）
 *   识别不到 ≥2 段时回退为整段 Markdown —— 不把正常行文切碎。
 * ============================================================ */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FlowBlock } from '@shared/types/flow'
import {
  ANSWER_LAYER_SPECS,
  parseAnswerLayers,
  shouldRenderLayered,
  type AnswerLayer,
  type AnswerLayerId,
} from '@shared/utils/answer-layers'
import { Markdown } from '../../Markdown'
import { Icon } from '../../../icons'

type AnswerBlockT = Extract<FlowBlock, { kind: 'answer' }>

/** 段标题的 i18n 键（缺段占位同理） */
const TITLE_KEY: Record<AnswerLayerId, string> = {
  conclusion: 'answerLayer.conclusion',
  changes: 'answerLayer.changes',
  verification: 'answerLayer.verification',
  next: 'answerLayer.next',
}
const MISSING_KEY: Record<AnswerLayerId, string> = {
  conclusion: 'answerLayer.missingConclusion',
  changes: 'answerLayer.missingChanges',
  verification: 'answerLayer.missingVerification',
  next: 'answerLayer.missingNext',
}

/** 折叠态的验证摘要行数（默认只露前 3 行：足够判断"跑没跑"，不挤掉结论） */
const COLLAPSED_LINES = 3

export function AnswerBlock({ block }: { block: AnswerBlockT }) {
  const { t } = useTranslation()
  const [verificationOpen, setVerificationOpen] = useState(false)

  // v0.41.0（D210 P4-4 · 对齐 ZCode）：最终答复**轻量强调容器** —— 让长轮次里
  // 「最终答复」有唯一的强终点。v0.42.0（用户反馈「蓝色背景有点奇怪」）：去掉
  // 浅蓝铺底，强调信号降调为**左侧 2px 主色边线**（线 ≠ 面，配色纪律：浅色
  // 铺底不进交互区正文）。流式/未分层/分层三种形态统一包裹；不改内部
  // Markdown / 分层逻辑，不新增文案。
  const shell = 'rounded-r-md border-l-2 border-l-accent pl-2.5 py-0.5'

  // 流式期不解析（防残帧）
  if (block.streaming) {
    return (
      <div className={`text-base text-text-primary leading-relaxed select-text ${shell}`}>
        <pre className="whitespace-pre-wrap font-sans m-0">{block.text}</pre>
      </div>
    )
  }

  const parsed = parseAnswerLayers(block.text)

  // 未成形（识别 < 2 段）→ 保持原样渲染，不做任何切分
  if (!shouldRenderLayered(parsed)) {
    return (
      <div className={`text-base text-text-primary leading-relaxed select-text ${shell}`}>
        <Markdown content={block.text} />
      </div>
    )
  }

  const byId = new Map<AnswerLayerId, AnswerLayer>(parsed.layers.map((l) => [l.id, l]))

  return (
    <div
      className={`text-base text-text-primary leading-relaxed select-text ${shell}`}
      data-testid="answer-layered"
    >
      {parsed.prefix && (
        <div className="mb-2">
          <Markdown content={parsed.prefix} />
        </div>
      )}
      <div className="space-y-2">
        {ANSWER_LAYER_SPECS.map((spec) => {
          const layer = byId.get(spec.id)
          const title = t(TITLE_KEY[spec.id])
          const body = layer?.body ?? ''
          const isVerification = spec.id === 'verification'
          const lines = body.split('\n')
          const collapsible = isVerification && !verificationOpen && lines.length > COLLAPSED_LINES
          const shown = collapsible ? lines.slice(0, COLLAPSED_LINES).join('\n') : body

          return (
            <section
              key={spec.id}
              data-testid={`answer-layer-${spec.id}`}
              data-present={layer ? '1' : '0'}
              className="rounded-md border border-border-subtle bg-bg-surface-2 px-2.5 py-1.5"
            >
              <div className="mb-1 flex items-center gap-1.5">
                {/* F1-4 反向约束（TC-COPY-001）：AnswerBlock 整文件不得出现 `select-none`
                    —— 段标题也属于可复制正文的一部分，用颜色/字重降权，而不是禁止选中。 */}
                <span className="text-2xs font-semibold tracking-wide text-text-secondary">
                  {title}
                </span>
                {isVerification && body && lines.length > COLLAPSED_LINES && (
                  <button
                    type="button"
                    data-testid="answer-layer-verification-toggle"
                    onClick={() => setVerificationOpen((v) => !v)}
                    className="inline-flex items-center gap-0.5 rounded-sm px-1 text-2xs text-text-tertiary hover:text-text-primary"
                  >
                    {verificationOpen ? (
                      <Icon.ChevronDown width={10} height={10} />
                    ) : (
                      <Icon.ChevronRight width={10} height={10} />
                    )}
                    {verificationOpen ? t('answerLayer.collapse') : t('answerLayer.expand')}
                  </button>
                )}
              </div>
              {layer ? (
                <div className="text-sm text-text-primary">
                  <Markdown content={shown} />
                </div>
              ) : (
                // 缺段：显式说明，不静默（用弱化色，不抢结论的注意力）
                <div
                  data-testid={`answer-layer-missing-${spec.id}`}
                  className="text-xs text-text-faint italic"
                >
                  {t(MISSING_KEY[spec.id])}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
