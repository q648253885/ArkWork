/* ============================================================
 * ArkWork — NoticeBlock（v0.31.0 B4）
 * 中性通告（软失败 / 上下文压缩 / 重试等）。warning 级用琥珀中性色，
 * **非红色报错**（v0.18 softFail 契约延续）。
 * v0.31.0 D21：warning 不再整块染琥珀（旧 --warning-bg 未定义 + Tailwind
 * 无法对纯 var() 施加透明度 → 双重空转）。提示强度改由左侧 2px 琥珀条承载，
 * 正文统一中性——通告不是错误，不该抢主内容的注意力。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'

type NoticeBlockT = Extract<FlowBlock, { kind: 'notice' }>

export function NoticeBlock({ block }: { block: NoticeBlockT }) {
  const warning = block.level === 'warning'
  return (
    <div
      className="text-xs select-text bg-bg-surface rounded-md px-2.5 py-1 border border-border-default whitespace-pre-wrap"
      style={{
        color: 'var(--text-secondary)',
        borderLeftWidth: 2,
        borderLeftColor: warning ? 'var(--warning)' : 'var(--border-strong)',
      }}
    >
      {block.text}
    </div>
  )
}
