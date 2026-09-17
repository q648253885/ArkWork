/* ============================================================
 * ArkWork — ErrorBlock（v0.31.0 B4）
 * 轮级错误（§11：本版新增可见类型，旧行为不展示）。
 * v0.31.0 D21：整卡不再染红（旧 bg-danger/5 是纯 var() 颜色，Tailwind 无法
 * 施加透明度 → class 空转，既没染成又掩盖了「卡片无底色」）。改为中性底 +
 * 左侧 2px 语义色条：错误仍一眼可辨，但不再整屏红块。
 * ============================================================ */
import type { FlowBlock } from '@shared/types/flow'

type ErrorBlockT = Extract<FlowBlock, { kind: 'error' }>

export function ErrorBlock({ block }: { block: ErrorBlockT }) {
  return (
    <div
      className="rounded-lg border border-border-default bg-bg-surface px-3 py-2 select-text"
      style={{ borderLeftWidth: 2, borderLeftColor: 'var(--danger)' }}
    >
      <div className="text-xs">{block.text}</div>
      {block.detail && (
        <div className="mt-1 text-2xs text-text-tertiary whitespace-pre-wrap select-text">{block.detail}</div>
      )}
    </div>
  )
}
